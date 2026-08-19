// api/dashboard-data.js
//
// Renvoie les clients et devis du commercial CONNECTÉ (via cookie de session),
// jamais d'un ID passé par le client. C'est ce filtrage côté serveur qui empêche
// un commercial de voir les données d'un autre en trafiquant l'URL.

import { verifySession } from './_session.js';

const AIRTABLE_BASE_ID = 'appPbx0vHGCSTE9wR';
const CONSULTANTS_TABLE = 'tblZe72whfqw8IPAx';
const CLIENTS_TABLE = 'tblPhDItWoYN7jgtA';
const AUDITS_TABLE = 'tblrZJAmMBa2SKjSF';

async function airtableGet(path, apiKey) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`Airtable ${res.status} sur ${path}`);
  return res.json();
}

function orRecordIds(ids) {
  return ids.map(id => `RECORD_ID()="${id}"`).join(',');
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ error: 'Non authentifié.' });
  }

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  if (!AIRTABLE_API_KEY) {
    return res.status(500).json({ error: 'Configuration serveur incomplète.' });
  }

  try {
    const consultant = await airtableGet(`${CONSULTANTS_TABLE}/${session.sub}`, AIRTABLE_API_KEY);
    const clientIds = consultant.fields.Clients || [];

    let clients = [];
    if (clientIds.length > 0) {
      const formula = encodeURIComponent(`OR(${orRecordIds(clientIds)})`);
      const clientsData = await airtableGet(`${CLIENTS_TABLE}?filterByFormula=${formula}`, AIRTABLE_API_KEY);
      clients = clientsData.records || [];
    }

    const auditIds = clients.flatMap(c => c.fields.Audits || []);
    let audits = [];
    if (auditIds.length > 0) {
      const formula = encodeURIComponent(`OR(${orRecordIds(auditIds)})`);
      const auditsData = await airtableGet(`${AUDITS_TABLE}?filterByFormula=${formula}`, AIRTABLE_API_KEY);
      audits = auditsData.records || [];
    }

    const clientById = Object.fromEntries(clients.map(c => [c.id, c]));

    const pipeline = { 'En attente': [], 'Envoyé': [], 'Signé': [], 'Payé': [], 'Perdu': [] };
    let caGenere = 0;

    audits.forEach(a => {
      const statut = a.fields.Statut || 'En attente';
      const clientId = (a.fields.Client || [])[0];
      const client = clientById[clientId];
      const item = {
        id: a.id,
        entreprise: client ? (client.fields.Entreprise || '') : '',
        montant: a.fields.Montant_HT || 0
      };
      if (pipeline[statut]) pipeline[statut].push(item);
      if (statut === 'Payé') caGenere += (a.fields.Montant_HT || 0);
    });

    const devisEnCours = pipeline['En attente'].length + pipeline['Envoyé'].length;
    const totalDevis = audits.length;
    const tauxSignature = totalDevis > 0 ? Math.round((pipeline['Signé'].length / totalDevis) * 100) : 0;

    const clientsOut = clients.map(c => {
      const clientAudits = audits.filter(a => (a.fields.Client || []).includes(c.id));
      const lastAudit = clientAudits[clientAudits.length - 1];
      // "Signé en externe" est une étiquette posée sur le CLIENT, indépendante du
      // devis Studeria — elle ne doit jamais écraser le vrai statut d'un devis.
      const statut = c.fields.Signe_Externe ? 'Externe' : (lastAudit ? lastAudit.fields.Statut : 'Aucun devis');
      return {
        id: c.id,
        entreprise: c.fields.Entreprise || '',
        secteur: c.fields.Secteur || '',
        statut
      };
    });

    // Commissions à facturer : tous les devis Payés du commercial, avec la commission
    // calculée à 5% et l'état "déjà facturé ou non" pour qu'il sache ce qu'il lui reste à faire.
    const commissions = audits
      .filter(a => (a.fields.Statut || '') === 'Payé')
      .map(a => {
        const clientId = (a.fields.Client || [])[0];
        const client = clientById[clientId];
        const montant = a.fields.Montant_HT || 0;
        return {
          id: a.id,
          entreprise: client ? (client.fields.Entreprise || '') : '',
          montant,
          commission: Math.round(montant * 0.05 * 100) / 100,
          facturee: !!a.fields.Commission_Facturee
        };
      });

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({
      nom: session.name,
      prenom: session.prenom,
      isAdmin: (consultant.fields.Email || '').trim().toLowerCase() === 'contact@chicouf.pro',
      liens: {
        // Le lien Tally est généré, jamais stocké : le formulaire est unique pour
        // tout le réseau, seul le paramètre consultant_id change selon qui est connecté.
        tally: `https://tally.so/r/D4OlX5?consultant_id=${session.sub}`,
        calendly: consultant.fields.Lien_Calendly || '',
        zoom: consultant.fields.Lien_Zoom || ''
      },
      kpis: {
        nbClients: clients.length,
        devisEnCours,
        tauxSignature,
        caGenere
      },
      pipeline,
      clients: clientsOut,
      commissions
    });
  } catch (err) {
    console.error('Erreur dashboard-data:', err);
    return res.status(500).json({ error: 'Erreur lors du chargement des données.' });
  }
}
