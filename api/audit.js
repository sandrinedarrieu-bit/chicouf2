export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'URL manquante' });

  const { url, context, mode } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const contextBlock = context ? ` Contexte: ${context}` : '';
  const proField = mode === 'pro' ? `"angle_commercial":"<10 mots>","offre_recommandee":"P1|P2|P1+P2"` : `"prochaine_etape":"P1|P2"`;

  const prompt = `Analyse ${url}${contextBlock}. Réponds UNIQUEMENT avec ce JSON, valeurs max 40 caractères, SANS apostrophes ni guillemets dans les textes:
{"score_global":7,"niveau":"Bon","titre_diagnostic":"Titre","resume":"Resume","sections":[{"id":"design","icon":"🎨","titre":"Design","score":"Bon","analyse":"Analyse","reco":"Reco"},{"id":"contenu","icon":"✍️","titre":"Contenu","score":"Bon","analyse":"Analyse","reco":"Reco"},{"id":"seo","icon":"🔍","titre":"SEO","score":"Bon","analyse":"Analyse","reco":"Reco"},{"id":"conversion","icon":"🎯","titre":"Conversion","score":"Bon","analyse":"Analyse","reco":"Reco"},{"id":"mobile","icon":"📱","titre":"Mobile","score":"Bon","analyse":"Analyse","reco":"Reco"}],"points_forts":["Point1","Point2"],"priorites":["Action1","Action2","Action3"],${proField}}
Remplace toutes les valeurs par ton analyse réelle. Score entre 1-10. score des sections: Bon|Moyen|Faible. N'utilise jamais d'apostrophe (remplace "qu'il" par "que cela", etc).`;

  const fallback = {
    score_global: 5, niveau: 'Analyse partielle',
    titre_diagnostic: 'Votre site a du potentiel',
    resume: 'Contactez-nous pour votre rapport complet.',
    sections: [
      {id:'design',icon:'🎨',titre:'Design',score:'Moyen',analyse:'Retour disponible.',reco:'Échangeons 30 min.'},
      {id:'contenu',icon:'✍️',titre:'Contenu',score:'Moyen',analyse:'Retour disponible.',reco:'Échangeons 30 min.'},
      {id:'seo',icon:'🔍',titre:'SEO',score:'Moyen',analyse:'Retour disponible.',reco:'Échangeons 30 min.'},
      {id:'conversion',icon:'🎯',titre:'Conversion',score:'Moyen',analyse:'Retour disponible.',reco:'Échangeons 30 min.'},
      {id:'mobile',icon:'📱',titre:'Mobile',score:'Moyen',analyse:'Retour disponible.',reco:'Échangeons 30 min.'}
    ],
    points_forts: ['Site en ligne', 'Présence établie'],
    priorites: ['Contactez CHIC OUF', 'Réservez 30 min gratuites', 'Recevez votre rapport'],
    prochaine_etape: 'P2'
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: 'Réponds uniquement en JSON valide, sans markdown, sans texte autour.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(buffer);

    if (!response.ok) {
      // Erreur API Anthropic — on l'expose pour debug
      return res.status(200).json({ ...fallback, debug_error: `API status ${response.status}: ${text.substring(0,300)}` });
    }

    const data = JSON.parse(text);
    const raw = (data.content || []).map(b => b.text || '').join('').trim();

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return res.status(200).json({ ...fallback, debug_error: 'Pas de JSON dans la réponse: ' + raw.substring(0,200) });

    try {
      let jsonStr = raw.substring(start, end + 1);
      // Nettoyer les caractères de contrôle qui cassent le JSON
      jsonStr = jsonStr.replace(/[\u0000-\u001F]+/g, ' ');
      const audit = JSON.parse(jsonStr);
      return res.status(200).json(audit);
    } catch(e) {
      return res.status(200).json({ ...fallback, debug_error: 'Parse error: ' + e.message });
    }

  } catch(err) {
    return res.status(200).json({ ...fallback, debug_error: 'Catch error: ' + err.message });
  }
}
