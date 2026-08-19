// api/auth.js
//
// Fusion de login.js + logout.js + set-password-with-token.js en une seule
// fonction serverless, routée par ?action=. Vercel Hobby plafonne à 12
// fonctions par déploiement — cette fusion libère 2 emplacements.
//
// Appels attendus :
//   POST /api/auth?action=login                 { email, password }
//   POST /api/auth?action=logout                 (aucun body)
//   POST /api/auth?action=set-password-with-token { token, password }
//
// Variables d'environnement Vercel requises :
//   AIRTABLE_API_KEY = Personal Access Token Airtable
//   SESSION_SECRET   = chaîne aléatoire longue (ex: openssl rand -hex 32)

import { verifyToken, verifyPassword, signSession, hashPassword } from './_session.js';

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

async function handleLogin(req, res) {
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

async function handleLogout(req, res) {
  res.setHeader('Set-Cookie', 'coch_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return res.status(200).json({ ok: true });
}

async function handleSetPasswordWithToken(req, res) {
  const { token, password } = req.body || {};
  const SESSION_SECRET = process.env.SESSION_SECRET;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

  if (!SESSION_SECRET || !AIRTABLE_API_KEY) {
    return res.status(500).json({ error: 'Configuration serveur incomplète.' });
  }
  if (!token || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Lien invalide ou mot de passe trop court (8 caractères minimum).' });
  }

  const invite = verifyToken(token, SESSION_SECRET);
  if (!invite || invite.purpose !== 'invite' || !invite.sub) {
    return res.status(401).json({ error: 'Ce lien a expiré ou n\'est plus valide. Contactez-nous pour en recevoir un nouveau.' });
  }

  try {
    const passwordHash = hashPassword(password);
    const updateRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}/${invite.sub}`,
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
    const updated = await updateRes.json();

    // Connexion automatique : on ouvre directement la session
    const session = {
      purpose: 'session',
      sub: invite.sub,
      name: updated.fields?.Nom || '',
      prenom: updated.fields?.Prenom || '',
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7
    };
    const sessionToken = signSession(session, SESSION_SECRET);
    res.setHeader(
      'Set-Cookie',
      `coch_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
    );

    return res.status(200).json({ ok: true, name: session.name });
  } catch (err) {
    console.error('Erreur set-password-with-token:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action;

  switch (action) {
    case 'login':
      return handleLogin(req, res);
    case 'logout':
      return handleLogout(req, res);
    case 'set-password-with-token':
      return handleSetPasswordWithToken(req, res);
    default:
      return res.status(400).json({ error: 'Action inconnue.' });
  }
}
