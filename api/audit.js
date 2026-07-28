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
    const fetchStart = Date.now();
    const siteResp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHICOUF-Audit/1.0)' },
      redirect: 'follow',
      signal: controller.signal
    });
    const responseTimeMs = Date.now() - fetchStart;
    clearTimeout(timeout);

    // Détection anti-robot (Cloudflare, Sucuri, etc.) : soit via l'en-tête serveur,
    // soit via les phrases caractéristiques d'une page de challenge/vérification.
    const serverHeader = (siteResp.headers.get('server') || '').toLowerCase();
    const hasCfRay = !!siteResp.headers.get('cf-ray');

    if (!siteResp.ok) {
      fetchError = `Le site a répondu avec le statut ${siteResp.status}`;
    } else {
      let html = await siteResp.text();

      const botChallengePatterns = /checking your browser|cf-browser-verification|just a moment|verify you are human|attention required|ddos protection by|enable javascript and cookies to continue|are you a robot/i;
      const looksLikeBotChallenge = (hasCfRay || serverHeader.includes('cloudflare')) && botChallengePatterns.test(html);

      // On retire d'abord les blocs explicitement marqués comme des exemples de démo
      // (ex: sur www.chicouf.pro lui-même, les exemples de rapport affichés aux
      // visiteurs). Sans ça, ces exemples fictifs seraient lus comme du vrai contenu
      // du site et fausseraient l'analyse (ex: un exemple "Urgent" de démo ferait
      // baisser le score réel du site qui l'affiche).
      html = html.replace(/<!--\s*AUDIT_EXTRACT_IGNORE_START[\s\S]*?-->[\s\S]*?<!--\s*AUDIT_EXTRACT_IGNORE_END\s*-->/g, ' ');

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
      // Un formulaire de contact est très souvent embarqué via un service tiers
      // dans un <iframe> (Jotform, Typeform, module CMS...) : dans ce cas le HTML
      // brut de la page ne contient que la balise iframe, pas le vrai formulaire.
      // On le signale pour éviter d'affirmer à tort qu'aucun formulaire n'existe.
      const hasIframe = /<iframe[\s>]/i.test(html);

      // Beaucoup de sites vitrines répartissent l'info utile sur plusieurs pages
      // (Contact, Services/Prestations, À propos) plutôt que sur la seule page
      // d'accueil. Pour éviter des faux constats ("pas de formulaire", jugement
      // hâtif sur le contenu) et enrichir la vraie analyse, on va chercher un lien
      // évident vers chacune de ces pages et on les vérifie aussi, dans la limite
      // de 3 pages annexes max et 5s chacune, pour rester rapide.
      const pagesAnnexesConfig = [
        { label: 'Contact', motsCles: 'contact' },
        { label: 'Services/Prestations', motsCles: 'service|prestation' },
        { label: 'À propos', motsCles: 'apropos|a-propos|about|qui-sommes' }
      ];
      const pagesAnnexesVerifiees = [];
      let hasFormSurPageAnnexe = false;
      let texteSupplémentaire = '';

      for (const page of pagesAnnexesConfig) {
        const regex = new RegExp(`<a[^>]+href=["']([^"']*(?:${page.motsCles})[^"']*)["']`, 'i');
        const linkMatch = html.match(regex);
        if (!linkMatch) continue;
        try {
          const pageUrl = new URL(linkMatch[1], url).toString();
          if (pageUrl === url) continue; // évite de re-fetcher la même page que l'accueil
          const pageController = new AbortController();
          const pageTimeout = setTimeout(() => pageController.abort(), 5000);
          const pageResp = await fetch(pageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CHICOUF-Audit/1.0)' },
            redirect: 'follow',
            signal: pageController.signal
          });
          clearTimeout(pageTimeout);
          if (!pageResp.ok) continue;
          const pageHtml = await pageResp.text();
          const pageHasForm = /<form[\s>]/i.test(pageHtml)
            || /type=["']email["']/i.test(pageHtml)
            || /<textarea/i.test(pageHtml)
            || /type=["']submit["']/i.test(pageHtml);
          if (pageHasForm) hasFormSurPageAnnexe = true;

          const pageText = pageHtml
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          texteSupplémentaire += `\n\n[Page "${page.label}" — ${pageUrl}]\n${pageText.slice(0, 3000)}`;

          pagesAnnexesVerifiees.push({ label: page.label, url: pageUrl, aUnFormulaire: pageHasForm });
        } catch (e) {
          // Page annexe inaccessible : on continue simplement sans bloquer l'analyse principale
        }
      }
      const hasFormOnContactPage = hasFormSurPageAnnexe; // conservé pour compatibilité
      const contactPageChecked = pagesAnnexesVerifiees.find(p => p.label === 'Contact')?.url || null;

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
      // Limite portée à 15000 caractères (au lieu de 6000) : le texte visible
      // d'une page comme celle de CHIC OUF dépasse largement 6000 caractères,
      // ce qui coupait avant la section contact et perdait des informations
      // réelles (ex: mots-clés locaux) sans que le modèle ne le sache.
      // On ajoute aussi le texte des pages annexes (Contact/Services/À propos)
      // trouvées ci-dessus, pour une analyse plus complète que la seule page d'accueil.
      text = (text + texteSupplémentaire).slice(0, 15000);

      siteExtract = {
        titre: titleMatch ? titleMatch[1].trim() : '',
        description: descMatch ? descMatch[1].trim() : '',
        aUnViewportMobile: viewportMatch,
        aUnFormulaire: hasForm,
        aUnFormulaireSurPageContact: hasFormOnContactPage,
        pageContactVerifiee: contactPageChecked,
        pagesAnnexesVerifiees,
        aUnIframe: hasIframe,
        aUnLienMailtoOuTel: hasMailto || hasTel,
        aUnTitreH1: hasH1,
        schemaJsonLdTypes: ldJsonTypes,
        tempsReponseMs: responseTimeMs,
        ressembleABlocageAntiRobot: looksLikeBotChallenge,
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
- Un moyen de contact (formulaire, champ email/message, ou lien mailto/tel) est présent sur la page d'accueil : ${siteExtract.aUnFormulaire ? 'oui' : 'non'}
${siteExtract.pagesAnnexesVerifiees && siteExtract.pagesAnnexesVerifiees.length ? `- Pages annexes également vérifiées automatiquement : ${siteExtract.pagesAnnexesVerifiees.map(p => `${p.label} (${p.url}) — formulaire ${p.aUnFormulaire ? 'présent' : 'non détecté'}`).join(' ; ')}. IMPORTANT : le texte de ces pages est inclus dans l'extrait ci-dessous, utilise-le pour ton analyse. Si un formulaire est présent sur une page annexe (ex: Contact) mais pas sur l'accueil, ne dis JAMAIS qu'il n'y a "aucun formulaire de contact sur le site" — précise plutôt qu'il se trouve sur cette page dédiée, ce qui est une pratique courante et non problématique.` : ''}
- Un iframe est présent sur la page : ${siteExtract.aUnIframe ? 'oui' : 'non'}${siteExtract.aUnIframe && !siteExtract.aUnFormulaire ? " — ATTENTION : un iframe est présent mais aucun formulaire n'est détecté dans le HTML brut. Un iframe peut charger un formulaire de contact hébergé par un service tiers (Jotform, Typeform, module CMS...), invisible dans ce HTML. NE PAS affirmer categoriquement l'absence de formulaire de contact dans ce cas : indique plutôt que ce point n'a pas pu être vérifié automatiquement, avec un score neutre ('Bon' ou 'A ameliorer') plutôt que d'affirmer un manque comme certain." : ''}
- Lien mailto ou tel détecté : ${siteExtract.aUnLienMailtoOuTel ? 'oui' : 'non'}
- Titre H1 présent : ${siteExtract.aUnTitreH1 ? 'oui' : 'non'}
- Schéma structuré JSON-LD déjà présent sur la page : ${siteExtract.schemaJsonLdTypes.length ? `oui (types : ${siteExtract.schemaJsonLdTypes.join(', ')})` : 'non'}
- Temps de réponse mesuré du serveur (pas le chargement complet avec images/CSS, juste la réponse HTML) : ${siteExtract.tempsReponseMs} ms
${siteExtract.ressembleABlocageAntiRobot ? "- ATTENTION CRITIQUE : cette page ressemble à une page de vérification anti-robot (Cloudflare ou similaire), pas au vrai contenu du site. Ne fais AUCUNE analyse de design/contenu/SEO/conversion basée sur ce texte : indique dans le resume que l'analyse automatique n'a pas pu accéder au vrai contenu du site (protection anti-robot détectée), mets un score global neutre (5/10) et un score 'A ameliorer' neutre partout, sans inventer de detail." : ''}
${siteExtract.probablementSiteDynamiqueJS ? "- ATTENTION : très peu de texte a pu être extrait du HTML brut. Ce site est probablement une application JavaScript (le contenu réel s'affiche après chargement par le navigateur, invisible dans le HTML brut). Dans ce cas, NE JAMAIS affirmer qu'un élément est absent (formulaire, CTA, contenu...) : indique explicitement dans les analyses concernées que ce point n'a pas pu être vérifié automatiquement, avec un score 'À améliorer' neutre plutôt que 'Urgent'." : ''}

Extrait du texte visible de la page (tronqué) :
"""
${siteExtract.extraitTexte || '(aucun texte extrait)'}
"""

RÈGLE IMPÉRATIVE : base ton analyse UNIQUEMENT sur ce contenu réel ci-dessus. N'invente jamais un constat (ex: "pas de formulaire visible") qui contredit les signaux détectés automatiquement (ex: "Formulaire HTML détecté : oui"). Si une information n'est pas vérifiable dans ce contenu, dis-le prudemment plutôt que d'affirmer un manque. En particulier, si "Schéma structuré JSON-LD déjà présent" indique "oui", ne recommande JAMAIS d'ajouter un schéma structuré ou un type qui figure déjà dans la liste des types détectés (par exemple ne pas recommander d'ajouter "LocalBusiness" si "ProfessionalService" est déjà présent, car ProfessionalService EST un sous-type de LocalBusiness ; ne pas recommander "FAQPage" s'il est déjà dans la liste). Pour la section Mobile ou toute mention de vitesse/performance, utilise le vrai "Temps de réponse mesuré du serveur" fourni ci-dessus (cite le chiffre en ms) plutôt que de suggérer vaguement de "tester la vitesse de chargement" — tu as déjà la donnée réelle, sers-t'en.`
    : `

ATTENTION : le contenu du site n'a pas pu être récupéré automatiquement (${fetchError || 'raison inconnue'}). N'invente aucun constat détaillé sur le design, le contenu ou la conversion : dans le champ "analyse" de chaque section, indique que ce point n'a pas pu être vérifié automatiquement, et mets un score "À améliorer" neutre partout plutôt que "Urgent". Le "resume" doit mentionner que l'analyse automatique n'a pas pu accéder au site.`;

  const prompt = `Analyse ce site: ${url}${contextBlock}
Tu representes CHIC OUF, une consultante qui propose 2 services pour TPE, artisans ET associations :
- Package 1 "Relation client/adherents" : CRM no-code, automatisation des relances, formulaires, tableau de bord, onboarding
- Package 2 "Communication & Visibilite" : audit presence en ligne, calendrier editorial, automatisation diffusion, sequence de contact, landing page

IMPORTANT - Adapte ton vocabulaire au type de structure que tu detectes :
- Si c'est une ASSOCIATION (mots-cles: association, adherents, benevoles, lien social, gratuit, don, cotisation) : utilise "adherents", "benevoles", "participants", "activites", JAMAIS "clients", "leads", "offres commerciales", "conversion de prospects". Le Package 1 sert a suivre adherents/benevoles, le Package 2 sert a communiquer sur les evenements et activites.
- Si c'est une ENTREPRISE/TPE/artisan : tu peux utiliser "clients", "prospects", "conversion" normalement.

INTERDICTION ABSOLUE : ne mentionne JAMAIS "Package 1", "Package 2", ni aucun nom d'offre commerciale dans les champs "analyse", "reco", "points_forts" ou "priorites". Ces deux packages sont uniquement un contexte interne pour toi, jamais a citer nommement dans le rapport. Chaque "reco" doit rester une recommandation d'action generale et actionnable (ex: "centralisez vos demandes pour ne rien oublier"), jamais un pitch commercial vers une offre nommee.
${siteContentBlock}

Reponds en JSON strict, textes courts et bienveillants (max 80 caracteres par champ) :
{"score_global":<1-10>,"niveau":"Faible|Moyen|Bon|Très bon","titre_diagnostic":"<titre encourageant>","resume":"<1 phrase bienveillante>","sections":[{"id":"design","icon":"🎨","titre":"Design","score":"Très bon|Bon|À améliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce, ou si score Très bon: encouragement a maintenir, sans forcer une critique artificielle>"},{"id":"contenu","icon":"✍️","titre":"Contenu","score":"Très bon|Bon|À améliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce, ou si score Très bon: encouragement a maintenir, sans forcer une critique artificielle>"},{"id":"seo","icon":"🔍","titre":"SEO","score":"Très bon|Bon|À améliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce, ou si score Très bon: encouragement a maintenir, sans forcer une critique artificielle>"},{"id":"conversion","icon":"🎯","titre":"Conversion","score":"Très bon|Bon|À améliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce, ou si score Très bon: encouragement a maintenir, sans forcer une critique artificielle>"},{"id":"mobile","icon":"📱","titre":"Mobile","score":"Très bon|Bon|À améliorer|Urgent","analyse":"<1 phrase valorisante>","reco":"<1 invitation douce, ou si score Très bon: encouragement a maintenir, sans forcer une critique artificielle>"}],"points_forts":["<pf1>","<pf2>"],"priorites":[{"action":"<p1, courte, actionnable>","objectif":"<benefice concret en 1 phrase courte, jamais une explication technique>"},{"action":"<p2>","objectif":"<o2>"},{"action":"<p3>","objectif":"<o3>"}],"type_structure":"association|entreprise","constat_maturite_ia":"<phrase courte, max 140 caracteres>"${proInstructions}}

IMPORTANT sur la notation : "Très bon" est un score legitime et pleinement valide pour une section, a utiliser des que ce critere est reellement solide et sans point faible reel detectable dans le contenu fourni. N'evite pas ce score par reflexe pour "avoir quelque chose a dire" : il n'est pas obligatoire de trouver une critique constructive artificielle quand tout va bien. Une section peut etre "Très bon" avec un simple encouragement a maintenir en reco, sans qu'il y ait besoin d'inventer un axe d'amelioration mineur.

IMPORTANT sur le score_global : n'evalue plus ce score en pensant "combien de Tres bon vs combien de Bon", mais en comptant le nombre de criteres FAIBLES (score "Urgent" ou "A ameliorer") parmi les 5 sections, puis applique cette grille stricte :
- 0 critere faible, les 5 sections sont "Tres bon" : score_global = 10
- 0 critere faible, mais au moins une section est "Bon" (le reste Tres bon/Bon) : score_global = 9
- Exactement 1 section "A ameliorer", le reste Tres bon/Bon : score_global = 8
- Exactement 1 section "Urgent", le reste Tres bon/Bon : score_global = 6 a 7
- Exactement 2 sections "A ameliorer" (aucune Urgent) : score_global = 6 a 7
- 2 sections faibles dont au moins 1 "Urgent" : score_global = 4 a 5
- 3 sections faibles ou plus (Urgent et/ou A ameliorer) : score_global = 2 a 4
Respecte cette grille strictement, sans plafond artificiel par prudence et sans y deroger par reflexe de moderation.

IMPORTANT sur "priorites" (action + objectif) : pour chaque priorite, le champ "action" reste la recommandation courte et actionnable comme avant (ex: "Ajoutez un schema structure JSON-LD"). Le nouveau champ "objectif" doit exprimer le BENEFICE CONCRET pour le prospect, jamais une explication technique de comment faire. Formule-le comme un resultat attendu, pas comme une methode. Exemples corrects (a suivre comme modele de ton et de longueur, une seule phrase courte) :
- Action: "Ajouter les donnees structurees JSON-LD" -> Objectif: "Aider Google a mieux comprendre l'activite et la zone geographique de l'entreprise."
- Action: "Verifier le suivi des demandes de devis" -> Objectif: "Eviter qu'un prospect interesse soit oublie faute de relance."
- Action: "Actualiser la galerie de realisations" -> Objectif: "Rassurer les visiteurs et leur donner davantage envie de demander un devis."
INTERDICTION : ne reformule jamais l'action elle-meme dans "objectif" (pas de redite), et n'invente aucun chiffre ou statistique precis sur cette structure.

IMPORTANT sur le champ "constat_maturite_ia" : cette phrase introduit un constat generique (le manque frequent de suivi structure des demandes clients/adherents chez les TPE et associations), contextualise UNIQUEMENT par le secteur d'activite ou le type de structure (association/entreprise) que tu as deja identifie. Tu peux nommer le secteur ou le type d'activite (ex: "pour une agence immobiliere", "pour une association culturelle"). INTERDICTION ABSOLUE d'affirmer ou de laisser entendre un fait precis sur le fonctionnement REEL de cette structure que tu ne peux pas verifier a partir du contenu du site (ex: ne dis jamais "vous perdez X% de vos prospects", "vos demandes ne sont pas suivies", "votre delai de reponse est trop long") car tu n'as aucune donnee sur leur gestion interne reelle. Reste sur une observation generale et prudente, formulee comme un constat de secteur, jamais comme une affirmation sur cette structure precise. Exemple correct : "Pour une agence immobiliere, chaque demande de visite non suivie peut representer une vente perdue." Exemple INTERDIT : "Vos demandes de visite ne sont pas suivies actuellement."`;

  const fallback = {
    score_global: 5, niveau: 'Analyse partielle',
    titre_diagnostic: 'Votre site a du potentiel',
    resume: 'Contactez-nous pour votre rapport complet.',
    sections: [
      {id:'design',icon:'🎨',titre:'Design',score:'À améliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'},
      {id:'contenu',icon:'✍️',titre:'Contenu',score:'À améliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'},
      {id:'seo',icon:'🔍',titre:'SEO',score:'À améliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'},
      {id:'conversion',icon:'🎯',titre:'Conversion',score:'À améliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'},
      {id:'mobile',icon:'📱',titre:'Mobile',score:'À améliorer',analyse:'Retour disponible sur demande.',reco:'Echangeons 30 min.'}
    ],
    points_forts: ['Votre site est en ligne et accessible'],
    priorites: [
      {action:'Contactez CHIC OUF pour un audit approfondi', objectif:'Obtenir un diagnostic complet et personnalise de votre site.'},
      {action:'Reservez un echange gratuit de 30 min', objectif:'Identifier ensemble vos priorites concretes.'}
    ],
    constat_maturite_ia: 'Au-dela du site, la plupart des TPE et associations manquent d\'un suivi structure de leurs demandes.'
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
        if (s.score === 'Très bon') return -1;
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
        if (s.score === 'À améliorer') return 1;
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
