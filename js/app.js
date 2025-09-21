
window.TC={fmtMoney(e){return new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(e)},q:s=>document.querySelector(s),ce:(t,a={})=>Object.assign(document.createElement(t),a),addScript(src){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.async=true;s.onload=res;s.onerror=rej;document.head.appendChild(s);});}};


/** Load config from Netlify Function (preferred) then /config.json fallback */
TC._config=null;
TC.loadConfig=async function(){
  if(TC._config) return TC._config;
  async function tryFetch(url){
    try{ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error('http '+r.status); return await r.json(); }
    catch(e){ console.warn('config fetch failed', url, e); return null; }
  }
  let cfg = await tryFetch('/.netlify/functions/config');
  if(!cfg) cfg = await tryFetch('/config.json');
  TC._config = cfg||{};
  return TC._config;
};
