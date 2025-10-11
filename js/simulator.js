/* simulator.js — version nettoyée (estimation + Calendly uniquement) */
(async function () {
  // Charge config + Google Maps
  const cfg = await TC.loadConfig();

  async function loadGmaps() {
    const r = await fetch('/.netlify/functions/public-gmaps-key');
    const { key } = await r.json();
    await TC.addScript(
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places`
    );
  }
  await loadGmaps();

  // ====== Barèmes ======
  const MAD_TOTALS = { 1: 100, 2: 180, 3: 240, 4: 300, 8: 560 };
  const FORFAITS = {
    ORY: { day: 60, night: 70 },
    CDG: { day: 80, night: 90 },
    BVA: { day: 150, night: 170 },
  };
  // Casino Barrière, 3 Av. de Ceinture, 95880 Enghien-les-Bains
  const ENGHIEN   = { lat: 48.96992, lng: 2.30939 };
  const R_ENGHIEN = 0.6; // km — rayon d’attache très court

  // ====== DOM ======
  const els = {
    from: TC.q('#from'),
    to: TC.q('#to'),
    date: TC.q('#date'),
    time: TC.q('#time'),
    pax: TC.q('#pax'),
    estimateBtn: TC.q('#estimate'),
    calendlyBtn: TC.q('#calendly'),
    distance: TC.q('#distance'),
    duration: TC.q('#duration'),
    total: TC.q('#total'),
    map: TC.q('#map'),
  };

  // ====== UI MAD : injecte la ligne "Durée" s'il n'existe pas, et masque "Arrivée" en MAD ======
  function ensureMadRow() {
    let row = document.getElementById('mad-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'mad-row';
      row.style.display = 'none';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      row.style.marginTop = '8px';
      row.innerHTML = `
        <label for="mad-hours" style="min-width:140px;">Durée (MAD)</label>
        <select id="mad-hours" class="input">
          <option value="1">1 h</option>
          <option value="2">2 h</option>
          <option value="3">3 h</option>
          <option value="4">4 h</option>
          <option value="8">8 h (journée)</option>
        </select>
      `;
      // point d’ancrage : juste après la ligne Passagers si possible
      const paxNode = document.getElementById('pax');
      const anchor =
        paxNode?.closest('div') ||
        els.time?.closest('div') ||
        els.map?.parentElement ||
        document.body;
      anchor.parentNode.insertBefore(row, anchor.nextSibling);
    }
  }

  function syncModeUI() {
    const isMad = document.getElementById('mode-mad')?.checked;
    const madRow = document.getElementById('mad-row');
    const toInput = document.getElementById('to');
    const toLabel =
      document.querySelector('label[for="to"]') ||
      (toInput ? toInput.previousElementSibling : null);

    if (madRow) madRow.style.display = isMad ? 'flex' : 'none';

    if (toInput) {
      toInput.style.display = isMad ? 'none' : '';
      if (isMad) toInput.value = '';
    }
    if (toLabel) toLabel.style.display = isMad ? 'none' : '';
  }

  ensureMadRow();
  syncModeUI();
  document.getElementById('mode-mad')?.addEventListener('change', syncModeUI);
  document.getElementById('mode-course')?.addEventListener('change', syncModeUI);

  // ====== Préremplissage date/heure (pas de 5 min + arrondi auto) ======
  {
    const now = new Date();
    // +120 min, arrondi au 5 min supérieur
    now.setMinutes(now.getMinutes() + 120, 0, 0);
    const round5 = (m) => Math.ceil(m / 5) * 5;
    now.setMinutes(round5(now.getMinutes()));

    const yyyy = now.toISOString().slice(0, 10);
    const hh   = String(now.getHours()).padStart(2, '0');
    const mm   = String(now.getMinutes()).padStart(2, '0');

    if (els.date) els.date.value = yyyy;

    if (els.time) {
      if (els.time.tagName === 'SELECT') {
        els.time.innerHTML = '';
        for (let H = 0; H < 24; H++) {
          for (let M = 0; M < 60; M += 5) {
            const opt = document.createElement('option');
            opt.value = `${String(H).padStart(2,'0')}:${String(M).padStart(2,'0')}`;
            opt.textContent = opt.value;
            els.time.appendChild(opt);
          }
        }
        els.time.value = `${hh}:${mm}`;
      } else {
        els.time.type = 'time';
        els.time.step = 300; // 5 min
        els.time.value = `${hh}:${mm}`;
        const snapTo5 = () => {
          const v = els.time.value || '';
          const m = v.match(/^(\d{1,2}):(\d{2})$/);
          if (!m) return;
          let H = parseInt(m[1],10), M = parseInt(m[2],10);
          M = Math.round(M / 5) * 5;
          if (M === 60) { M = 0; H = (H + 1) % 24; }
          els.time.value = `${String(H).padStart(2,'0')}:${String(M).padStart(2,'0')}`;
        };
        ['change','blur'].forEach(ev => els.time.addEventListener(ev, snapTo5));
      }
    }
  }

  // Bouton calendrier (icône)
  document.getElementById('openDate')?.addEventListener('click', () => {
    const inp = document.getElementById('date');
    if (!inp) return;
    if (inp.showPicker) inp.showPicker();
    else inp.focus();
  });

  // ====== Google Places + Map ======
  new google.maps.places.Autocomplete(els.from, { componentRestrictions: { country: 'fr' } });
  new google.maps.places.Autocomplete(els.to,   { componentRestrictions: { country: 'fr' } });

  const map = new google.maps.Map(els.map, {
    center: { lat: 48.987, lng: 2.3 },
    zoom: 11,
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false,
  });
  const ds = new google.maps.DirectionsService();
  const dr = new google.maps.DirectionsRenderer({ map });

  // ====== Utilitaires tarifs ======
  function isNightOrWeekend(dateStr, timeStr) {
    try {
      const [y, m, d] = (dateStr || '').split('-').map(Number);
      const [hh, mm] = (timeStr || '').split(':').map(Number);
      const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
      const day = dt.getDay(); // 0 = dimanche
      const hour = dt.getHours();
      const isWE = day === 0 || day === 6;
      const isNight = hour >= 23 || hour < 7;
      return isNight || isWE;
    } catch {
      return false;
    }
  }

  function detectAirportCode(fromText, toText) {
    const t = (fromText + ' ' + toText).toLowerCase();
    if (t.includes('orly') || t.includes('ory')) return 'ORY';
    if (t.includes('roissy') || t.includes('charles de gaulle') || t.includes('cdg')) return 'CDG';
    if (t.includes('beauvais') || t.includes('tillé') || t.includes('bva')) return 'BVA';
    return null;
  }

  function isParisLeg(fromText, toText) {
    const f = (fromText || '').toLowerCase();
    const t = (toText || '').toLowerCase();
    return f.includes('paris') || t.includes('paris');
  }

  function haversineKm(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lng - a.lng) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function computeEnghienForfait(kmToEnghien, isNightWE) {
    let band = null;
    if (kmToEnghien <= 5)
      band = isNightWE ? { price: 20, label: 'Forfait Enghien 5 km (nuit/WE)' }
                       : { price: 15, label: 'Forfait Enghien 5 km (jour)' };
    else if (kmToEnghien <= 10)
      band = isNightWE ? { price: 30, label: 'Forfait Enghien 10 km (nuit/WE)' }
                       : { price: 25, label: 'Forfait Enghien 10 km (jour)' };
    else if (kmToEnghien <= 20)
      band = isNightWE ? { price: 60, label: 'Forfait Enghien 20 km (nuit/WE)' }
                       : { price: 50, label: 'Forfait Enghien 20 km (jour)' };
    else if (kmToEnghien <= 30)
      band = isNightWE ? { price: 80, label: 'Forfait Enghien 30 km (nuit/WE)' }
                       : { price: 70, label: 'Forfait Enghien 30 km (jour)' };
    return band ? { total: band.price, label: band.label } : null;
  }

  // ====== TARIF CLASSIQUE LISSÉ ======
  // Base : 10 € pickup + 2,00 €/km + 1,50 €/min
  // Dégressivité distance (appliquée sur la part km) :
  //   0–30 km 100% ; 30–60 km 90% ; 60–120 km 80% ; 120+ km 70%
  // Dégressivité temps (appliquée sur la part minutes) :
  //   0–60 min 100% ; 60–120 min 90% ; 120+ min 80%
  // Majoration Nuit/WE : +15%
  function price(dist_m, dur_s, when) {
    const PICKUP_FEE = 10.00;
    const PER_KM     = 2.00;
    const PER_MIN    = 1.50;

    const km  = Math.max(0, dist_m / 1000);
    const min = Math.max(0, dur_s / 60);

    function kmCharge(k) {
      const bands = [
        { upto: 30,      factor: 1.00 },
        { upto: 60,      factor: 0.90 },
        { upto: 120,     factor: 0.80 },
        { upto: Infinity, factor: 0.70 }
      ];
      let remain = k, last = 0, sum = 0;
      for (const b of bands) {
        const seg = Math.max(0, Math.min(remain, b.upto - last));
        if (!seg) continue;
        sum += seg * PER_KM * b.factor;
        remain -= seg;
        last = b.upto;
        if (remain <= 0) break;
      }
      return sum;
    }

    function minCharge(m) {
      const bands = [
        { upto: 60,      factor: 1.00 },
        { upto: 120,     factor: 0.90 },
        { upto: Infinity, factor: 0.80 }
      ];
      let remain = m, last = 0, sum = 0;
      for (const b of bands) {
        const seg = Math.max(0, Math.min(remain, b.upto - last));
        if (!seg) continue;
        sum += seg * PER_MIN * b.factor;
        remain -= seg;
        last = b.upto;
        if (remain <= 0) break;
      }
      return sum;
    }

    const isNW = isNightOrWeekend(
      when.toISOString().slice(0, 10),
      when.toTimeString().slice(0, 5)
    );

    let amt = PICKUP_FEE + kmCharge(km) + minCharge(min);
    if (isNW) amt *= 1.15;

    return Math.round(amt * 100) / 100;
  }

  // ====== Estimation ======
  async function estimate() {
    const from = els.from.value.trim();
    const to = (els.to.value || '').trim();
    const dateStr = els.date.value;
    const timeStr = els.time.value;
    const dt = new Date((dateStr || '') + 'T' + (timeStr || '') + ':00');
    const modeMad = !!document.getElementById('mode-mad')?.checked;

    if (!from) {
      alert("Renseignez l’adresse de départ.");
      return;
    }
    if (!dateStr || !timeStr) {
      alert("Sélectionnez la date et l’heure.");
      return;
    }

    // MAD (forfait fixe)
    if (modeMad) {
      const sel = document.getElementById('mad-hours');
      const h = sel ? Number(sel.value || 1) : 1;
      let total = MAD_TOTALS[h];
      if (total == null) total = 100 * h; // secours

      els.distance.textContent = '—';
      els.duration.textContent = h + ' h';
      els.total.textContent = TC.fmtMoney(total);
      const totalLbl = document.getElementById('totalLabel');
      if (totalLbl) {
        totalLbl.textContent = `MAD ${h}h`;
        totalLbl.style.display = '';
      }

      els.calendlyBtn?.removeAttribute('disabled');

      window._TC_LAST = {
        type: 'MAD',
        mode: 'mad',
        from,
        to: '',
        whenISO: dt.toISOString(),
        mad_hours: h,
        price_eur: total,
        label: `MAD ${h}h`,
      };

      try { dr.set('directions', null); } catch {}
      return;
    }

    // Courses : besoin d'une arrivée
    if (!to) {
      alert("Renseignez l’adresse d’arrivée.");
      return;
    }

    // Itinéraire (pour affichage)
    const route = await ds.route({
      origin: from,
      destination: to,
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: { departureTime: dt, trafficModel: 'bestguess' },
    });
    dr.setDirections(route);

    const fromText = els.from.value || '';
    const toText = els.to.value || '';
    const isNW = isNightOrWeekend(dateStr, timeStr);
    const ap = detectAirportCode(fromText, toText);

    // Forfait aéroport
    if (ap && isParisLeg(fromText, toText)) {
      const base = FORFAITS[ap][isNW ? 'night' : 'day'];

      els.distance.textContent = '—';
      els.duration.textContent = '—';
      els.total.textContent = TC.fmtMoney(base);
      const totalLbl = document.getElementById('totalLabel');
      if (totalLbl) {
        totalLbl.textContent = `Forfait ${ap} ${isNW ? 'nuit/WE' : 'jour'}`;
        totalLbl.style.display = '';
      }

      els.calendlyBtn?.removeAttribute('disabled');

      window._TC_LAST = {
        type: 'FORFAIT_AEROPORT',
        airport: ap,
        from,
        to,
        whenISO: dt.toISOString(),
        price_eur: base,
        label: `Forfait ${ap} ${isNW ? 'nuit/WE' : 'jour'}`,
      };
      return;
    }

    // === Forfait Enghien (rayon court autour du Casino) ===
    const leg = route.routes?.[0]?.legs?.[0];
    if (leg) {
      const start = { lat: leg.start_location.lat(), lng: leg.start_location.lng() };
      const end   = { lat: leg.end_location.lat(),   lng: leg.end_location.lng() };

      const dStart = haversineKm(start, ENGHIEN);
      const dEnd   = haversineKm(end,   ENGHIEN);

      const isEnghienEndpoint = (dStart <= R_ENGHIEN) || (dEnd <= R_ENGHIEN);
      if (isEnghienEndpoint) {
        const bandDist = (dStart <= R_ENGHIEN) ? dEnd : dStart;

        const eng = computeEnghienForfait(bandDist, isNW);
        if (eng) {
          els.distance.textContent = '—';
          els.duration.textContent = '—';
          els.total.textContent    = TC.fmtMoney(eng.total);
          const totalLbl = document.getElementById('totalLabel');
          if (totalLbl) { totalLbl.textContent = eng.label; totalLbl.style.display = ''; }

          els.calendlyBtn?.removeAttribute('disabled');

          window._TC_LAST = {
            type: 'FORFAIT_ENGHIEN',
            from, to,
            whenISO: dt.toISOString(),
            price_eur: eng.total,
            label: eng.label,
            km_to_enghien: Math.round(bandDist * 10) / 10
          };
          return;
        }
      }
    }

    // Tarif classique lissé
    const dm = new google.maps.DistanceMatrixService();
    const r = await dm.getDistanceMatrix({
      origins: [from],
      destinations: [to],
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: { departureTime: dt, trafficModel: 'bestguess' },
    });
    const cell = r.rows[0].elements[0];
    const dist = cell.distance.value; // m
    const dur = (cell.duration_in_traffic || cell.duration).value; // s

    const p = price(dist, dur, dt);
    els.distance.textContent = (dist / 1000).toFixed(1) + ' km';
    els.duration.textContent = Math.round(dur / 60) + ' min';
    els.total.textContent = TC.fmtMoney(p);
    const totalLbl = document.getElementById('totalLabel');
    if (totalLbl) {
      totalLbl.textContent = 'Tarif classique';
      totalLbl.style.display = '';
    }

    els.calendlyBtn?.removeAttribute('disabled');

    window._TC_LAST = {
      type: 'COURSE',
      from,
      to,
      whenISO: dt.toISOString(),
      dist_m: dist,
      dur_s: dur,
      price_eur: p,
      label: 'Tarif classique',
    };
  } // fin estimate()

  // ===== Bind UI =====
  if (els && els.estimateBtn) {
    els.estimateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      estimate().catch((err) => {
        console.error(err);
        alert('Estimation impossible. Réessayez.');
      });
    });
  }

  // === FIN du fichier : exactement UNE seule IIFE fermée ===
})();
