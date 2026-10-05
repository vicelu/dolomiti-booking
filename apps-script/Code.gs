/**
 * Ciasa Irma — booking backend (Google Apps Script + Google Sheet).
 *
 * - POST  (from the website)          → stores a request as "pending", emails the owner
 *                                        Approve / Decline links, and emails the guest a receipt.
 * - POST {action: "pool.*"}           → car-share pools: people gather on the same dates, agree on who
 *                                        drives, and once every member confirms, the pool becomes a
 *                                        single booking request (see "Pools" below).
 * - GET ?action=availability          → public list of pending/approved stays and pools (no emails, no tokens).
 * - GET ?action=approve|decline&id&token → one-click decision from the owner's email.
 *
 * Setup: see README.md.
 */

const SETTINGS = {
  OWNER_EMAIL: "pericakeksic@gmail.com",
  COTTAGE: "Ciasa Irma",
  SITE_URL: "https://vicelu.github.io/dolomiti-booking/",
  TRIP_START: "2027-02-13",
  TRIP_END: "2027-03-21",
  SPARE_BEDS: 3,
  MAX_GROUP: 3,
  LOCK_DATE: "2027-02-01T00:00:00+01:00",
  SHEET_NAME: "Bookings",
  // Only needed if you created the script at script.google.com instead of via the Sheet:
  // paste the long ID from the Sheet URL (docs.google.com/spreadsheets/d/<THIS PART>/edit).
  SHEET_ID: "",
};

const HEADERS = ["id", "createdAt", "status", "name", "email", "groupSize", "arrival", "departure",
  "nights", "companions", "message", "token", "decidedAt", "poolId"];

// Pool status: open | requested | cancelled. Member status: active | left.
const POOL_HEADERS = ["id", "createdAt", "status", "arrival", "departure", "plan", "bookingId", "updatedAt"];
const MEMBER_HEADERS = ["id", "poolId", "createdAt", "status", "name", "email", "groupSize", "from",
  "canDrive", "seats", "confirmed", "token"];
const COMMENT_HEADERS = ["id", "poolId", "createdAt", "name", "email", "memberId", "text"];
const PLAN_FIELDS = ["driver", "leaving", "pickups", "back", "notes"];

const TABLES = {
  bookings: { name: SETTINGS.SHEET_NAME, headers: HEADERS },
  pools: { name: "Pools", headers: POOL_HEADERS },
  members: { name: "PoolMembers", headers: MEMBER_HEADERS },
  comments: { name: "PoolComments", headers: COMMENT_HEADERS },
};

/* ---------------- Entry points ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === "approve" || p.action === "decline") return decide_(p.id, p.token, p.action);
  if (p.action === "availability")
    return json_({ ok: true, locked: isLocked_(), bookings: publicBookings_(), pools: publicPools_() });
  return json_({ ok: true, service: SETTINGS.COTTAGE + " bookings" });
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: "Invalid request." }); }
  if (data.website) return json_({ ok: true }); // honeypot: silently ignore bots

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (String(data.action || "").indexOf("pool.") === 0) return json_(poolAction_(data));
    return json_(createBooking_(data));
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: "Server error — please try again later." });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Logic ---------------- */

function createBooking_(data) {
  const v = validate_(data);
  if (!v.ok) return v;
  const b = insertBooking_({
    name: clean_(data.name, 80), email: clean_(data.email, 120), groupSize: data.groupSize,
    arrival: data.arrival, departure: data.departure,
    companions: clean_(data.companions, 200), message: clean_(data.message, 1000),
  });
  notifyOwner_(b);
  notifyGuestReceived_(b);
  return { ok: true, id: b.id };
}

function insertBooking_(b) {
  b.id = newId_();
  b.token = newToken_();
  b.createdAt = new Date().toISOString();
  b.status = "pending";
  b.nights = nightsBetween_(b.arrival, b.departure).length;
  append_(TABLES.bookings, b);
  return rowToObj_(HEADERS.map(function (h) { return b[h] == null ? "" : String(b[h]); }));
}

function validate_(d) {
  if (isLocked_()) return { ok: false, error: "Booking is closed — the calendar locked on 1 February." };
  if (!d.name || !String(d.name).trim()) return { ok: false, error: "Name is required." };
  if (!validEmail_(d.email)) return { ok: false, error: "A valid email is required." };
  const size = Number(d.groupSize);
  if (!validSize_(size)) return { ok: false, error: "Group size must be 1–" + SETTINGS.MAX_GROUP + "." };
  const dv = validateDates_(d.arrival, d.departure);
  if (!dv.ok) return dv;
  const full = fullNights_(d.arrival, d.departure, size, null);
  if (full.length) return { ok: false, error: "Sorry, not enough free berths on: " + full.join(", ") + ". Please pick other dates." };
  return { ok: true };
}

function validateDates_(arrival, departure) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(arrival) || !re.test(departure)) return { ok: false, error: "Invalid dates." };
  if (arrival < SETTINGS.TRIP_START || departure > SETTINGS.TRIP_END || departure <= arrival)
    return { ok: false, error: "Dates must be within the trip and departure after arrival." };
  return { ok: true };
}

/** Nights in [arrival, departure) where approved guests + size would exceed capacity. */
function fullNights_(arrival, departure, size, ignoreId) {
  const taken = {};
  allBookings_().forEach(function (b) {
    if (b.status !== "approved" || b.id === ignoreId) return;
    nightsBetween_(b.arrival, b.departure).forEach(function (n) { taken[n] = (taken[n] || 0) + Number(b.groupSize); });
  });
  return nightsBetween_(arrival, departure).filter(function (n) { return (taken[n] || 0) + size > SETTINGS.SPARE_BEDS; });
}

function decide_(id, token, action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheet_();
    const values = sheet.getDataRange().getDisplayValues();
    for (let i = 1; i < values.length; i++) {
      const b = rowToObj_(values[i]);
      if (b.id !== id) continue;
      if (!token || b.token !== token) return page_("Invalid link", "This approval link is not valid.");
      if (b.status !== "pending") return page_("Already handled", esc_(b.name) + "'s request is already <b>" + b.status + "</b>.");

      if (action === "approve") {
        const full = fullNights_(b.arrival, b.departure, Number(b.groupSize), b.id);
        if (full.length) return page_("Can't approve",
          "Approving would overbook these nights: <b>" + full.join(", ") + "</b>.<br>Decline it or change other bookings in the sheet first.");
      }
      const status = action === "approve" ? "approved" : "declined";
      const statusCol = HEADERS.indexOf("status") + 1, decidedCol = HEADERS.indexOf("decidedAt") + 1;
      sheet.getRange(i + 1, statusCol).setValue(status);
      sheet.getRange(i + 1, decidedCol).setNumberFormat("@").setValue(new Date().toISOString());
      b.status = status;
      notifyGuestDecision_(b);
      return page_(status === "approved" ? "Approved ✅" : "Declined",
        esc_(b.name) + " · " + b.groupSize + " pax · " + b.arrival + " → " + b.departure +
        "<br>The guest" + (b.poolId ? "s have" : " has") + " been emailed" +
        (status === "approved" ? " and the calendar is updated." : "."));
    }
    return page_("Not found", "No booking with id " + id + ".");
  } finally {
    lock.releaseLock();
  }
}

function publicBookings_() {
  return allBookings_()
    .filter(function (b) { return b.status === "approved" || b.status === "pending"; })
    .map(function (b) {
      const approved = b.status === "approved";
      // Pool bookings store "Ana Kovač, Marko Horvat" — show each first name.
      const names = String(b.name).split(/\s*,\s*/).filter(String).map(first_);
      return {
        arrival: b.arrival, departure: b.departure, groupSize: Number(b.groupSize), status: b.status,
        name: approved ? names.join(", ") : undefined,
        extra: approved ? Math.max(0, Number(b.groupSize) - names.length) : undefined,
      };
    });
}

/* ---------------- Pools ----------------
 * A pool is a soft pre-reservation: it shows on the calendar but doesn't block anyone else.
 * Members join with name + email and get a private link (memberId + key) to act on the pool.
 * Every change to the group or the travel plan resets confirmations; when the last active member
 * confirms, the pool turns into one pending booking for the whole group.
 */

function poolAction_(d) {
  switch (d.action) {
    case "pool.create": return poolCreate_(d);
    case "pool.join": return poolJoin_(d);
    case "pool.update": return poolUpdate_(d);
    case "pool.leave": return poolLeave_(d);
    case "pool.confirm": return poolConfirm_(d);
    case "pool.plan": return poolPlan_(d);
    case "pool.comment": return poolComment_(d);
  }
  return { ok: false, error: "Unknown action." };
}

function memberInput_(d, needContact) {
  const m = {
    name: clean_(String(d.name || "").trim(), 80),
    email: clean_(String(d.email || "").trim(), 120),
    groupSize: Number(d.groupSize),
    from: clean_(String(d.from || "").trim(), 120),
    canDrive: d.canDrive ? "yes" : "no",
    seats: d.canDrive ? Math.max(0, Math.min(8, Math.floor(Number(d.seats) || 0))) : 0,
  };
  if (needContact && !m.name) return { error: "Name is required." };
  if (needContact && !validEmail_(m.email)) return { error: "A valid email is required." };
  if (!validSize_(m.groupSize)) return { error: "Group size must be 1–" + SETTINGS.MAX_GROUP + "." };
  return m;
}

function poolCreate_(d) {
  if (isLocked_()) return { ok: false, error: "Booking is closed — the calendar locked on 1 February." };
  const dv = validateDates_(d.arrival, d.departure);
  if (!dv.ok) return dv;
  const m = memberInput_(d, true);
  if (m.error) return { ok: false, error: m.error };
  const full = fullNights_(d.arrival, d.departure, m.groupSize, null);
  if (full.length) return { ok: false, error: "Not enough free berths on: " + full.join(", ") + "." };

  const now = new Date().toISOString();
  const pool = { id: newId_(), createdAt: now, status: "open", arrival: d.arrival, departure: d.departure,
    plan: "{}", bookingId: "", updatedAt: now };
  append_(TABLES.pools, pool);
  const me = addMember_(pool, m);
  notifyMember_(pool, me, "Your car-share pool is open",
    "You started a pool for <b>" + range_(pool) + "</b>. Share the site with friends so they can join, " +
    "agree on who drives in the comments, and once everyone clicks <b>I'm in</b> the booking request goes out automatically.");
  return { ok: true, poolId: pool.id, memberId: me.id, key: me.token };
}

function poolJoin_(d) {
  if (isLocked_()) return { ok: false, error: "Booking is closed — the calendar locked on 1 February." };
  const ctx = poolCtx_(d.poolId);
  if (!ctx) return { ok: false, error: "That pool doesn't exist anymore." };
  if (ctx.pool.status !== "open") return { ok: false, error: "This pool has already sent its booking request." };
  const m = memberInput_(d, true);
  if (m.error) return { ok: false, error: m.error };
  if (ctx.members.some(function (x) { return x.email.toLowerCase() === m.email.toLowerCase(); }))
    return { ok: false, error: "That email is already in this pool. Use the link from your email to manage it." };
  const total = groupTotal_(ctx.members) + m.groupSize;
  if (total > SETTINGS.SPARE_BEDS) return { ok: false, error: "Only " + (SETTINGS.SPARE_BEDS - groupTotal_(ctx.members)) + " berth(s) left in this pool." };
  const full = fullNights_(ctx.pool.arrival, ctx.pool.departure, total, null);
  if (full.length) return { ok: false, error: "Not enough free berths on: " + full.join(", ") + "." };

  resetConfirmations_(ctx);
  const me = addMember_(ctx.pool, m);
  touch_(ctx.pool);
  notifyMember_(ctx.pool, me, "You joined a car-share pool",
    "You're in the pool for <b>" + range_(ctx.pool) + "</b>. Sort out who drives and where to meet in the comments, " +
    "then click <b>I'm in</b> on the site. The booking request goes out once everyone has.");
  notifyOthers_(ctx, me.id, me.name + " joined your pool",
    "<b>" + esc_(me.name) + "</b>" + (me.groupSize > 1 ? " (+" + (me.groupSize - 1) + ")" : "") + " joined" +
    (me.from ? ", leaving from " + esc_(me.from) : "") + ". Confirmations were reset, so please check the plan and confirm again.");
  return { ok: true, poolId: ctx.pool.id, memberId: me.id, key: me.token };
}

function poolUpdate_(d) {
  const ctx = poolCtx_(d.poolId), me = ctx && auth_(ctx, d);
  if (!me) return { ok: false, error: "Your pool link isn't valid anymore." };
  const m = memberInput_(d, false);
  if (m.error) return { ok: false, error: m.error };
  const patch = { from: m.from, canDrive: m.canDrive, seats: String(m.seats) };
  if (m.groupSize !== Number(me.groupSize)) {
    if (ctx.pool.status !== "open") return { ok: false, error: "The booking was already requested — ask the host to change the group size." };
    if (isLocked_()) return { ok: false, error: "Booking is closed." };
    const total = groupTotal_(ctx.members) - Number(me.groupSize) + m.groupSize;
    if (total > SETTINGS.SPARE_BEDS || fullNights_(ctx.pool.arrival, ctx.pool.departure, total, null).length)
      return { ok: false, error: "Not enough free berths for that group size." };
    patch.groupSize = String(m.groupSize);
    resetConfirmations_(ctx);
  }
  patch_(TABLES.members, me._row, patch);
  touch_(ctx.pool);
  return { ok: true };
}

function poolLeave_(d) {
  const ctx = poolCtx_(d.poolId), me = ctx && auth_(ctx, d);
  if (!me) return { ok: false, error: "Your pool link isn't valid anymore." };
  if (ctx.pool.status !== "open") return { ok: false, error: "The booking was already requested — please contact the host." };
  patch_(TABLES.members, me._row, { status: "left", confirmed: "" });
  ctx.members = ctx.members.filter(function (x) { return x.id !== me.id; });
  if (!ctx.members.length) {
    patch_(TABLES.pools, ctx.pool._row, { status: "cancelled", updatedAt: new Date().toISOString() });
    return { ok: true };
  }
  resetConfirmations_(ctx);
  touch_(ctx.pool);
  notifyOthers_(ctx, me.id, me.name + " left your pool",
    "<b>" + esc_(me.name) + "</b> left the pool. Confirmations were reset, so please check the plan and confirm again.");
  return { ok: true };
}

function poolConfirm_(d) {
  const ctx = poolCtx_(d.poolId), me = ctx && auth_(ctx, d);
  if (!me) return { ok: false, error: "Your pool link isn't valid anymore." };
  if (ctx.pool.status !== "open") return { ok: false, error: "The booking request was already sent." };
  if (!d.value) {
    patch_(TABLES.members, me._row, { confirmed: "" });
    return { ok: true };
  }
  if (isLocked_()) return { ok: false, error: "Booking is closed — the calendar locked on 1 February." };
  const others = ctx.members.filter(function (x) { return x.id !== me.id; });
  const everyone = others.every(function (x) { return x.confirmed === "yes"; });
  if (everyone) {
    const full = fullNights_(ctx.pool.arrival, ctx.pool.departure, groupTotal_(ctx.members), null);
    if (full.length) return { ok: false, error: "Someone booked in the meantime — not enough free berths on: " + full.join(", ") + "." };
  }
  patch_(TABLES.members, me._row, { confirmed: "yes" });
  me.confirmed = "yes";
  if (!everyone) return { ok: true, submitted: false };
  submitPool_(ctx);
  return { ok: true, submitted: true };
}

/** Everyone confirmed: turn the pool into a single pending booking. */
function submitPool_(ctx) {
  const pool = ctx.pool, members = ctx.members, plan = parsePlan_(pool.plan);
  const b = insertBooking_({
    name: members.map(function (m) { return m.name; }).join(", "),
    email: members.map(function (m) { return m.email; }).join(", "),
    groupSize: groupTotal_(members), arrival: pool.arrival, departure: pool.departure,
    companions: members.map(memberLine_).join("; ").slice(0, 1000),
    message: planText_(plan).slice(0, 1000),
    poolId: pool.id,
  });
  patch_(TABLES.pools, pool._row, { status: "requested", bookingId: b.id, updatedAt: new Date().toISOString() });
  notifyOwner_(b);
  notifyGuestReceived_(b);
}

function poolPlan_(d) {
  const ctx = poolCtx_(d.poolId), me = ctx && auth_(ctx, d);
  if (!me) return { ok: false, error: "Your pool link isn't valid anymore." };
  const plan = {};
  PLAN_FIELDS.forEach(function (f) { plan[f] = clean_(String((d.plan || {})[f] || "").trim(), 400); });
  const json = JSON.stringify(plan);
  if (json === JSON.stringify(parsePlan_(ctx.pool.plan))) return { ok: true };
  patch_(TABLES.pools, ctx.pool._row, { plan: json, updatedAt: new Date().toISOString() });
  // Once the booking is requested the plan is just travel logistics; no need to re-confirm.
  if (ctx.pool.status === "open") resetConfirmations_(ctx);
  notifyOthers_(ctx, me.id, "Travel plan updated",
    "<b>" + esc_(me.name) + "</b> updated the plan:<br><br>" + esc_(planText_(plan)).replace(/\n/g, "<br>") +
    (ctx.pool.status === "open" ? "<br><br>Confirmations were reset, so please check it and confirm again." : ""));
  return { ok: true };
}

function poolComment_(d) {
  const ctx = poolCtx_(d.poolId);
  if (!ctx || ctx.pool.status === "cancelled") return { ok: false, error: "That pool doesn't exist anymore." };
  const me = d.key ? auth_(ctx, d) : null;
  if (d.key && !me) return { ok: false, error: "Your pool link isn't valid anymore." };
  const text = clean_(String(d.text || "").trim(), 1000);
  if (!text) return { ok: false, error: "Write something first." };
  const name = me ? me.name : clean_(String(d.name || "").trim(), 80);
  const email = me ? me.email : clean_(String(d.email || "").trim(), 120);
  if (!name) return { ok: false, error: "Name is required." };
  if (!validEmail_(email)) return { ok: false, error: "A valid email is required." };
  append_(TABLES.comments, { id: newId_(), poolId: ctx.pool.id, createdAt: new Date().toISOString(),
    name: name, email: email, memberId: me ? me.id : "", text: text });
  notifyOthers_(ctx, me ? me.id : null, "New comment from " + name,
    "<b>" + esc_(name) + "</b>" + (me ? "" : " (not in the pool yet)") + " wrote:<br><br>" +
    '<div style="border-left:3px solid #e0a458;padding:4px 12px;color:#2b2118">' + esc_(text).replace(/\n/g, "<br>") + "</div>",
    me ? null : email);
  return { ok: true };
}

/* ---------- Pool helpers ---------- */

function poolCtx_(poolId) {
  const pool = rows_(TABLES.pools).filter(function (p) { return p.id === String(poolId || ""); })[0];
  if (!pool) return null;
  const members = rows_(TABLES.members).filter(function (m) { return m.poolId === pool.id && m.status === "active"; });
  return { pool: pool, members: members };
}

function auth_(ctx, d) {
  return ctx.members.filter(function (m) { return m.id === d.memberId && d.key && m.token === d.key; })[0] || null;
}

function addMember_(pool, m) {
  const me = { id: newId_(), poolId: pool.id, createdAt: new Date().toISOString(), status: "active",
    name: m.name, email: m.email, groupSize: m.groupSize, from: m.from, canDrive: m.canDrive, seats: m.seats,
    confirmed: "", token: newToken_() };
  append_(TABLES.members, me);
  return me;
}

function resetConfirmations_(ctx) {
  ctx.members.forEach(function (m) {
    if (m.confirmed) { patch_(TABLES.members, m._row, { confirmed: "" }); m.confirmed = ""; }
  });
}

function touch_(pool) { patch_(TABLES.pools, pool._row, { updatedAt: new Date().toISOString() }); }
function groupTotal_(members) { return members.reduce(function (s, m) { return s + Number(m.groupSize); }, 0); }
function range_(pool) { return pool.arrival + " → " + pool.departure; }
function parsePlan_(s) { try { return JSON.parse(s || "{}") || {}; } catch (e) { return {}; } }

function memberLine_(m) {
  return m.name + (Number(m.groupSize) > 1 ? " +" + (Number(m.groupSize) - 1) : "") +
    (m.from ? ", from " + m.from : "") + (m.canDrive === "yes" ? ", can drive (" + m.seats + " free seats)" : ", needs a ride");
}

function planText_(plan) {
  const labels = { driver: "Driver", leaving: "Leaving", pickups: "Pickups", back: "Return", notes: "Notes" };
  return PLAN_FIELDS.filter(function (f) { return plan[f]; })
    .map(function (f) { return labels[f] + ": " + plan[f]; }).join("\n") || "No travel plan yet.";
}

function publicPools_() {
  const bookings = {};
  allBookings_().forEach(function (b) { bookings[b.id] = b.status; });
  const members = rows_(TABLES.members), comments = rows_(TABLES.comments);
  return rows_(TABLES.pools)
    .filter(function (p) { return p.status === "open" || p.status === "requested"; })
    .map(function (p) {
      return {
        id: p.id, arrival: p.arrival, departure: p.departure, createdAt: p.createdAt,
        // requested pools report their booking's state: pending, approved or declined
        status: p.status === "open" ? "open" : (bookings[p.bookingId] || "pending"),
        plan: parsePlan_(p.plan),
        members: members.filter(function (m) { return m.poolId === p.id && m.status === "active"; }).map(function (m) {
          return { id: m.id, name: m.name, groupSize: Number(m.groupSize), from: m.from,
            canDrive: m.canDrive === "yes", seats: Number(m.seats) || 0, confirmed: m.confirmed === "yes" };
        }),
        comments: comments.filter(function (c) { return c.poolId === p.id; }).map(function (c) {
          return { name: c.name, memberId: c.memberId, text: c.text, createdAt: c.createdAt };
        }),
      };
    });
}

/* ---------------- Emails ---------------- */

function notifyOwner_(b) {
  const base = ScriptApp.getService().getUrl();
  const link = function (a) { return base + "?action=" + a + "&id=" + b.id + "&token=" + b.token; };
  const btn = function (href, label, color) {
    return '<a href="' + href + '" style="display:inline-block;padding:12px 22px;margin-right:8px;border-radius:999px;' +
      'background:' + color + ';color:#fff;text-decoration:none;font-weight:bold">' + label + "</a>";
  };
  const pool = !!b.poolId;
  const html =
    '<div style="font-family:Arial,sans-serif;color:#2b2118;max-width:560px">' +
    "<h2 style=\"margin:0 0 8px\">New " + (pool ? "group " : "") + "booking request — " + SETTINGS.COTTAGE + "</h2>" +
    (pool ? '<p style="color:#6f6257;margin:0 0 12px">Sent automatically after everyone in the car-share pool confirmed.</p>' : "") +
    table_([[pool ? "Names" : "Name", b.name], ["Email", b.email], ["Group size", b.groupSize], ["Arrival", b.arrival],
      ["Departure", b.departure], ["Nights", b.nights], ["Person-nights", Number(b.nights) * Number(b.groupSize)],
      [pool ? "Members" : "Companions", b.companions || "—"], [pool ? "Travel plan" : "Message", b.message || "—"]]) +
    '<p style="margin:20px 0">' + btn(link("approve"), "Approve", "#4f8a5b") + btn(link("decline"), "Decline", "#c8553d") + "</p>" +
    '<p style="color:#6f6257;font-size:12px">Booking id ' + b.id + ". You can also edit the status directly in the Google Sheet.</p></div>";
  MailApp.sendEmail({
    to: SETTINGS.OWNER_EMAIL, replyTo: String(b.email).split(",")[0].trim(),
    subject: "🏔️ " + (pool ? "Group booking" : "Booking") + " request: " + b.name + " (" + b.groupSize + " pax) " + b.arrival + " → " + b.departure,
    htmlBody: html,
  });
}

function notifyGuestReceived_(b) {
  MailApp.sendEmail({
    to: b.email, replyTo: SETTINGS.OWNER_EMAIL, name: SETTINGS.COTTAGE,
    subject: "We got your request — " + SETTINGS.COTTAGE,
    htmlBody: guestMail_("Request received ⛷️",
      "Thanks, " + esc_(greet_(b)) + "! " + (b.poolId ? "Everyone in your pool confirmed, so your" : "Your") +
      " request for <b>" + b.groupSize + " pax</b>, <b>" + b.arrival + " → " + b.departure +
      "</b> has been sent. You'll get another email once it's approved. The final price is set on 1 February."),
  });
}

function notifyGuestDecision_(b) {
  const approved = b.status === "approved";
  MailApp.sendEmail({
    to: b.email, replyTo: SETTINGS.OWNER_EMAIL, name: SETTINGS.COTTAGE,
    subject: (approved ? "You're in! " : "About your request — ") + SETTINGS.COTTAGE,
    htmlBody: guestMail_(approved ? "You're in! 🎉" : "Sorry!",
      approved
        ? "Your stay at " + SETTINGS.COTTAGE + " (" + b.groupSize + " pax, <b>" + b.arrival + " → " + b.departure + "</b>) is confirmed. " +
          "The price per person per night will be set on 1 February based on all bookings — tell your friends!"
        : "Unfortunately your request for " + b.arrival + " → " + b.departure + " couldn't be confirmed. " +
          "Reply to this email and we'll figure something out, or pick other dates on the site."),
  });
}

/** Email one pool member, with their private link to manage the pool. */
function notifyMember_(pool, m, subject, body) {
  const link = SETTINGS.SITE_URL
    ? SETTINGS.SITE_URL.replace(/#.*$/, "") + "#pool=" + pool.id + "&m=" + m.id + "&k=" + m.token : "";
  MailApp.sendEmail({
    to: m.email, replyTo: SETTINGS.OWNER_EMAIL, name: SETTINGS.COTTAGE,
    subject: subject + " — " + SETTINGS.COTTAGE + " " + range_(pool),
    htmlBody: guestMail_(esc_(subject), body +
      (link ? '<br><br><a href="' + link + '" style="display:inline-block;padding:10px 20px;border-radius:999px;background:#c8553d;color:#fff;text-decoration:none;font-weight:bold">Open your pool</a>' +
        '<br><span style="color:#6f6257;font-size:12px">This link is personal: it lets you confirm, edit the plan or leave. Don\'t share it.</span>' : ""), true),
  });
}

function notifyOthers_(ctx, exceptMemberId, subject, body, alsoEmail) {
  ctx.members.forEach(function (m) {
    if (m.id !== exceptMemberId && m.email !== alsoEmail) notifyMember_(ctx.pool, m, subject, body);
  });
}

function guestMail_(title, body, noSiteLink) {
  return '<div style="font-family:Arial,sans-serif;color:#2b2118;max-width:560px">' +
    '<h2 style="margin:0 0 10px">' + title + "</h2><p>" + body + "</p>" +
    (SETTINGS.SITE_URL && !noSiteLink ? '<p><a href="' + SETTINGS.SITE_URL + '" style="color:#c8553d">See the calendar</a></p>' : "") +
    '<p style="color:#6f6257">— ' + SETTINGS.COTTAGE + ", Val di Fassa</p></div>";
}

/* ---------------- Helpers ---------------- */

function spreadsheet_() {
  return SETTINGS.SHEET_ID ? SpreadsheetApp.openById(SETTINGS.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

/** Get (or create) a table's sheet; also adds header columns introduced by later versions of this script. */
function sheetFor_(t) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(t.name);
  if (!sh) {
    sh = ss.insertSheet(t.name);
    sh.setFrozenRows(1);
  }
  if (sh.getLastColumn() < t.headers.length) sh.getRange(1, 1, 1, t.headers.length).setValues([t.headers]).setFontWeight("bold");
  return sh;
}

function sheet_() { return sheetFor_(TABLES.bookings); }

/** All rows of a table as objects; `_row` is the 1-based sheet row for patch_. */
function rows_(t) {
  const values = sheetFor_(t).getDataRange().getDisplayValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    const o = { _row: i + 1 };
    t.headers.forEach(function (h, j) { o[h] = values[i][j] == null ? "" : values[i][j]; });
    if (o.status != null) o.status = String(o.status).trim().toLowerCase();
    out.push(o);
  }
  return out;
}

function append_(t, obj) {
  const sh = sheetFor_(t);
  const row = t.headers.map(function (h) { return obj[h] == null ? "" : String(obj[h]); });
  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat("@").setValues([row]);
}

function patch_(t, rowNum, obj) {
  const sh = sheetFor_(t);
  Object.keys(obj).forEach(function (k) {
    const col = t.headers.indexOf(k) + 1;
    if (col) sh.getRange(rowNum, col).setNumberFormat("@").setValue(String(obj[k]));
  });
}

function allBookings_() {
  const values = sheet_().getDataRange().getDisplayValues();
  return values.slice(1).filter(function (r) { return r[0]; }).map(rowToObj_);
}

function rowToObj_(r) {
  const o = {};
  HEADERS.forEach(function (h, i) { o[h] = r[i] == null ? "" : r[i]; });
  o.status = String(o.status || "").trim().toLowerCase();
  return o;
}

function nightsBetween_(a, b) {
  const out = [];
  let t = Date.parse(a + "T00:00:00Z");
  const end = Date.parse(b + "T00:00:00Z");
  while (t < end) { out.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; }
  return out;
}

function isLocked_() { return Date.now() >= new Date(SETTINGS.LOCK_DATE).getTime(); }
function validEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "")); }
function validSize_(n) { return n >= 1 && n <= SETTINGS.MAX_GROUP && Math.floor(n) === n; }
function newId_() { return Utilities.getUuid().slice(0, 8); }
function newToken_() { return Utilities.getUuid().replace(/-/g, ""); }
function clean_(s, max) { return String(s || "").replace(/^[=+\-@]/, "'$&").slice(0, max); }
function first_(name) { return String(name).split(" ")[0]; }
function greet_(b) { return b.poolId ? "everyone" : first_(b.name); }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function table_(rows) {
  return '<table style="border-collapse:collapse;width:100%">' + rows.map(function (r) {
    return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#6f6257;width:130px">' + r[0] +
      '</td><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>' + esc_(r[1]) + "</b></td></tr>";
  }).join("") + "</table>";
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function page_(title, body) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:30px;border-radius:18px;' +
    'background:#faf6ef;color:#2b2118;text-align:center"><h1 style="margin-top:0">' + title + "</h1><p>" + body + "</p></div>"
  ).setTitle(SETTINGS.COTTAGE);
}

/** Run once from the editor to create the sheets and grant email permissions. */
function setup() {
  Object.keys(TABLES).forEach(function (k) { sheetFor_(TABLES[k]); });
  MailApp.getRemainingDailyQuota();
}
