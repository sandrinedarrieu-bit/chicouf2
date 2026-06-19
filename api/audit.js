export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, context, mode } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const proInstructions = mode === 'pro' ? `,"angle_commercial":"accroche email en 1 phrase"` : '';

  const contextBlock = context ? ` Contexte: ${context}` : '';

  const prompt = `Analyse ce site: ${url}${contextBlock}
Tu representes CHIC OUF, une consultante qui propose 2 services pour TPE, artisans ET associations :
- Package 1 "Relation client/adherents" : CRM no-code, automatisation des relances, formulaires, tableau de bord, onboarding
- Package 2 "Communication & Visibilite" : audit presence en ligne, calendrier editorial, automatisation diffusion, sequence de contact, landing page

IMPORTANT - Adapte ton vocabulaire au type de structure que tu detectes :
- Si c'est une ASSOCIATION (mots-cles: association, adherents, benevoles, lien social, gratuit, don, cotisation) : utilise "adherents", "benevoles", "participants", "activites", JAMAIS "clients", "leads", "offres commerciales", "conversion de prospects". Le Package 1 sert a suivre adherents/benevoles, le Package 2 sert a communiquer sur les evenements et activites.
- Si c'est une ENTREPRISE/TPE/artisan : tu peux utiliser "clients", "prospects", "conversion" normalement.

Reponds en JSON strict, textes courts et bienveillants (max 80 caracteres par champ) :
{"score_global":<1-10>,"niveau":"Faible|Moyen|Bon|Tres bon","titre_diagnostic":"<titre encourageant>","resume":"<1 phrase bienveillante>","sections":[{"id":"design","icon":"🎨","titre":"Design","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"},{"id":"contenu","icon":"✍️","titre":"Contenu","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"},{"id":"seo","icon":"🔍","titre":"SEO","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"},{"id":"conversion","icon":"🎯","titre":"Conversion","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"},{"id":"mobile","icon":"📱","titre":"Mobile","score":"Bon|A ameliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce>"}],"points_forts":["<pf1>","<pf2>"],"priorites":["<p1>","<p2>","<p3>"],"type_structure":"association|entreprise"${proInstructions}}`;

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
    priorites: ['Contactez CHIC OUF pour un audit approfondi','Reservez un echange gratuit de 30 min']
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
        max_tokens: 1500,
        system: 'Tu es un expert en presence en ligne pour TPE francaises. Reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(buffer);

    if (!response.ok) {
      return res.status(200).json({ ...fallback, debug_error: `API ${response.status}: ${text.substring(0,300)}` });
    }

    const data = JSON.parse(text);
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

    // Calcul automatique du package recommande a partir des scores (fiable, pas demande a Claude)
    if (mode !== 'pro') {
      const sections = audit.sections || [];
      const getSection = (id) => sections.find(x => x.id === id);
      const getScore = (id) => {
        const s = getSection(id);
        if (!s) return 1;
        if (s.score === 'Bon') return 0;
        if (s.score === 'Urgent') return 2;
        return 1;
      };
      const scoreP2 = getScore('design') + getScore('seo') + getScore('contenu') + getScore('mobile');
      const scoreP1 = getScore('conversion') * 4;

      if (scoreP1 >= scoreP2) {
        // Package 1 — reprendre le point faible reel de la section conversion
        const conv = getSection('conversion');
        const detail = conv ? conv.analyse.toLowerCase() : 'le suivi de vos contacts';
        if (audit.type_structure === 'association') {
          audit.prochaine_etape = `Le Package 1 vous aiderait a mieux suivre vos adherents et benevoles : ${detail} Vous ne perdriez plus le contact avec vos participants.`;
        } else {
          audit.prochaine_etape = `Le Package 1 Relation Client repondrait directement a ce constat : ${detail} Vous ne perdriez plus aucun prospect.`;
        }
      } else {
        // Package 2 — identifier la section la plus faible parmi design/seo/contenu/mobile
        const candidats = ['seo','design','contenu','mobile'].map(id => ({ id, s: getSection(id), score: getScore(id) }));
        candidats.sort((a,b) => b.score - a.score);
        const top = candidats[0];
        const labels = { seo: 'votre referencement', design: 'votre design', contenu: 'votre contenu', mobile: 'votre experience mobile' };
        const detail = top.s ? top.s.analyse.toLowerCase() : '';
        if (audit.type_structure === 'association') {
          audit.prochaine_etape = `Le Package 2 ciblerait en priorite ${labels[top.id]} : ${detail} Vous gagneriez en visibilite aupres de nouveaux benevoles et participants.`;
        } else {
          audit.prochaine_etape = `Le Package 2 Communication ciblerait en priorite ${labels[top.id]} : ${detail} Vous gagneriez en visibilite rapidement.`;
        }
      }
    }

    return res.status(200).json({ ...audit, _version: 'v3-calcul-auto' });

  } catch (err) {
    return res.status(200).json({ ...fallback, debug_error: 'Catch: ' + err.message });
  }
}
