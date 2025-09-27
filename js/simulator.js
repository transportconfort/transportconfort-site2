(async function () {
 const cfg = await TC.loadConfig();

 // === BARÈMES OFFICIELS ===

// MAD : totaux fixes (pas de +20%)
const MAD_TOTALS = { 1: 100, 2: 180, 3: 240, 4: 300, 8: 560 };

// Aéroports : montants fixes jour/nuit
const FORFAITS = {
  ORY: { day: 60,  night: 70  },
  CDG: { day: 80,  night: 90  },
  BVA: { day: 150, night: 170 }
};

// Enghien (Casino/Théâtre) : 5/10/20/30 km, au-delà => classique
function enghienBandKm(km) {
  if (km <= 5)  return { day: 15, night: 20 };
  if (km <= 10) return { day: 25, night: 30 };
  if (km <= 20) return { day: 50, night: 60 };
  if (km <= 30) return { day: 70, night: 80 };
  return null;
}

async function loadGmaps() {
  const r = await fetch('/.netlify/functions/public-gmaps-key');
  const { key } = await r.json();
  await TC.addScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places`);
}
await loadGmaps();

  const els = {
    from: TC.q('#from'),
    to: TC.q('#to'),
    date: TC.q('#date'),
    time: TC.q('#time'),
    pax: TC.q('#pax'),
    estimateBtn: TC.q('#estimate'),
    calendlyBtn: TC.q('#calendly'),
    pay20: TC.q('#pay20'),
    pay100: TC.q('#pay100'),
    distance: TC.q('#distance'),
    duration: TC.q('#duration'),
    total: TC.q('#total'),
    map: TC.q('#map')
  };

  // Pré-remplir date/heure (T+120 min, arrondi 5 min)
  els.time.step = 300;
  const now = new Date();
  now.setMinutes(now.getMinutes() + 120);
  now.setSeconds(0, 0);
  const step = 5;
  now.setMinutes(Math.ceil(now.getMinutes() / step) * step);
  els.date.value = now.toISOString().slice(0, 10);
  els.time.value = now.toTimeString().slice(0, 5);

  // Si <select>, remplir 00:00 → 23:55
  if (els.time && els.time.tagName === 'SELECT') {
    els.time.innerHTML = '';
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 5) {
        const hh = String(h).padStart(2, '0'), mm = String(m).padStart(2, '0');
        const opt = document.createElement('option');
        opt.value = `${hh}:${mm}`;
        opt.textContent = `${hh}:${mm}`;
        els.time.appendChild(opt);
      }
    }
  }

  // Autocomplete
  new google.maps.places.Autocomplete(els.from, { componentRestrictions: { country: "fr" } });
  new google.maps.places.Autocomplete(els.to, { componentRestrictions: { country: "fr" } });

// Carte + itinéraire
const map = new google.maps.Map(els.map, {
  center: { lat: 48.987, lng: 2.3 },
  zoom: 11,
  mapTypeControl: false,
  fullscreenControl: false,
  streetViewControl: false
});
const ds = new google.maps.DirectionsService();
const dr = new google.maps.DirectionsRenderer({ map });

 
  function price(dist, dur, when) {
  const min = 10, perKm = 1.6, perMin = 0.55;
  const isNW = isNightOrWeekend(
    when.toISOString().slice(0, 10),
    when.toTimeString().slice(0, 5)
  );
  let amt = (perKm * (dist / 1000)) + (perMin * (dur / 60));
  if (amt < min) amt = min;
  return Math.round(amt * (isNW ? 1.2 : 1) * 100) / 100;
}

  async function estimate() {
  const from    = els.from.value.trim();
  const to      = (els.to.value || '').trim();
  const dateStr = els.date.value;
  const timeStr = els.time.value;
  const dt      = new Date((dateStr || '') + 'T' + (timeStr || '') + ':00');
  const modeMad = !!document.getElementById('mode-mad')?.checked;

  if (!from) { alert('Renseignez l’adresse de prise en charge.'); return; }
  if (!dateStr || !timeStr) { alert('Sélectionnez la date et l’heure.'); return; }

  // ========== MISE À DISPOSITION (MAD) – forfaits fixes ==========
  if (modeMad) {
    const sel = document.getElementById('mad-hours');
    const h   = sel ? Number(sel.value || 1) : 1;
    let total = MAD_TOTALS[h];
    if (total == null) total = 100 * h; // secours

    // UI
    els.distance.textContent = '—';
    els.duration.textContent = h + ' h';
    els.total.textContent    = TC.fmtMoney(total);
    const totalLbl = document.getElementById('totalLabel');
    if (totalLbl) { totalLbl.textContent = `MAD ${h}h`; totalLbl.style.display = ''; }

    // Actions
    els.pay20.disabled = false;
    els.pay100.disabled = false;
    els.calendlyBtn.disabled = false;

    // Contexte de réservation/paiement
    window._TC_LAST = {
      type: 'MAD',
      mode: 'mad',
      from,
      to: '',
      whenISO: dt.toISOString(),
      mad_hours: h,
      price_eur: total,
      label: `MAD ${h}h`
    };

    // Nettoie un éventuel itinéraire affiché
    try { if (window.dr) window.dr.set('directions', null); } catch (_) {}
    return; // pas de Google Distance pour MAD
  }

  // ========== COURSES / FORFAITS ==========
  if (!to) { alert('Renseignez l’adresse d’arrivée.'); return; }

  // On trace un itinéraire (utile pour récupérer les coords legs + UX)
  const route = await ds.route({
    origin: from,
    destination: to,
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: dt, trafficModel: 'bestguess' }
  });
  dr.setDirections(route);

  // 1) Forfait AÉROPORT (si un des deux points est Paris)
  const fromText = els.from.value || '';
  const toText   = els.to.value   || '';
  const isNW     = isNightOrWeekend(dateStr, timeStr);
  const ap       = detectAirportCode(fromText, toText);

  if (ap && isParisLeg(fromText, toText)) {
    const base = AIRPORT_FORFAITS[ap][isNW ? 'night' : 'day'];

    els.distance.textContent = '—';
    els.duration.textContent = '—';
    els.total.textContent    = TC.fmtMoney(base);
    const totalLbl = document.getElementById('totalLabel');
    if (totalLbl) { totalLbl.textContent = `Forfait ${ap} ${isNW ? 'nuit/WE' : 'jour'}`; totalLbl.style.display = ''; }

    els.pay20.disabled = false;
    els.pay100.disabled = false;
    els.calendlyBtn.disabled = false;

    window._TC_LAST = {
      type: 'FORFAIT_AEROPORT',
      airport: ap,
      from, to,
      whenISO: dt.toISOString(),
      price_eur: base,
      label: `Forfait ${ap} ${isNW ? 'nuit/WE' : 'jour'}`
    };
    return;
  }

  // 2) Forfait ENGHIEN (si l’un des 2 points est ≤ 30 km du centre)
  const leg = route.routes?.[0]?.legs?.[0];
  if (leg) {
    const start = { lat: leg.start_location.lat(), lng: leg.start_location.lng() };
    const end   = { lat: leg.end_location.lat(),   lng: leg.end_location.lng() };

    const dStart = haversineKm(start, ENGHIEN);
    const dEnd   = haversineKm(end,   ENGHIEN);
    const dMin   = Math.min(dStart, dEnd);

    const eng = computeEnghienForfait(dMin, isNW);
    if (eng) {
      els.distance.textContent = '—';
      els.duration.textContent = '—';
      els.total.textContent    = TC.fmtMoney(eng.total);
      const totalLbl = document.getElementById('totalLabel');
      if (totalLbl) { totalLbl.textContent = eng.label; totalLbl.style.display = ''; }

      els.pay20.disabled = false;
      els.pay100.disabled = false;
      els.calendlyBtn.disabled = false;

      window._TC_LAST = {
        type: 'FORFAIT_ENGHIEN',
        from, to,
        whenISO: dt.toISOString(),
        price_eur: eng.total,
        label: eng.label,
        km_to_enghien: Math.round(dMin * 10) / 10
      };
      return;
    }

  // 3) TARIF CLASSIQUE (km + min, +20 % nuit/WE)
  const dm  = new google.maps.DistanceMatrixService();
  const r   = await dm.getDistanceMatrix({
    origins: [from],
    destinations: [to],
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: { departureTime: dt, trafficModel: 'bestguess' }
  });
  const cell = r.rows[0].elements[0];
  const dist = cell.distance.value;                          // en mètres
  const dur  = (cell.duration_in_traffic || cell.duration).value; // en secondes

  const p = price(dist, dur, dt); // ta fonction existante (min 10€, 1.60€/km, 0.55€/min, +20% nuit/WE)
  els.distance.textContent = (dist / 1000).toFixed(1) + ' km';
  els.duration.textContent = Math.round(dur / 60) + ' min';
  els.total.textContent    = TC.fmtMoney(p);
  const totalLbl = document.getElementById('totalLabel');
  if (totalLbl) { totalLbl.textContent = 'Tarif classique'; totalLbl.style.display = ''; }

  els.pay20.disabled = false;
  els.pay100.disabled = false;
  els.calendlyBtn.disabled = false;

  window._TC_LAST = {
    type: 'COURSE',
    from, to,
    whenISO: dt.toISOString(),
    dist_m: dist,
    dur_s: dur,
    price_eur: p,
    label: 'Tarif classique'
  };
}

// ===== Paiement via Stancer (paylink) =====
async function pay(payFull = false) {
  try {
    if (!window._TC_LAST) {
      alert('Faites une estimation d’abord.');
      return;
    }

    // Prépare la charge selon le mode
    const isMAD = (window._TC_LAST.type === 'MAD' || document.getElementById('mode-mad')?.checked);
    const payload = {
      type: isMAD ? 'mad' : 'course',
      from: window._TC_LAST.from || els.from.value,
      to: window._TC_LAST.to || els.to.value,
      dateISO: window._TC_LAST.whenISO,
      dureeHeures: isMAD ? (window._TC_LAST.mad_hours || Number(document.getElementById('mad-hours')?.value || 1)) : undefined
    };

    // Appelle la fonction Netlify → calcule prix (Google si course) → crée paylink Stancer
    const resp = await fetch('/.netlify/functions/paylink-from-simulator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error('Stancer error:', txt);
      alert('❌ Paiement indisponible pour le moment.');
      return;
    }

    const { paylink } = await resp.json();
    if (!paylink) {
      alert('❌ Lien de paiement introuvable.');
      return;
    }

    // Redirection unique vers la page de paiement Stancer
    window.location.href = paylink;
  } catch (e) {
    console.error(e);
    alert('❌ Erreur pendant l’initialisation du paiement.');
  }
}

  
  function calendly() {
  if (window.openInlineCalendly) {
    window.openInlineCalendly();   // ouvre l'embed inline en bas de page
  } else {
    alert("Calendly se charge… réessayez dans 1 seconde.");
  }
}

  // Bind UI
  els.estimateBtn.addEventListener('click', estimate);
  els.pay20.addEventListener('click', () => pay(false));
  els.pay100.addEventListener('click', () => pay(true));
  els.calendlyBtn.addEventListener('click', calendly);


// ===== Utilitaires hors IIFE =====
function isNightOrWeekend(dateStr, timeStr) {
  try {
    const [y, m, d] = (dateStr || '').split('-').map(Number);
    const [hh, mm] = (timeStr || '').split(':').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
    const day = dt.getDay();               // 0=dimanche
    const hour = dt.getHours();
    const isWE = (day === 0 || day === 6);
    const isNight = (hour >= 23 || hour < 7);
    return isNight || isWE;
  } catch (e) { return false; }
}

// ------ Helpers forfaits (Aéroports + Enghien) ------

// Nuit/WE (23:00–07:00 ou samedi/dimanche) : sert à choisir le tarif nuit des forfaits Enghien,
// et pour la +20% des courses classiques (déjà gérée dans price()).
function isNightOrWeekend(dateStr, timeStr) {
  try {
    const [y, m, d] = (dateStr || '').split('-').map(Number);
    const [hh, mm] = (timeStr || '').split(':').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
    const day = dt.getDay(); // 0=dimanche
    const hour = dt.getHours();
    const isWE = (day === 0 || day === 6);
    const isNight = (hour >= 23 || hour < 7);
    return isNight || isWE;
  } catch (e) { return false; }
}

// Aéroports (depuis/vers PARIS uniquement)
const AIRPORT_FORFAITS = {
  ORY: { day: 60,  night: 70  },
  CDG: { day: 80,  night: 90  },
  BVA: { day: 150, night: 170 }
};

// Détection par texte (simple et robuste pour ton usage)
function detectAirportCode(fromText, toText) {
  const t = (fromText + ' ' + toText).toLowerCase();
  if (t.includes('orly') || t.includes('ory')) return 'ORY';
  if (t.includes('roissy') || t.includes('charles de gaulle') || t.includes('cdg')) return 'CDG';
  if (t.includes('beauvais') || t.includes('tillé') || t.includes('bva')) return 'BVA';
  return null;
}

// Vérifie si un des deux champs mentionne "paris"
function isParisLeg(fromText, toText) {
  const f = (fromText || '').toLowerCase();
  const t = (toText   || '').toLowerCase();
  return f.includes('paris') || t.includes('paris');
}

// Enghien-les-Bains (Casino/Théâtre) – centre de référence
const ENGHIEN = { lat: 48.9697, lng: 2.3091 };

// Haversine (km)
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Calcule le forfait Enghien en fonction de la distance au centre ENGHien
// Retourne {total, label} ou null si > 30 km (pas de forfait).
function computeEnghienForfait(kmToEnghien, isNightWE) {
  let band = null;
  if (kmToEnghien <= 5)       band = isNightWE ? { price: 20, label: 'Forfait Enghien 5 km (nuit/WE)' } 
                                              : { price: 15, label: 'Forfait Enghien 5 km (jour)' };
  else if (kmToEnghien <= 10) band = isNightWE ? { price: 30, label: 'Forfait Enghien 10 km (nuit/WE)' } 
                                              : { price: 25, label: 'Forfait Enghien 10 km (jour)' };
  else if (kmToEnghien <= 20) band = isNightWE ? { price: 60, label: 'Forfait Enghien 20 km (nuit/WE)' } 
                                              : { price: 50, label: 'Forfait Enghien 20 km (jour)' };
  else if (kmToEnghien <= 30) band = isNightWE ? { price: 80, label: 'Forfait Enghien 30 km (nuit/WE)' } 
                                              : { price: 70, label: 'Forfait Enghien 30 km (jour)' };
  return band ? { total: band.price, label: band.label } : null;
}

function applyPricing(distanceKm, durationMin, dateStr, timeStr, fromText, toText, mode, madHours) {
  const NIGHT_OR_WE = isNightOrWeekend(dateStr, timeStr);

  // MAD
  if (mode === 'mad') {
    const madRates = { 1: 100, 2: 90, 3: 80, 4: 75, 8: 70 };
    let h = Number(madHours || 1);
    if (!madRates[h]) h = 1;
    let hourly = madRates[h];
    let total = hourly * h;
    if (NIGHT_OR_WE) total = Math.round(total * 1.2);
    return { total, base: total, label: `MAD ${h}h @ ${hourly}€/h` };
  }

  // Forfaits aéroports
  const airport = detectAirportForfait(fromText, toText);
  if (airport) {
    const f = FORFAITS[airport];
    let base = NIGHT_OR_WE ? f.night : f.day;
    return { total: base, base, label: `Forfait ${airport} ${NIGHT_OR_WE ? 'nuit/WE' : 'jour'}` };
  }

  // Classique
  const PRICE_PER_KM = 1.60;
  const PRICE_PER_MIN = 0.55;
  const MINIMUM = 10.0;
  let base = Math.max(MINIMUM, PRICE_PER_KM * distanceKm + PRICE_PER_MIN * durationMin);
  if (NIGHT_OR_WE) base *= 1.2;
  base = Math.round(base * 100) / 100;
  return { total: base, base, label: 'Tarif classique' };
}

async function computeAndDisplay(result) {
  const els = {
    from: document.getElementById('from'),
    to: document.getElementById('to'),
    date: document.getElementById('date'),
    time: document.getElementById('time'),
    modeCourse: document.getElementById('mode-course'),
    modeMAD: document.getElementById('mode-mad'),
    durationMAD: document.getElementById('mad-hours')
  };
  const mode = (els.modeMAD && els.modeMAD.checked) ? 'mad' : 'course';
  const madHours = els.durationMAD ? els.durationMAD.value : 1;
  const pricing = applyPricing(result.distanceKm, result.durationMin, els.date.value, els.time.value, els.from.value, els.to.value, mode, madHours);

  const discounted = Math.round(pricing.total * 100) / 100; // (si tu appliques -15% un jour, calcule-le ici)
  const panelTotal = document.getElementById('totalPanel');
  if (panelTotal) {
    panelTotal.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px">
      <div><small>${pricing.label}</small></div>
      <div><small>Prix normal :</small> <s>${pricing.total.toFixed(2)} € TTC</s></div>
      <div><b>Total estimé :</b> ${discounted.toFixed(2)} € TTC</div>
    </div>`;
  }
  window.__lastEstimate = { ...result, total: discounted, label: pricing.label, base: pricing.total };
}

document.addEventListener('DOMContentLoaded', addMADControls);

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('openDate');
  const inp = document.getElementById('date');
  if (btn && inp) {
    btn.addEventListener('click', () => { if (inp.showPicker) inp.showPicker(); else inp.focus(); });
  }
});
  
function syncModeUI() {
  const isMad   = document.getElementById('mode-mad')?.checked;
  const madRow  = document.getElementById('mad-row');
  const toInput = document.getElementById('to');
  const toLabel = toInput ? toInput.previousElementSibling : null;

  if (madRow)  madRow.style.display  = isMad ? 'flex' : 'none';
  if (toInput) toInput.style.display = isMad ? 'none' : '';
  if (toLabel) toLabel.style.display = isMad ? 'none' : '';
}

// === hooks DOM ===
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('mode-mad')?.addEventListener('change', syncModeUI);
  document.getElementById('mode-course')?.addEventListener('change', syncModeUI);
  syncModeUI(); // appel initial au chargement
});
})(); // fin de l’IIFE
