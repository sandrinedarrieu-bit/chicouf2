// api/update-links.js
//
// Permet au commercial CONNECTÉ de renseigner ou modifier ses liens Calendly et
// Zoom personnels. Comme pour dashboard-data.js, le commercial ciblé vient
// uniquement du cookie de session — jamais d'un ID passé par le client — donc
// impossible de modifier la fiche de quelqu'un d'autre en trafiquant la requête.

import { verifySession } from './_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';

function isValidUrl(value) {
  if (!value) return true; // champ optionnel, peut être vidé
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ error: 'Non authentifié.' });
  }

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  if (!AIRTABLE_API_KEY) {
    return res.status(500).json({ error: 'Configuration serveur incomplète.' });
  }

  const { calendly, zoom } = req.body || {};

  if (!isValidUrl(calendly) || !isValidUrl(zoom)) {
    return res.status(400).json({ error: 'Lien invalide. Vérifiez le format (https://...).' });
  }

  const fields = {};
  if (calendly !== undefined) fields.Lien_Calendly = calendly;
  if (zoom !== undefined) fields.Lien_Zoom = zoom;

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
  }

  try {
    const resp = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}/${session.sub}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('Erreur Airtable update-links:', detail);
      return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erreur update-links:', err);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
  }
}
