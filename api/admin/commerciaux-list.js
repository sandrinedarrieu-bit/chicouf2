// api/admin/commerciaux-list.js
//
// Liste tous les membres du réseau CommercI.A.l avec leur statut, réservée à l'admin
// (vérifié via la session, pas de clé à retaper). Le statut est déduit de ce qui existe
// déjà : présence d'un mot de passe = accès créé (payé), sinon présence d'un RDV = contact
// pris, sinon simple prospect.
//
// Deux chiffres de CA bien distincts sont calculés pour chaque commercial :
//   - caReseau  : ce que CHIC · OUF a encaissé DE ce commercial (kit + abonnement), via Stripe
//   - caClients : ce que CE commercial a généré chez SES clients (devis payés), base de sa commission à 5%
//
// Chaque prospect/commercial embarque aussi son historique d'appels (table Historique_appels),
// pour repérer facilement d'éventuels doublons créés via le récap Tally (même personne, deux
// fiches) et voir tous les échanges passés d'un coup d'œil.

import { verifySession } from '../_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';
const CLIENTS_TABLE = 'tblPhDItWoYN7jgtA';
const AUDITS_TABLE = 'tblrZJAmMBa2SKjSF';
const HISTORIQUE_TABLE = 'tbl2iu6bQ38Un4s8p';
const ADMIN_EMAIL = 'contact@chicouf.pro';
const COMMISSION_RATE = 0.05;

function orRecordIds(ids) {
  return ids.map((id) => `RECORD_ID()="${id}"`).join(',');
}

async function airtableGet(path, apiKey) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`Airtable ${res.status} sur ${path}`);
  return res.json();
}

// CA que CHIC · OUF a encaissé de ce commercial : somme des factures payées sur Stripe pour son email.
async function getCaReseau(email, stripeKey) {
  if (!stripeKey || !email) return null;
  try {
    const custRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: `Bearer ${stripeKey}` } }
    );
    if (!custRes.ok) return null;
    const custData = await custRes.json();
    const customer = custData.data && custData.data[0];
    if (!customer) return 0; // pas encore de client Stripe pour cet email

    let total = 0;
    let startingAfter = null;
    for (let i = 0; i < 5; i++) { // jusqu'à 500 factures, largement suffisant
      const url = new URL(`https://api.stripe.com/v1/invoices`);
      url.searchParams.set('customer', customer.id);
      url.searchParams.set('status', 'paid');
      url.searchParams.set('limit', '100');
      if (startingAfter) url.searchParams.set('starting_after', startingAfter);

      const invRes = await fetch(url, { headers: { Authorization: `Bearer ${stripeKey}` } });
      if (!invRes.ok) break;
      const invData = await invRes.json();
      (invData.data || []).forEach((inv) => { total += inv.amount_paid || 0; });
      if (!invData.has_more || !invData.data.length) break;
      startingAfter = invData.data[invData.data.length - 1].id;
    }
    return Math.round(total / 100); // centimes → euros
  } catch {
    return null; // n'empêche jamais l'affichage du reste de la liste
  }
}

// CA que CE commercial a généré chez ses propres clients : somme des devis "Payé".
async function getCaClients(consultant, apiKey) {
  const clientIds = consultant.fields.Clients || [];
  if (clientIds.length === 0) return 0;

  const clientsData = await airtableGet(
    `${CLIENTS_TABLE}?filterByFormula=${encodeURIComponent(`OR(${orRecordIds(clientIds)})`)}`,
    apiKey
  );
  const clients = clientsData.records || [];
  const auditIds = clients.flatMap((c) => c.fields.Audits || []);
  if (auditIds.length === 0) return 0;

  const auditsData = await airtableGet(
    `${AUDITS_TABLE}?filterByFormula=${encodeURIComponent(`OR(${orRecordIds(auditIds)})`)}`,
    apiKey
  );
  const audits = auditsData.records || [];
  return audits
    .filter((a) => a.fields.Statut === 'Payé')
    .reduce((sum, a) => sum + (a.fields.Montant_HT || 0), 0);
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: 'Non authentifié.' });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY_LIVE;
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'Configuration serveur incomplète.' });

  try {
    // Vérifier que la session appartient bien à l'admin
    const meRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}/${session.sub}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (!meRes.ok) throw new Error(`Airtable ${meRes.status}`);
    const me = await meRes.json();
    const isAdmin = (me.fields.Email || '').trim().toLowerCase() === ADMIN_EMAIL;
    if (!isAdmin) return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });

    // Récupérer tout le réseau CommercI.A.l : motif de RDV correspondant, déjà onboardé,
    // OU capturé via le formulaire de récap Tally (identifiable par un Prénom renseigné).
    const filterFormula = encodeURIComponent(
      `OR({Motif_RDV} = "Rejoindre le réseau - CommercI.A.l", {Password_hash} != "", {Prenom} != "")`
    );
    const listData = await airtableGet(
      `${CONSULTANTS_TABLE}?filterByFormula=${filterFormula}&sort[0][field]=Date_RDV&sort[0][direction]=desc`,
      AIRTABLE_API_KEY
    );
    const records = listData.records || [];

    // Récupérer en une seule fois tout l'historique d'appels lié à l'ensemble de ces fiches.
    const allHistoriqueIds = records.flatMap((r) => r.fields.Historique_appels || []);
    let historiqueById = {};
    if (allHistoriqueIds.length > 0) {
      const histoData = await airtableGet(
        `${HISTORIQUE_TABLE}?filterByFormula=${encodeURIComponent(`OR(${orRecordIds(allHistoriqueIds)})`)}`,
        AIRTABLE_API_KEY
      );
      historiqueById = Object.fromEntries((histoData.records || []).map((h) => [h.id, h]));
    }

    const commerciaux = await Promise.all(
      records.map(async (r) => {
        let statut = 'Contact';
        if (r.fields.Password_hash) statut = 'Signé';
        else if (r.fields.Date_RDV) statut = 'RDV pris';

        const email = r.fields.Email || '';
        const [caReseau, caClients] = await Promise.all([
          statut === 'Signé' ? getCaReseau(email, STRIPE_SECRET_KEY) : Promise.resolve(0),
          getCaClients(r, AIRTABLE_API_KEY)
        ]);

        const historique = (r.fields.Historique_appels || [])
          .map((id) => historiqueById[id])
          .filter(Boolean)
          .map((h) => ({
            date: h.fields.Date || null,
            resume: h.fields.Resume || '',
            solution: h.fields.Solution_proposee || []
          }))
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        return {
          nom: r.fields.Nom || '(sans nom)',
          email,
          statut,
          dateRDV: r.fields.Date_RDV || null,
          caReseau, // null si pas encore calculable (Stripe non configuré ou client introuvable)
          caClients,
          commission: Math.round(caClients * COMMISSION_RATE),
          historique
        };
      })
    );

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ commerciaux, stripeConfigured: !!STRIPE_SECRET_KEY });
  } catch (err) {
    console.error('Erreur commerciaux-list:', err);
    return res.status(500).json({ error: 'Erreur lors du chargement de la liste.' });
  }
}
