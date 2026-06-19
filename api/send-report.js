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
    const prenom_display = prenom || 'Bonjour';

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

    // ── 1. AIRTABLE ──────────────────────────────────
    console.log('Airtable config:', {
      hasBaseId: !!process.env.AIRTABLE_BASE_ID,
      hasApiKey: !!process.env.AIRTABLE_API_KEY,
      baseId: process.env.AIRTABLE_BASE_ID
    });

    if (process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_API_KEY) {
      try {
        const atResp = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/tblYndbnnzwU33sdZ`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`
          },
          body: JSON.stringify({
            records: [{
              fields: {
                'fld7tEbc6J5HMDmhh': prenom || '',
                'fldgmi96dhLgaN5h1': email,
                'fldHDiQol01sJ7M49': url || '',
                'fldJLI4dys1YxMU7L': audit.score_global || 0,
                'fldHRtR1PkT3xmUcW': audit.niveau || '',
                'fldSMV28x33cEvUrU': audit.titre_diagnostic || '',
                'fldLwVlQKDPQoy7iY': packageReco,
                // Actions prioritaires
                'fld1ZRALbf7Ph7L94': audit.priorites?.[0] || '',
                'fldftAEyRGpwUrbb8': audit.priorites?.[1] || '',
                'fldn3Y7PW28aZcqbA': audit.priorites?.[2] || '',
                'fldfW7xcErUNiUaKD': new Date().toISOString().split('T')[0]
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
      const color = s.score === 'Bon' ? '#16A34A' : s.score === 'Urgent' ? '#DC2626' : '#D97706';
      const bg    = s.score === 'Bon' ? '#F0FDF4' : s.score === 'Urgent' ? '#FEF2F2' : '#FFFBEB';
      return `<tr><td style="padding:12px 16px;border-bottom:1px solid #F0EDE8;">
        <div style="margin-bottom:4px;"><span>${s.icon}</span> <strong style="color:#2D1F6E;font-size:14px;">${s.titre}</strong>
        <span style="float:right;background:${bg};color:${color};font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;">${s.score}</span></div>
        <p style="margin:0;font-size:13px;color:#555;">${s.analyse}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#7B5CF0;"><strong>→</strong> ${s.reco}</p>
      </td></tr>`;
    }).join('');

    const prioritesHtml = (audit.priorites || []).map(p =>
      `<li style="margin-bottom:6px;font-size:13px;color:#3D3D3D;">${p}</li>`
    ).join('');

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#F8F7F4;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#2C2C3E;padding:28px 32px;text-align:center;">
    <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:.06em;color:#fff;">CHIC <span style="color:#A78BFA;">OUF</span></p>
    <p style="margin:6px 0 0;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.45);">Rapport d'audit · Présence en ligne</p>
  </div>
  <div style="padding:28px 32px 0;">
    <p style="font-size:15px;color:#3D3D3D;">${prenom_display},</p>
    <p style="font-size:14px;color:#555;line-height:1.6;">Voici votre audit de présence en ligne pour <strong style="color:#2D1F6E;">${url}</strong>.</p>
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
  ${packageReco !== 'À définir' ? `<div style="margin:0 32px 8px;background:#F5F0FF;border-radius:10px;padding:14px 18px;">
    <p style="margin:0;font-size:13px;color:#7B5CF0;font-weight:600;">💡 ${packageReco} — la prochaine étape recommandée</p>
    <p style="margin:4px 0 0;font-size:13px;color:#555;">${etape}</p>
  </div>` : ''}
  <div style="margin:8px 32px 32px;background:#2C2C3E;border-radius:12px;padding:24px;text-align:center;">
    <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#fff;">Parlons de votre projet</p>
    <p style="margin:0 0 16px;font-size:13px;color:rgba(255,255,255,.6);">30 minutes offertes pour transformer ces recommandations en plan d'action.</p>
    <a href="https://calendly.com/votre-lien-ici" style="display:inline-block;background:#7B5CF0;color:#fff;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;">Réserver un créneau gratuit</a>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #F0EDE8;text-align:center;">
    <p style="margin:0;font-size:11px;color:#AAAAAA;">CHIC OUF · Sandrine Darrieu · Consultante No-Code & IA · Brunoy, Île-de-France</p>
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

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'CHIC OUF <onboarding@resend.dev>',
        to: [process.env.OWNER_EMAIL || email],
        reply_to: email,
        subject: `Audit de présence en ligne — ${url}`,
        html
      })
    });

    const result = await resendResp.json();
    console.log('Resend result:', JSON.stringify(result));

    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-report fatal error:', err.message);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
}
