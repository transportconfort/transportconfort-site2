// netlify/functions/stripe-webhook.js
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

async function pingSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { statusCode: 500, body: 'Missing STRIPE_WEBHOOK_SECRET' };

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secret);
  } catch (err) {
    console.error('Signature error', err);
    return { statusCode: 400, body: 'Bad signature' };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const s = stripeEvent.data.object;
      const eur = (s.amount_total || 0) / 100;
      const md = s.metadata || {};

      const lines = [
        '💳 Paiement confirmé (Stripe Checkout)',
        `Montant: ${eur.toFixed(2)} € • Mode: ${md.pay_mode || ''}`,
        `Type: ${md.type || ''} • Date: ${md.whenISO || ''}`,
        `From: ${md.from || ''}`,
        md.type === 'mad' ? `Durée MAD: ${md.mad_hours || ''}h` : `To: ${md.to || ''}`,
        `Client: ${s.customer_details?.name || ''} • ${s.customer_details?.email || ''}`
      ].filter(Boolean).join('\n');

      await pingSlack(lines);
    }
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'hook err' };
  }
};
