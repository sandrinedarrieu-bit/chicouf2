export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, prenom, url, audit } = req.body || {};
    console.log('send-report called:', { email, prenom, url, hasAudit: !!audit });

    if (!email || !audit) return res.status(400).json({ error: 'Données manquantes' });

    const scoreEmoji = audit.score_global >= 7 ? '🟢' : audit.score_global >= 5 ? '🟡' : '🔴';
    // Mise en forme du prénom saisi (ex: "sandrine" -> "Sandrine", "jean-pierre" -> "Jean-Pierre"),
    // au cas où le visiteur l'ait tapé tout en minuscules.
    const formatPrenom = (str) => {
      if (!str) return str;
      return str
        .toLowerCase()
        .split(/([\s-])/)
        .map(part => /^[\s-]$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
    };
    const prenom_display = prenom ? formatPrenom(prenom) : 'Bonjour';

    const etape = audit.prochaine_etape || audit.offre_recommandee || '';
    let packageReco = 'À définir';
    const etapeLower = etape.toLowerCase();
    if (etapeLower.includes('p1') || etapeLower.includes('package 1') || etapeLower.includes('relation client')) {
      packageReco = 'Package 1 · Relation client';
    } else if (etapeLower.includes('p2') || etapeLower.includes('package 2') || etapeLower.includes('communication') || etapeLower.includes('prospection')) {
      packageReco = 'Package 2 · Communication';
    } else if (etapeLower.includes('p1+p2') || etapeLower.includes('les deux')) {
      packageReco = 'Package 1 + Package 2';
    }

    // Solution IA precise recommandee par audit.js (avec tarif), independante du package ci-dessus
    const solIa = audit.solution_ia_recommandee;
    const solutionIaHtml = solIa ? `<div style="margin:0 32px 8px;background:#FFF8EC;border:1px dashed #F5C77A;border-radius:10px;padding:14px 18px;">
      <table style="width:100%;"><tr>
        <td style="vertical-align:top;">
          <p style="margin:0;font-size:13px;color:#7A5200;font-weight:700;">🔧 Solution suggérée : ${solIa.titre}</p>
          <p style="margin:4px 0 0;font-size:13px;color:#555;">${solIa.description}</p>
        </td>
        <td style="vertical-align:top;text-align:right;white-space:nowrap;padding-left:12px;">
          <span style="display:inline-block;background:#F59E0B;color:#2C2C3E;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;">${solIa.prix}</span>
        </td>
      </tr></table>
    </div>` : '';

    // ── 1. AIRTABLE ──────────────────────────────────
    console.log('Airtable config:', {
      hasBaseId: !!process.env.AIRTABLE_BASE_ID,
      hasApiKey: !!process.env.AIRTABLE_API_KEY,
      baseId: process.env.AIRTABLE_BASE_ID
    });

    if (process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_API_KEY) {
      try {
        // Détail par critère (Design/Contenu/SEO/Conversion/Mobile), pour alimenter
        // l'analyse du corpus Airtable — jusqu'ici seules les 3 priorités globales
        // étaient stockées, sans le détail par critère individuel.
        const sectionDetail = (id) => {
          const s = (audit.sections || []).find(x => x.id === id);
          if (!s) return '';
          return `Score: ${s.score || ''} | Analyse: ${s.analyse || ''} | Reco: ${s.reco || ''}`;
        };
        const formatPrioriteAirtable = (p) => {
          if (!p) return '';
          if (typeof p === 'string') return p;
          return p.objectif ? `${p.action} — Objectif : ${p.objectif}` : (p.action || '');
        };
        const atResp = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/tblYndbnnzwU33sdZ`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`
          },
          body: JSON.stringify({
            records: [{
              fields: {
                'fld7tEbc6J5HMDmhh': prenom_display !== 'Bonjour' ? prenom_display : '',
                'fldgmi96dhLgaN5h1': email,
                'fldHDiQol01sJ7M49': url || '',
                'fldJLI4dys1YxMU7L': audit.score_global || 0,
                'fldHRtR1PkT3xmUcW': audit.niveau || '',
                'fldSMV28x33cEvUrU': audit.titre_diagnostic || '',
                'fldLwVlQKDPQoy7iY': packageReco + (solIa ? ` | Solution IA suggérée : ${solIa.titre} (${solIa.prix})` : ''),
                // Actions prioritaires
                'fld1ZRALbf7Ph7L94': formatPrioriteAirtable(audit.priorites?.[0]),
                'fldftAEyRGpwUrbb8': formatPrioriteAirtable(audit.priorites?.[1]),
                'fldn3Y7PW28aZcqbA': formatPrioriteAirtable(audit.priorites?.[2]),
                'fldfW7xcErUNiUaKD': new Date().toISOString(),
                // Détail par critère (nouveau)
                'fldaqJ8BBiYTMkIgj': sectionDetail('design'),
                'fld1jtYAoh9UJfYww': sectionDetail('contenu'),
                'fldifAGbvXAKlpk8j': sectionDetail('seo'),
                'fldoVLPTDuMn766Lq': sectionDetail('conversion'),
                'fldme04yXWOlojHQG': sectionDetail('mobile')
              }
            }]
          })
        });
        const atResult = await atResp.json();
        console.log('Airtable result:', JSON.stringify(atResult));
      } catch(e) {
        console.error('Airtable error:', e.message);
      }
    } else {
      console.warn('Airtable skipped: missing env vars');
    }

    // ── 2. EMAIL HTML ────────────────────────────────
    const sectionsHtml = (audit.sections || []).map(s => {
      const color = s.score === 'Très bon' ? '#15803D' : s.score === 'Bon' ? '#16A34A' : s.score === 'Urgent' ? '#DC2626' : '#D97706';
      const bg    = s.score === 'Très bon' ? '#DCFCE7' : s.score === 'Bon' ? '#F0FDF4' : s.score === 'Urgent' ? '#FEF2F2' : '#FFFBEB';
      return `<tr><td style="padding:12px 16px;border-bottom:1px solid #F0EDE8;">
        <div style="margin-bottom:4px;"><span>${s.icon}</span> <strong style="color:#2D1F6E;font-size:14px;">${s.titre}</strong>
        <span style="float:right;background:${bg};color:${color};font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;">${s.score}</span></div>
        <p style="margin:0;font-size:13px;color:#555;">${s.analyse}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#7B5CF0;"><strong>→</strong> ${s.reco}</p>
      </td></tr>`;
    }).join('');

    const prioritesHtml = (audit.priorites || []).map(p => {
      const action = typeof p === 'string' ? p : (p?.action || '');
      const objectif = typeof p === 'string' ? '' : (p?.objectif || '');
      return `<li style="margin-bottom:10px;font-size:13px;color:#3D3D3D;">${action}${objectif ? `<br><span style="font-size:12px;color:#8A8A8A;">Objectif : ${objectif}</span>` : ''}</li>`;
    }).join('');

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#F8F7F4;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#2C2C3E;padding:28px 32px;text-align:center;">
    <a href="https://www.chicouf.pro/" style="text-decoration:none;">
      <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:.06em;color:#fff;">CHIC <span style="color:#A78BFA;">OUF</span></p>
    </a>
    <p style="margin:6px 0 0;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#CACACF;">Rapport d'audit · Site internet</p>
  </div>
  <div style="padding:28px 32px 0;">
    <p style="font-size:15px;color:#3D3D3D;">${prenom_display},</p>
    <p style="font-size:14px;color:#555;line-height:1.6;">Voici l'audit de votre site internet pour <strong style="color:#2D1F6E;">${url}</strong>.</p>
  </div>
  <div style="margin:20px 32px;background:#F5F0FF;border-radius:12px;padding:20px;">
    <table style="width:100%;"><tr>
      <td style="width:80px;text-align:center;vertical-align:middle;">
        <div style="font-size:36px;font-weight:800;color:#2D1F6E;line-height:1;">${audit.score_global}</div>
        <div style="font-size:12px;color:#8A8A8A;">/10</div>
      </td>
      <td style="vertical-align:middle;padding-left:16px;">
        <div style="font-size:13px;font-weight:700;color:#7B5CF0;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">${scoreEmoji} ${audit.niveau}</div>
        <div style="font-size:14px;font-weight:700;color:#2D1F6E;margin-bottom:4px;">${audit.titre_diagnostic}</div>
        <div style="font-size:13px;color:#555;line-height:1.5;">${audit.resume}</div>
        ${audit.score_global >= 9 ? '<div style="font-size:13px;color:#555;line-height:1.5;margin-top:6px;">Votre site inspire confiance et présente correctement votre activité. Son principal potentiel d\'amélioration concerne désormais sa capacité à générer, suivre et convertir davantage de demandes de devis.</div>' : ''}
      </td>
    </tr></table>
  </div>
  <div style="padding:0 32px;">
    <p style="font-size:13px;font-weight:700;color:#2D1F6E;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">Détail par critère</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #F0EDE8;">${sectionsHtml}</table>
  </div>
  <div style="padding:20px 32px;">
    <p style="font-size:13px;font-weight:700;color:#2D1F6E;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">3 actions prioritaires</p>
    <ul style="margin:0;padding-left:18px;">${prioritesHtml}</ul>
  </div>
  <div style="margin:0 32px 20px;background:#FFF8EC;border:1px dashed #F5C77A;border-radius:10px;padding:16px 18px;">
    <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#7A5200;">🔎 Un constat complémentaire</p>
    <p style="margin:0 0 10px;font-size:13px;color:#555;line-height:1.5;">${audit.constat_maturite_ia || 'Au-delà du site, la plupart des TPE et associations manquent d\'un suivi structuré de leurs demandes.'}</p>
    <a href="https://tally.so/r/68PxQB" style="font-size:13px;color:#7B5CF0;font-weight:600;text-decoration:none;">Évaluer gratuitement l'organisation de votre suivi commercial (10 min) →</a>
  </div>
  <div style="margin:8px 32px 32px;background:#2C2C3E;border-radius:12px;padding:24px;text-align:center;">
    <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#fff;">Parlons de votre projet</p>
    <p style="margin:0 0 16px;font-size:13px;color:#ABABB2;">30 minutes offertes pour transformer ces recommandations en plan d'action.</p>
    <a href="https://calendly.com/sandrine-darrieu/meeting-chic-ouf" style="display:inline-block;background:#7B5CF0;color:#fff;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;">Réserver un créneau gratuit</a>
    <p style="margin:10px 0 0;font-size:11px;color:#96969E;">ou copiez ce lien : <a href="https://calendly.com/sandrine-darrieu/meeting-chic-ouf" style="color:#A78BFA;">calendly.com/sandrine-darrieu/meeting-chic-ouf</a></p>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #F0EDE8;text-align:center;">
    <p style="margin:0;font-size:11px;color:#AAAAAA;"><span style="color:#2D1F6E;font-weight:700;">CHIC</span> <span style="color:#F59E0B;">·</span> <span style="color:#7B5CF0;font-weight:700;">OUF</span> · Sandrine Darrieu · Consultante en transformation digitale & Product Builder · Brunoy, Île-de-France et à distance partout en France</p>
    <p style="margin:4px 0 0;font-size:11px;color:#AAAAAA;">📧 contact@chicouf.pro · 📞 07 56 92 59 84 · 🌐 <a href="https://www.chicouf.pro/" style="color:#7B5CF0;text-decoration:none;">www.chicouf.pro</a></p>
    <p style="margin:8px 0 0;font-size:10px;color:#BBBBBB;line-height:1.5;">Vous recevez cet email suite à votre demande d'audit sur www.chicouf.pro. Vous ne souhaitez pas être recontacté(e) ou plus recevoir d'emails de notre part ? Répondez simplement "STOP" à cet email, ou consultez notre <a href="https://www.chicouf.pro/politique-confidentialite.html" style="color:#8A8A8A;">politique de confidentialité</a>.</p>
  </div>
</div></body></html>`;

    // ── 3. RESEND ────────────────────────────────────
    console.log('Resend config:', {
      hasKey: !!process.env.RESEND_API_KEY,
      ownerEmail: process.env.OWNER_EMAIL
    });

    if (!process.env.RESEND_API_KEY) {
      console.warn('Resend skipped: RESEND_API_KEY missing');
      return res.status(200).json({ success: true, warning: 'Email non envoyé : clé Resend manquante' });
    }

    const OWNER_EMAIL = process.env.OWNER_EMAIL || 'contact@chicouf.pro';

    // 3a. Email au visiteur : son rapport d'audit complet et personnalisé
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'CHIC OUF <audit@chicouf.edukia.site>',
        to: [email],
        cc: [OWNER_EMAIL],
        reply_to: OWNER_EMAIL,
        subject: `Audit de votre site internet — ${url}`,
        html
      })
    });

    const result = await resendResp.json();
    console.log('Resend result:', JSON.stringify(result));

    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

    // Simplification : la copie pour Sandrine se fait désormais via le "cc" ajouté
    // directement sur l'envoi ci-dessus (même email, un seul envoi, donc pas de
    // second point de défaillance possible). Le résumé (score, package recommandé,
    // solution IA) reste disponible dans Airtable pour le suivi CRM.
    console.log('Copie envoyée en CC à', OWNER_EMAIL, '- Score:', audit.score_global, '- Package:', packageReco);

    // ── 4. BRIEF COMMERCIAL INTERNE (uniquement pour Sandrine) ──────────
    // Associe chacune des 3 vraies priorités du rapport à l'axe du catalogue
    // correspondant (offre + tarif + argumentaire), pour avoir immédiatement
    // de quoi répondre si ce prospect recontacte suite à l'audit.
    // NOTE IMPORTANT : les tarifs de l'Axe "Suivi & relance" ne sont pas
    // encore valides — Sandrine doit les valider avec son associé avant
    // d'utiliser cet axe commercialement. Le reste du catalogue est figé.
    const AXES_CATALOGUE = {
      SEO: {
        nom: 'Optimisation SEO technique locale',
        prix: '250 € HT',
        argumentaire: "La plupart des TPE n'ont pas de schéma structuré ou de meta description soignée : c'est une intervention rapide, à forte valeur perçue, pour la visibilité locale. Bon point d'entrée si le prospect est sensible au référencement."
      },
      CONVERSION: {
        nom: 'Refonte du parcours de contact',
        prix: '350 € HT',
        argumentaire: "Un formulaire absent ou mal positionné, ce sont des demandes concrètement perdues. C'est l'argument le plus facile à chiffrer en \"manque à gagner\" direct pour le prospect."
      },
      MOBILE_PERF: {
        nom: 'Audit technique et optimisation de performance',
        prix: '350 € HT (ou sur devis si migration d\'hébergement)',
        argumentaire: "Un temps de réponse lent pénalise à la fois le référencement et l'expérience utilisateur. Bon argument si le prospect a un site ancien, ou un hébergement peu performant."
      },
      PREUVE_SOCIALE: {
        nom: 'Collecte et intégration de preuve sociale',
        prix: '250 € HT',
        argumentaire: "Les visiteurs se décident souvent sur la confiance visuelle (avis, réalisations). C'est concret, rapide à montrer en exemple, et facile à justifier auprès du prospect."
      },
      CONTENU_EDITORIAL: {
        nom: 'Création de contenu IA',
        prix: '350 € HT',
        argumentaire: "Utile si le prospect veut construire une présence dans la durée (actualités, FAQ, blog). Bon complément à proposer en 2e temps, moins urgent qu'un point technique bloquant."
      },
      SUIVI_RELANCE: {
        nom: 'Accompagnement suivi & relance (offre "maturité IA", tarif à valider avec votre associé)',
        prix: 'À définir',
        argumentaire: "C'est l'axe le plus fréquent détecté sur l'ensemble du corpus testé, mais volontairement pas encore chiffré. À mentionner à l'oral comme complément naturel, sans prix ferme pour l'instant."
      }
    };

    const classifyPriorite = (texte) => {
      const t = (texte || '').toLowerCase();
      // Priorité aux verbes d'action en tout début de phrase pour distinguer
      // "ajouter un formulaire" (Conversion) de "mettre en place un suivi
      // centralisé" qui peut mentionner "formulaire" comme simple canal parmi
      // d'autres (Suivi & relance) - l'ordre des tests seul ne suffit pas.
      const debutePasAjoutFormulaire = /^(ajoutez|ajouter|ajoutons|int[eé]grez|int[eé]grer|mettre en place un formulaire|cr[eé]ez? un formulaire)/i.test(t.trim()) && /formulaire/.test(t);
      if (debutePasAjoutFormulaire) return 'CONVERSION';
      if (/suivi|centralis|relance|crm|tableau de bord/.test(t)) return 'SUIVI_RELANCE';
      if (/formulaire|cta|appel[s]? à l'action|capturer/.test(t)) return 'CONVERSION';
      if (/schéma|json-ld|localbusiness|meta description|référencement|seo local|h1\b/.test(t)) return 'SEO';
      if (/temps de réponse|vitesse|viewport|mobile|responsive|performance|chargement/.test(t)) return 'MOBILE_PERF';
      if (/témoignage|avis|photo|réalisation|crédibilité|preuve sociale/.test(t)) return 'PREUVE_SOCIALE';
      if (/calendrier|faq|guide|contenu éditorial|mots-clés/.test(t)) return 'CONTENU_EDITORIAL';
      return null;
    };

    const briefRowsHtml = (audit.priorites || []).map(p => {
      const action = typeof p === 'string' ? p : (p?.action || '');
      const objectif = typeof p === 'string' ? '' : (p?.objectif || '');
      const axeId = classifyPriorite(action + ' ' + objectif);
      const axe = axeId ? AXES_CATALOGUE[axeId] : null;
      return `<tr><td style="padding:14px 16px;border-bottom:1px solid #F0EDE8;">
        <p style="margin:0 0 6px;font-size:13px;color:#2D1F6E;font-weight:700;">${action}</p>
        ${axe ? `<p style="margin:0 0 4px;font-size:13px;color:#3D3D3D;">🔧 <strong>${axe.nom}</strong> — <span style="color:#F59E0B;font-weight:700;">${axe.prix}</span></p>
        <p style="margin:0;font-size:12px;color:#7B5CF0;">${axe.argumentaire}</p>`
        : `<p style="margin:0;font-size:12px;color:#AAAAAA;">Aucun axe du catalogue ne correspond clairement — à évaluer au cas par cas.</p>`}
      </td></tr>`;
    }).join('');

    const briefHtml = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#F8F7F4;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#2C2C3E;padding:24px 32px;text-align:center;">
    <p style="margin:0;font-size:16px;font-weight:700;color:#fff;">Brief commercial — usage interne</p>
    <p style="margin:6px 0 0;font-size:12px;color:#CACACF;">${prenom_display !== 'Bonjour' ? prenom_display : ''} · ${url}</p>
  </div>
  <div style="padding:20px 32px;">
    <p style="font-size:13px;color:#555;">Score : <strong>${audit.score_global}/10</strong> (${audit.niveau})</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #F0EDE8;margin-top:8px;">${briefRowsHtml}</table>
    <p style="margin-top:16px;font-size:11px;color:#AAAAAA;">Ce brief n'est jamais envoyé au prospect — il ne sert qu'à préparer ta réponse s'il te recontacte.</p>
  </div>
</div></body></html>`;

    try {
      const briefResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'CHIC OUF <audit@chicouf.edukia.site>',
          to: [OWNER_EMAIL],
          subject: `Brief commercial — ${url}`,
          html: briefHtml
        })
      });
      const briefResult = await briefResp.json();
      console.log('Brief commercial envoyé:', JSON.stringify(briefResult));
    } catch (e) {
      console.error('Erreur envoi brief commercial (non bloquant):', e.message);
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-report fatal error:', err.message);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
}
