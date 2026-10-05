(() => {
  "use strict";
  const C = window.CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const DEMO = !C.apiUrl;
  const DEMO_KEY = "ciasa-irma-demo-bookings";

  /* ================= Dates (all as "YYYY-MM-DD", computed in UTC) ================= */
  const DAY = 86400000;
  const toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const toStr = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (s, n) => toStr(toMs(s) + n * DAY);
  const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
  const fmt = (s, opts = { weekday: "short", day: "numeric", month: "short" }) =>
    new Date(toMs(s)).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  const nightsOf = (arr, dep) => { const out = []; for (let d = arr; d < dep; d = addDays(d, 1)) out.push(d); return out; };

  const TRIP_NIGHTS = nightsOf(C.tripStart, C.tripEnd);
  const SPARE = C.totalBeds - C.hostBeds;
  const MAX_PN = TRIP_NIGHTS.length * SPARE;
  const HOST_PN = TRIP_NIGHTS.length * C.hostBeds;
  const LOCK_MS = new Date(C.lockDate).getTime();
  const isLocked = () => Date.now() >= LOCK_MS;

  /* ================= State ================= */
  let bookings = [];          // [{arrival, departure, groupSize, status, name}]
  let occ = {};               // date -> {taken, pending, names[]}
  let selStart = null, selEnd = null;

  function computeOccupancy() {
    occ = {};
    TRIP_NIGHTS.forEach((d) => (occ[d] = { taken: 0, pending: 0, names: [] }));
    for (const b of bookings) {
      for (const d of nightsOf(b.arrival, b.departure)) {
        if (!occ[d]) continue;
        if (b.status === "approved") {
          occ[d].taken += +b.groupSize;
          if (b.name) occ[d].names.push(b.name + (b.groupSize > 1 ? ` +${b.groupSize - 1}` : ""));
        } else if (b.status === "pending") occ[d].pending += +b.groupSize;
      }
    }
  }
  const freeOn = (d) => (occ[d] ? Math.max(0, SPARE - occ[d].taken) : 0);
  const personNights = (status) =>
    bookings.filter((b) => b.status === status)
      .reduce((sum, b) => sum + nightsOf(b.arrival, b.departure).filter((d) => occ[d]).length * b.groupSize, 0);

  /* ================= API ================= */
  async function loadBookings() {
    if (DEMO) {
      try { bookings = JSON.parse(localStorage.getItem(DEMO_KEY)) || null; } catch { bookings = null; }
      if (!bookings) {
        bookings = [
          { arrival: "2027-02-13", departure: "2027-02-20", groupSize: 2, status: "approved", name: "Ana" },
          { arrival: "2027-02-18", departure: "2027-02-22", groupSize: 1, status: "approved", name: "Marko" },
          { arrival: "2027-03-05", departure: "2027-03-12", groupSize: 3, status: "approved", name: "Luka" },
          { arrival: "2027-02-26", departure: "2027-03-01", groupSize: 2, status: "pending" },
        ];
      }
      return;
    }
    const res = await fetch(`${C.apiUrl}?action=availability`, { cache: "no-store" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Could not load availability");
    bookings = data.bookings || [];
  }

  async function submitBooking(payload) {
    if (DEMO) {
      await new Promise((r) => setTimeout(r, 700));
      const list = bookings.concat({ ...payload, status: "pending" });
      try { localStorage.setItem(DEMO_KEY, JSON.stringify(list)); } catch {}
      return { ok: true };
    }
    // text/plain avoids a CORS preflight, which Apps Script can't answer.
    const res = await fetch(C.apiUrl, { method: "POST", body: JSON.stringify(payload) });
    return res.json();
  }

  /* ================= Hero ================= */
  function initHero() {
    const nav = $("#nav");
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    const first = C.gallery[0];
    if (first) {
      const img = new Image();
      // absolute URL: a url() inside a CSS variable resolves against the stylesheet, not the page
      img.onload = () => $(".hero").style.setProperty("--hero-img", `url("${img.src}")`);
      img.src = first.src;
    }
    $("#statNights").textContent = TRIP_NIGHTS.length;
    updateCountdown();
    setInterval(updateCountdown, 60000);
    initSnow();
  }

  function updateCountdown() {
    const ms = LOCK_MS - Date.now();
    if (ms <= 0) {
      $("#statCountdown").textContent = "Locked";
      $("#statCountdownLabel").textContent = "price has been set";
      return;
    }
    const days = Math.floor(ms / DAY);
    $("#statCountdown").textContent = days > 0 ? `${days} days` : `${Math.ceil(ms / 3600000)} h`;
  }

  function initSnow() {
    const cvs = $("#snow");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = cvs.getContext("2d");
    let w, h, flakes;
    const resize = () => {
      w = cvs.width = cvs.offsetWidth * devicePixelRatio;
      h = cvs.height = cvs.offsetHeight * devicePixelRatio;
      const n = Math.min(160, Math.floor(cvs.offsetWidth / 9));
      flakes = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: (Math.random() * 2.2 + .6) * devicePixelRatio,
        s: Math.random() * .6 + .3, d: Math.random() * Math.PI * 2,
      }));
    };
    resize();
    window.addEventListener("resize", resize);
    let visible = true;
    new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(cvs);
    (function tick() {
      if (visible) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(255,255,255,.85)";
        for (const f of flakes) {
          f.d += .01; f.y += f.s * devicePixelRatio; f.x += Math.sin(f.d) * .4 * devicePixelRatio;
          if (f.y > h) { f.y = -5; f.x = Math.random() * w; }
          ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
        }
      }
      requestAnimationFrame(tick);
    })();
  }

  /* ================= Price meter & stats ================= */
  const eur = (n) => "€" + n.toFixed(2).replace(/\.00$/, "");
  function renderStats() {
    const approved = personNights("approved");
    const pending = personNights("pending");
    $("#statFree").textContent = Math.max(0, MAX_PN - approved);
    $("#meterText").textContent = `${approved} confirmed${pending ? ` + ${pending} pending` : ""} / ${MAX_PN}`;
    $("#meterFill").style.width = `${(approved / MAX_PN) * 100}%`;
    $("#meterPending").style.width = `${(Math.min(pending, MAX_PN - approved) / MAX_PN) * 100}%`;

    const note = $("#priceNote");
    if (C.finalPricePerNight != null) {
      note.innerHTML = `Final price: <strong>${eur(C.finalPricePerNight)} per person per night</strong>.`;
    } else if (C.totalCostEUR) {
      const hostPart = C.hostSharesCost ? HOST_PN : 0;
      const now = C.totalCostEUR / Math.max(1, approved + hostPart);
      const best = C.totalCostEUR / (MAX_PN + hostPart);
      note.innerHTML = `With today's bookings it would be <strong>${eur(now)}</strong> per person per night. ` +
        `If every berth is filled it drops to <strong>${eur(best)}</strong>. Bring friends!`;
    }
  }

  /* ================= Cottage features ================= */
  const ICONS = {
    bed: '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M3 14h18M7 10V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3"/>',
    mountain: '<path d="M3 20 10 7l4 7 2-3 5 9z"/><path d="m8.5 10 1.5 1.5L11.5 10"/>',
    ski: '<circle cx="16" cy="4.5" r="1.8"/><path d="m4 20 16-6M8 8l4 2 1 4-3 3M12 10l3-1 2 3"/>',
    fire: '<path d="M12 21c4 0 6.5-2.5 6.5-6 0-4-3.5-6-4-10-2 1.5-3 3.5-3 5.5-1-1-1.5-2-1.5-3C7.5 9 5.5 12 5.5 15c0 3.5 2.5 6 6.5 6z"/>',
  };
  function renderFeatures() {
    $("#features").innerHTML = C.features.map((f) => `
      <article class="feature">
        <div class="feature-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[f.icon] || ICONS.mountain}</svg></div>
        <h3>${esc(f.title)}</h3><p>${esc(f.text)}</p>
      </article>`).join("");
  }

  /* ================= Gallery + lightbox ================= */
  let shown = [];
  function renderGallery() {
    const grid = $("#galleryGrid");
    grid.innerHTML = "";
    shown = [];
    C.gallery.forEach((g) => {
      const btn = document.createElement("button");
      btn.className = "g-item" + (g.span ? " wide" : "");
      if (g.span) btn.style.setProperty("--span", g.span);
      btn.type = "button";
      btn.innerHTML = `<img src="${esc(g.src)}" alt="${esc(g.caption || "Ciasa Irma")}" loading="lazy">` +
        (g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : "");
      const img = btn.querySelector("img");
      img.onerror = () => {
        btn.outerHTML = `<div class="g-item g-placeholder"><div><span>🏔️</span>Photo coming soon</div></div>`;
      };
      img.onload = () => shown.push(g);
      btn.addEventListener("click", () => openLightbox(g));
      grid.appendChild(btn);
    });

    const lb = $("#lightbox");
    lb.addEventListener("click", (e) => {
      const a = e.target.dataset.lb;
      if (a === "close" || e.target === lb) lb.close();
      if (a === "prev") step(-1);
      if (a === "next") step(1);
    });
    document.addEventListener("keydown", (e) => {
      if (!lb.open) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    });
  }
  let lbIndex = 0;
  function ordered() { return C.gallery.filter((g) => shown.includes(g)); }
  function openLightbox(g) {
    lbIndex = ordered().indexOf(g);
    showLb();
    $("#lightbox").showModal();
  }
  function step(n) { const list = ordered(); lbIndex = (lbIndex + n + list.length) % list.length; showLb(); }
  function showLb() {
    const g = ordered()[lbIndex];
    if (!g) return;
    $("#lbImg").src = g.src;
    $("#lbImg").alt = g.caption || "Ciasa Irma";
    $("#lbCap").textContent = g.caption || "";
  }

  /* ================= Map ================= */
  function haversine(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function initMap() {
    const resorts = C.skiAreas
      .map((r) => ({ ...r, dist: haversine(C.location, r) }))
      .sort((a, b) => a.dist - b.dist);

    const cards = $("#resorts");
    cards.innerHTML = resorts.map((r, i) => `
      <button class="resort" type="button" data-i="${i}">
        <div class="resort-top"><h4>${esc(r.name)}</h4><span class="dist">~${r.dist.toFixed(1)} km</span></div>
        <div class="village">${esc(r.village)}</div>
        <div class="chips"><span class="chip">↑ ${r.top.toLocaleString("en")} m</span><span class="chip">${r.km} km slopes</span><span class="chip">${r.lifts} lifts</span></div>
      </button>`).join("");

    if (!window.L) { $("#map").innerHTML = '<p style="padding:2rem;color:#333">Map could not load.</p>'; return; }

    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap contributors",
    });
    const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17, attribution: "© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)",
    });
    const pistes = L.tileLayer("https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "Pistes © OpenSnowMap.org",
    });
    const map = L.map("map", { scrollWheelZoom: false, layers: [osm, pistes] });
    L.control.layers({ "Street": osm, "Topographic": topo }, { "Ski pistes": pistes }).addTo(map);
    map.on("focus", () => map.scrollWheelZoom.enable());
    map.on("blur", () => map.scrollWheelZoom.disable());

    const home = L.marker([C.location.lat, C.location.lng], {
      icon: L.divIcon({ className: "", html: '<div class="home-pin"><span>🏠</span></div>', iconSize: [44, 44], iconAnchor: [22, 44], popupAnchor: [0, -40] }),
      zIndexOffset: 1000,
    }).addTo(map).bindPopup(`<h4>${esc(C.cottageName)}</h4><p>${esc(C.address)}</p>
      <p><a href="https://www.google.com/maps/dir/?api=1&destination=${C.location.lat},${C.location.lng}" target="_blank" rel="noopener">Directions ↗</a></p>`);

    const markers = resorts.map((r) =>
      L.marker([r.lat, r.lng], {
        icon: L.divIcon({ className: "", html: '<div class="ski-pin">⛷</div>', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }),
      }).addTo(map).bindPopup(`
        <h4>${esc(r.name)}</h4>
        <div class="popup-stats"><span>📍 ${esc(r.village)}</span><span>~${r.dist.toFixed(1)} km away</span></div>
        <div class="popup-stats"><span>↑ ${r.top.toLocaleString("en")} m</span><span>${r.km} km slopes</span><span>${r.lifts} lifts</span></div>
        <p>${esc(r.note)}</p>
        ${r.url ? `<p><a href="${esc(r.url)}" target="_blank" rel="noopener">More info ↗</a></p>` : ""}`)
    );

    map.fitBounds(L.featureGroup([home, ...markers]).getBounds().pad(0.1));
    home.openPopup();

    cards.addEventListener("click", (e) => {
      const card = e.target.closest(".resort");
      if (!card) return;
      const m = markers[+card.dataset.i];
      $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
      map.flyTo(m.getLatLng(), 13, { duration: 1 });
      setTimeout(() => m.openPopup(), 1000);
    });
  }

  /* ================= Calendar ================= */
  function renderCalendar() {
    const cal = $("#calendar");
    cal.innerHTML = "";
    const locked = isLocked();
    let y = +C.tripStart.slice(0, 4), m = +C.tripStart.slice(5, 7) - 1;
    const endY = +C.tripEnd.slice(0, 4), endM = +C.tripEnd.slice(5, 7) - 1;
    const sel = selectionNights();
    const size = groupSize();

    while (y < endY || (y === endY && m <= endM)) {
      const month = document.createElement("div");
      month.className = "month";
      const first = Date.UTC(y, m, 1);
      const label = new Date(first).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
      const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const offset = (new Date(first).getUTCDay() + 6) % 7; // Monday first
      let html = `<h4>${label}</h4><div class="dow">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => `<span>${d}</span>`).join("")}</div><div class="days">`;
      for (let i = 0; i < offset; i++) html += `<span class="day out"></span>`;
      for (let day = 1; day <= daysIn; day++) {
        const d = toStr(Date.UTC(y, m, day));
        const inTrip = d >= C.tripStart && d <= C.tripEnd;
        if (!inTrip) { html += `<button class="day outside" disabled tabindex="-1"><span class="num">${day}</span></button>`; continue; }

        const isNight = !!occ[d];
        const cls = ["day"];
        let beds = "", title;
        if (isNight) {
          const o = occ[d], free = freeOn(d);
          const pend = Math.min(o.pending, free);
          for (let i = 0; i < SPARE; i++) beds += `<i class="${i < o.taken ? "t" : i < o.taken + pend ? "p" : ""}"></i>`;
          if (free === 0) cls.push("full");
          title = `${fmt(d)}: ${free} of ${SPARE} berths free` +
            (C.showGuestNames && o.names.length ? ` · staying: ${o.names.join(", ")}` : "") +
            (o.pending ? ` · ${o.pending} pending` : "");
        } else {
          cls.push("checkout-only");
          title = `${fmt(d)}: last check-out day`;
        }
        if (d === selStart) cls.push("sel-start");
        if (d === selEnd) cls.push("sel-end");
        if (selStart && selEnd && d > selStart && d < selEnd) cls.push("in-range");
        if (sel.includes(d) && freeOn(d) < size) cls.push("conflict");

        // You can click: any night as arrival (if it has room); as departure any day after arrival.
        const clickable = !locked && (isNight ? true : !!selStart);
        html += `<button type="button" class="${cls.join(" ")}" data-date="${d}" title="${esc(title)}" ${clickable ? "" : "disabled"}>
          <span class="num">${day}</span><span class="beds">${beds}</span></button>`;
      }
      html += "</div>";
      month.innerHTML = html;
      cal.appendChild(month);
      m++; if (m > 11) { m = 0; y++; }
    }
  }

  function onCalendarClick(e) {
    const btn = e.target.closest(".day[data-date]");
    if (!btn || btn.disabled) return;
    const d = btn.dataset.date;
    if (!selStart || selEnd || d <= selStart) {
      if (!occ[d]) return;             // checkout-only day can't be an arrival
      if (freeOn(d) === 0) { flashHint(`${fmt(d)} is fully booked — pick another arrival day.`); return; }
      selStart = d; selEnd = null;
      $("#calHint").textContent = "Now tap your departure day.";
    } else {
      selEnd = d;
      $("#calHint").textContent = "Tap a new arrival day to start over.";
    }
    syncInputs();
    refreshSelection();
  }
  function flashHint(msg) {
    const h = $("#calHint");
    h.textContent = msg; h.style.color = "var(--ember-dark)";
    setTimeout(() => { h.style.color = ""; }, 2500);
  }

  /* ================= Form ================= */
  const groupSize = () => +(document.querySelector('input[name="groupSize"]:checked')?.value || 1);
  const selectionNights = () => (selStart && selEnd ? nightsOf(selStart, selEnd) : []);

  function syncInputs() {
    $("#arrival").value = selStart || "";
    $("#departure").value = selEnd || "";
  }

  function validateSelection() {
    if (!selStart || !selEnd) return { ok: false, msg: "Select your arrival and departure dates." };
    if (selStart < C.tripStart || selEnd > C.tripEnd) return { ok: false, msg: `Dates must be between ${fmt(C.tripStart)} and ${fmt(C.tripEnd)}.` };
    if (selEnd <= selStart) return { ok: false, msg: "Departure must be after arrival." };
    const size = groupSize();
    const bad = selectionNights().filter((d) => freeOn(d) < size);
    if (bad.length) {
      const minFree = Math.min(...bad.map(freeOn));
      return { ok: false, msg: `Not enough room on ${bad.slice(0, 3).map((d) => fmt(d, { day: "numeric", month: "short" })).join(", ")}${bad.length > 3 ? "…" : ""} — only ${minFree} berth${minFree === 1 ? "" : "s"} free.` };
    }
    return { ok: true };
  }

  function refreshSelection() {
    renderCalendar();
    const sum = $("#summary");
    // Disable group sizes that can't fit the whole selected range.
    const nights = selectionNights();
    const cap = nights.length ? Math.min(...nights.map(freeOn)) : (selStart ? freeOn(selStart) : SPARE);
    document.querySelectorAll('input[name="groupSize"]').forEach((r) => (r.disabled = +r.value > Math.max(cap, 0) || isLocked()));

    if (!selStart) { sum.className = "summary"; sum.textContent = "Select dates to see a summary."; return; }
    if (!selEnd) { sum.className = "summary"; sum.innerHTML = `Arriving <strong>${fmt(selStart)}</strong> — now choose a departure day.`; return; }
    const v = validateSelection();
    const size = groupSize();
    const n = nights.length;
    if (!v.ok) { sum.className = "summary bad"; sum.textContent = v.msg; return; }
    let extra = "";
    if (C.finalPricePerNight != null) extra = ` · ${eur(C.finalPricePerNight * n * size)}`;
    else if (C.totalCostEUR) {
      const hostPart = C.hostSharesCost ? HOST_PN : 0;
      const after = C.totalCostEUR / (personNights("approved") + hostPart + n * size);
      extra = `<br>Estimated today: ~${eur(after)} pp/night (drops as more people book)`;
    }
    sum.className = "summary";
    sum.innerHTML = `<strong>${fmt(selStart)} → ${fmt(selEnd)}</strong><br>${n} night${n > 1 ? "s" : ""} × ${size} ${size > 1 ? "people" : "person"} = <strong>${n * size} person-nights</strong>${extra}`;
  }

  function initForm() {
    const arr = $("#arrival"), dep = $("#departure");
    arr.min = C.tripStart; arr.max = addDays(C.tripEnd, -1);
    dep.min = addDays(C.tripStart, 1); dep.max = C.tripEnd;
    arr.addEventListener("change", () => {
      selStart = arr.value || null;
      if (selEnd && selStart && selEnd <= selStart) { selEnd = null; dep.value = ""; }
      refreshSelection();
    });
    dep.addEventListener("change", () => { selEnd = dep.value || null; refreshSelection(); });
    document.querySelectorAll('input[name="groupSize"]').forEach((r) => r.addEventListener("change", refreshSelection));
    $("#calendar").addEventListener("click", onCalendarClick);

    $("#bookingForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target, err = $("#formError"), btn = $("#submitBtn");
      err.hidden = true;
      if (isLocked()) return showError("Booking is closed — the calendar locked on 1 February.");
      const v = validateSelection();
      if (!v.ok) return showError(v.msg);
      const fd = new FormData(form);
      const name = (fd.get("name") || "").trim();
      const email = (fd.get("email") || "").trim();
      if (!name) return showError("Please tell me your name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError("Please enter a valid email so I can confirm.");

      const payload = {
        name, email,
        arrival: selStart, departure: selEnd, groupSize: groupSize(),
        companions: (fd.get("companions") || "").trim(),
        message: (fd.get("message") || "").trim(),
        website: fd.get("website") || "",
      };
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        const res = await submitBooking(payload);
        if (!res.ok) throw new Error(res.error || "Something went wrong.");
        $("#successText").innerHTML =
          `Thanks, ${esc(name.split(" ")[0])}! Your request for <strong>${fmt(selStart)} → ${fmt(selEnd)}</strong> ` +
          `(${payload.groupSize} ${payload.groupSize > 1 ? "people" : "person"}) has been sent. ` +
          `I'll review it and you'll get an email at <strong>${esc(email)}</strong> once it's approved.`;
        $("#successModal").showModal();
        form.reset();
        selStart = selEnd = null;
        syncInputs();
        $("#calHint").textContent = "Tap your arrival day, then your departure day.";
        await refreshData();
      } catch (ex) {
        showError(ex.message || "Could not send the request. Please try again.");
      } finally {
        btn.disabled = false; btn.textContent = "Send booking request";
      }
    });
  }
  function showError(msg) { const el = $("#formError"); el.textContent = msg; el.hidden = false; }

  function applyLockState() {
    const banner = $("#statusBanner");
    if (isLocked()) {
      banner.hidden = false; banner.className = "banner locked";
      banner.innerHTML = C.finalPricePerNight != null
        ? `🔒 Booking is closed. Final price: <strong>${eur(C.finalPricePerNight)}</strong> per person per night. See you on the slopes!`
        : "🔒 Booking closed on 1 February. The final price is being calculated — you'll hear from me soon.";
      $("#bookingForm").classList.add("locked");
      $("#calHint").textContent = "The calendar is locked.";
    } else if (DEMO) {
      banner.hidden = false; banner.className = "banner warn";
      banner.textContent = "Demo mode: no backend connected yet, so requests are only saved in this browser. (Set apiUrl in js/config.js.)";
    }
  }

  async function refreshData() {
    try {
      await loadBookings();
      $("#calLoading").hidden = true;
    } catch (ex) {
      $("#calLoading").textContent = "Couldn't load live availability — please refresh in a moment.";
      console.error(ex);
    }
    computeOccupancy();
    renderStats();
    refreshSelection();
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ================= Boot ================= */
  initHero();
  renderFeatures();
  renderGallery();
  initMap();
  initForm();
  applyLockState();
  computeOccupancy();
  renderCalendar();
  refreshData();
})();
