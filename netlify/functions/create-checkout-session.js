
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY||'');
exports.handler = async (event)=>{
  if(event.httpMethod!=='POST'){return{statusCode:405,body:'Method not allowed'}};
  try{
    if(!process.env.STRIPE_SECRET_KEY){return{statusCode:503,body:'Stripe non configuré (clé secrète manquante).'}};
    const {amount_eur, metadata}=JSON.parse(event.body||'{}'); if(!amount_eur||amount_eur<1){return{statusCode:400,body:'Montant invalide.'}};
    const unit_amount=Math.round(amount_eur*100); const site=process.env.SITE_URL||'https://transportconfort.com';
    const session=await stripe.checkout.sessions.create({mode:'payment',payment_method_types:['card'],line_items:[{quantity:1,price_data:{currency:'eur',unit_amount,product_data:{name:metadata&&metadata.price_eur?`Acompte/Trajet VTC — ${metadata.price_eur} € TTC`:'Paiement VTC',description:metadata?`De ${metadata.from} à ${metadata.to} — ${Math.round((metadata.dist_m||0)/1000)} km — ${Math.round((metadata.dur_s||0)/60)} min`:undefined}}}],success_url:`${site}/simulator.html?paid=1`,cancel_url:`${site}/simulator.html?canceled=1`,metadata:{...(metadata||{}),amount_eur:amount_eur}});
    return{statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify({id:session.id,url:session.url})};
  }catch(e){console.error(e);return{statusCode:500,body:'Erreur Stripe'}}
};
