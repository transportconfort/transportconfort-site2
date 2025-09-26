// Renvoie la clé navigateur (restreinte par referrer) depuis les variables d'env Netlify
exports.handler = async () => {
  const key = process.env.GMAPS_KEY || "";
  if (!key) return { statusCode: 500, body: "GMAPS_KEY manquante" };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    body: JSON.stringify({ key })
  };
};
