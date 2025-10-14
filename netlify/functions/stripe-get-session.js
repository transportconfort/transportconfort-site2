// netlify/functions/stripe-get-session.js
const Stripe = require("stripe");

exports.handler = async (event) => {
  try {
    const rawUrl = event.rawUrl || `https://${event.headers.host}${event.path}${event.rawQuery ? "?" + event.rawQuery : ""}`;
    const url = new URL(rawUrl);
    const sessionId = url.searchParams.get("session_id");

    if (!sessionId) {
      return { statusCode: 400, body: "Missing session_id" };
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    });

    // Récupérer la session + détails utiles
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "line_items"],
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: true,
        id: session.id,
        payment_status: session.payment_status,   // 'paid' attendu
        status: session.status,                   // 'complete' attendu
        currency: session.currency,
        amount_total: session.amount_total,
        customer_email: session.customer_details?.email || null,
        metadata: session.metadata || {},
        line_items: session.line_items?.data?.map(li => ({
          desc: li.description, amount: li.amount_total, qty: li.quantity
        })) || []
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
