exports.handler = async () => {
  const k = process.env.STRIPE_SECRET_KEY || "";
  const safe = k
    ? (k.startsWith("sk_live_") ? "sk_live_" : "sk_test_") + k.slice(8, 14)
    : "absente";

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain" },
    body: `STRIPE_SECRET_KEY chargée: ${safe}`,
  };
};
