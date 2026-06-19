export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, context, mode } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const proInstructions = mode === 'pro'
    ? `,"angle_commercial":"accroche email en 1 phrase","offre_recommandee":"Package 1 ou 2 ou les deux"`
    : `,"prochaine_etape":"1 phrase qui oriente vers Package 1 (relation client) ou Package 2 (communication/prospection) selon le besoin detecte"`;

  const contextBlock = context ? ` Contexte: ${context}` : '';

  const prompt = `Analyse ce site: ${url}${contextBlock}
Tu representes CHIC OUF, une consultante qui propose 2 services :
- Package 1 "Relation client" : CRM no-code, automatisation des relances, formulaires, tableau de bord, onboarding client
- Package 2 "Communication & Prospection" : audit presence en ligne, calendrier editorial, automatisation diffusion, sequence prospection, landing page

Tes recommandations doivent naturellement orienter vers l'un ou l'autre de ces packages selon ce que tu observes sur le site.

Reponds en JSON strict, textes courts et bienveillants (max 80 caracteres par champ) :
{"score_global":<1-10>,"niveau":"Faible|Moyen|Bon|Tres bon","titre_diagnostic":"<titre encourageant>","resume":"<1 phrase bienveillante>","sections":[{"id":"design","icon":"🎨","titre":"Design","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"},{"id":"contenu","icon":"✍️","titre":"Contenu","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"},{"id":"seo","icon":"🔍","titre":"SEO","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"},{"id":"conversion","icon":"🎯","titre":"Conversion","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"},{"id":"mobile","icon":"📱","titre":"Mobile","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"}],"points_forts":["<pf1>","<pf2>"],"priorites":["<p1>","<p2>","<p3>"]${proInstructions}}`;

  const fallback = {
    score_global: 5, niveau: 'Analyse partielle',
    titre_diagnostic: 'Votre site a du potentiel',
    resume: 'Contactez-nous pour votre rapport complet.',
    sections: [
      {id:'design',icon:'🎨',titre:'Design',score:'A ameliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'},
      {id:'contenu',icon:'✍️',titre:'Contenu',score:'A ameliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'},
      {id:'seo',icon:'🔍',titre:'SEO',score:'A ameliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'},
      {id:'conversion',icon:'🎯',titre:'Conversion',score:'A ameliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'},
      {id:'mobile',icon:'📱',titre:'Mobile',score:'A ameliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'}
    ],
    points_forts: ['Votre site est en ligne et accessible'],
    priorites: ['Contactez CHIC OUF pour un audit approfondi','Reservez un echange gratuit de 30 min'],
    prochaine_etape: 'Reservez un echange gratuit pour recevoir votre rapport complet.'
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: 'Tu es un expert en presence en ligne pour TPE francaises. Reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(200).json({ ...fallback, debug_error: `API ${response.status}: ${JSON.stringify(data).substring(0,300)}` });
    }

    const raw = data.content.map(b => b.text || '').join('');

    let audit;
    try {
      audit = JSON.parse(raw);
    } catch(e) {
      try {
        audit = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch(e2) {
        return res.status(200).json({ ...fallback, debug_error: 'Parse: ' + e2.message + ' RAW:' + raw.substring(0,200) });
      }
    }

    return res.status(200).json(audit);

  } catch (err) {
    return res.status(200).json({ ...fallback, debug_error: 'Catch: ' + err.message });
  }
}
