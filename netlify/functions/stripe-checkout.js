// netlify/functions/stripe-checkout.js
const Stripe = require('stripe');
const crypto = require('crypto');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

function verifySignedCanon(signed) {
  if (!signed || !signed.signature || !signed.canon_b64) return null;
  const canonStr = Buffer.from(signed.canon_b64, 'base64').toString('utf8');
  const key = process.env.HMAC_SECRET;
  if (!key) return null;
  const sig = crypto.createHmac('sha256', key).update(canonStr).digest('hex');
  if (sig !== signed.signature) return null;
  try { return JSON.parse(canonStr); } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const body = JSON.parse(event.body || '{}');
    const { signed, payFull = false, customer = {} } = body;

    const canon = verifySignedCanon(signed);
    if (!canon || !canon.whenISO || !canon.from) {
      return { statusCode: 400, body: 'Bad or missing signature/canon' };
    }
    const site = process.env.SITE_URL || `https://${event.headers.host}`;

    // Montant à encaisser (EUR → cents)
    const base = Number(canon.price_eur || 0);
    const amount = payFull ? base : base * 0.20;
    const cents = Math.max( Math.round(amount * 100), 50 ); // min 0,50 €

    const label =
      (payFull ? 'Paiement 100% — ' : 'Acompte 20% — ') +
      (canon.type === 'mad' ? `MAD ${canon.mad_hours || '?'}h` : 'Course') +
      ` • ${new Date(canon.whenISO).toLocaleString('fr-FR')}`;

    const desc = canon.type === 'mad'
      ? `Mise à disposition ${canon.mad_hours || '?'}h — Départ: ${canon.from}`
      : `Trajet • De: ${canon.from} • À: ${canon.to || ''}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'fr',
      currency: 'eur',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: cents,
          product_data: { name: label, description: desc }
        }
      }],
      success_url: `${site}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/simulator.html?canceled=1`,
      customer_email: customer.email || undefined,
      metadata: {
        pay_mode: payFull ? 'full' : 'deposit',
        type: canon.type || '',
        whenISO: canon.whenISO,
        from: canon.from || '',
        to: canon.to || '',
        mad_hours: String(canon.mad_hours || ''),
        price_eur: String(base || ''),
        canon_b64: signed.canon_b64,
        sig: signed.signature
      }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ url: session.url })
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'Stripe error' };
  }
};
