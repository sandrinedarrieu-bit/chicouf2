// api/auth/logout.js
export default async function handler(req, res) {
  res.setHeader('Set-Cookie', 'coch_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return res.status(200).json({ ok: true });
}
