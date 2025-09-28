// netlify/functions/sim-presign.js
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const HMAC_SECRET = process.env.HMAC_SECRET;
  if (!HMAC_SECRET) return { statusCode: 500, body: 'Missing HMAC_SECRET' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Bad JSON' }; }
  const canon = body.canon;
  if (!canon || !canon.type || !canon.whenISO || !canon.from) {
    return { statusCode: 400, body: 'canon incomplete' };
  }

  // Canon normalisé pour signature stable
  const normalized = {
    type: canon.type,                     // 'mad' | 'course'
    whenISO: canon.whenISO,               // ISO string
    from: canon.from,
    to: canon.to || '',
    price_eur: Number(canon.price_eur ?? 0),
    mad_hours: canon.type === 'mad' ? Number(canon.mad_hours ?? 1) : undefined
  };

  const canonStr = JSON.stringify(normalized);
  const signature = crypto.createHmac('sha256', HMAC_SECRET).update(canonStr).digest('hex');
  const canon_b64 = Buffer.from(canonStr, 'utf8').toString('base64');
  const nonce = crypto.randomBytes(8).toString('hex'); // anti-rejeu simple

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ signature, canon_b64, nonce })
  };
};
