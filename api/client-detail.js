// api/client-detail.js
//
// Permet au commercial CONNECTÉ de :
//  - créer un nouveau prospect (POST sans id) — automatiquement lié à lui
//  - consulter la fiche d'un de SES clients : coordonnées, diagnostics CAPE liés
//    (avec la recommandation de l'algorithme) et historique de ses devis (GET)
//  - modifier la fiche d'un de SES clients (POST avec id)
//  - supprimer un prospect sans devis lié (DELETE)
//
// L'appartenance est vérifiée à chaque lecture/modification (Clients.Consultant_ID
// doit contenir l'ID du commercial connecté) — impossible de voir ou modifier
// la fiche d'un client qui ne lui appartient pas, même en devinant son ID.

import { verifySession } from './_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CLIENTS_TABLE = 'tblPhDItWoYN7jgtA';
const DIAGNOSTICS_TABLE = 'tblTeIGD63oOOHaob';
const AUDITS_TABLE = 'tblrZJAmMBa2SKjSF';

async function airtableFetch(path, apiKey, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Airtable ${res.status} sur ${path}`);
  return res.json();
}

function isOwner(record, consultantId) {
  const owners = record.fields.Consultant_ID || [];
  return owners.includes(consultantId);
}

async function fetchDiagnostics(diagnosticIds, apiKey) {
  if (!diagnosticIds || diagnosticIds.length === 0) return [];
  const results = await Promise.all(
    diagnosticIds.map(id =>
      airtableFetch(`${DIAGNOSTICS_TABLE}/${id}`, apiKey).catch(() => null)
    )
  );
  return results
    .filter(Boolean)
    .map(d => ({
      id: d.id,
      date: d.fields.Date_diagnostic || '',
      niveau: d.fields.Niveau_Global || '',
      score: d.fields.Score_Global ?? null,
      famille: d.fields.Famille_4AI || '',
      // Recommandation automatique de l'algorithme CAPE — un point de départ,
      // pas ce qui a été réellement proposé (ça, c'est l'historique des devis).
      offreRecommandee: d.fields['Offre proposée'] || '',
      lienRapport: d.fields['Lien rapport'] || ''
    }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function fetchAuditsHistory(auditIds, apiKey) {
  if (!auditIds || auditIds.length === 0) return [];
  const results = await Promise.all(
    auditIds.map(id =>
      airtableFetch(`${AUDITS_TABLE}/${id}`, apiKey).catch(() => null)
    )
  );
  return results
    .filter(Boolean)
    .map(a => ({
      id: a.id,
      statut: a.fields.Statut || 'En attente',
      montant: a.fields.Montant_HT || 0,
      description: a.fields.Description_besoin || '',
      dateSignature: a.fields.Date_Signature || null
    }));
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: 'Non authentifié.' });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  if (!AIRTABLE_API_KEY) return res.status(500).json({ error: 'Configuration serveur incomplète.' });

  const id = (req.method === 'GET' || req.method === 'DELETE') ? req.query.id : (req.body || {}).id;

  try {
    // Création d'un nouveau prospect — pas d'id fourni
    if (req.method === 'POST' && !id) {
      const { entreprise, nomContact, email, telephone, adresse, siteWeb, secteur } = req.body || {};
      if (!entreprise) return res.status(400).json({ error: 'Le nom de l\'entreprise est requis.' });

      const created = await airtableFetch(CLIENTS_TABLE, AIRTABLE_API_KEY, {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            Entreprise: entreprise,
            Nom_contact: nomContact || '',
            Email: email || '',
            Telephone: telephone || '',
            Adresse: adresse || '',
            'Site web': siteWeb || '',
            Secteur: secteur || '',
            Consultant_ID: [session.sub]
          },
          typecast: true
        })
      });

      return res.status(200).json({
        id: created.id,
        entreprise: created.fields.Entreprise || '',
        nomContact: created.fields.Nom_contact || '',
        email: created.fields.Email || '',
        telephone: created.fields.Telephone || '',
        adresse: created.fields.Adresse || '',
        siteWeb: created.fields['Site web'] || '',
        secteur: created.fields.Secteur || '',
        diagnostics: [],
        audits: []
      });
    }

    if (!id) return res.status(400).json({ error: 'Identifiant client manquant.' });

    const record = await airtableFetch(`${CLIENTS_TABLE}/${id}`, AIRTABLE_API_KEY);
    if (!isOwner(record, session.sub)) {
      return res.status(403).json({ error: 'Ce client ne fait pas partie de votre portefeuille.' });
    }

    if (req.method === 'GET') {
      const [diagnostics, audits] = await Promise.all([
        fetchDiagnostics(record.fields.Diagnostics, AIRTABLE_API_KEY),
        fetchAuditsHistory(record.fields.Audits, AIRTABLE_API_KEY)
      ]);
      return res.status(200).json({
        id: record.id,
        entreprise: record.fields.Entreprise || '',
        nomContact: record.fields.Nom_contact || '',
        email: record.fields.Email || '',
        telephone: record.fields.Telephone || '',
        adresse: record.fields.Adresse || '',
        siteWeb: record.fields['Site web'] || '',
        secteur: record.fields.Secteur || '',
        signeExterne: !!record.fields.Signe_Externe,
        diagnostics,
        audits
      });
    }

    if (req.method === 'POST') {
      const { entreprise, nomContact, email, telephone, adresse, siteWeb, secteur, signeExterne } = req.body || {};
      if (!entreprise) return res.status(400).json({ error: 'Le nom de l\'entreprise est requis.' });

      const updated = await airtableFetch(`${CLIENTS_TABLE}/${id}`, AIRTABLE_API_KEY, {
        method: 'PATCH',
        body: JSON.stringify({
          fields: {
            Entreprise: entreprise,
            Nom_contact: nomContact || '',
            Email: email || '',
            Telephone: telephone || '',
            Adresse: adresse || '',
            'Site web': siteWeb || '',
            Secteur: secteur || '',
            Signe_Externe: !!signeExterne
          },
          typecast: true
        })
      });

      const [diagnostics, audits] = await Promise.all([
        fetchDiagnostics(updated.fields.Diagnostics, AIRTABLE_API_KEY),
        fetchAuditsHistory(updated.fields.Audits, AIRTABLE_API_KEY)
      ]);
      return res.status(200).json({
        id: updated.id,
        entreprise: updated.fields.Entreprise || '',
        nomContact: updated.fields.Nom_contact || '',
        email: updated.fields.Email || '',
        telephone: updated.fields.Telephone || '',
        adresse: updated.fields.Adresse || '',
        siteWeb: updated.fields['Site web'] || '',
        secteur: updated.fields.Secteur || '',
        signeExterne: !!updated.fields.Signe_Externe,
        diagnostics,
        audits
      });
    }

    if (req.method === 'DELETE') {
      const hasAudits = (record.fields.Audits || []).length > 0;
      if (hasAudits) {
        return res.status(400).json({
          error: 'Ce prospect a déjà un ou plusieurs devis liés — contactez Sandrine pour le supprimer.'
        });
      }

      await airtableFetch(`${CLIENTS_TABLE}/${id}`, AIRTABLE_API_KEY, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Erreur client-detail:', err);
    return res.status(500).json({ error: 'Erreur serveur, réessayez.' });
  }
}
