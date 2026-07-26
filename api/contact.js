// Proxy serveur pour le formulaire de contact.
// Objectif : ne jamais exposer l'URL du webhook Make dans le JS public,
// valider les données reçues, filtrer les robots basiques et limiter les abus.

// Limiteur de requêtes très simple, en mémoire (par instance de fonction Vercel).
// Ce n'est pas un rate-limit distribué robuste, mais ça bloque déjà les scripts
// qui tapent en boucle sur le même exécutable chaud. Pour une protection plus
// solide (multi-instances), on pourra brancher un compteur Upstash/Redis plus tard.
const HITS = new Map(); // ip -> [timestamps]
const WINDOW_MS = 60_000; // 1 minute
const MAX_HITS_PER_WINDOW = 5;

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  return hits.length > MAX_HITS_PER_WINDOW;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Trop de tentatives, merci de réessayer dans une minute.' });
  }

  const { prenom, nom, email, structure, interet, message, website } = req.body || {};

  // Honeypot : un vrai visiteur ne remplit jamais ce champ (caché en CSS côté site).
  // Un robot qui remplit tous les champs du formulaire le remplira, lui.
  if (website) {
    // On répond succès pour ne pas indiquer au bot qu'il a été détecté,
    // mais on n'envoie rien à Make.
    return res.status(200).json({ ok: true });
  }

  if (!prenom || !email) {
    return res.status(400).json({ error: 'Prénom et email requis.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (message && message.length > 3000) {
    return res.status(400).json({ error: 'Message trop long.' });
  }

  const webhookUrl = process.env.MAKE_CONTACT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('MAKE_CONTACT_WEBHOOK_URL manquant dans les variables d\'environnement Vercel');
    return res.status(500).json({ error: 'Configuration serveur manquante.' });
  }

  try {
    const makeResp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prenom: String(prenom).slice(0, 200),
        nom: String(nom || '').slice(0, 200),
        email: String(email).slice(0, 200),
        structure: String(structure || '').slice(0, 200),
        interet: String(interet || '').slice(0, 200),
        message: String(message || '').slice(0, 3000),
        source: 'chicouf2.vercel.app',
        date: new Date().toISOString()
      })
    });

    if (!makeResp.ok) {
      throw new Error('Réponse invalide de Make (statut ' + makeResp.status + ')');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erreur envoi vers Make :', err);
    return res.status(502).json({ error: 'Envoi impossible pour le moment, merci de réessayer.' });
  }
}
