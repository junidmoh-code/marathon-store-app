// ─── A TILL THAT TOOK CARD MONEY WITH NO BATCH RECORDED ──────────────────────
// Junid, 25 Oct 2026: "Two consecutive silent days on a till that took card
// money should never again be something Junid discovers himself." The poller's
// dead-man switch (cardReconHealthScan) watches the MAILBOX; nothing watched
// the TILLS. A machine that stops emailing, a report sent for the wrong batch
// (Trophy Till 1 re-printed its 17 Sep batch 57 on 25 Oct), a photo that never
// reached the server — each leaves a till with card money and no batch, and
// the only witness was the Card Recon screen, which Junid has to open.
//
// This is the decision, pure: no firebase-admin, no clock. cardTillSilenceScan
// (functions/index.js) runs it every morning on Google's scheduler and prints
// CARD_TILL_SILENT_ALARM, which Cloud Monitoring emails to Junid with the line
// itself (scripts/cardrecon/install-till-silence-alarm.mjs).
//
// THE RULE. For each SAST day in the lookback, each till a registered,
// unretired machine stood on that day (its placement — lib/card-terminal-
// placements.cjs — never its filing key):
//   · TRADED  — the till's card legs in /pos/paymentEvents sum to more than 0.
//   · COVERED — a /card_batches record of a machine on that till closed that
//               day, or its window runs across the day's end (a batch left
//               open and reported later — its report holds the day's money).
// A till is SILENT when, walking back from yesterday, it has one or more
// traded-and-uncovered days before its first covered trading day. Days with
// no card money neither count nor break the run (a Sunday the shop was shut).
// Every morning it stays silent it is reported again, its day count higher.
//
// What it does NOT judge: whether the batch agrees with the till. A recorded
// batch with a variance is Card Recon's question; this one is only "is there
// anything at all".
//
// Tested in functions/test/till-silence.test.cjs.

"use strict";

const { tillAt, terminalPlacements } = require("./card-terminal-placements.cjs");
const { isRetiredTerminal } = require("./card-terminals.cjs");
const { formatCents } = require("./card-recon.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;   // South Africa: UTC+2 all year
// How far back a run looks. A week covers a long weekend and a till that has
// been silent for days; the alarm says "7+ days" past it rather than read
// further. The payment ledger read is one indexed range over these days.
const LOOKBACK_DAYS = 7;
const MARKER = "CARD_TILL_SILENT_ALARM";

/** The SAST calendar day of an instant, "YYYY-MM-DD". */
function sastYmd(ms) {
  return new Date(ms + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

/** SAST midnight that opens a "YYYY-MM-DD" day, as epoch ms. */
function sastDayStart(ymd) {
  return Date.parse(`${ymd}T00:00:00+02:00`);
}

/**
 * The days a run judges, newest first: yesterday back `lookbackDays` days.
 * Today is never judged — its reports land in the afternoon.
 */
function judgedDays(nowMs, lookbackDays = LOOKBACK_DAYS) {
  const todayStart = sastDayStart(sastYmd(nowMs));
  const out = [];
  for (let i = 1; i <= lookbackDays; i++) {
    const startMs = todayStart - i * DAY_MS;
    out.push({ ymd: sastYmd(startMs + 60 * 60 * 1000), startMs, endMs: startMs + DAY_MS });
  }
  return out;
}


/**
 * The tills a machine stood on during [startMs, endMs): where it stood at the
 * start, plus every placement that began inside the day.
 */
function tillsDuring(row, startMs, endMs) {
  const out = [tillAt(row, startMs)];
  for (const p of terminalPlacements(row)) {
    if (p.effectiveFrom > startMs && p.effectiveFrom < endMs) out.push({ storeId: p.storeId, tillId: p.tillId, label: p.label || null });
  }
  return out.filter((t) => t && t.storeId && t.tillId);
}

/** Does this /card_batches record hold the money of the day [startMs, endMs)? */
function covers(record, startMs, endMs) {
  const slip = record && record.slip;
  if (!slip) return false;
  const closed = Number(slip.closedAt);
  const opened = Number(slip.openedAt);
  if (!Number.isFinite(closed)) return false;
  if (closed >= startMs && closed < endMs) return true;
  return closed >= endMs && Number.isFinite(opened) && opened < endMs;
}

/** Signed card cents on one till in [startMs, endMs). */
function cardCentsOn(events, { storeId, tillId, startMs, endMs }) {
  let cents = 0;
  for (const e of events) {
    if (!e || e.method !== "card" || e.storeId !== storeId || e.tillId !== tillId) continue;
    const at = Number(e.at);
    if (!Number.isFinite(at) || at < startMs || at >= endMs) continue;
    if (Number.isInteger(e.amount)) cents += e.amount;
  }
  return cents;
}

/**
 * @param {object} p
 * @param {number} p.nowMs                    the server's clock
 * @param {object} p.terminals                /config/cardTerminals
 * @param {object|object[]} p.events          /pos/paymentEvents over the lookback
 * @param {Object<string,object>} p.recordsByTid  tid → {batchKey: record} (closedAt in the lookback)
 * @returns {{ days: string[], silent: Array<{storeId, tillId, label, tids: string[], days: number, cents: number, missing: string[], capped: boolean}> }}
 */
function assessTillSilence({ nowMs, terminals, events, recordsByTid, lookbackDays = LOOKBACK_DAYS }) {
  const days = judgedDays(nowMs, lookbackDays);
  const rows = Array.isArray(events) ? events : Object.values(events || {});
  // RETIRED MACHINES COUNT UNTIL THEY RETIRED: a machine retired yesterday
  // and replaced today still stood on its till yesterday, and yesterday's card
  // money is judged against its records. (Sonnet architect review, #799.)
  const reg = Object.entries(terminals || {}).filter(([, r]) => r && typeof r === "object");

  // till key → per-day { tids, label }
  const tills = new Map();
  for (const [tid, row] of reg) {
    const activeFrom = Number(row.activeFrom);
    for (const d of days) {
      if (Number.isFinite(activeFrom) && activeFrom >= d.endMs) continue;   // not in the estate yet
      if (isRetiredTerminal(row) && row.retiredAt <= d.startMs) continue;   // gone before the day began
      for (const t of tillsDuring(row, d.startMs, d.endMs)) {
        const key = `${t.storeId}/${t.tillId}`;
        if (!tills.has(key)) tills.set(key, { storeId: t.storeId, tillId: t.tillId, byDay: new Map() });
        const till = tills.get(key);
        if (!till.byDay.has(d.ymd)) till.byDay.set(d.ymd, { tids: new Set(), label: null });
        const slot = till.byDay.get(d.ymd);
        slot.tids.add(tid);
        slot.label = slot.label || t.label || row.label || null;
      }
    }
  }

  const silent = [];
  for (const till of tills.values()) {
    const missing = [];
    let cents = 0;
    let tids = new Set();
    let label = null;
    let reachedCovered = false;
    for (const d of days) {                       // yesterday first
      const slot = till.byDay.get(d.ymd);
      if (!slot) continue;                        // no machine stood here that day: nothing to judge
      const dayCents = cardCentsOn(rows, { storeId: till.storeId, tillId: till.tillId, startMs: d.startMs, endMs: d.endMs });
      if (dayCents <= 0) continue;                // no card money: neither counts nor breaks the run
      const covered = [...slot.tids].some((tid) =>
        Object.values((recordsByTid && recordsByTid[tid]) || {}).some((r) => covers(r, d.startMs, d.endMs)));
      if (covered) { reachedCovered = true; break; }
      missing.push(d.ymd);
      cents += dayCents;
      slot.tids.forEach((t) => tids.add(t));
      label = label || slot.label;
    }
    if (missing.length) {
      silent.push({
        storeId: till.storeId, tillId: till.tillId, label,
        tids: [...tids].sort(), days: missing.length, cents, missing,
        // Silent across the WHOLE lookback with nothing covered behind it: the
        // true run may be longer than this run can see.
        capped: !reachedCovered && missing.length >= 1 && missing.at(-1) === days.at(-1).ymd,
      });
    }
  }
  silent.sort((a, b) => b.days - a.days || `${a.storeId}/${a.tillId}`.localeCompare(`${b.storeId}/${b.tillId}`));
  return { days: days.map((d) => d.ymd), silent };
}

const shortDay = (ymd) => {
  const d = new Date(`${ymd}T12:00:00+02:00`);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
};

/**
 * The ONE line the scan prints when any till is silent — one line for all of
 * them, because a log-match policy notifies at most once per five minutes and
 * a second till's line would be swallowed. The marker is load-bearing: the
 * installer's --verify pins it to this file.
 */
function alarmLine(silent) {
  const parts = silent.map((s) => {
    const name = s.label || `${s.storeId} ${s.tillId}`;
    const span = s.days === 1 ? "1 day" : `${s.days}${s.capped ? "+" : ""} days`;
    const which = s.missing.slice().reverse().map(shortDay).join(", ");
    return `${name} (${s.storeId}/${s.tillId}, terminal ${s.tids.join(" + ")}): ${span} with card money and NO batch recorded — ${which} (${formatCents(s.cents)} on card)`;
  });
  return `${MARKER} ${parts.join(" · ")}. `
    + "Each of these tills took card payments and no batch report covers them: "
    + "check the speedpoint sent its report (emailed banking report, or a photographed slip), "
    + "then the Card recon tab under 'Emailed slips' for a refusal.";
}

/**
 * The line printed when the CHECK ITSELF fails — a read error, a crash. Same
 * marker, same email: a watchdog that dies quietly is the failure this whole
 * file exists to prevent.
 */
function failureLine(err) {
  const why = String((err && err.message) || err || "no reason given").replace(/\s+/g, " ").slice(0, 300);
  return `${MARKER} The till silence check itself FAILED this morning, so no till was judged: ${why}. `
    + "Run `node scripts/cardrecon/till-silence-report.mjs` for the answer, and read the cardTillSilenceScan logs.";
}

/**
 * Has the morning check stopped running? Decided every ten minutes by
 * cardReconHealthScan (a scheduler that never fires prints nothing at all),
 * from the `checkedAt` the check writes on every run. Stale after 26 hours —
 * one missed 07:30 plus slack — and said at most once a day.
 *
 * @returns {string|null} the alarm line, or null
 */
const STALE_AFTER_MS = 26 * 60 * 60 * 1000;
const STALE_REPEAT_MS = 24 * 60 * 60 * 1000;
function staleCheckLine({ nowMs, checkedAt, lastStaleAlarmAt }) {
  // null (never written) is NOT 0 — Number(null) would date it to 1970.
  const last = checkedAt === null || checkedAt === undefined ? NaN : Number(checkedAt);
  const fresh = Number.isFinite(last) && nowMs - last <= STALE_AFTER_MS;
  if (fresh) return null;
  if (Number.isFinite(Number(lastStaleAlarmAt)) && nowMs - Number(lastStaleAlarmAt) < STALE_REPEAT_MS) return null;
  const since = Number.isFinite(last) ? `has not run since ${new Date(last + SAST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ")} SAST` : "has NEVER run";
  return `${MARKER} The 07:30 till silence check ${since} — no till is being watched for card money with no batch. `
    + "Check the cardTillSilenceScan function and its Cloud Scheduler job in marathon-club (europe-west1).";
}

/**
 * THE ONLY IO: the three bounded reads a run needs, all indexed — the
 * registry (six rows), /pos/paymentEvents by `at` over the lookback, and each
 * machine's /card_batches by `slip/closedAt` from the lookback's first day.
 * Never a whole node. Shared by cardTillSilenceScan and the read-only
 * scripts/cardrecon/till-silence-report.mjs, so the probe reads what the
 * alarm reads.
 */
async function readTillSilenceInputs(db, { nowMs, lookbackDays = LOOKBACK_DAYS }) {
  const days = judgedDays(nowMs, lookbackDays);
  const fromMs = days.at(-1).startMs;
  const toMs = days[0].endMs;
  const terminals = (await db.ref("config/cardTerminals").once("value")).val() || {};
  const events = (await db.ref("pos/paymentEvents").orderByChild("at").startAt(fromMs).endAt(toMs - 1).once("value")).val() || {};
  const recordsByTid = {};
  for (const [tid, row] of Object.entries(terminals)) {
    if (!row || typeof row !== "object" || !row.storeId) continue;
    if (isRetiredTerminal(row) && row.retiredAt < fromMs) continue;   // retired before the lookback
    recordsByTid[tid] = (await db.ref(`card_batches/${row.storeId}/${tid}`)
      .orderByChild("slip/closedAt").startAt(fromMs).once("value")).val() || {};
  }
  return { terminals, events, recordsByTid };
}

module.exports = { MARKER, STALE_AFTER_MS, failureLine, staleCheckLine, readTillSilenceInputs, LOOKBACK_DAYS, sastYmd, sastDayStart, judgedDays, covers, cardCentsOn, assessTillSilence, alarmLine };
