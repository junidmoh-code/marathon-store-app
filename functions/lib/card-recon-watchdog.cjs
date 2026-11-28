// ─── THE 19:00 CARD-RECON WATCHDOG (Junid, 27 Nov 2026) ──────────────────────
// "Till 2 must never break again." Every evening at 19:00 SAST, for each active
// till that took POS card money today, Junid is emailed — ONLY when something
// is wrong — one line per till:
//   • card sales but no slip / report arrived today;
//   • a slip arrived but no total was read and no typed total exists;
//   • an ingestion error or rejected upload in the last 24 hours
//     (lib/card-recon-errors.cjs — every failure path writes one).
// One email, to gunidmoh@gmail.com, through the mailbox poller on the Mac mini
// (a notice of kind "watchdog"; scripts/cardrecon/email-poller.mjs sends it).
// No email when everything is fine. Never WhatsApp.
//
// READS (all bounded, never a whole node): the terminal registry (≈8 rows),
// today's /pos/paymentEvents by the indexed `at`, and per till: today's staff
// slip log (one day key), today's job count (one leaf), today's unread marker
// (one day key), its records closing since yesterday (indexed slip/closedAt),
// and the last 24 h of /card_recon_errors by key.
//
// assessWatchdog is PURE and tested (test/card-recon-till2-guard.test.cjs).
"use strict";

const { tillAt } = require("./card-terminal-placements.cjs");
const { isRetiredTerminal } = require("./card-terminals.cjs");
const { formatCents } = require("./card-recon.cjs");
const { ERRORS_PATH, errorKeyFrom } = require("./card-recon-errors.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const WATCHDOG_TO = "gunidmoh@gmail.com";
const WATCHDOG_NOTICE_KIND = "watchdog";

const sastYmd = (ms) => new Date(ms + SAST_OFFSET_MS).toISOString().slice(0, 10);
const sastDayStart = (ymd) => Date.parse(`${ymd}T00:00:00+02:00`);

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []).filter((x) => x && typeof x === "object");

/**
 * @param {object} p
 * @param {number} p.nowMs
 * @param {object} p.terminals           /config/cardTerminals
 * @param {object|object[]} p.events     today's /pos/paymentEvents
 * @param {Object<string,object>} p.perTid  tid → { staffSlips, jobsToday, unread, records }
 * @param {object} p.errors              /card_recon_errors for the last 24 h
 * @returns {{ dayYmd: string, lines: string[] }}
 */
function assessWatchdog({ nowMs, terminals, events, perTid = {}, errors = {} }) {
  const dayYmd = sastYmd(nowMs);
  const start = sastDayStart(dayYmd);
  const end = start + DAY_MS;
  const rows = asList(events);
  const lines = [];
  const labelOf = {};
  for (const [tid, row] of Object.entries(terminals || {})) {
    if (!row || typeof row !== "object" || !row.storeId || isRetiredTerminal(row)) continue;
    const here = tillAt(row, nowMs);
    const storeId = here.storeId || row.storeId;
    const tillId = here.tillId || row.tillId;
    const label = here.label || row.label || `${storeId}/${tillId}`;
    labelOf[tid] = label;
    let cents = 0;
    for (const e of rows) {
      if (e.method !== "card" || e.storeId !== storeId || e.tillId !== tillId) continue;
      const at = Number(e.at);
      if (Number.isFinite(at) && at >= start && at < end && Number.isInteger(e.amount)) cents += e.amount;
    }
    if (cents === 0) continue; // no card money today: nothing to answer for
    const p = perTid[tid] || {};
    const slips = Object.values(p.staffSlips || {}).filter((x) => x && typeof x === "object");
    const records = Object.values(p.records || {}).filter((r) => r && typeof r === "object" && !r.displacedBy);
    // TODAY'S FIGURE = a record whose batch CLOSED today (a report read, a
    // typed total standing, Junid's entry), or a typed total on today's slip.
    // When it was submitted proves nothing: yesterday's report sent today is
    // not today's figure (CodeRabbit, #1022).
    const recordToday = records.some((r) => {
      const closed = Number(r.slip && r.slip.closedAt);
      return Number.isFinite(closed) && closed >= start && closed < end;
    });
    const anyTyped = slips.some((s) => Number.isInteger(s.cents));
    const arrived = slips.length > 0 || Number(p.jobsToday) > 0 || recordToday;
    if (!arrived) {
      lines.push(`${label}: ${formatCents(cents)} of card sales today, but no slip or report has arrived.`);
    } else if (!recordToday && !anyTyped) {
      const unreadOpen = p.unread && p.unread.status === "unread";
      const stillReading = slips.some((s) => !s.read) || (slips.length === 0 && Number(p.jobsToday) > 0);
      lines.push(unreadOpen
        ? `${label}: today's slip arrived but no total could be read, and no card total was typed — enter the figure from the photo.`
        : stillReading
          ? `${label}: today's slip arrived but has still not been read, and no card total was typed — check the reader, or enter the figure from the photo.`
          : `${label}: a slip arrived but no total for today was read and no card total was typed — enter the figure from the photo.`);
    }
    // FILED UNDER THIS TILL, PRINTED BY ANOTHER MACHINE (Junid's total rule
    // files a slip under the till it was sent for): said at 19:00, never only
    // in a note nobody opens (architect review, #1022).
    for (const r of records) {
      const printed = r.totalRule && r.totalRule.printedTid;
      const closed = Number(r.slip && r.slip.closedAt);
      if (printed && printed !== tid && terminals[printed] && Number.isFinite(closed) && closed >= start - DAY_MS && closed < end) {
        lines.push(`${label}: a slip filed under this till prints ${terminals[printed].label || printed}'s terminal ID — check it is this till's report.`);
      }
    }
  }
  // Ingestion errors / rejected uploads in the last 24 h, one line per till (or "card recon").
  const byWho = new Map();
  for (const e of asList(errors)) {
    if (!Number.isFinite(Number(e.at)) || Number(e.at) < nowMs - DAY_MS) continue;
    const who = (e.tid && labelOf[e.tid]) || e.label || e.tid || "Card recon";
    const cur = byWho.get(who) || { n: 0, last: null, kinds: new Set() };
    cur.n++; cur.kinds.add(e.kind || "error"); cur.last = e.message || cur.last;
    byWho.set(who, cur);
  }
  for (const [who, v] of byWho) {
    lines.push(`${who}: ${v.n} upload/ingest error${v.n === 1 ? "" : "s"} in the last 24 h (${[...v.kinds].join(", ")}) — last: ${String(v.last || "").slice(0, 200)}`);
  }
  return { dayYmd, lines };
}

/** The one email, or null when everything is fine. */
function watchdogNotice({ dayYmd, lines }, nowMs) {
  if (!lines.length) return null;
  return {
    kind: WATCHDOG_NOTICE_KIND,
    to: WATCHDOG_TO,
    subject: `Card recon 19:00 check ${dayYmd}: ${lines.length} problem${lines.length === 1 ? "" : "s"}`,
    text: `Card recon check at 19:00 on ${dayYmd}. Something needs looking at:\n\n${lines.map((l) => `• ${l}`).join("\n")}\n\nThe photos and figures are in Card Recon in the POS. This email is sent only when something is wrong.`,
    createdAt: nowMs,
    attempts: 0,
  };
}

async function readWatchdogInputs(db, { nowMs }) {
  const dayYmd = sastYmd(nowMs);
  const start = sastDayStart(dayYmd);
  const terminals = (await db.ref("config/cardTerminals").once("value")).val() || {};
  const events = (await db.ref("pos/paymentEvents").orderByChild("at").startAt(start).endAt(start + DAY_MS - 1).once("value")).val() || {};
  const perTid = {};
  for (const [tid, row] of Object.entries(terminals)) {
    if (!row || typeof row !== "object" || !row.storeId || isRetiredTerminal(row)) continue;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(tid) || !/^[A-Za-z0-9_-]{1,40}$/.test(String(row.storeId))) continue;
    const [staffSlips, jobsToday, unread, records] = await Promise.all([
      db.ref(`card_batch_overrides/staff_slips/${row.storeId}/${tid}/${dayYmd}`).once("value").then((s) => s.val()),
      db.ref(`card_batch_jobs_count/${tid}/${dayYmd}`).once("value").then((s) => s.val()),
      db.ref(`card_batch_overrides/unread/${row.storeId}/${tid}/${dayYmd}`).once("value").then((s) => s.val()),
      db.ref(`card_batches/${row.storeId}/${tid}`).orderByChild("slip/closedAt").startAt(start - DAY_MS).once("value").then((s) => s.val()),
    ]);
    perTid[tid] = { staffSlips, jobsToday, unread, records };
  }
  // The LATEST 500 of the last 24 h (a flood can only hide older errors).
  const errors = (await db.ref(ERRORS_PATH).orderByKey().startAt(errorKeyFrom(nowMs - DAY_MS)).limitToLast(500).once("value")).val() || {};
  return { terminals, events, perTid, errors };
}

module.exports = { WATCHDOG_TO, WATCHDOG_NOTICE_KIND, assessWatchdog, watchdogNotice, readWatchdogInputs, sastYmd };
