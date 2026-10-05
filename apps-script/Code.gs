/**
 * Ciasa Irma — booking backend (Google Apps Script + Google Sheet).
 *
 * - POST  (from the website)          → stores a request as "pending", emails the owner
 *                                        Approve / Decline links, and emails the guest a receipt.
 * - GET ?action=availability          → public list of pending/approved stays (no emails, no messages).
 * - GET ?action=approve|decline&id&token → one-click decision from the owner's email.
 *
 * Setup: see README.md.
 */

const SETTINGS = {
  OWNER_EMAIL: "pericakeksic@gmail.com",
  COTTAGE: "Ciasa Irma",
  SITE_URL: "", // optional: your GitHub Pages URL, used in guest emails
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
  "nights", "companions", "message", "token", "decidedAt"];

/* ---------------- Entry points ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === "approve" || p.action === "decline") return decide_(p.id, p.token, p.action);
  if (p.action === "availability") return json_({ ok: true, locked: isLocked_(), bookings: publicBookings_() });
  return json_({ ok: true, service: SETTINGS.COTTAGE + " bookings" });
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: "Invalid request." }); }
  if (data.website) return json_({ ok: true }); // honeypot: silently ignore bots

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const v = validate_(data);
    if (!v.ok) return json_(v);

    const sheet = sheet_();
    const id = Utilities.getUuid().slice(0, 8);
    const token = Utilities.getUuid().replace(/-/g, "");
    const nights = nightsBetween_(data.arrival, data.departure).length;
    const row = [id, new Date().toISOString(), "pending", clean_(data.name, 80), clean_(data.email, 120),
      String(data.groupSize), data.arrival, data.departure, String(nights),
      clean_(data.companions, 200), clean_(data.message, 1000), token, ""];
    const r = sheet.getLastRow() + 1;
    sheet.getRange(r, 1, 1, row.length).setNumberFormat("@").setValues([row]);

    notifyOwner_(rowToObj_(row));
    notifyGuestReceived_(rowToObj_(row));
    return json_({ ok: true, id: id });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: "Server error — please try again later." });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Logic ---------------- */

function validate_(d) {
  if (isLocked_()) return { ok: false, error: "Booking is closed — the calendar locked on 1 February." };
  if (!d.name || !String(d.name).trim()) return { ok: false, error: "Name is required." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email || ""))) return { ok: false, error: "A valid email is required." };
  const size = Number(d.groupSize);
  if (!(size >= 1 && size <= SETTINGS.MAX_GROUP && Math.floor(size) === size)) return { ok: false, error: "Group size must be 1–" + SETTINGS.MAX_GROUP + "." };
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(d.arrival) || !re.test(d.departure)) return { ok: false, error: "Invalid dates." };
  if (d.arrival < SETTINGS.TRIP_START || d.departure > SETTINGS.TRIP_END || d.departure <= d.arrival)
    return { ok: false, error: "Dates must be within the trip and departure after arrival." };
  const full = fullNights_(d.arrival, d.departure, size, null);
  if (full.length) return { ok: false, error: "Sorry, not enough free berths on: " + full.join(", ") + ". Please pick other dates." };
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
        "<br>The guest has been emailed" + (status === "approved" ? " and the calendar is updated." : "."));
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
      return {
        arrival: b.arrival, departure: b.departure, groupSize: Number(b.groupSize), status: b.status,
        name: b.status === "approved" ? String(b.name).split(" ")[0] : undefined,
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
  const html =
    '<div style="font-family:Arial,sans-serif;color:#2b2118;max-width:560px">' +
    "<h2 style=\"margin:0 0 8px\">New booking request — " + SETTINGS.COTTAGE + "</h2>" +
    table_([["Name", b.name], ["Email", b.email], ["Group size", b.groupSize], ["Arrival", b.arrival],
      ["Departure", b.departure], ["Nights", b.nights], ["Person-nights", Number(b.nights) * Number(b.groupSize)],
      ["Companions", b.companions || "—"], ["Message", b.message || "—"]]) +
    '<p style="margin:20px 0">' + btn(link("approve"), "Approve", "#4f8a5b") + btn(link("decline"), "Decline", "#c8553d") + "</p>" +
    '<p style="color:#6f6257;font-size:12px">Booking id ' + b.id + ". You can also edit the status directly in the Google Sheet.</p></div>";
  MailApp.sendEmail({
    to: SETTINGS.OWNER_EMAIL, replyTo: b.email,
    subject: "🏔️ Booking request: " + b.name + " (" + b.groupSize + " pax) " + b.arrival + " → " + b.departure,
    htmlBody: html,
  });
}

function notifyGuestReceived_(b) {
  MailApp.sendEmail({
    to: b.email, replyTo: SETTINGS.OWNER_EMAIL, name: SETTINGS.COTTAGE,
    subject: "We got your request — " + SETTINGS.COTTAGE,
    htmlBody: guestMail_("Request received ⛷️",
      "Thanks, " + esc_(first_(b.name)) + "! Your request for <b>" + b.groupSize + " pax</b>, <b>" + b.arrival + " → " + b.departure +
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

function guestMail_(title, body) {
  return '<div style="font-family:Arial,sans-serif;color:#2b2118;max-width:560px">' +
    '<h2 style="margin:0 0 10px">' + title + "</h2><p>" + body + "</p>" +
    (SETTINGS.SITE_URL ? '<p><a href="' + SETTINGS.SITE_URL + '" style="color:#c8553d">See the calendar</a></p>' : "") +
    '<p style="color:#6f6257">— ' + SETTINGS.COTTAGE + ", Val di Fassa</p></div>";
}

/* ---------------- Helpers ---------------- */

function sheet_() {
  const ss = SETTINGS.SHEET_ID ? SpreadsheetApp.openById(SETTINGS.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SETTINGS.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SETTINGS.SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function allBookings_() {
  const values = sheet_().getDataRange().getDisplayValues();
  return values.slice(1).filter(function (r) { return r[0]; }).map(rowToObj_);
}

function rowToObj_(r) {
  const o = {};
  HEADERS.forEach(function (h, i) { o[h] = r[i]; });
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
function clean_(s, max) { return String(s || "").replace(/^[=+\-@]/, "'$&").slice(0, max); }
function first_(name) { return String(name).split(" ")[0]; }
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

/** Run once from the editor to create the sheet and grant email permissions. */
function setup() {
  sheet_();
  MailApp.getRemainingDailyQuota();
}
