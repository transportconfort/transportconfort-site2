// netlify/functions/calendly-webhook.js
const crypto = require('crypto');
const fetch = (...a)=>import('node-fetch').then(({default:f})=>f(...a));

const HMAC_SECRET = process.env.HMAC_SECRET;                     // même secret que sim-presign
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';   // Slack Incoming Webhook
const CALENDLY_SIGNING_KEY = process.env.CALENDLY_SIGNING_KEY || ''; // (optionnel mais recommandé)

// === RENSEIGNE ICI tes IDs de questions Calendly (voir section D) ===
const QID = {
  mad:   { date:'QID_MAD_DATE', time:'QID_MAD_TIME', from:'QID_MAD_FROM', duration:'QID_MAD_DURATION', price:'QID_MAD_PRICE' },
  course:{ date:'QID_VTC_DATE', time:'QID_VTC_TIME', from:'QID_VTC_FROM', to:'QID_VTC_TO', price:'QID_VTC_PRICE' }
};

function verifyCalendlySignature(raw, header) {
  try {
    if (!CALENDLY_SIGNING_KEY || !header) return true; // tolérant si non configuré
    const parts = Object.fromEntries(header.split(',').map(x=>x.trim().split('=')));
    const data = `${parts.t}.${raw}`;
    const expected = crypto.createHmac('sha256', CALENDLY_SIGNING_KEY).update(data).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch { return false; }
}

function decodeCanon(tracking){
  try{
    const b64 = tracking?.utm_content || tracking?.utmContent;
    if(!b64) return null;
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  }catch{ return null; }
}
const hmac = str => crypto.createHmac('sha256', HMAC_SECRET).update(str).digest('hex');

function extractAnswers(resource){
  const qa = resource?.questions_and_answers || resource?.payload?.questions_and_answers || [];
  const map = {};
  for(const q of qa){
    map[q.id] = q.answer;
    if(q.question) map[q.question.toLowerCase()] = q.answer; // fallback par libellé
  }
  return map;
}
function pickAnswers(type, answers){
  const ids = QID[type] || {};
  const a = {};
  if (ids.price) a.price = answers[ids.price] ?? answers['tarif estimé'];
  if (ids.from)  a.from  = answers[ids.from]  ?? answers['adresse de prise en charge'];
  if (type==='course' && ids.to) a.to = answers[ids.to] ?? answers['adresse de dépose'];
  if (type==='mad' && ids.duration) a.duration = answers[ids.duration] ?? answers['durée souhaitée'];
  if (ids.date) a.date = answers[ids.date] ?? answers['date souhaitée'];
  if (ids.time) a.time = answers[ids.time] ?? answers['heure souhaitée'];
  return a;
}
function diff(canon, a){
  const diffs = [];
  const toNum = v => Number(String(v).replace(/[^\d.,-]/g,'').replace(',','.'));
  if (canon.price_eur!=null && a.price!=null) {
    const pa = toNum(a.price);
    if (!Number.isNaN(pa) && Math.abs(pa - Number(canon.price_eur)) > 0.01) {
      diffs.push({field:'price', canon:canon.price_eur, client:pa});
    }
  }
  if (canon.from && a.from && a.from.trim() !== canon.from.trim()) {
    diffs.push({field:'from', canon:canon.from, client:a.from});
  }
  if (canon.type==='course' && canon.to && a.to && a.to.trim() !== canon.to.trim()) {
    diffs.push({field:'to', canon:canon.to, client:a.to});
  }
  if (canon.type==='mad' && canon.mad_hours && a.duration) {
    const dh = Number(String(a.duration).match(/\d+/)?.[0]||'0');
    if (dh !== Number(canon.mad_hours)) diffs.push({field:'mad_hours', canon:canon.mad_hours, client:dh});
  }
  if (canon.whenISO && a.time) {
    const hc = new Date(canon.whenISO).toTimeString().slice(0,5);
    const ht = String(a.time).slice(0,5);
    if (hc && ht && hc !== ht) diffs.push({field:'time', canon:hc, client:ht});
  }
  return diffs;
}
async function notifySlack(title, body){
  if (!SLACK_WEBHOOK_URL) return;
  await fetch(SLACK_WEBHOOK_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ text: `*${title}*\n${body}` })
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const raw = event.body || '';
  const sigHeader = event.headers['calendly-webhook-signature'] || event.headers['Calendly-Webhook-Signature'];
  if (!verifyCalendlySignature(raw, sigHeader)) return { statusCode: 401, body: 'Invalid signature' };

  let body;
  try { body = JSON.parse(raw); } catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const resource = body.payload || body.resource || body; // compat formats
  const tracking = resource?.tracking || {};
  const answers  = extractAnswers(resource);

  const canon = decodeCanon(tracking);
  if (!canon) {
    await notifySlack('Calendly: UTM manquant', 'Impossible de décoder le canon (utm_content).');
    return { statusCode: 200, body: 'OK' };
  }

  // Recalcule la signature attendue
  const normalized = {
    type: canon.type,
    whenISO: canon.whenISO,
    from: canon.from,
    to: canon.to || '',
    price_eur: Number(canon.price_eur ?? 0),
    mad_hours: canon.type==='mad' ? Number(canon.mad_hours ?? 1) : undefined
  };
  const expectSig = hmac(JSON.stringify(normalized));
  if (tracking?.utm_medium !== expectSig) {
    await notifySlack('Calendly: signature HMAC invalide', 'Les UTM ne correspondent pas à la signature attendue.');
    return { statusCode: 200, body: 'OK' };
  }

  const a = pickAnswers(canon.type, answers);
  const diffs = diff(canon, a);
  const who = resource?.email || resource?.name || 'Invité';
  const when = canon.whenISO;

  if (diffs.length === 0) {
    await notifySlack('Réservation conforme', `Client: ${who}\nType: ${canon.type}\nQuand: ${when}\nPrix: ${canon.price_eur} €\nDépart: ${canon.from}${canon.type==='course' ? `\nArrivée: ${canon.to}`:''}`);
  } else {
    const lines = diffs.map(d => `• ${d.field}: client="${d.client}" vs canon="${d.canon}"`).join('\n');
    await notifySlack('⚠️ Écart Calendly détecté', `Client: ${who}\nType: ${canon.type}\nQuand: ${when}\n${lines}`);
  }
  return { statusCode: 200, body: 'OK' };
};
