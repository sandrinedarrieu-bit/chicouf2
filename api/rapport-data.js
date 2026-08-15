// api/rapport-data.js
//
// Proxy sécurisé entre le rapport interactif Lovable et Airtable.
// La clé API Airtable reste côté serveur (variable d'environnement Vercel),
// jamais exposée dans le code frontend.
//
// Usage : GET /api/rapport-data?id=recXXXXXXXXXXXXXX
//
// Variable d'environnement à créer sur Vercel (Project Settings → Environment Variables) :
//   AIRTABLE_API_KEY = <Personal Access Token Airtable, scope data.records:read sur la base CIA>

export default async function handler(req, res) {
  const { id } = req.query;

  // Validation stricte du format de l'ID Airtable (recXXXXXXXXXXXXXX)
  if (!id || !/^rec[a-zA-Z0-9]{14}$/.test(id)) {
    return res.status(400).json({ error: 'ID de rapport invalide.' });
  }

  const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR'; // Base "CIA"
  const AIRTABLE_TABLE_ID = 'tblTeIGD63oOOHaob'; // Table "Diagnostics"
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

  if (!AIRTABLE_API_KEY) {
    console.error('AIRTABLE_API_KEY manquante dans les variables d\'environnement Vercel');
    return res.status(500).json({ error: 'Configuration serveur incomplète.' });
  }

  try {
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}/${id}`,
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        },
      }
    );

    if (!airtableRes.ok) {
      if (airtableRes.status === 404) {
        return res.status(404).json({ error: 'Rapport introuvable. Vérifiez le lien.' });
      }
      throw new Error(`Airtable a répondu avec le statut ${airtableRes.status}`);
    }

    const record = await airtableRes.json();
    const f = record.fields || {};

    // Score C/A/P/E vont de 0 à 12 dans Airtable — on calcule le pourcentage ici
    // plutôt que de stocker un champ redondant dans Airtable.
    const pct = (score) => Math.round(((score || 0) / 12) * 100);

    const data = {
      entreprise: f.Entreprise || '',
      dateDiagnostic: f.Date_diagnostic || '',

      // Section 1 — Synthèse Exécutive
      synthese: {
        scoreGlobal: f.Score_Global || 0,
        scoreGlobalMax: 48,
        scoreGlobalPct: Math.round(((f.Score_Global || 0) / 48) * 100),
        niveauGlobal: f.Niveau_Global || '',
        texteNiveau: f.texte_niveau || '',
      },

      // Section 2 — État des Lieux (AS-IS) : les 4 branches du radar
      etatDesLieux: {
        connaissance: {
          label: 'Connaissance',
          score: f.Score_C || 0,
          pct: pct(f.Score_C),
          niveau: f.Niveau_C || '',
          reco: f.Reco_C || '',
        },
        adoption: {
          label: 'Adoption',
          score: f.Score_A || 0,
          pct: pct(f.Score_A),
          niveau: f.Niveau_A || '',
          reco: f.Reco_A || '',
        },
        processus: {
          label: 'Processus',
          score: f.Score_P || 0,
          pct: pct(f.Score_P),
          niveau: f.Niveau_P || '',
          reco: f.Reco_P || '',
        },
        engagement: {
          label: 'Engagement',
          score: f.Score_E || 0,
          pct: pct(f.Score_E),
          niveau: f.Niveau_E || '',
          reco: f.Reco_E || '',
        },
      },

      // Section 3 — Diagnostic des Risques
      diagnosticRisques: {
        famille4AI: f.Famille_4AI || '',
        explicationFamille: f.explication_famille || '',
        signalBandit: f.Signal_bandit === 'OUI',
        anglesMorts: [f.Angle_mort_1, f.Angle_mort_2, f.Angle_mort_3].filter(Boolean),
      },

      // Section 4 — Feuille de Route (TO-BE)
      feuilleDeRoute: {
        priorites: [
          { titre: f.Priorite_1_titre || '', detail: f.Priorite_1_detail || '' },
          { titre: f.Priorite_2_titre || '', detail: f.Priorite_2_detail || '' },
          { titre: f.Priorite_3_titre || '', detail: f.Priorite_3_detail || '' },
        ],
        exemplesSecteur: f.Exemples_secteur || '',
      },

      // Section 5 — Annexes & ROI → préconisation Studeria
      annexesROI: {
        ctaTitre: f.CTA_titre || '',
        ctaDetail: f.cta_detail || '',
        ctaAction: f.cta_action || '',
        offreNom: f.offre_nom || '',
        offreLien: f.offre_lien || 'https://calendly.com/sandrine-darrieu/rendez-vous-chicouf',
      },
    };

    // Cache 1h côté CDN Vercel — les données d'un diagnostic ne changent pas après coup
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json(data);
  } catch (error) {
    console.error('Erreur proxy rapport CAPE:', error);
    return res.status(500).json({ error: 'Erreur lors de la récupération du rapport.' });
  }
}
