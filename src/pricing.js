// src/pricing.js (CommonJS pour simplicité Netlify)
function isNightOrWeekend(dateISO){
  if(!dateISO) return false;
  const d = new Date(dateISO);
  if (isNaN(d)) return false;
  const h = d.getHours();
  const day = d.getDay(); // 0=dim, 6=sam
  return (h >= 23 || h < 7) || (day === 0 || day === 6);
}

function madHourlyRateEUR(h){
  if (h <= 1) return 100;
  if (h <= 2) return 90;
  if (h <= 3) return 80;
  if (h <= 4) return 75;
  return 70; // ≥8h
}

function computeCourseTTC({distanceKm=0,durationMin=0,dateISO=null,pickupFeeEUR=10,perKmEUR=1.60,perMinEUR=0.55}={}){
  const base = pickupFeeEUR + (perKmEUR*distanceKm) + (perMinEUR*durationMin);
  const ttc = Math.max(0.5, base * (isNightOrWeekend(dateISO) ? 1.20 : 1.00));
  const tvaRate = 10; // transport de personnes
  return {
    amountCents: Math.round(ttc*100),
    tvaRate,
    description: `Course classique${isNightOrWeekend(dateISO)?" (maj. Nuit/WE)":""} — ${distanceKm.toFixed(1)} km, ${Math.round(durationMin)} min`
  };
}

function computeMadTTC({dureeHeures=1,dateISO=null}={}){
  const base = madHourlyRateEUR(dureeHeures) * Math.max(1, Math.ceil(dureeHeures));
  const ttc = Math.max(0.5, base * (isNightOrWeekend(dateISO) ? 1.20 : 1.00));
  const tvaRate = 20; // mise à disposition
  return {
    amountCents: Math.round(ttc*100),
    tvaRate,
    description: `Mise à disposition${isNightOrWeekend(dateISO)?" (maj. Nuit/WE)":""} — ${Math.ceil(dureeHeures)} h`
  };
}

// Point d'entrée unique
async function computeTTC(p={}){
  const ev = String(p.eventType||"").toLowerCase();
  if (ev.includes("mad") || ev.includes("mise")) {
    return computeMadTTC({ dureeHeures: Number(p.dureeHeures||1), dateISO: p.startISO });
  }
  const hasD = Number(p.distanceKm||0)>0;
  const hasT = Number(p.durationMin||0)>0;
  if (!hasD && !hasT) {
    // Si on ne connaît pas distance/durée (réservation Calendly brute) : acompte
    return { amountCents: 2000, tvaRate: 10, description: "Acompte course classique" };
  }
  return computeCourseTTC({
    distanceKm: Number(p.distanceKm||0),
    durationMin: Number(p.durationMin||0),
    dateISO: p.startISO
  });
}

module.exports = { computeTTC, isNightOrWeekend, madHourlyRateEUR, computeCourseTTC, computeMadTTC };
