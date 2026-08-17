// api/auth/set-password-with-token.js
//
// Le commercial arrive ici depuis le lien reçu par email après paiement.
// Le token prouve son identité (signé par le serveur, impossible à falsifier) :
// pas besoin de retaper un mot de passe existant, il choisit le sien.
// Une fois le mot de passe défini, on ouvre directement sa session.

import { verifyToken, signSession, hashPassword } from '../_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
