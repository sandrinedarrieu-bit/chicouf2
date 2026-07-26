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

  // Catalogue des Solutions IA proposées sur le site, avec leur tarif affiché,
  // pour recommander la solution la plus pertinente selon le point faible détecté.
  const SOLUTIONS_IA = {
    design:     { nom: 'Création de site internet', prix: 'à partir de 590 €', pitch: "un site professionnel, rapide à déployer et pensé pour convertir." },
    seo:        { nom: 'Création de site internet', prix: 'à partir de 590 €', pitch: "un site conçu pour être visible sur les moteurs de recherche." },
    mobile:     { nom: 'Création de site internet', prix: 'à partir de 590 €', pitch: "un site optimisé pour l'expérience mobile de vos visiteurs." },
    contenu:    { nom: 'Création de contenu IA',    prix: 'à partir de 250 €', pitch: "rédaction et publication automatisées, sans y consacrer vos journées." },
    conversion: { nom: 'Création de site internet', prix: 'à partir de 590 €', pitch: "un site restructuré autour de CTAs clairs et d'un parcours de conversion optimisé." }
  };

  // ── Récupération réelle du contenu du site ─────────────────────────────
  // Sans ça, le modèle analysait uniquement la chaîne de caractères de l'URL
  // et inventait une analyse plausible mais non fondée (ex: "pas de formulaire
  // de contact visible" sur un site qui en a un). On va chercher le vrai HTML,
  // et on en extrait des signaux fiables (calculés en code, pas par le modèle)
  // en plus d'un texte lisible pour l'analyse qualitative.
  let siteExtract = null;
  let fetchError = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const siteResp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHICOUF-Audit/1.0)' },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!siteResp.ok) {
      fetchError = `Le site a répondu avec le statut ${siteResp.status}`;
    } else {
      const html = await siteResp.text();

      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
      const viewportMatch = /<meta[^>]+name=["']viewport["']/i.test(html);

      // Signaux détectés en code (fiables), pas laissés à l'appréciation du modèle.
      // On élargit volontairement la détection de "formulaire" au-delà de la balise
      // <form> native, car beaucoup de sites (dont celui de CHIC OUF) gèrent l'envoi
      // en JavaScript (onclick) sans jamais utiliser de vraie balise <form>.
      const hasForm = /<form[\s>]/i.test(html)
        || /type=["']email["']/i.test(html)
        || /<textarea/i.test(html)
        || /type=["']submit["']/i.test(html);
      const hasMailto = /mailto:/i.test(html);
      const hasTel = /href=["']tel:/i.test(html);
      const hasH1 = /<h1[\s>]/i.test(html);

      // Schéma structuré (JSON-LD) : on l'extrait et on le signale explicitement
      // AVANT de le retirer du texte lisible plus bas. Sans ça, le modèle ne peut
      // jamais savoir qu'un schéma existe déjà (il est invisible dans le texte
      // visible), et recommande à tort d'en ajouter un qui est déjà en place.
      const ldJsonBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
        .map(m => m[1]);
      const ldJsonTypes = [];
      for (const block of ldJsonBlocks) {
        try {
          const parsed = JSON.parse(block);
          const t = parsed['@type'];
          if (Array.isArray(t)) ldJsonTypes.push(...t);
          else if (t) ldJsonTypes.push(t);
        } catch (e) { /* bloc JSON-LD malformé, on l'ignore silencieusement */ }
      }

      // Texte lisible : on retire scripts/styles/balises, on compresse les espaces
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const textLength = text.length;
      text = text.slice(0, 6000);

      siteExtract = {
        titre: titleMatch ? titleMatch[1].trim() : '',
        description: descMatch ? descMatch[1].trim() : '',
        aUnViewportMobile: viewportMatch,
        aUnFormulaire: hasForm,
        aUnLienMailtoOuTel: hasMailto || hasTel,
        aUnTitreH1: hasH1,
        schemaJsonLdTypes: ldJsonTypes,
        longueurTexteVisible: textLength,
        // Si le texte extrait est très court, le site est probablement une
        // application JS (React/Vue) dont le contenu réel n'est pas dans le
        // HTML brut : on le signale plutôt que de laisser le modèle deviner.
        probablementSiteDynamiqueJS: textLength < 200,
        extraitTexte: text
      };
    }
  } catch (err) {
    fetchError = err.name === 'AbortError' ? 'Le site a mis trop de temps à répondre' : err.message;
  }

  const siteContentBlock = siteExtract
    ? `

CONTENU RÉEL DU SITE (récupéré automatiquement, à utiliser comme SEULE source de vérité) :
- Titre de la page : ${siteExtract.titre || '(non trouvé)'}
- Meta description : ${siteExtract.description || '(non trouvée)'}
- Balise viewport mobile présente : ${siteExtract.aUnViewportMobile ? 'oui' : 'non'}
- Un moyen de contact (formulaire, champ email/message, ou lien mailto/tel) est présent : ${siteExtract.aUnFormulaire ? 'oui' : 'non'}
- Lien mailto ou tel détecté : ${siteExtract.aUnLienMailtoOuTel ? 'oui' : 'non'}
- Titre H1 présent : ${siteExtract.aUnTitreH1 ? 'oui' : 'non'}
- Schéma structuré JSON-LD déjà présent sur la page : ${siteExtract.schemaJsonLdTypes.length ? `oui (types : ${siteExtract.schemaJsonLdTypes.join(', ')})` : 'non'}
${siteExtract.probablementSiteDynamiqueJS ? "- ATTENTION : très peu de texte a pu être extrait du HTML brut. Ce site est probablement une application JavaScript (le contenu réel s'affiche après chargement par le navigateur, invisible dans le HTML brut). Dans ce cas, NE JAMAIS affirmer qu'un élément est absent (formulaire, CTA, contenu...) : indique explicitement dans les analyses concernées que ce point n'a pas pu être vérifié automatiquement, avec un score 'A ameliorer' neutre plutôt que 'Urgent'." : ''}

Extrait du texte visible de la page (tronqué) :
"""
${siteExtract.extraitTexte || '(aucun texte extrait)'}
"""

RÈGLE IMPÉRATIVE : base ton analyse UNIQUEMENT sur ce contenu réel ci-dessus. N'invente jamais un constat (ex: "pas de formulaire visible") qui contredit les signaux détectés automatiquement (ex: "Formulaire HTML détecté : oui"). Si une information n'est pas vérifiable dans ce contenu, dis-le prudemment plutôt que d'affirmer un manque. En particulier, si "Schéma structuré JSON-LD déjà présent" indique "oui", ne recommande JAMAIS d'ajouter un schéma structuré ou un type qui figure déjà dans la liste des types détectés (par exemple ne pas recommander d'ajouter "LocalBusiness" si "ProfessionalService" est déjà présent, car ProfessionalService EST un sous-type de LocalBusiness ; ne pas recommander "FAQPage" s'il est déjà dans la liste).`
    : `

ATTENTION : le contenu du site n'a pas pu être récupéré automatiquement (${fetchError || 'raison inconnue'}). N'invente aucun constat détaillé sur le design, le contenu ou la conversion : dans le champ "analyse" de chaque section, indique que ce point n'a pas pu être vérifié automatiquement, et mets un score "A ameliorer" neutre partout plutôt que "Urgent". Le "resume" doit mentionner que l'analyse automatique n'a pas pu accéder au site.`;

  const prompt = `Analyse ce site: ${url}${contextBlock}
Tu representes CHIC OUF, une consultante qui propose 2 services pour TPE, artisans ET associations :
- Package 1 "Relation client/adherents" : CRM no-code, automatisation des relances, formulaires, tableau de bord, onboarding
- Package 2 "Communication & Visibilite" : audit presence en ligne, calendrier editorial, automatisation diffusion, sequence de contact, landing page

IMPORTANT - Adapte ton vocabulaire au type de structure que tu detectes :
- Si c'est une ASSOCIATION (mots-cles: association, adherents, benevoles, lien social, gratuit, don, cotisation) : utilise "adherents", "benevoles", "participants", "activites", JAMAIS "clients", "leads", "offres commerciales", "conversion de prospects". Le Package 1 sert a suivre adherents/benevoles, le Package 2 sert a communiquer sur les evenements et activites.
- Si c'est une ENTREPRISE/TPE/artisan : tu peux utiliser "clients", "prospects", "conversion" normalement.
${siteContentBlock}

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
        // temperature à 0 : pour un même contenu de site (inchangé entre deux tests),
        // on veut un résultat stable plutôt qu'un score qui varie aléatoirement
        // d'un passage à l'autre sur les catégories limites (ex: Bon vs Très bon).
        temperature: 0,
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
    // Cet audit ne mesure que le site (design/seo/contenu/conversion/mobile) : il n'evalue rien
    // qui releve du CRM/suivi client, donc il recommande toujours le Package 2 (Communication &
    // Visibilite), coherent avec ce qu'il mesure reellement.
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
      const candidats = ['seo','design','contenu','mobile','conversion'].map(id => ({ id, s: getSection(id), score: getScore(id) }));
      candidats.sort((a, b) => b.score - a.score);
      const top = candidats[0];
      const labels = { seo: 'votre referencement', design: 'votre design', contenu: 'votre contenu', mobile: 'votre experience mobile', conversion: 'vos parcours de conversion' };
      const detail = top.s ? top.s.analyse.toLowerCase() : '';
      if (audit.type_structure === 'association') {
        audit.prochaine_etape = `Le Package 2 ciblerait en priorite ${labels[top.id]} : ${detail} Vous gagneriez en visibilite aupres de nouveaux benevoles et participants.`;
      } else {
        audit.prochaine_etape = `Le Package 2 Communication ciblerait en priorite ${labels[top.id]} : ${detail} Vous gagneriez en visibilite rapidement.`;
      }
    }

    // Recommandation d'une Solution IA precise (avec tarif), en complement du package ci-dessus.
    // Base sur le point le plus faible, tous criteres confondus (design/seo/contenu/mobile/conversion).
    if (mode !== 'pro') {
      const sections = audit.sections || [];
      const getSection = (id) => sections.find(x => x.id === id);
      const weaknessScore = (id) => {
        const s = getSection(id);
        if (!s) return 0;
        if (s.score === 'Urgent') return 2;
        if (s.score === 'A ameliorer') return 1;
        return 0;
      };
      const candidats = Object.keys(SOLUTIONS_IA).map(id => ({ id, score: weaknessScore(id), s: getSection(id) }));
      candidats.sort((a, b) => b.score - a.score);
      const top = candidats[0];

      if (top && top.score > 0) {
        const sol = SOLUTIONS_IA[top.id];
        const detail = top.s ? top.s.analyse : '';
        audit.solution_ia_recommandee = {
          titre: sol.nom,
          prix: sol.prix,
          description: detail ? `${sol.pitch} (${detail})` : sol.pitch
        };
      }
    }

    return res.status(200).json({ ...audit, _version: 'v4-solution-ia' });

  } catch (err) {
    return res.status(200).json({ ...fallback, debug_error: 'Catch: ' + err.message });
  }
}
