// netlify/functions/stancer-webhook.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    const body = JSON.parse(event.body || "{}");
    console.log("Stancer webhook:", body?.type || body?.event, (body?.data||body?.object)?.id);
    // TODO: ici tu peux : envoyer un email, pousser en compta, etc.
    return { statusCode: 200, body: "ok" };
  } catch (e) {
    return { statusCode: 500, body: "error" };
  }
};
