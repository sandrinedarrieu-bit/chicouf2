// api/admin/set-password.js
//
// Permet à Sandrine (et uniquement elle, via ADMIN_SECRET) de créer ou réinitialiser
// le mot de passe d'un commercial, sans jamais stocker ni transmettre le mot de passe
// en clair dans Airtable : seul le hash (scrypt + sel) y est écrit.
//
// Variable d'environnement Vercel supplémentaire requise :
//   ADMIN_SECRET = une chaîne secrète que seule Sandrine connaît

import { hashPassword } from '../_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { adminSecret, email, newPassword } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

  if (!ADMIN_SECRET || !AIRTABLE_API_KEY) {
    return res.status(500).json({ error: 'Configuration serveur incomplète.' });
  }
  if (!adminSecret || adminSecret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  if (!email || !newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Email et mot de passe (8 caractères minimum) requis.' });
  }

  try {
    const filterFormula = encodeURIComponent(`LOWER({Email}) = "${String(email).trim().toLowerCase()}"`);
    const searchRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (!searchRes.ok) throw new Error(`Airtable ${searchRes.status}`);
    const searchData = await searchRes.json();
    const record = searchData.records && searchData.records[0];
    if (!record) {
      return res.status(404).json({ error: 'Aucun consultant trouvé avec cet email.' });
    }

    const passwordHash = hashPassword(newPassword);
    const updateRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}/${record.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields: { Password_hash: passwordHash } })
      }
    );
    if (!updateRes.ok) throw new Error(`Airtable ${updateRes.status}`);

    return res.status(200).json({ ok: true, nom: record.fields.Nom || '' });
  } catch (err) {
    console.error('Erreur set-password:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
}
