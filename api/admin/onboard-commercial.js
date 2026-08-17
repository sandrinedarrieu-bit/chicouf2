// api/admin/onboard-commercial.js
//
// Appelé par Make dès qu'un paiement Stripe CommercI.A.l est confirmé.
// Retrouve ou crée la fiche du commercial dans Airtable, puis génère un lien
// d'invitation signé (valable 48h) permettant au commercial de définir lui-même
// son mot de passe — jamais de mot de passe envoyé en clair par email.
//
// Variables d'environnement Vercel requises (déjà en place) :
//   AIRTABLE_API_KEY, SESSION_SECRET, ADMIN_SECRET

import { signSession, guessPrenom } from '../_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';
const INVITE_VALIDITY_MS = 1000 * 60 * 60 * 48; // 48 heures

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { adminSecret, email, nom } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const SESSION_SECRET = process.env.SESSION_SECRET;

  if (!ADMIN_SECRET || !AIRTABLE_API_KEY || !SESSION_SECRET) {
    return res.status(500).json({ error: 'Configuration serveur incomplète.' });
  }
  if (!adminSecret || adminSecret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  if (!email) {
    return res.status(400).json({ error: 'Email requis.' });
  }

  try {
    // 1. Chercher un commercial existant avec cet email
    const filterFormula = encodeURIComponent(`LOWER({Email}) = "${String(email).trim().toLowerCase()}"`);
    const searchRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (!searchRes.ok) throw new Error(`Airtable recherche ${searchRes.status}`);
    const searchData = await searchRes.json();
    let record = searchData.records && searchData.records[0];
    let isNew = false;

    // 2. Sinon, créer la fiche
    if (!record) {
      const createRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            fields: {
              Nom: nom || '',
              Prenom: guessPrenom(nom),
              Email: email
            },
            typecast: true
          })
        }
      );
      if (!createRes.ok) throw new Error(`Airtable création ${createRes.status}`);
      record = await createRes.json();
      isNew = true;
    }

    // 3. Générer le lien d'invitation signé
    const invitePayload = {
      purpose: 'invite',
      sub: record.id,
      email,
      exp: Date.now() + INVITE_VALIDITY_MS
    };
    const token = signSession(invitePayload, SESSION_SECRET);
    const inviteUrl = `https://www.chicouf.pro/definir-mot-de-passe.html?token=${encodeURIComponent(token)}`;

    return res.status(200).json({
      ok: true,
      isNew,
      recordId: record.id,
      nom: record.fields?.Nom || nom || '',
      inviteUrl
    });
  } catch (err) {
    console.error('Erreur onboard-commercial:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
}
