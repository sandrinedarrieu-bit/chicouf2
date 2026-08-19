// api/request-devis.js
//
// Trois usages, sur la même route (pour rester sous la limite Vercel Hobby) :
//  - POST sans "action"        : le commercial demande un devis pour un client (existant)
//  - GET  ?id=recXXX           : détail d'un devis (description, montant, dates)
//  - POST { id, action:'update-status', statut } : le commercial signale une évolution
//
// Sécurité : chaque lecture/modification vérifie que le devis appartient bien au
// commercial connecté (Audits.Consultant contient son ID) avant d'agir.

import { verifySession } from './_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CLIENTS_TABLE = 'tblPhDItWoYN7jgtA';
const AUDITS_TABLE = 'tblrZJAmMBa2SKjSF';
const NOTIFY_WEBHOOK = 'https://hook.eu1.make.com/8bdhqj9rk31rr0qpvo9ja4q6c5pqrujx';

// Transitions que le commercial est autorisé à faire lui-même. Il ne peut jamais
// toucher au montant, ni faire passer un devis à "Payé" (ça reste piloté par Stripe/Sandrine).
const ALLOWED_TRANSITIONS = {
  'Envoyé': ['Signé', 'Perdu']
};

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

function isOwnerOfAudit(record, consultantId) {
  const owners = record.fields.Consultant || [];
  return owners.includes(consultantId);
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: 'Non authentifié.' });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'Configuration serveur incomplète.' });

  // --- Détail d'un devis ---
  if (req.method === 'GET') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Identifiant de devis manquant.' });

    try {
      const audit = await airtableFetch(`${AUDITS_TABLE}/${id}`, AIRTABLE_API_KEY);
      if (!isOwnerOfAudit(audit, session.sub)) {
        return res.status(403).json({ error: 'Ce devis ne fait pas partie de votre portefeuille.' });
      }

      let entreprise = '';
      const clientId = (audit.fields.Client || [])[0];
      if (clientId) {
        const client = await airtableFetch(`${CLIENTS_TABLE}/${clientId}`, AIRTABLE_API_KEY).catch(() => null);
        entreprise = client ? (client.fields.Entreprise || '') : '';
      }

      return res.status(200).json({
        id: audit.id,
        entreprise,
        statut: audit.fields.Statut || 'En attente',
        montant: audit.fields.Montant_HT || 0,
        description: audit.fields.Description_besoin || '',
        dateEnvoi: audit.fields.Date_envoi_devis || null,
        dateSignature: audit.fields.Date_Signature || null,
        transitions: ALLOWED_TRANSITIONS[audit.fields.Statut] || []
      });
    } catch (err) {
      console.error('Erreur request-devis (detail):', err);
      return res.status(500).json({ error: 'Erreur lors du chargement du devis.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // --- Mise à jour de statut par le commercial ---
  if ((req.body || {}).action === 'update-status') {
    const { id, statut } = req.body;
    if (!id || !statut) return res.status(400).json({ error: 'Devis et statut requis.' });

    try {
      const audit = await airtableFetch(`${AUDITS_TABLE}/${id}`, AIRTABLE_API_KEY);
      if (!isOwnerOfAudit(audit, session.sub)) {
        return res.status(403).json({ error: 'Ce devis ne fait pas partie de votre portefeuille.' });
      }

      const currentStatut = audit.fields.Statut || 'En attente';
      const allowed = ALLOWED_TRANSITIONS[currentStatut] || [];
      if (!allowed.includes(statut)) {
        return res.status(400).json({ error: `Impossible de passer de "${currentStatut}" à "${statut}" depuis le dashboard.` });
      }

      const fields = { Statut: statut };
      if (statut === 'Signé') {
        fields.Date_Signature = new Date().toISOString().slice(0, 10);
      }

      const updated = await airtableFetch(`${AUDITS_TABLE}/${id}`, AIRTABLE_API_KEY, {
        method: 'PATCH',
        body: JSON.stringify({ fields, typecast: true })
      });

      return res.status(200).json({ ok: true, statut: updated.fields.Statut });
    } catch (err) {
      console.error('Erreur request-devis (update-status):', err);
      return res.status(500).json({ error: 'Erreur lors de la mise à jour du devis.' });
    }
  }

  // --- Le commercial indique/modifie la date d'envoi du devis au prospect ---
  if ((req.body || {}).action === 'set-date-envoi') {
    const { id, date } = req.body;
    if (!id || !date) return res.status(400).json({ error: 'Devis et date requis.' });

    try {
      const audit = await airtableFetch(`${AUDITS_TABLE}/${id}`, AIRTABLE_API_KEY);
      if (!isOwnerOfAudit(audit, session.sub)) {
        return res.status(403).json({ error: 'Ce devis ne fait pas partie de votre portefeuille.' });
      }

      const updated = await airtableFetch(`${AUDITS_TABLE}/${id}`, AIRTABLE_API_KEY, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { Date_envoi_devis: date }, typecast: true })
      });

      return res.status(200).json({ ok: true, dateEnvoi: updated.fields.Date_envoi_devis });
    } catch (err) {
      console.error('Erreur request-devis (set-date-envoi):', err);
      return res.status(500).json({ error: 'Erreur lors de la mise à jour de la date.' });
    }
  }

  // --- Le commercial coche/décoche "commission facturée" sur un devis payé ---
  if ((req.body || {}).action === 'toggle-commission') {
    const { id, facturee } = req.body;
    if (!id) return res.status(400).json({ error: 'Devis requis.' });

    try {
      const audit = await airtableFetch(`${AUDITS_TABLE}/${id}`, AIRTABLE_API_KEY);
      if (!isOwnerOfAudit(audit, session.sub)) {
        return res.status(403).json({ error: 'Ce devis ne fait pas partie de votre portefeuille.' });
      }
      if ((audit.fields.Statut || '') !== 'Payé') {
        return res.status(400).json({ error: 'Seuls les devis payés ont une commission à suivre.' });
      }

      const updated = await airtableFetch(`${AUDITS_TABLE}/${id}`, AIRTABLE_API_KEY, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { Commission_Facturee: !!facturee }, typecast: true })
      });

      return res.status(200).json({ ok: true, facturee: !!updated.fields.Commission_Facturee });
    } catch (err) {
      console.error('Erreur request-devis (toggle-commission):', err);
      return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
    }
  }

  // --- Demande de devis (comportement existant, inchangé) ---
  const { entreprise, nomContact, secteur, description } = req.body || {};
  if (!entreprise || !description) {
    return res.status(400).json({ error: 'Entreprise et description du besoin sont requis.' });
  }

  try {
    const filterFormula = encodeURIComponent(
      `AND(LOWER({Entreprise}) = "${entreprise.trim().toLowerCase()}", FIND("${session.sub}", ARRAYJOIN({Consultant_ID})))`
    );
    const searchData = await airtableFetch(
      `${CLIENTS_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`,
      AIRTABLE_API_KEY
    );
    let client = searchData.records && searchData.records[0];

    if (!client) {
      const createClient = await airtableFetch(CLIENTS_TABLE, AIRTABLE_API_KEY, {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            Entreprise: entreprise,
            Nom_contact: nomContact || '',
            Secteur: secteur || '',
            Consultant_ID: [session.sub]
          },
          typecast: true
        })
      });
      client = createClient;
    }

    await airtableFetch(AUDITS_TABLE, AIRTABLE_API_KEY, {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          Client: [client.id],
          Consultant: [session.sub],
          Statut: 'En attente',
          Description_besoin: description
        },
        typecast: true
      })
    });

    await fetch(NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commercialNom: session.name,
        entreprise,
        nomContact: nomContact || '',
        secteur: secteur || '',
        description
      })
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erreur request-devis:', err);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi de la demande.' });
  }
}
