// api/webhooks/stripe.js
//
// Reçoit directement les événements Stripe (au lieu de passer par Make, qui se faisait
// bloquer par le pare-feu Vercel). Stripe → Vercel est un schéma standard et fiable.
// Une fois le paiement traité, cet endpoint appelle un webhook Make très simple
// (juste l'envoi d'email) — un appel SORTANT depuis Vercel, jamais soumis au pare-feu
// qui ne protège que ce qui ENTRE sur le site.
//
// Variables d'environnement Vercel requises :
//   AIRTABLE_API_KEY, SESSION_SECRET (déjà en place)
//   STRIPE_WEBHOOK_SECRET (nouvelle, à récupérer dans Stripe lors de la création
//   de ce webhook — voir instructions)

import crypto from 'crypto';
import { signSession } from '../_session.js';

export const config = {
  api: {
    bodyParser: false // on a besoin du corps brut pour vérifier la signature Stripe
  }
};

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';
const MAKE_EMAIL_WEBHOOK = 'https://hook.eu1.make.com/1q2av6e3065l7om7iiyc6lpy0evoca80';
const INVITE_VALIDITY_MS = 1000 * 60 * 60 * 48; // 48 heures

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, sigHeader, secrets) {
  if (!sigHeader) return false;
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const { t: timestamp, v1: signature } = parts;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const sigBuf = Buffer.from(signature, 'hex');

  // On essaie chaque clé connue (test et/ou live) — la première qui correspond valide la requête.
  for (const secret of secrets) {
    if (!secret) continue;
    const expectedSig = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
      return true;
    }
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const STRIPE_WEBHOOK_SECRET_TEST = process.env.STRIPE_WEBHOOK_SECRET_TEST;
  const STRIPE_WEBHOOK_SECRET_LIVE = process.env.STRIPE_WEBHOOK_SECRET_LIVE;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const SESSION_SECRET = process.env.SESSION_SECRET;

  if ((!STRIPE_WEBHOOK_SECRET_TEST && !STRIPE_WEBHOOK_SECRET_LIVE) || !AIRTABLE_API_KEY || !SESSION_SECRET) {
    console.error('Variables d\'environnement manquantes pour le webhook Stripe');
    return res.status(500).end();
  }

  const rawBody = await getRawBody(req);
  const sigHeader = req.headers['stripe-signature'];

  if (!verifyStripeSignature(rawBody, sigHeader, [STRIPE_WEBHOOK_SECRET_TEST, STRIPE_WEBHOOK_SECRET_LIVE])) {
    console.error('Signature Stripe invalide');
    return res.status(400).json({ error: 'Signature invalide.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Payload invalide.' });
  }

  // On répond vite à Stripe pour éviter les retries, puis on traite en arrière-plan serait idéal,
  // mais sur Vercel serverless on traite avant de répondre — reste rapide (Airtable + un appel HTTP).
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const session = event.data?.object;
  const email = session?.customer_details?.email;
  const nom = session?.customer_details?.name || '';

  if (!email) {
    console.error('Pas d\'email dans la session Stripe');
    return res.status(200).json({ ok: true, skipped: 'no-email' });
  }

  try {
    // 1. Chercher un commercial existant avec cet email
    const filterFormula = encodeURIComponent(`LOWER({Email}) = "${email.trim().toLowerCase()}"`);
    const searchRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CONSULTANTS_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (!searchRes.ok) throw new Error(`Airtable recherche ${searchRes.status}`);
    const searchData = await searchRes.json();
    let record = searchData.records && searchData.records[0];

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
          body: JSON.stringify({ fields: { Nom: nom, Email: email }, typecast: true })
        }
      );
      if (!createRes.ok) throw new Error(`Airtable création ${createRes.status}`);
      record = await createRes.json();
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

    // 4. Déclencher l'envoi de l'email via Make (appel SORTANT, jamais bloqué par le firewall)
    await fetch(MAKE_EMAIL_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nom, inviteUrl })
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erreur webhook Stripe:', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}
