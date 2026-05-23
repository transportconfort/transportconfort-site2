/* simulator.js — estimation + Calendly
   - Affichage carte = itinéraire LE PLUS RAPIDE
   - Calcul prix = distance LA PLUS COURTE (évite les détours coûteux)
   - Forfaits aéroports: CDG/ORY si ≤ 40 km ; Beauvais = départ IDF → BVA
   - Tarifs classiques lissés: pickup 9 € + 1.85 €/km + 0.95 €/min (+15% nuit/WE)
*/

(async function () {
  // ====== Chargement config & Google Maps ======
  if (!window.TC) throw new Error('Espace TC manquant');
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
  const MAD_TOTALS = { 1: 80, 2: 150, 3: 210, 4: 240, 8: 400 };
  const FORFAITS = {
    ORY: { day: 50, night: 60 },
    CDG: { day: 60, night: 70 },
    BVA: { day: 150, night: 170 },
  };

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

  // ====== UI MAD : ajout de la ligne Durée + masquage du champ Arrivée ======
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

  // ====== Date/heure par défaut (arrondi 5 min) ======
  {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 120, 0, 0);
    const round5 = (m) => Math.ceil(m / 5) * 5;
    now.setMinutes(round5(now.getMinutes()));

    const yyyy = now.toISOString().slice(0, 10);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');

    if (els.date) els.date.value = yyyy;

    if (els.time) {
      if (els.time.tagName === 'SELECT') {
        els.time.innerHTML = '';
        for (let H = 0; H < 24; H++) {
          for (let M = 0; M < 60; M += 5) {
            const opt = document.createElement('option');
            opt.value = `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
            opt.textContent = opt.value;
            els.time.appendChild(opt);
          }
        }
        els.time.value = `${hh}:${mm}`;
      } else {
        els.time.type = 'time';
        els.time.step = 300;
        els.time.value = `${hh}:${mm}`;
        const snapTo5 = () => {
          const v = els.time.value || '';
          const m = v.match(/^(\d{1,2}):(\d{2})$/);
          if (!m) return;
          let H = parseInt(m[1], 10), M = parseInt(m[2], 10);
          M = Math.round(M / 5) * 5;
          if (M === 60) { M = 0; H = (H + 1) % 24; }
          els.time.value = `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
        };
        ['change', 'blur'].forEach(ev => els.time.addEventListener(ev, snapTo5));
      }
    }
  }

  // ====== Google Places + Map ======
  new google.maps.places.Autocomplete(els.from, { componentRestrictions: { country: 'fr' } });
  new google.maps.places.Autocomplete(els.to, { componentRestrictions: { country: 'fr' } });

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
  function isNight(dateStr, timeStr) {
    if (!timeStr) return false;
    const parts = timeStr.split(':');
    const hour = parseInt(parts[0], 10);
    return hour >= 23 || hour < 7;
  }

  function isNightOrWeekend(dateStr, timeStr) {
    try {
      const [y, m, d] = (dateStr || '').split('-').map(Number);
      const [hh, mm] = (timeStr || '').split(':').map(Number);

      const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);

      const day = dt.getDay();
      const hour = dt.getHours();

      const isWE = day === 0 || day === 6;
      const isNightTime = hour >= 23 || hour < 7;

      return isWE || isNightTime;
    } catch {
      return false;
    }
  }

  // Ces deux helpers restent dispo si tu veux t’en resservir ailleurs
 function detectAirportCode(fromText, toText) {
  const t = (fromText + ' ' + toText).toLowerCase();

  // ===== ORLY =====
  if (
    t.includes('orly') ||
    t.includes('ory')
  ) {
    return 'ORY';
  }

  // ===== CDG / ROISSY =====
  if (
    t.includes('roissy') ||
    t.includes('charles de gaulle') ||
    t.includes('charles-de-gaulle') ||
    t.includes('aéroport de paris-charles-de-gaulle') ||
    t.includes('aeroport de paris-charles-de-gaulle') ||
    t.includes('cdg') ||

    // terminaux CDG
    t.includes('terminal 1') ||
    t.includes('terminal 2') ||
    t.includes('terminal 2a') ||
    t.includes('terminal 2b') ||
    t.includes('terminal 2c') ||
    t.includes('terminal 2d') ||
    t.includes('terminal 2e') ||
    t.includes('terminal 2f') ||
    t.includes('terminal 2g') ||
    t.includes('terminal 3') ||

    // communes ultra liées CDG
    t.includes('le mesnil-amelot') ||
    t.includes('tremblay-en-france')
  ) {
    return 'CDG';
  }

  // ===== BEAUVAIS =====
  if (
    t.includes('beauvais') ||
    t.includes('tillé') ||
    t.includes('tille') ||
    t.includes('bva')
  ) {
    return 'BVA';
  }

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

// ===== Minimum de course =====
const MIN_FARE = 20; // ou 18 selon ta stratégie

function applyMinimumFare(amount) {
  return amount < MIN_FARE ? MIN_FARE : amount;
}

  // ====== TARIF CLASSIQUE LISSÉ (avec plafond dynamique minutes) ======
  // Base : 5 € pickup + 1,50 €/km + 0,50 €/min
  // Dégressivité distance (part km) : 0–30 km 100% ; 30–60 km 90% ; 60–120 km 80% ; 120+ km 70%
  // Dégressivité temps (part min)   : 0–60 min 100% ; 60–120 min 90% ; 120+ min 80%
  // Majoration Nuit/WE : +15%
  // Plafond dynamique : minutes facturables ≤ 1.5 × km (évite les excès sur trajets courts très congestionnés)
  function price(dist_m, dur_s, when) {
    const PICKUP_FEE = 10.00;
    const PER_KM = 1.40;
    const PER_MIN = 0.35;

    const km = Math.max(0, dist_m / 1000);
    const min = Math.max(0, dur_s / 60);

    // === Plafond dynamique des minutes facturables ===
    // Exemple : 25 km ⇒ max 37.5 min facturées (arrondi appliqué par la dégressivité)
    let MINUTES_CAP_RATIO;

    if (km <= 10) {
      MINUTES_CAP_RATIO = 2.2;
    } else if (km <= 25) {
      MINUTES_CAP_RATIO = 2.0;
    } else if (km <= 50) {
      MINUTES_CAP_RATIO = 1.7;
    } else {
      MINUTES_CAP_RATIO = 1.5;
    } // 1.1 min par km

    const maxBillableMin = MINUTES_CAP_RATIO * km;
    const billableMin = Math.min(min, maxBillableMin);

    function kmCharge(k) {
      const bands = [
        { upto: 15, factor: 1.00 },
        { upto: 35, factor: 0.82 },
        { upto: 60, factor: 0.68 },
        { upto: Infinity, factor: 0.62 }
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

    const isShortTrip = km <= 20;
    function minCharge(m) {
      const bands = isShortTrip
        ? [
            { upto: 45, factor: 1.05 },
            { upto: 90, factor: 0.75 },
            { upto: Infinity, factor: 0.65 }
          ]
        : [
            { upto: 45, factor: 0.85 },
            { upto: 90, factor: 0.75 },
            { upto: Infinity, factor: 0.65 }
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

    let amt = PICKUP_FEE + kmCharge(km) + minCharge(billableMin);
    if (isNW) amt *= 1.10;

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

    if (!from) { alert("Renseignez l’adresse de départ."); return; }
    if (!dateStr || !timeStr) { alert("Sélectionnez la date et l’heure."); return; }

    // ===== MAD =====
    if (modeMad) {
      const sel = document.getElementById('mad-hours');
      const h = sel ? Number(sel.value || 1) : 1;
      let total = MAD_TOTALS[h];
      if (total == null) total = 80 * h;

      els.distance.textContent = '—';
      els.duration.textContent = h + ' h';
      els.total.textContent = TC.fmtMoney(total);
      const totalLbl = document.getElementById('totalLabel');
      if (totalLbl) { totalLbl.textContent = `MAD ${h}h`; totalLbl.style.display = ''; }

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

    // ===== Course classique : besoin d'une arrivée =====
    if (!to) {
      alert("Renseignez l’adresse d’arrivée.");
      return;
    }

    // ===== Itinéraires (alternatives) =====
    let routes = [];
    try {
      const directions = await ds.route({
        origin: from,
        destination: to,
        travelMode: google.maps.TravelMode.DRIVING,
        drivingOptions: { departureTime: dt, trafficModel: 'bestguess' },
        provideRouteAlternatives: true
      });
      routes = directions.routes || [];
      if (routes.length) {
        // Choix affichage/prix
        const sumDist = (r) => (r.legs || []).reduce((s, l) => s + (l.distance?.value || 0), 0);
        const sumDur = (r) => (r.legs || []).reduce((s, l) => s + ((l.duration_in_traffic?.value) || (l.duration?.value) || 0), 0);

        let shortestIdx = 0, fastestIdx = 0;
        routes.forEach((r, i) => {
          if (sumDist(r) < sumDist(routes[shortestIdx])) shortestIdx = i;
          if (sumDur(r) < sumDur(routes[fastestIdx])) fastestIdx = i;
        });

        // Affichage = plus rapide
        dr.setDirections(directions);
        try { dr.setRouteIndex(fastestIdx); } catch {}

        var dist_m = sumDist(routes[shortestIdx]); // pour tarification
        var dur_s = sumDur(routes[fastestIdx]);    // pour durée affichée
      }
    } catch (e) {
      console.warn('Directions KO, on bascule sur DistanceMatrix', e);
    }

    // Fallback DistanceMatrix (si Directions a échoué)
    if (!routes.length) {
      const dm = new google.maps.DistanceMatrixService();
      const r = await dm.getDistanceMatrix({
        origins: [from],
        destinations: [to],
        travelMode: google.maps.TravelMode.DRIVING,
        drivingOptions: { departureTime: dt, trafficModel: 'bestguess' },
      });
      const cell = r.rows[0].elements[0];
      var dist_m = cell.distance.value;
      var dur_s = (cell.duration_in_traffic || cell.duration).value;
      // On efface toute route affichée
      try { dr.set('directions', null); } catch {}
    }

    const fromText = els.from.value || '';
    const toText = els.to.value || '';

    const isNW = isNightOrWeekend(dateStr, timeStr); // classique + Enghien
    const isAirportNight = isNight(dateStr, timeStr); // aéroports uniquement

    // Petite heuristique IDF
    function isIDF(addr) {
      const patterns = [
        "paris", " 75", " 92", " 93", " 94", " 95", " 91", " 78", " 77",
        "enghien", "epinay", "épinay", "sarcelles", "saint-denis", "st-denis",
        "gennevilliers", "argenteuil", "aubervilliers", "cergy", "montmorency"
      ];
      const a = (addr || '').toLowerCase();
      return patterns.some(p => a.includes(p));
    }

    function isParisTrainStation(text) {
      const t = (text || '').toLowerCase();

      const stations = [
        'gare du nord',
        'gare de lyon',
        'gare montparnasse',
        'gare saint-lazare',
        'gare de l\'est',
        'gare d\'austerlitz',
        'gare bercy'
      ];

      return stations.some(s => t.includes(s));
    }

    // ===== Forfaits Aéroports =====
    // NB: seuil de 35 km évalué sur la distance tarifiée (plus courte)
    (function tryAirportFare() {
      const kmTotal = dist_m / 1000;
      const airportCode = detectAirportCode(fromText, toText);

      const isCDG = airportCode === 'CDG';
      const isOrly = airportCode === 'ORY';
      const isBeauvais = airportCode === 'BVA';

      let airportFare = null, airportLabel = null;

      if ((isCDG || isOrly) && kmTotal <= 40) {
        if (isCDG) {
          airportFare = FORFAITS.CDG[isAirportNight ? 'night' : 'day'];
          airportLabel = `Forfait CDG ${isAirportNight ? 'nuit' : 'jour'}`;
        } else {
          airportFare = FORFAITS.ORY[isAirportNight ? 'night' : 'day'];
          airportLabel = `Forfait ORY ${isAirportNight ? 'nuit' : 'jour'}`;
        }
      } else if (isBeauvais && isIDF(fromText)) {
        airportFare = FORFAITS.BVA[isAirportNight ? 'night' : 'day'];
        airportLabel = `Forfait BVA ${isAirportNight ? 'nuit' : 'jour'}`;
      }

      if (airportFare !== null) {
        els.distance.textContent = '—';
        els.duration.textContent = '—';
        els.total.textContent = TC.fmtMoney(airportFare);

        const totalLbl = document.getElementById('totalLabel');

        if (totalLbl) {
          totalLbl.textContent = airportLabel;
          totalLbl.style.display = '';
        }

        els.calendlyBtn?.removeAttribute('disabled');

        window._TC_LAST = {
          type: 'FORFAIT_AEROPORT',
          from,
          to,
          whenISO: dt.toISOString(),
          price_eur: airportFare,
          label: airportLabel
        };

        throw '__DONE__';
      }
    })();

    // ===== Tarif classique (prix = distance la plus courte ; durée = plus rapide/fallback) =====
    let p = price(dist_m, dur_s, dt);

    // Application du minimum de course
    p = applyMinimumFare(p);

    // Supplément gare parisienne
    const hasStationSupplement =
      isParisTrainStation(fromText) ||
      isParisTrainStation(toText);

    if (hasStationSupplement) {
      p += 3;
    }

    els.distance.textContent = (dist_m / 1000).toFixed(1) + ' km';
    els.duration.textContent = Math.round(dur_s / 60) + ' min';
    els.total.textContent = TC.fmtMoney(p);

    const totalLbl = document.getElementById('totalLabel');

    if (totalLbl) {
      totalLbl.textContent = hasStationSupplement
        ? 'Tarif gare parisienne'
        : 'Tarif classique';

      totalLbl.style.display = '';
    }

    els.calendlyBtn?.removeAttribute('disabled');

    window._TC_LAST = {
      type: 'COURSE',
      from,
      to,
      whenISO: dt.toISOString(),
      dist_m: dist_m,
      dur_s: dur_s,
      price_eur: p,
      label: hasStationSupplement
        ? 'Tarif gare parisienne'
        : 'Tarif classique',
    };
  } // fin estimate()

  // ===== Bind UI =====
  if (els && els.estimateBtn) {
    els.estimateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      estimate().catch((err) => {
        if (err === '__DONE__') return; // cas forfait/enghien qui sort volontairement
        console.error(err);
        alert('Estimation impossible. Réessayez.');
      });
    });
  }

  // === Rendre toute la zone "Date" cliquable (desktop) ===
  (function makeWholeDateAreaClickable() {
    const input = document.getElementById('date');
    const button = document.getElementById('openDate');

    if (!input) return;

    const container =
      (button && button.parentElement) ||
      input.parentElement ||
      input.closest('div');

    if (container) {
      container.style.cursor = 'pointer';

      container.addEventListener('click', (e) => {
        if (e.target === input || e.target === button || e.target.closest('#openDate')) return;

        input.focus();
        if (typeof input.showPicker === 'function') {
          try { input.showPicker(); } catch (_) { }
        }
      });
    }

    const label = document.querySelector('label[for="date"]');
    if (label) {
      label.style.cursor = 'pointer';
      label.addEventListener('click', (e) => {
        e.preventDefault();
        input.focus();
        if (typeof input.showPicker === 'function') {
          try { input.showPicker(); } catch (_) { }
        }
      });
    }
  })();
})();
