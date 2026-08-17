// api/request-devis.js
//
// Un commercial connecté demande un devis pour un de SES clients. Le client et le
// devis sont automatiquement liés à son propre compte via sa session — jamais un ID
// envoyé par le navigateur, donc impossible d'attribuer un client à quelqu'un d'autre.

import { verifySession } from './_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CLIENTS_TABLE = 'tblPhDItWoYN7jgtA';
const AUDITS_TABLE = 'tblrZJAmMBa2SKjSF';
const NOTIFY_WEBHOOK = 'https://hook.eu1.make.com/8bdhqj9rk31rr0qpvo9ja4q6c5pqrujx';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: 'Non authentifié.' });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'Configuration serveur incomplète.' });

  const { entreprise, nomContact, secteur, description } = req.body || {};
  if (!entreprise || !description) {
    return res.status(400).json({ error: 'Entreprise et description du besoin sont requis.' });
  }

  try {
    // 1. Chercher si ce commercial a déjà un client avec ce nom d'entreprise
    const filterFormula = encodeURIComponent(
      `AND(LOWER({Entreprise}) = "${entreprise.trim().toLowerCase()}", FIND("${session.sub}", ARRAYJOIN({Consultant_ID})))`
    );
    const searchData = await airtableFetch(
      `${CLIENTS_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`,
      AIRTABLE_API_KEY
    );
    let client = searchData.records && searchData.records[0];

    // 2. Sinon, créer le client, lié au commercial connecté
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

    // 3. Créer le devis (Audit), statut "En attente"
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

    // 4. Notifier Sandrine par email (appel sortant vers Make, jamais bloqué)
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
