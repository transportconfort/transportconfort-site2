// netlify/functions/stripe-pay-redirect.js
const Stripe = require('stripe');
const crypto = require('crypto');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

function verifySignedCanonFromQuery(qs) {
  // On attend utm_content (canon en base64) + utm_medium (signature HMAC)
  const canon_b64 = qs.utm_content || '';
  const sig_client = qs.utm_medium || ''; // posée par le simulateur
  if (!canon_b64 || !sig_client) return null;

  let canonStr = '';
  try { canonStr = Buffer.from(canon_b64, 'base64').toString('utf8'); }
  catch { return null; }

  const key = process.env.HMAC_SECRET;
  if (!key) return null;

  const sig_server = crypto.createHmac('sha256', key).update(canonStr).digest('hex');
  if (sig_server !== sig_client) return null;

  try { return JSON.parse(canonStr); } catch { return null; }
}

exports.handler = async (event) => {
  try {
    const site = process.env.SITE_URL || `https://${event.headers.host}`;
    const url = new URL(event.rawUrl || `${site}${event.path}${event.rawQuery ? '?' + event.rawQuery : ''}`);

    // 1) Récup canon signé depuis les UTM passés par Calendly
    const canon = verifySignedCanonFromQuery(Object.fromEntries(url.searchParams.entries()));
    if (!canon || !canon.whenISO || !canon.from) {
      // Fallback UX propre
      const msg = 'Impossible de valider les informations de paiement (signature manquante ou invalide).';
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `
<!doctype html><meta charset="utf-8">
<title>Paiement</title>
<body style="font-family:Inter,system-ui;padding:24px;background:#0b0b0b;color:#fff">
  <h2>⚠️ Paiement indisponible</h2>
  <p>${msg}</p>
  <p>Revenez au <a href="${site}/simulator.html" style="color:#C7A24B">simulateur</a> et relancez la réservation.</p>
</body>`
      };
    }

    // 2) Décider acompte (20%) vs 100%
    // Par défaut: acompte 20%. Si tu veux 100% pour certains cas, change la logique (ex: canon.type === 'mad' ? 20% : 100%)
    const payFull = false;

    // 3) Montant (EUR→cents) sécurisé (vient du canon signé)
    const base = Number(canon.price_eur || 0);
    const amount = payFull ? base : base * 0.20;
    const cents = Math.max(Math.round(amount * 100), 50); // min 0,50 €

    const label =
      (payFull ? 'Paiement 100% — ' : 'Acompte 20% — ') +
      (canon.type === 'mad' ? `MAD ${canon.mad_hours || '?'}h` : 'Course') +
      ` • ${new Date(canon.whenISO).toLocaleString('fr-FR')}`;

    const desc = canon.type === 'mad'
      ? `Mise à disposition ${canon.mad_hours || '?'}h — Départ: ${canon.from}`
      : `Trajet • De: ${canon.from} • À: ${canon.to || ''}`;

    // 4) Création session Stripe Checkout
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
      metadata: {
        pay_mode: payFull ? 'full' : 'deposit',
        type: canon.type || '',
        whenISO: canon.whenISO,
        from: canon.from || '',
        to: canon.to || '',
        mad_hours: String(canon.mad_hours || ''),
        price_eur: String(base || '')
      }
    });

    // 5) Redirection 303 vers Stripe
    return {
      statusCode: 303,
      headers: { Location: session.url, 'Cache-Control': 'no-store' },
      body: ''
    };

  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'Stripe redirect error' };
  }
};
