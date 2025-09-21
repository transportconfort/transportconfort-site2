
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      GMAPS_KEY: process.env.GMAPS_KEY || process.env.GMAPS_PUBLIC || null,
      CALENDLY_VTC: process.env.CALENDLY_VTC || null,
      CALENDLY_MAD: process.env.CALENDLY_MAD || null,
      STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || null,
      SUCCESS_URL: process.env.SUCCESS_URL || null,
      CANCEL_URL: process.env.CANCEL_URL || null,
      SITE_URL: process.env.SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || null
    })
  };
};
