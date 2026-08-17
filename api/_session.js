// api/_session.js
//
// Vérification de la session commercial. Fichier préfixé par "_" : Vercel ne le
// déploie pas comme route API, il est seulement importé par les autres fonctions.
//
// Le cookie de session contient un payload signé par HMAC-SHA256 (clé = SESSION_SECRET,
// variable d'environnement Vercel). On ne stocke rien côté serveur : la signature suffit
// à garantir que le contenu n'a pas été modifié par le client.

import crypto from 'crypto';

// Vérifie un token signé brut (payload.sig), quelle que soit sa provenance
// (cookie de session ou lien d'invitation envoyé par email).
export function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;

  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null; // expiré
    return payload;
  } catch {
    return null;
  }
}

export function verifySession(req) {
  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!SESSION_SECRET) {
    console.error('SESSION_SECRET manquant dans les variables d\'environnement Vercel');
    return null;
  }

  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/coch_session=([^;]+)/);
  if (!match) return null;

  const payload = verifyToken(match[1], SESSION_SECRET);
  if (!payload || !payload.sub || payload.purpose !== 'session') return null;
  return payload; // { purpose: 'session', sub: recordId Consultant, name, exp }
}

export function signSession(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const hash = crypto.scryptSync(password, salt, 64);
    const storedHash = Buffer.from(hashHex, 'hex');
    if (hash.length !== storedHash.length) return false;
    return crypto.timingSafeEqual(hash, storedHash);
  } catch {
    return false;
  }
}
