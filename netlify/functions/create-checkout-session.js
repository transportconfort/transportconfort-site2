// ... imports (Stripe), parse des params, calcul du total (total_eur) et du montant à payer (amount_eur)
// total_eur = total de la course/MAD; amount_eur = 20% ou 100%
// chargePct = 20 ou 100; isMad = true/false; label/desc/from/to/whenISO/madHours/email...

const origin =
  (event.headers['x-forwarded-proto'] || 'https') + '://' +
  (event.headers['x-forwarded-host']  || event.headers.host);

// Sécurité: borne les décimales et convertit en centimes
const unitAmount = Math.round(Number(amount_eur) * 100);

const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],
  allow_promotion_codes: true,

  line_items: [{
    quantity: 1,
    price_data: {
      currency: 'eur',
      unit_amount: unitAmount,
      product_data: {
        name: label,        // ex: "Acompte 20% — MAD 4h" ou "Course classique"
        description: desc || undefined
      }
    }
  }],

  // ✅ redirections
  success_url: `${origin}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${origin}/simulator.html#cancel`,

  // ✅ données pour la page merci + backoffice
  metadata: {
    type: isMad ? 'mad' : 'course',
    from: from || '',
    to: to || '',
    whenISO: whenISO || '',
    mad_hours: madHours ? String(madHours) : '',
    price_total_eur: String(total_eur), // total course/MAD (pas l’acompte)
    charge_pct: String(chargePct)       // "20" ou "100"
  },

  // optionnel si tu l’as
  customer_email: email || undefined
});

// Réponse (selon ton handler)
return {
  statusCode: 302,
  headers: { Location: session.url }
};
// ou bien JSON:
// return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
