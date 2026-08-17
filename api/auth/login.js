// api/auth/login.js
//
// Vérifie email + mot de passe d'un commercial contre la table Consultants,
// puis ouvre une session via cookie signé (httpOnly, jamais lisible en JS côté client).
//
// Variables d'environnement Vercel requises :
//   AIRTABLE_API_KEY = Personal Access Token Airtable (déjà utilisé par rapport-data.js)
//   SESSION_SECRET   = chaîne aléatoire longue (ex: openssl rand -hex 32)

import { verifyPassword, signSession } from '../_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';

const HITS = new Map();
const WINDOW_MS = 60_000;
const MAX_HITS_PER_WINDOW = 8;

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  return hits.length > MAX_HITS_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une minute.' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!AIRTABLE_API_KEY || !SESSION_SECRET) {
    console.error('Variables d\'environnement manquantes (AIRTABLE_API_KEY / SESSION_SECRET)');
    return res.status(500).json({ error: 'Configuration serveur incomplète.' });
  }

  // Réponse identique en cas d'email inconnu ou de mot de passe faux :
  // on ne révèle jamais si un email existe dans la base.
  const genericError = () => res.status(401).json({ error: 'Email ou mot de passe incorrect.' });

  try {
    const filterFormula = encodeURIComponent(`LOWER({Email}) = "${String(email).trim().toLowerCase()}"`);
    const searchRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (!searchRes.ok) throw new Error(`Airtable ${searchRes.status}`);
    const searchData = await searchRes.json();
    const record = searchData.records && searchData.records[0];

    if (!record || !record.fields.Password_hash) {
      return genericError();
    }

    const valid = verifyPassword(password, record.fields.Password_hash);
    if (!valid) return genericError();

    const session = {
      purpose: 'session',
      sub: record.id,
      name: record.fields.Nom || '',
      prenom: record.fields.Prenom || '',
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7 // 7 jours
    };
    const token = signSession(session, SESSION_SECRET);

    res.setHeader(
      'Set-Cookie',
      `coch_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    );
    return res.status(200).json({ ok: true, name: session.name });
  } catch (err) {
    console.error('Erreur login:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
}
