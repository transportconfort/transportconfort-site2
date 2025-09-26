// netlify/functions/calendly-to-stancer.js
// Reçoit la redirection Calendly, calcule le TTC, crée un paylink Stancer, puis 302 vers la page de paiement.
const { computeTTC } = require("../../src/pricing.js");

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl || `https://dummy${event.rawQueryString ? '?'+event.rawQueryString : ''}`);
    const p = Object.fromEntries(url.searchParams.entries());

    const eventType = (p.event_type_name || p.event_type || "").toLowerCase();
    const startISO = p.event_start_time || null;

    // Questions personnalisées (Calendly "Pass event details")
    const from = p.a1 || p.depart || "";
    const to = p.a2 || p.arrivee || "";
    const dureeHeures = Number(p.a3 || p.duree || 0);
    const pax = Number(p.a4 || p.pax || 1);

    // Si ton simulateur passe distance/durée en query
    const distanceKm = Number(p.distance || p.distance_km || 0);
    const durationMin = Number(p.duration || p.duration_min || 0);

    const pricing = await computeTTC({ eventType, startISO, from, to, dureeHeures, pax, distanceKm, durationMin });
    if (!pricing?.amountCents || pricing.amountCents < 50) {
      return { statusCode: 400, body: "Montant invalide" };
    }

    const secret = process.env.STANCER_SECRET_KEY;
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://example.com";
    if (!secret) return { statusCode: 500, body: "Missing STANCER_SECRET_KEY" };

    const payload = {
      amount: pricing.amountCents,
      currency: "EUR",
      description: pricing.description || "Paiement VTC",
      capture: true,
      method: "link",
      references: { eventType, tvaRate: pricing.tvaRate, from, to, dureeHeures, pax, distanceKm, durationMin },
      return_url: `${baseUrl}/paiement/success`,
      cancel_url: `${baseUrl}/paiement/cancel`
    };

    const resp = await fetch("https://api.stancer.com/v1/charges", {
      method: "POST",
      headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: 400, body: "Erreur Stancer" };

    const paylink = data.link || data.hosted_payment_url;
    if (!paylink) return { statusCode: 400, body: "Lien paiement introuvable" };

    // Redirection unique vers Stancer
    return { statusCode: 302, headers: { Location: paylink } };
  } catch (e) {
    return { statusCode: 500, body: "Erreur serveur" };
  }
};
