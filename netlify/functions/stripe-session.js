// netlify/functions/stripe-session.js
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20', // laisse la version récente que tu utilises
});

exports.handler = async (event) => {
  try {
    const session_id = (event.queryStringParameters || {}).session_id;
    if (!session_id) {
      return json(400, { error: 'session_id manquant' });
    }

    // Récupère la session + détails utiles
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['customer', 'payment_intent.charges', 'line_items']
    });

    // On renvoie juste ce qui est utile au front (pas d’info sensible)
    const payload = {
      id: session.id,
      amount_total: session.amount_total,   // en cents
      currency: session.currency,
      payment_status: session.payment_status,
      customer_email: session.customer_email,
      customer_details: session.customer_details,
      metadata: session.metadata || {},
      line_items: (session.line_items && session.line_items.data || []).map(li => ({
        description: li.description,
        amount_subtotal: li.amount_subtotal,
        amount_total: li.amount_total,
        quantity: li.quantity
      }))
    };

    return json(200, payload);
  } catch (e) {
    console.error('stripe-session error', e);
    return json(500, { error: 'Impossible de récupérer la session Stripe.' });
  }
};

function json(code, body){
  return {
    statusCode: code,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}
