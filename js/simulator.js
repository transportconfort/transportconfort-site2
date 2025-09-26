(async function () {
 const cfg = await TC.loadConfig();

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
  const map = new google.maps.Map(els.map, { center: { lat: 48.987, lng: 2.3 }, zoom: 11, mapTypeControl: false, fullscreenControl: false, streetViewControl: false });
  const ds = new google.maps.DirectionsService();
  const dr = new google.maps.DirectionsRenderer({ map });

  function isNightWeekend(dt) {
    const h = dt.getHours();
    const isN = (h >= 23 || h < 7);
    const d = dt.getDay();
    const isWE = (d === 0 || d === 6);
    return isN || isWE;
  }

  function price(dist, dur, when) {
    const min = 10, perKm = 1.6, perMin = 0.55, surge = isNightWeekend(when) ? 1.2 : 1;
    let amt = (perKm * (dist / 1000)) + (perMin * (dur / 60));
    if (amt < min) amt = min;
    return Math.round(amt * surge * 100) / 100;
  }

  async function estimate() {
    const from = els.from.value.trim();
    const to = els.to.value ? els.to.value.trim() : '';
    const dateStr = els.date.value;
    const timeStr = els.time.value;
    const dt = new Date((dateStr || '') + "T" + (timeStr || '') + ":00");
    const modeMadEl = document.getElementById('mode-mad');
    const modeMad = !!(modeMadEl && modeMadEl.checked);

    if (!from) { alert("Renseignez l’adresse de prise en charge."); return; }
    if (!dateStr || !timeStr) { alert("Sélectionnez la date et l’heure."); return; }

    // MAD (mise à dispo) : tarif horaire
    if (modeMad) {
      const sel = document.getElementById('mad-hours');
      const h = sel ? Number(sel.value || 1) : 1;
      const madRates = { 1: 100, 2: 90, 3: 80, 4: 75, 8: 70 };
      const hourly = madRates[h] || 120;
      let total = hourly * h;
      if (isNightOrWeekend(dateStr, timeStr)) total = Math.round(total * 1.2);

      const distEl = document.getElementById('distance');
      const durEl = document.getElementById('duration');
      const totalEl = document.getElementById('total');
      if (distEl) distEl.textContent = '—';
      if (durEl) durEl.textContent = h + " h";
      if (totalEl) totalEl.textContent = TC.fmtMoney(total);

      els.pay20.disabled = false;
      els.pay100.disabled = false;
      els.calendlyBtn.disabled = false;

      window._TC_LAST = { type: 'MAD', mode: 'mad', from, to: '', whenISO: dt.toISOString(), mad_hours: h, price_eur: total };
      try { if (window.dr) { window.dr.set('directions', null); } } catch (e) { /* noop */ }
      return;
    }

    // Courses classiques / aéroports
    if (!to) { alert("Renseignez l’adresse d’arrivée."); return; }

    const route = await ds.route({
      origin: from,
      destination: to,
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: { departureTime: dt, trafficModel: 'bestguess' }
    });
    dr.setDirections(route);

    const dm = new google.maps.DistanceMatrixService();
    const r = await dm.getDistanceMatrix({
      origins: [from],
      destinations: [to],
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: { departureTime: dt, trafficModel: 'bestguess' }
    });
    const cell = r.rows[0].elements[0];
    const dist = cell.distance.value;
    const dur = (cell.duration_in_traffic || cell.duration).value;

    const p = price(dist, dur, dt);
    els.distance.textContent = (dist / 1000).toFixed(1) + " km";
    els.duration.textContent = Math.round(dur / 60) + " min";
    els.total.textContent = TC.fmtMoney(p);

    els.pay20.disabled = false;
    els.pay100.disabled = false;
    els.calendlyBtn.disabled = false;

    window._TC_LAST = { type: 'COURSE', from, to, whenISO: dt.toISOString(), dist_m: dist, dur_s: dur, price_eur: p };
  }

  // ===== Stripe Pay (corrigé) =====
  async function pay(payFull = false) {
    try {
      if (!window._TC_LAST) {
        alert('Faites une estimation d’abord.');
        return;
      }

      const stripePk =
        cfg.STRIPE_PUBLISHABLE_KEY ||
        window.STRIPE_PUBLISHABLE_KEY ||
        (window.TC_conf && TC_conf.STRIPE_PUBLISHABLE_KEY);

      if (!stripePk || !window.Stripe) {
        alert('Stripe non configuré.');
        return;
      }

      const stripe = Stripe(stripePk);
      let card = window._stripeElements && window._stripeElements.getElement && window._stripeElements.getElement('card');

      if (!card) {
        const el = document.getElementById('card-element');
        if (!el) {
          alert('Zone carte manquante (#card-element).');
          return;
        }
        const elements = stripe.elements();
        card = elements.create('card');
        card.mount(el);
        // Optionnel : conserver globalement
        window._stripeElements = elements;
      }

      const status = document.getElementById('status');
      if (status) status.textContent = 'Création du paiement…';

      const amount_eur = Math.round(Math.max(window._TC_LAST.price_eur || 0, 0) * 100);
      const meta = Object.assign({}, window._TC_LAST || {}, { pay_mode: payFull ? 'FULL' : 'DEPOSIT' });

      const resp = await fetch('/.netlify/functions/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_eur, metadata: meta })
      });
      if (!resp.ok) throw new Error(await resp.text());
      const { clientSecret } = await resp.json();

      const result = await stripe.confirmCardPayment(clientSecret, {
        payment_method: {
          card,
          billing_details: { name: 'Client Transport Confort' }
        }
      });

      if (result.error) throw result.error;

      if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
        if (status) {
          status.style.color = '#2ecc71';
          status.textContent = '✅ Paiement confirmé. Vous pouvez finaliser la réservation dans Calendly.';
        }
      } else {
        if (status) status.textContent = '🕓 Paiement en attente de validation (3-D Secure)…';
      }
    } catch (e) {
      console.error(e);
      const status = document.getElementById('status');
      if (status) {
        status.style.color = '#ff5252';
        status.textContent = '❌ Paiement refusé/indisponible.';
      }
      alert('❌ Paiement indisponible pour le moment.');
    }
  }

  function calendly() {
    const calMAD = (cfg.CALENDLY_MAD || '').trim();
    const calVTC = (cfg.CALENDLY_VTC || window.CALENDLY_URL || '').trim();
    const cal = (document.getElementById('mode-mad')?.checked ? calMAD : calVTC);

    if (!cal) { alert("Lien Calendly non configuré."); return; }
    if (!window._TC_LAST) { alert("Faites une estimation d'abord."); return; }

    const url = new URL(cal);
    url.searchParams.set("name", "Client Transport Confort");
    url.searchParams.set("start_time", window._TC_LAST.whenISO);
    url.searchParams.set("utm_content", JSON.stringify(window._TC_LAST));
    window.open(url.toString(), "_blank");
  }

  // Bind UI
  els.estimateBtn.addEventListener('click', estimate);
  els.pay20.addEventListener('click', () => pay(false));
  els.pay100.addEventListener('click', () => pay(true));
  els.calendlyBtn.addEventListener('click', calendly);
})();

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

function detectAirportForfait(fromText, toText) {
  const t = (fromText + ' ' + toText).toLowerCase();
  let airport = null;
  if (t.includes('orl') || t.includes('orly')) airport = 'ORY';
  if (t.includes('roissy') || t.includes('charles de gaulle') || t.includes('cdg')) airport = 'CDG';
  if (t.includes('beauvais') || t.includes('bva') || t.includes('tillé')) airport = 'BVA';
  return airport;
}

const FORFAITS = {
  ORY: { day: 60, night: 70 },
  CDG: { day: 90, night: 105 },
  BVA: { day: 170, night: 190 }
};

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

function addMADControls() {
  if (document.getElementById('mad-hours')) return;
  const modeMad = document.getElementById('mode-mad');
  const modeCourse = document.getElementById('mode-course');
  const passengers = document.getElementById('passengers');
  const toInput = document.getElementById('to');
  const toLabel = toInput ? toInput.previousElementSibling : null;

  const passengersRow = passengers ? passengers.parentElement : null;
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>Durée (MAD)</label><select id="mad-hours" class="input">
    <option value="1">1h (120 €)</option>
    <option value="2">2h (110 €/h)</option>
    <option value="3">3h (100 €/h)</option>
    <option value="4">4h (95 €/h)</option>
    <option value="8">8h (85 €/h)</option>
  </select>`;
  if (passengersRow && passengersRow.after) { passengersRow.after(row); }
  row.style.display = 'none';

  function sync() {
    const isMad = !!(modeMad && modeMad.checked);
    row.style.display = isMad ? 'flex' : 'none';
    if (toInput) { toInput.style.display = isMad ? 'none' : ''; }
    if (toLabel) { toLabel.style.display = isMad ? 'none' : ''; }
  }
  if (modeCourse) modeCourse.addEventListener('change', sync);
  if (modeMad) modeMad.addEventListener('change', sync);
  sync();
}
document.addEventListener('DOMContentLoaded', addMADControls);

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('openDate');
  const inp = document.getElementById('date');
  if (btn && inp) {
    btn.addEventListener('click', () => { if (inp.showPicker) inp.showPicker(); else inp.focus(); });
  }
});
