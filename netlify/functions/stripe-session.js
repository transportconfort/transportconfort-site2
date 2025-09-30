// netlify/functions/stripe-session.js
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const sessionId = qs.id || qs.session_id; // <-- accepte les deux
    if (!sessionId) {
      return json(400, { error: 'missing session id' });
    }

    // Récupère la session (avec champs utiles)
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'payment_intent.charges', 'line_items'],
    });

    const payload = {
      id: session.id,
      amount_total: session.amount_total,          // en cents
      currency: session.currency,
      payment_status: session.payment_status,
      customer_email:
        (session.customer_details && session.customer_details.email) ||
        session.customer_email ||
        '',
      customer_details: session.customer_details,
      metadata: session.metadata || {},
      line_items: (session.line_items?.data || []).map((li) => ({
        description: li.description,
        amount_subtotal: li.amount_subtotal,
        amount_total: li.amount_total,
        quantity: li.quantity,
      })),
    };

    return json(200, payload);
  } catch (e) {
    console.error('stripe-session error', e);
    return json(500, { error: 'Impossible de récupérer la session Stripe.' });
  }
};

function json(code, body) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',               // évite les 304/caches
    },
    body: JSON.stringify(body),
  };
}
