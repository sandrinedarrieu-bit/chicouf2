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

import { verifySession, signSession } from '../_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';
const CLIENTS_TABLE = 'tblPhDItWoYN7jgtA';
const AUDITS_TABLE = 'tblrZJAmMBa2SKjSF';
const HISTORIQUE_TABLE = 'tbl2iu6bQ38Un4s8p';
const PAIEMENTS_TABLE = 'tblxB3tjITPrkBUp8';
const ADMIN_EMAIL = 'contact@chicouf.pro';
const COMMISSION_RATE = 0.05;

// Même mécanisme d'invitation que api/webhooks/stripe.js (lien signé + email via Make) —
// réutilisé ici pour le bouton "Envoyer le lien dashboard" plutôt que d'en recréer un.
const MAKE_EMAIL_WEBHOOK = 'https://hook.eu1.make.com/1q2av6e3065l7om7iiyc6lpy0evoca80';
const INVITE_VALIDITY_MS = 1000 * 60 * 60 * 48; // 48 heures

// Statuts de candidature suivis dans l'onglet Prospects commerciaux.
const PROSPECT_STATUTS = ['Nouveau candidat', 'RDV pris', 'Candidat non engagé', 'Accepté', 'À revoir', 'Refusé', 'Actif'];
// Seules ces 3 valeurs sont choisissables depuis le menu Décision — les autres statuts
// restent en lecture seule côté dashboard (cohérent avec ALLOWED_TRANSITIONS de request-devis.js).
const DECISION_OPTIONS = ['Accepté', 'À revoir', 'Refusé'];

function orRecordIds(ids) {
  return ids.map((id) => `RECORD_ID()="${id}"`).join(',');
}

async function airtableFetch(path, apiKey, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Airtable ${res.status} sur ${path}`);
  return res.json();
}
const airtableGet = airtableFetch; // alias : conserve le nom utilisé par le reste du fichier

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

// Vérifie que la session appartient bien à l'admin — partagé par toutes les branches de ce
// fichier (GET ?resource=... et POST action:...), jamais dérivé d'un ID fourni par le client.
async function requireAdmin(session, apiKey) {
  const meRes = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}/${session.sub}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!meRes.ok) throw new Error(`Airtable ${meRes.status}`);
  const me = await meRes.json();
  return (me.fields.Email || '').trim().toLowerCase() === ADMIN_EMAIL;
}

// --- Prospects commerciaux : candidats en recrutement (au-delà des commerciaux déjà signés) ---
async function getProspects(apiKey) {
  const formula = encodeURIComponent(`OR(${PROSPECT_STATUTS.map((s) => `{Statut}="${s}"`).join(',')})`);
  const data = await airtableFetch(
    `${CONSULTANTS_TABLE}?filterByFormula=${formula}&sort[0][field]=Date_RDV&sort[0][direction]=desc`,
    apiKey
  );
  return (data.records || []).map((r) => {
    const statut = r.fields.Statut || '';
    return {
      id: r.id,
      nom: r.fields.Nom || '',
      prenom: r.fields.Prenom || '',
      email: r.fields.Email || '',
      telephone: r.fields['Téléphone'] || '',
      dateRDV: r.fields.Date_RDV || null,
      relances: {
        h4: !!r.fields.Relance_RDV_4h_envoyee,
        h24: !!r.fields.Relance_RDV_24h_envoyee,
        j3: !!r.fields.Relance_RDV_3j_envoyee
      },
      statut,
      cgvAcceptees: !!r.fields.CGV_acceptees,
      dateEnvoiContrat: r.fields.Date_envoi_contrat || null,
      dateSignatureContrat: r.fields.Date_signature_contrat || null,
      dashboardEnvoye: !!r.fields.Dashboard_envoye
    };
  });
}

// --- Suivi CA / Paiement : table Paiements (commerciaux + clients CAPE) ---
async function getPaiements(apiKey) {
  let records = [];
  let offset;
  for (let i = 0; i < 10; i++) { // jusqu'à 1000 paiements, largement suffisant
    let path = `${PAIEMENTS_TABLE}?pageSize=100`;
    if (offset) path += `&offset=${offset}`;
    const data = await airtableFetch(path, apiKey);
    records = records.concat(data.records || []);
    offset = data.offset;
    if (!offset) break;
  }

  const paiements = records
    .map((r) => ({
      id: r.id,
      nomComplet: r.fields.Nom_complet || '',
      origine: r.fields.Origine || '',
      typePaiement: r.fields.Type_paiement || '',
      montant: r.fields.Montant || 0,
      datePaiement: r.fields.Date_paiement || null,
      statutPaiement: r.fields.Statut_paiement || ''
    }))
    .sort((a, b) => (b.datePaiement || '').localeCompare(a.datePaiement || ''));

  // CA par mois, "Statut_paiement" = OK uniquement, 6 derniers mois — une liste simple plutôt
  // qu'un graphique, comme le permet explicitement le brief ("privilégier la simplicité").
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    months.push({ key, mois: label.charAt(0).toUpperCase() + label.slice(1), total: 0 });
  }
  const monthByKey = Object.fromEntries(months.map((m) => [m.key, m]));
  paiements.forEach((p) => {
    if (p.statutPaiement !== 'OK' || !p.datePaiement) return;
    const month = monthByKey[p.datePaiement.slice(0, 7)];
    if (month) month.total += p.montant;
  });

  return { paiements, caParMois: months.map((m) => ({ mois: m.mois, total: m.total })) };
}

// --- Bandeau "Actions à faire" : ce qui attend une décision humaine ---
async function getActionsAFaire(apiKey) {
  const actions = [];
  const TWO_DAYS_MS = 1000 * 60 * 60 * 24 * 2;

  const formula = encodeURIComponent('{Statut}="Accepté"');
  const acceptedData = await airtableFetch(`${CONSULTANTS_TABLE}?filterByFormula=${formula}`, apiKey);
  const accepted = acceptedData.records || [];

  // Règle 1 : contrat pas encore parti, plus de 2 jours après la décision (filet de sécurité,
  // cas rare). Date_decision est renseignée automatiquement par l'automatisation Airtable/Make
  // à chaque décision — ce dashboard se contente de la lire.
  const contratNonParti = accepted.filter((r) => {
    const sigId = r.fields.Contrat_signature_id;
    const decision = r.fields.Date_decision;
    if (sigId || !decision) return false;
    return Date.now() - new Date(decision).getTime() > TWO_DAYS_MS;
  });
  if (contratNonParti.length > 0) {
    actions.push({
      type: 'contrat-non-parti',
      message: `${contratNonParti.length} candidat${contratNonParti.length > 1 ? 's' : ''} accepté${contratNonParti.length > 1 ? 's' : ''} dont le contrat n'est pas encore parti depuis plus de 2 jours`,
      targetTab: 'prospects-commerciaux',
      targetIds: contratNonParti.map((r) => r.id)
    });
  }

  // Règle 2 : contrat envoyé mais non signé depuis plus de 7 jours (déjà détecté par
  // l'automatisation existante via Notification_J7_envoyee).
  const enAttenteSignature = accepted.filter((r) => !!r.fields.Notification_J7_envoyee);
  if (enAttenteSignature.length > 0) {
    actions.push({
      type: 'contrat-en-attente',
      message: `${enAttenteSignature.length} contrat${enAttenteSignature.length > 1 ? 's' : ''} envoyé${enAttenteSignature.length > 1 ? 's' : ''} en attente de signature depuis plus de 7 jours`,
      targetTab: 'prospects-commerciaux',
      targetIds: enAttenteSignature.map((r) => r.id)
    });
  }

  // Règle 3 : paiements rejetés dans les 30 derniers jours, à relancer.
  const paiementsFormula = encodeURIComponent(
    `AND({Statut_paiement}="Rejeté", IS_AFTER({Date_paiement}, DATEADD(TODAY(), -30, 'days')))`
  );
  const paiementsData = await airtableFetch(`${PAIEMENTS_TABLE}?filterByFormula=${paiementsFormula}`, apiKey);
  const rejetes = paiementsData.records || [];
  if (rejetes.length > 0) {
    actions.push({
      type: 'paiement-rejete',
      message: `${rejetes.length} paiement${rejetes.length > 1 ? 's' : ''} rejeté${rejetes.length > 1 ? 's' : ''} à relancer`,
      targetTab: 'paiements',
      targetIds: rejetes.map((r) => r.id)
    });
  }

  return actions;
}

// --- POST action:'update-statut' : décision (Accepté/À revoir/Refusé) sur un candidat ---
async function handleUpdateStatut(req, res, apiKey) {
  const { id, statut } = req.body || {};
  if (!id || !statut) return res.status(400).json({ error: 'Candidat et statut requis.' });
  if (!DECISION_OPTIONS.includes(statut)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }

  try {
    // Ce changement déclenche déjà des automatisations Make côté Airtable (envoi de contrat,
    // email de refus) — le rôle de ce endpoint est uniquement d'écrire la nouvelle valeur.
    const updated = await airtableFetch(`${CONSULTANTS_TABLE}/${id}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { Statut: statut }, typecast: true })
    });
    return res.status(200).json({ ok: true, statut: updated.fields.Statut });
  } catch (err) {
    console.error('Erreur update-statut:', err);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour du statut.' });
  }
}

// --- POST action:'send-dashboard-link' : envoie le lien d'invitation dashboard ---
async function handleSendDashboardLink(req, res, apiKey, sessionSecret) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Candidat requis.' });

  try {
    const record = await airtableFetch(`${CONSULTANTS_TABLE}/${id}`, apiKey);
    const email = record.fields.Email;
    if (!email) return res.status(400).json({ error: 'Ce candidat n\'a pas d\'email renseigné.' });

    // Même mécanisme d'invitation que api/webhooks/stripe.js : token signé + email via Make.
    const invitePayload = {
      purpose: 'invite',
      sub: record.id,
      email,
      exp: Date.now() + INVITE_VALIDITY_MS
    };
    const token = signSession(invitePayload, sessionSecret);
    const inviteUrl = `https://www.chicouf.pro/definir-mot-de-passe.html?token=${encodeURIComponent(token)}`;

    await fetch(MAKE_EMAIL_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nom: record.fields.Nom || '', inviteUrl })
    });

    const updated = await airtableFetch(`${CONSULTANTS_TABLE}/${id}`, apiKey, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { Dashboard_envoye: true }, typecast: true })
    });

    return res.status(200).json({ ok: true, dashboardEnvoye: !!updated.fields.Dashboard_envoye });
  } catch (err) {
    console.error('Erreur send-dashboard-link:', err);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi du lien.' });
  }
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: 'Non authentifié.' });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY_LIVE;
  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'Configuration serveur incomplète.' });

  try {
    const isAdmin = await requireAdmin(session, AIRTABLE_API_KEY);
    if (!isAdmin) return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });

    if (req.method === 'POST') {
      const action = (req.body || {}).action;
      if (action === 'update-statut') return handleUpdateStatut(req, res, AIRTABLE_API_KEY);
      if (action === 'send-dashboard-link') {
        if (!SESSION_SECRET) return res.status(500).json({ error: 'Configuration serveur incomplète.' });
        return handleSendDashboardLink(req, res, AIRTABLE_API_KEY, SESSION_SECRET);
      }
      return res.status(400).json({ error: 'Action inconnue.' });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const resource = req.query.resource || 'reseau';

    if (resource === 'prospects') {
      const prospects = await getProspects(AIRTABLE_API_KEY);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ prospects });
    }

    if (resource === 'paiements') {
      const { paiements, caParMois } = await getPaiements(AIRTABLE_API_KEY);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ paiements, caParMois });
    }

    if (resource === 'actions') {
      const actions = await getActionsAFaire(AIRTABLE_API_KEY);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ actions });
    }

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
