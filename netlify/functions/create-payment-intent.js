
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY||'');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!process.env.STRIPE_SECRET_KEY) return { statusCode: 503, body: 'Stripe non configuré (clé secrète manquante).' };
  try {
    const { amount_eur, metadata } = JSON.parse(event.body || '{}');
    if (!amount_eur || amount_eur < 1) return { statusCode: 400, body: 'Montant invalide.' };
    const amount = Math.round(amount_eur * 100);
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { ...(metadata || {}) }
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientSecret: intent.client_secret }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'Erreur Stripe' };
  }
};
