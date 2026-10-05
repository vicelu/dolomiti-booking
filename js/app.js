(() => {
  "use strict";
  const C = window.CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const DEMO = !C.apiUrl;
  const DEMO_KEY = "ciasa-irma-demo-bookings";
  const DEMO_POOLS_KEY = "ciasa-irma-demo-pools";
  const POOL_KEYS = "ciasa-irma-pool-keys"; // {poolId: {m: memberId, k: key}} — this browser's pool memberships

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
  let bookings = [];          // [{arrival, departure, groupSize, status, name, extra}]
  let pools = [];             // [{id, arrival, departure, status, plan, members[], comments[]}]
  let occ = {};               // date -> {taken, pending, held, names[]}
  let selStart = null, selEnd = null;

  function computeOccupancy() {
    occ = {};
    TRIP_NIGHTS.forEach((d) => (occ[d] = { taken: 0, pending: 0, held: 0, names: [] }));
    for (const b of bookings) {
      for (const d of nightsOf(b.arrival, b.departure)) {
        if (!occ[d]) continue;
        if (b.status === "approved") {
          occ[d].taken += +b.groupSize;
          const extra = b.extra ?? b.groupSize - 1;
          if (b.name) occ[d].names.push(b.name + (extra > 0 ? ` +${extra}` : ""));
        } else if (b.status === "pending") occ[d].pending += +b.groupSize;
      }
    }
    // Open pools are soft pre-reservations: shown, but they don't reduce freeOn().
    for (const p of pools) {
      if (p.status !== "open") continue;
      for (const d of nightsOf(p.arrival, p.departure)) if (occ[d]) occ[d].held += poolSize(p);
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
      try { pools = JSON.parse(localStorage.getItem(DEMO_POOLS_KEY)) || null; } catch { pools = null; }
      if (!pools) pools = demoSeedPools();
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
    pools = data.pools || [];
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

  async function poolApi(payload) {
    if (DEMO) {
      await new Promise((r) => setTimeout(r, 400));
      return demoPoolAction(payload);
    }
    const res = await fetch(C.apiUrl, { method: "POST", body: JSON.stringify(payload) });
    return res.json();
  }

  /* Demo mode: a small in-browser stand-in for the pool endpoints in apps-script/Code.gs. */
  function demoSeedPools() {
    return [{
      id: "demo1", arrival: "2027-02-22", departure: "2027-03-01", status: "open",
      plan: { driver: "Ivana's Golf", leaving: "Mon 22 Feb, 6:30 from Zagreb (Avenue Mall)" },
      members: [
        { id: "m1", key: "-", name: "Ivana", groupSize: 1, from: "Zagreb", canDrive: true, seats: 3, confirmed: true },
        { id: "m2", key: "-", name: "Petra", groupSize: 1, from: "Ljubljana", canDrive: false, seats: 0, confirmed: false },
      ],
      comments: [
        { name: "Ivana", memberId: "m1", text: "I can drive, there's room for skis on the roof.", createdAt: "2026-10-01T18:20:00Z" },
        { name: "Petra", memberId: "m2", text: "Could you pick me up at BTC in Ljubljana? Happy to split fuel.", createdAt: "2026-10-02T09:05:00Z" },
      ],
    }];
  }
  function demoPoolAction(d) {
    const rid = () => Math.random().toString(36).slice(2, 10);
    const p = pools.find((x) => x.id === d.poolId);
    const me = p && p.members.find((m) => m.id === d.memberId && m.key === d.key);
    const member = () => ({ id: rid(), key: rid() + rid(), name: d.name, groupSize: +d.groupSize, from: d.from,
      canDrive: !!d.canDrive, seats: d.canDrive ? +d.seats || 0 : 0, confirmed: false });
    const reset = () => p.members.forEach((m) => (m.confirmed = false));
    let out = { ok: true };
    if (d.action !== "pool.create" && !p) return { ok: false, error: "That pool doesn't exist anymore." };
    if (!["pool.create", "pool.join", "pool.comment"].includes(d.action) && !me) return { ok: false, error: "Your pool link isn't valid anymore." };
    switch (d.action) {
      case "pool.create": {
        const m = member();
        pools.push({ id: rid(), arrival: d.arrival, departure: d.departure, status: "open", plan: {}, members: [m], comments: [] });
        out = { ok: true, poolId: pools.at(-1).id, memberId: m.id, key: m.key };
        break;
      }
      case "pool.join": {
        if (poolRoom(p) < +d.groupSize) return { ok: false, error: "Not enough berths left in this pool." };
        reset();
        const m = member();
        p.members.push(m);
        out = { ok: true, poolId: p.id, memberId: m.id, key: m.key };
        break;
      }
      case "pool.update":
        if (+d.groupSize !== me.groupSize) {
          if (poolRoom(p) + me.groupSize < +d.groupSize) return { ok: false, error: "Not enough free berths for that group size." };
          reset();
        }
        Object.assign(me, { groupSize: +d.groupSize, from: d.from, canDrive: !!d.canDrive, seats: d.canDrive ? +d.seats || 0 : 0 });
        break;
      case "pool.leave":
        p.members = p.members.filter((m) => m !== me);
        reset();
        if (!p.members.length) pools = pools.filter((x) => x !== p);
        break;
      case "pool.confirm":
        me.confirmed = !!d.value;
        if (p.members.every((m) => m.confirmed)) {
          if (poolRoom(p) < 0) { me.confirmed = false; return { ok: false, error: "Someone booked in the meantime, so there aren't enough free berths." }; }
          p.status = "pending";
          bookings.push({ arrival: p.arrival, departure: p.departure, groupSize: poolSize(p), status: "pending" });
          try { localStorage.setItem(DEMO_KEY, JSON.stringify(bookings)); } catch {}
          out.submitted = true;
        }
        break;
      case "pool.plan":
        p.plan = { ...d.plan };
        if (p.status === "open") reset();
        break;
      case "pool.comment":
        p.comments.push({ name: me ? me.name : d.name, memberId: me ? me.id : "", text: d.text, createdAt: new Date().toISOString() });
        break;
    }
    try { localStorage.setItem(DEMO_POOLS_KEY, JSON.stringify(pools)); } catch {}
    return out;
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
          const held = Math.min(o.held, free - pend);
          for (let i = 0; i < SPARE; i++)
            beds += `<i class="${i < o.taken ? "t" : i < o.taken + pend ? "p" : i < o.taken + pend + held ? "h" : ""}"></i>`;
          if (free === 0) cls.push("full");
          title = `${fmt(d)}: ${free} of ${SPARE} berths free` +
            (C.showGuestNames && o.names.length ? ` · staying: ${o.names.join(", ")}` : "") +
            (o.pending ? ` · ${o.pending} pending` : "") +
            (o.held ? ` · ${o.held} pre-reserved in car-share pools` : "");
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

    applyPoolFilter();
    $("#startPoolBtn").disabled = isLocked() || !selStart || !selEnd || !validateSelection().ok;
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
    const overlapping = pools.filter((p) => p.status === "open" && overlapsSelection(p)).length;
    sum.innerHTML = `<strong>${fmt(selStart)} → ${fmt(selEnd)}</strong><br>${n} night${n > 1 ? "s" : ""} × ${size} ${size > 1 ? "people" : "person"} = <strong>${n * size} person-nights</strong>${extra}` +
      (overlapping ? `<a class="pool-hint" href="#pools" data-filter-pools>🚗 ${overlapping} open car-share pool${overlapping > 1 ? "s" : ""} overlap${overlapping > 1 ? "" : "s"} these dates. Join instead?</a>` : "");
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
        $("#successModal h3").textContent = "Request sent!";
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
  /* ================= Car-share pools ================= */
  const poolSize = (p) => p.members.reduce((s, m) => s + +m.groupSize, 0);
  // Berths still free for this pool's group across all its nights (approved bookings only); < 0 = overbooked.
  const poolRoom = (p) => Math.min(...nightsOf(p.arrival, p.departure).filter((d) => occ[d]).map(freeOn)) - poolSize(p);
  const overlapsSelection = (p) => !!(selStart && selEnd && p.arrival < selEnd && p.departure > selStart);

  let poolKeys = {};
  try { poolKeys = JSON.parse(localStorage.getItem(POOL_KEYS)) || {}; } catch {}
  function saveCreds(poolId, memberId, key) {
    poolKeys[poolId] = { m: memberId, k: key };
    try { localStorage.setItem(POOL_KEYS, JSON.stringify(poolKeys)); } catch {}
  }
  /** This browser's membership in a pool, if it still exists. */
  function myCreds(p) {
    const c = poolKeys[p.id];
    return c && p.members.some((m) => m.id === c.m) ? c : null;
  }
  const authOf = (p) => { const c = myCreds(p); return { poolId: p.id, memberId: c.m, key: c.k }; };

  /** Private links from emails look like #pool=<id>&m=<memberId>&k=<key>. */
  function readPoolLink() {
    const m = location.hash.match(/^#pool=([\w-]+)&m=([\w-]+)&k=([\w-]+)/);
    if (!m) return location.hash.startsWith("#pool-") ? location.hash.slice(6) : null;
    saveCreds(m[1], m[2], m[3]);
    history.replaceState(null, "", location.pathname + location.search + "#pool-" + m[1]);
    return m[1];
  }

  const STATUS = {
    open: "Pre-reservation", pending: "Booking requested", approved: "Booked ✓", declined: "Declined",
  };
  const PLAN_LABELS = { driver: "Driver", leaving: "Leaving", pickups: "Pickups", back: "Return", notes: "Notes" };
  const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function renderPools() {
    const list = $("#poolList");
    const sorted = pools.slice().sort((a, b) => a.arrival.localeCompare(b.arrival) || a.departure.localeCompare(b.departure));
    if (!sorted.length) {
      list.innerHTML = `<p class="pools-empty">No pools yet. Pick your dates in the calendar and start the first one.</p>`;
      return;
    }
    list.innerHTML = sorted.map(poolCard).join("") + `<p class="pools-empty" id="poolsNone" hidden>No pools overlap your selected dates yet. Start one!</p>`;
    applyPoolFilter();
  }

  function poolCard(p) {
    const mine = myCreds(p), open = p.status === "open", locked = isLocked();
    const n = diffDays(p.arrival, p.departure), size = poolSize(p), room = poolRoom(p);
    const done = p.members.filter((m) => m.confirmed).length;
    const members = p.members.map((m) => `
      <li class="${m.confirmed ? "ok" : ""}">
        <span class="pm-name">${esc(m.name)}${m.groupSize > 1 ? ` +${m.groupSize - 1}` : ""}${mine && mine.m === m.id ? " <em>(you)</em>" : ""}</span>
        <span class="pm-meta">${m.from ? `<span>from ${esc(m.from)}</span>` : ""}
          ${m.canDrive ? `<span class="drive">🚗 can drive · ${m.seats} free seat${m.seats === 1 ? "" : "s"}</span>` : "<span>needs a ride</span>"}</span>
        ${open ? `<span class="pm-ok">${m.confirmed ? "✓ I'm in" : "not yet"}</span>` : ""}
      </li>`).join("");

    const planRows = Object.keys(PLAN_LABELS).filter((k) => p.plan && p.plan[k]);
    const plan = planRows.length
      ? `<dl>${planRows.map((k) => `<dt>${PLAN_LABELS[k]}</dt><dd>${esc(p.plan[k])}</dd>`).join("")}</dl>`
      : `<p class="empty">Nothing agreed yet. Use the comments to work out who drives and where to meet.</p>`;

    const comments = p.comments.length
      ? `<ol>${p.comments.map((c) => `<li><div class="c-meta"><b>${esc(c.name)}</b>${c.memberId ? "" : " · not in the pool"} · ${when(c.createdAt)}</div><p class="c-text">${esc(c.text)}</p></li>`).join("")}</ol>`
      : `<p class="none">No comments yet.</p>`;

    let warn = "";
    if (open && room < 0) {
      const left = room + size;
      warn = `<p class="pool-warn">⚠ Someone else booked some of these nights. Only ${Math.max(0, left)} berth${left === 1 ? "" : "s"} are left, so this pool can't be booked as it is. Shrink the group or start a pool on other dates.</p>`;
    }

    let actions = "";
    if (open && !locked) {
      if (mine) {
        const meConfirmed = p.members.find((m) => m.id === mine.m).confirmed;
        actions = (meConfirmed
          ? `<button type="button" class="btn btn-outline btn-sm" data-act="unconfirm">Undo "I'm in"</button>`
          : `<button type="button" class="btn btn-primary btn-sm" data-act="confirm" ${room < 0 ? "disabled" : ""}>I'm in ✓</button>`) +
          `<button type="button" class="btn btn-quiet btn-sm" data-act="edit">Edit my details</button>` +
          `<button type="button" class="btn btn-quiet btn-sm" data-act="leave">Leave pool</button>`;
      } else if (room > 0) {
        actions = `<button type="button" class="btn btn-primary btn-sm" data-act="join">Join this pool</button>`;
      }
    } else if (mine && !open) {
      actions = `<button type="button" class="btn btn-quiet btn-sm" data-act="edit">Edit my details</button>`;
    }

    const roomText = !open ? "" : room > 0 ? ` · room for ${room} more` : room === 0 ? " · full" : "";
    return `
      <article class="pool" id="pool-${esc(p.id)}" data-pool="${esc(p.id)}">
        <header class="pool-head">
          <div>
            <h3>${fmt(p.arrival)} → ${fmt(p.departure)}<span class="match-tag" hidden>your dates</span></h3>
            <p class="pool-sub">${n} night${n > 1 ? "s" : ""} · ${size} ${size > 1 ? "people" : "person"}${roomText}</p>
          </div>
          <span class="pool-status s-${p.status}">${STATUS[p.status] || esc(p.status)}</span>
        </header>
        ${warn}
        <ul class="pool-members">${members}</ul>
        ${open ? `<p class="pool-progress"><strong>${done} of ${p.members.length}</strong> confirmed. The booking request goes to ${esc(C.hostName)} automatically once everyone is in. Any change to the group or the plan resets confirmations.</p>` : ""}
        <div class="pool-plan">
          <div class="pool-plan-head"><h4>Travel plan</h4>${mine ? `<button type="button" class="link-btn" data-act="plan">${planRows.length ? "Edit" : "Add plan"}</button>` : ""}</div>
          ${plan}
        </div>
        <div class="pool-comments">
          <h4>Comments</h4>
          ${comments}
          <form class="comment-form" novalidate>
            ${mine ? "" : `<div class="cf-who"><input type="text" name="name" placeholder="Your name" maxlength="80" autocomplete="name"><input type="email" name="email" placeholder="Email (not shown)" maxlength="120" autocomplete="email"></div>`}
            <div class="cf-send">
              <textarea name="text" rows="1" maxlength="1000" placeholder="${mine ? "Who drives, where to meet…" : "Ask something or say hi…"}"></textarea>
              <button type="submit" class="btn btn-outline btn-sm">Post</button>
            </div>
          </form>
        </div>
        <div class="pool-actions">${actions}</div>
        <p class="pool-error" role="alert" hidden></p>
      </article>`;
  }

  function applyPoolFilter() {
    const only = $("#poolFilter").checked && selStart && selEnd;
    let shownCount = 0;
    document.querySelectorAll(".pool").forEach((el) => {
      const p = pools.find((x) => x.id === el.dataset.pool);
      const match = !!p && overlapsSelection(p);
      el.classList.toggle("match", match);
      el.querySelector(".match-tag").hidden = !match;
      el.classList.toggle("hidden", !!only && !match);
      if (!only || match) shownCount++;
    });
    const none = $("#poolsNone");
    if (none) none.hidden = shownCount > 0;
  }

  function focusPool(id) {
    const el = document.getElementById("pool-" + id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1800);
  }

  async function poolAct(cardEl, payload, btn) {
    const err = cardEl && cardEl.querySelector(".pool-error");
    if (err) err.hidden = true;
    if (btn) btn.disabled = true;
    try {
      const res = await poolApi(payload);
      if (!res.ok) throw new Error(res.error || "Something went wrong.");
      return res;
    } catch (ex) {
      if (err) { err.textContent = ex.message || "Could not reach the server. Please try again."; err.hidden = false; }
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---- start / join / edit dialog ---- */
  let dlg = null; // {mode: "create"|"join"|"edit", pool}
  function openPoolDialog(mode, pool) {
    dlg = { mode, pool };
    const f = $("#poolForm");
    f.reset();
    $("#poolError").hidden = true;
    const arr = pool ? pool.arrival : selStart, dep = pool ? pool.departure : selEnd;
    $("#poolDlgTitle").textContent = { create: "Start a car-share pool", join: "Join this pool", edit: "Your details" }[mode];
    $("#poolDlgDates").textContent = `${fmt(arr)} → ${fmt(dep)} · ${diffDays(arr, dep)} nights`;
    $("#poolSubmit").textContent = { create: "Start pool", join: "Join pool", edit: "Save" }[mode];
    f.querySelector(".dlg-contact").hidden = mode === "edit";

    let cap, me = null;
    if (mode === "create") {
      cap = Math.min(...nightsOf(arr, dep).map(freeOn));
      const bf = $("#bookingForm");
      f.name.value = bf.name.value;
      f.email.value = bf.email.value;
      setGroup(f, Math.min(groupSize(), cap));
    } else if (mode === "join") {
      cap = poolRoom(pool);
    } else {
      me = pool.members.find((m) => m.id === myCreds(pool).m);
      cap = pool.status === "open" ? poolRoom(pool) + me.groupSize : me.groupSize;
      setGroup(f, me.groupSize);
      f.from.value = me.from || "";
      f.canDrive.checked = !!me.canDrive;
      f.seats.value = me.canDrive ? me.seats : 3;
    }
    f.querySelectorAll('input[name="pGroup"]').forEach((r) => {
      r.disabled = +r.value > cap && !(me && +r.value === me.groupSize);
    });
    syncSeats();
    $("#poolDialog").showModal();
  }
  function setGroup(f, n) { const r = f.querySelector(`input[name="pGroup"][value="${Math.max(1, n)}"]`); if (r) r.checked = true; }
  function syncSeats() { const f = $("#poolForm"); f.querySelector(".dlg-seats").hidden = !f.canDrive.checked; }

  async function submitPoolDialog(e) {
    e.preventDefault();
    const f = e.target, err = $("#poolError"), btn = $("#poolSubmit");
    err.hidden = true;
    const fd = new FormData(f);
    const payload = {
      groupSize: +(fd.get("pGroup") || 1),
      from: (fd.get("from") || "").trim(),
      canDrive: f.canDrive.checked,
      seats: +(fd.get("seats") || 0),
      website: fd.get("website") || "",
    };
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    if (dlg.mode !== "edit") {
      payload.name = (fd.get("name") || "").trim();
      payload.email = (fd.get("email") || "").trim();
      if (!payload.name) return fail("Please tell us your name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return fail("Please enter a valid email. You'll get your private pool link there.");
    }
    if (dlg.mode === "create") Object.assign(payload, { action: "pool.create", arrival: selStart, departure: selEnd });
    if (dlg.mode === "join") Object.assign(payload, { action: "pool.join", poolId: dlg.pool.id });
    if (dlg.mode === "edit") Object.assign(payload, { action: "pool.update" }, authOf(dlg.pool));

    btn.disabled = true;
    try {
      const res = await poolApi(payload);
      if (!res.ok) return fail(res.error || "Something went wrong.");
      if (res.memberId) saveCreds(res.poolId, res.memberId, res.key);
      $("#poolDialog").close();
      const id = res.poolId || dlg.pool.id;
      if (dlg.mode === "create") {
        selStart = selEnd = null;
        syncInputs();
        $("#calHint").textContent = "Tap your arrival day, then your departure day.";
      }
      await refreshData();
      focusPool(id);
    } catch (ex) {
      fail(ex.message || "Could not reach the server. Please try again.");
    } finally {
      btn.disabled = false;
    }
  }

  /* ---- travel plan dialog ---- */
  let planPool = null;
  function openPlanDialog(pool) {
    planPool = pool;
    const f = $("#planForm");
    $("#planError").hidden = true;
    Object.keys(PLAN_LABELS).forEach((k) => (f[k].value = (pool.plan && pool.plan[k]) || ""));
    $("#driverList").innerHTML = pool.members.filter((m) => m.canDrive).map((m) => `<option value="${esc(m.name)}">`).join("");
    f.querySelector(".dlg-dates").textContent = pool.status === "open"
      ? "What the group agreed on. Changing it asks everyone to confirm again."
      : "What the group agreed on.";
    $("#planDialog").showModal();
  }
  async function submitPlan(e) {
    e.preventDefault();
    const f = e.target, err = $("#planError"), btn = $("#planSubmit");
    const plan = {};
    Object.keys(PLAN_LABELS).forEach((k) => (plan[k] = f[k].value.trim()));
    err.hidden = true;
    btn.disabled = true;
    try {
      const res = await poolApi({ action: "pool.plan", plan, ...authOf(planPool) });
      if (!res.ok) { err.textContent = res.error || "Something went wrong."; err.hidden = false; return; }
      $("#planDialog").close();
      await refreshData();
      focusPool(planPool.id);
    } catch (ex) {
      err.textContent = "Could not reach the server. Please try again."; err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  function initPools() {
    const list = $("#poolList");
    list.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const card = btn.closest(".pool");
      const p = pools.find((x) => x.id === card.dataset.pool);
      if (!p) return;
      const act = btn.dataset.act;
      if (act === "join") return openPoolDialog("join", p);
      if (act === "edit") return openPoolDialog("edit", p);
      if (act === "plan") return openPlanDialog(p);
      if (act === "leave" && !confirm("Leave this pool? The others will be notified.")) return;
      const payload = { action: act === "leave" ? "pool.leave" : "pool.confirm", value: act === "confirm", ...authOf(p) };
      const res = await poolAct(card, payload, btn);
      if (!res) return;
      if (act === "leave") { delete poolKeys[p.id]; try { localStorage.setItem(POOL_KEYS, JSON.stringify(poolKeys)); } catch {} }
      await refreshData();
      if (res.submitted) {
        $("#successModal h3").textContent = "Everyone's in!";
        $("#successText").innerHTML = `The booking request for <strong>${fmt(p.arrival)} → ${fmt(p.departure)}</strong> ` +
          `(${poolSize(p)} ${poolSize(p) > 1 ? "people" : "person"}) has been sent to ${esc(C.hostName)}. Everyone in the pool will get an email once it's approved.`;
        $("#successModal").showModal();
      } else if (act !== "leave") focusPool(p.id);
    });
    list.addEventListener("submit", async (e) => {
      const form = e.target.closest(".comment-form");
      if (!form) return;
      e.preventDefault();
      const card = form.closest(".pool");
      const p = pools.find((x) => x.id === card.dataset.pool);
      const text = form.text.value.trim();
      const err = card.querySelector(".pool-error");
      const fail = (msg) => { err.textContent = msg; err.hidden = false; };
      if (!text) return;
      const payload = { action: "pool.comment", poolId: p.id, text };
      if (myCreds(p)) Object.assign(payload, authOf(p));
      else {
        payload.name = form.name.value.trim();
        payload.email = form.email.value.trim();
        if (!payload.name) return fail("Please add your name to comment.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return fail("Please add a valid email. It isn't shown to anyone.");
      }
      const res = await poolAct(card, payload, form.querySelector("button"));
      if (!res) return;
      await refreshData();
      const ol = document.querySelector(`#pool-${p.id} .pool-comments ol`);
      if (ol) ol.scrollTop = ol.scrollHeight;
    });

    $("#poolForm").addEventListener("submit", submitPoolDialog);
    $("#poolForm").canDrive.addEventListener("change", syncSeats);
    $("#planForm").addEventListener("submit", submitPlan);
    document.querySelectorAll(".modal-form [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
    $("#poolFilter").addEventListener("change", applyPoolFilter);

    const start = () => {
      if (isLocked()) return;
      if (!selStart || !selEnd || !validateSelection().ok) {
        $("#book").scrollIntoView({ behavior: "smooth" });
        flashHint("Pick your arrival and departure in the calendar first, then start the pool.");
        return;
      }
      openPoolDialog("create");
    };
    $("#startPoolBtn").addEventListener("click", start);
    $("#newPoolBtn").addEventListener("click", start);
    $("#summary").addEventListener("click", (e) => {
      if (e.target.closest("[data-filter-pools]")) $("#poolFilter").checked = true;
      applyPoolFilter();
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
      $("#newPoolBtn").hidden = true;
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
    renderPools();
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
  initPools();
  applyLockState();
  computeOccupancy();
  renderCalendar();
  const linkedPool = readPoolLink();
  refreshData().then(() => linkedPool && focusPool(linkedPool));
})();
