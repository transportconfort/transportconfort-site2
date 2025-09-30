// netlify/functions/stripe-pay-redirect.js
const Stripe = require("stripe");
const crypto = require("crypto");

exports.handler = async (event) => {
  try {
    // --- Base URL du site (prod / preview)
    const site = process.env.SITE_URL || `https://${event.headers.host}`;

    // --- Toggle global pour couper le paiement si besoin
    const enabled = (process.env.PAY_AFTER_CALENDLY || "1") === "1";
    if (!enabled) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        },
        body: `<!doctype html><meta charset="utf-8"><title>Paiement</title>
<body style="font-family:Inter,system-ui;padding:24px;background:#0b0b0b;color:#fff">
  <h2>Paiement temporairement indisponible</h2>
  <p>Merci, votre réservation a bien été enregistrée. Le paiement en ligne est momentanément désactivé.</p>
  <p><a href="${site}/" style="color:#C7A24B">Retour à l’accueil</a></p>
</body>`
      };
    }

    // --- Stripe client (pas de await ici)
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    });

    // --- Vérif HMAC (canon signé passé en UTM)
    function verifySignedCanonFromQuery(params) {
      const canon_b64 = params.utm_content || "";
      const sig_client = params.utm_medium || "";
      if (!canon_b64 || !sig_client) return null;

      let canonStr;
      try {
        canonStr = Buffer.from(canon_b64, "base64").toString("utf8");
      } catch {
        return null;
      }

      const key = process.env.HMAC_SECRET;
      if (!key) return null;

      const sig_server = crypto
        .createHmac("sha256", key)
        .update(canonStr)
        .digest("hex");
      if (sig_server !== sig_client) return null;

      try { return JSON.parse(canonStr); } catch { return null; }
    }

    // --- Reconstitue URL + query
    const rawUrl =
      event.rawUrl || `${site}${event.path}${event.rawQuery ? "?" + event.rawQuery : ""}`;
    const url = new URL(rawUrl);
    const params = Object.fromEntries(url.searchParams.entries());

    // --- Canon signé
    const canon = verifySignedCanonFromQuery(params);
    if (!canon || !canon.whenISO || !canon.from) {
      const msg = "Impossible de valider les informations de paiement (signature manquante ou invalide).";
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        },
        body: `<!doctype html><meta charset="utf-8"><title>Paiement</title>
<body style="font-family:Inter,system-ui;padding:24px;background:#0b0b0b;color:#fff">
  <h2>⚠️ Paiement indisponible</h2>
  <p>${msg}</p>
  <p>Revenez au <a href="${site}/simulator.html" style="color:#C7A24B">simulateur</a> et relancez la réservation.</p>
</body>`
      };
    }

    // --- Règle d’encaissement (20% par défaut, 100% si demandé)
    const payFull =
      (params.pay === "full") || (canon && canon.pay_mode === "full");

    const base = Number(canon.price_eur || 0);
    const amount = payFull ? base : base * 0.20;
    const cents = Math.max(Math.round(amount * 100), 50); // min 0,50 €

    const label =
      (payFull ? "Paiement 100% — " : "Acompte 20% — ") +
      (canon.type === "mad" ? `MAD ${canon.mad_hours || "?"}h` : "Course") +
      ` • ${new Date(canon.whenISO).toLocaleString("fr-FR")}`;

    const desc = (canon.type === "mad")
      ? `Mise à disposition ${canon.mad_hours || "?"}h — Départ: ${canon.from}`
      : `Trajet • De: ${canon.from} • À: ${canon.to || ""}`;

    // --- Création unique de la session Checkout
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      locale: "fr",
      currency: "eur",
      // payment_method_types facultatif sur les dernières versions
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: cents,
          product_data: { name: label, description: desc },
        },
      }],
      success_url: `${site}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/simulator.html?canceled=1`,
      metadata: {
        // Pour la page /merci.html
        pay_mode: payFull ? "full" : "deposit",
        type: canon.type || "",
        whenISO: canon.whenISO,
        from: canon.from || "",
        to: canon.to || "",
        mad_hours: String(canon.mad_hours || ""),
        price_eur: String(base || ""),
      },
    });

    // --- Redirection HTTP vers Stripe
    return {
      statusCode: 303,
      headers: {
        Location: checkoutSession.url,
        "Cache-Control": "no-store",
      },
      body: "",
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Stripe redirect error" };
  }
};
