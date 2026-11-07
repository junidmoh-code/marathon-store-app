// ─── THE SIMPLYBLU PORTAL IS THE RECORD FOR STANDARD BANK TILLS (3 Nov 2026) ──
// Junid, 2 Nov 2026: from 3 Nov the Standard Bank tills (Marathon PE Till 2 and
// Trophy Till 2 under MID 4977890; Concrete Till 1/2 under 5377331 once it is
// linked) take EVERY card payment through the SimplyBLU app on the machine, so
// the SimplyBLU portal's transaction list is the record for those tills. Until
// then that list held only the app-initiated payments (29 ever on 4977890, see
// docs/CARD-RECON.md) — which is why the start date is a constant and nothing
// before it is ever recorded from the portal.
//
// WHAT A PORTAL RECORD IS: one ordinary /card_batches record per terminal per
// SAST CALENDAR DAY (stores close 17:00; the pull runs at 18:00 and 18:20).
// Its window is 00:00:00.000 → 23:59:59.999 SAST (`windowSource:
// "portal-day"`), its lines are the portal's own transactions (signed cents,
// refunds negative), and `capturedVia: "simplyblu-portal"`. The POS report
// reads it like any capture — the verdict is the money (R5 tolerance, R20 over
// seven days), so a ZERO-transaction day with POS card legs is SHORT, never
// clean. A day is only recorded once the terminal is visible in the portal at
// all (its TID is in the report's Terminal ID list): until then it has no
// record and the POS shows its money as "awaiting portal data".
//
// THE STAFF SLIP IS EVIDENCE, NEVER THE RECORD, for these tills from the start
// date: a slip arriving before the day's portal record is HELD
// (card_batch_overrides/portal/held) and moved onto the record as a supporting
// slip when it is written; one arriving after is attached as today. A record
// already on file for the day (a slip recorded before this shipped, Junid's
// manual entry) is SUPERSEDED by the portal record as a revision of its batch,
// so the day stays one card.
//
// PURE: no firebase-admin, no clock, no IO. cardRecon.js (handlePortalDay)
// does the reads and writes; tools/sb-portal-recon/ fetches the rows.

"use strict";

const { terminalBank, STANDARD_BANK, resolveRegisteredTid, canonicalTid, wasActiveAt, isRetiredTerminal } = require("./card-terminals.cjs");
const { sastDayYmd, sastDayStartMs, isDayYmd, DAY_MS, OVERRIDES_PATH } = require("./card-unread.cjs");

const PORTAL_SOURCE = "simplyblu-portal";
const PORTAL_WINDOW = "portal-day";
const PORTAL_FORMAT = "portal";
// WHEN THE PORTAL BECOMES A TILL'S RECORD IS PER TERMINAL (Junid, 2 Nov
// 2026): `portalFrom: "YYYY-MM-DD"` on the registry row. Concrete's two
// machines traded through the SimplyBLU app from their first day (30 Oct
// 2026); Marathon PE Till 2 and Trophy Till 2 only from 3 Nov 2026, before
// which their portal held app-initiated payments only (29 ever). A Standard
// Bank row WITHOUT `portalFrom` takes the default; nothing is ever taken from
// the portal before the floor.
const PORTAL_FROM_YMD = "2026-11-03";       // the default
const PORTAL_EARLIEST_YMD = "2026-10-30";   // the floor, for every terminal

/** The first SAST day the portal is this machine's record. */
function portalFromOf(row) {
  const v = row && typeof row.portalFrom === "string" && isDayYmd(row.portalFrom) ? row.portalFrom : PORTAL_FROM_YMD;
  return v < PORTAL_EARLIEST_YMD ? PORTAL_EARLIEST_YMD : v;
}
const PORTAL_PATH = `${OVERRIDES_PATH}/portal`;
const PORTAL_HELD_PATH = `${PORTAL_PATH}/held`;
const PORTAL_UNASSIGNED_PATH = `${PORTAL_PATH}/unassigned`;
const PORTAL_DAYS_PATH = `${PORTAL_PATH}/days`;
const PORTAL_STATUS_PATH = `${PORTAL_PATH}/status`;
// Metabase caps an embedded card's rows at 2,000. A day that comes back at the
// cap may be cut short, and a cut-short day would read as a shortage — refused.
const METABASE_ROW_CAP = 2000;
const MAX_ROWS = METABASE_ROW_CAP;
const MAX_CENTS = 100000000; // R1,000,000 on one transaction is a misread
const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Is the portal the record for this machine on this SAST day? */
function isPortalDay(row, dayYmd) {
  return !!row && terminalBank(row) === STANDARD_BANK && isDayYmd(dayYmd) && dayYmd >= portalFromOf(row);
}

/** The SAST calendar-day window a portal record covers. */
function portalDayWindow(dayYmd) {
  const start = sastDayStartMs(dayYmd);
  if (start === null) return null;
  return { openedAt: start, closedAt: start + DAY_MS - 1 };
}

// ── THE PORTAL'S COLUMNS ─────────────────────────────────────────────────────
// Read BY NAME from the card's own column list, never by position: the
// dashboard is Standard Bank's and they may add a column tomorrow. A column
// this needs and cannot find refuses the whole day.
const COLUMN_NAMES = {
  at: [/^DateCreated/i],
  id: [/^ID$/i],
  number: [/^TransactionNumber$/i],
  type: [/^TransactionType$/i],
  status: [/^TransactionStatus$/i],
  tid: [/^TerminalId$/i],
  batchNo: [/^BatchNo$/i],
  ref: [/^PaymentRefNo$/i],
  authCode: [/^AuthCode$/i],
  amount: [/^Transaction Amount$/i, /^Amount Paid$/i],
};

function columnIndex(cols) {
  const names = (Array.isArray(cols) ? cols : []).map((c) => (typeof c === "string" ? c : c && (c.display_name || c.name)) || "");
  const out = {};
  for (const [field, pats] of Object.entries(COLUMN_NAMES)) {
    let idx = -1;
    for (const p of pats) { idx = names.findIndex((n) => p.test(n.trim())); if (idx >= 0) break; }
    out[field] = idx;
  }
  return out;
}

const REQUIRED_COLUMNS = ["at", "type", "status", "tid", "amount"];

const tidChars = (raw) => (typeof raw === "string" ? raw.trim().replace(/[\s-]/g, "") : "");

/** "Purchase" → "purchase", "Refund" → "refund"; anything else is not money we record. */
function txnKind(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (t === "purchase" || t === "sale") return "purchase";
  if (t === "refund") return "refund";
  return null;
}

const isSuccess = (raw) => /^(success|successful|approved)$/i.test(String(raw || "").trim());
// The statuses that are NOT money and are known to be so. Anything else — a
// status renamed tomorrow ("Completed") — refuses the whole source: silently
// skipping it would record every portal till as R0.00 and call it SHORT
// (Sonnet architect review, #837).
const isKnownNotMoney = (raw) => /^(failed|failure|declined|cancelled|canceled|reversed|voided|void|aborted|timeout|timed ?out|error|pending|in ?progress|incomplete|open)$/i.test(String(raw || "").trim());
// Types that are known and are not a purchase or a refund.
const isKnownOtherType = (raw) => /^(void|reversal|balance ?enquiry|pre-?auth(orisation|orization)?)$/i.test(String(raw || "").trim());

/** A decimal rand amount (930, "930,00", "R 1 000,00", 12.5) → integer cents, or null. */
function randsToCents(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  if (typeof raw !== "string") return null;
  let s = raw.replace(/R/gi, "").replace(/\s/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/**
 * The card's raw rows → the transactions that are money: SUCCESSFUL purchases
 * and refunds only (a declined or reversed attempt is not money). A refund is
 * stored NEGATIVE, as every other reader in the estate stores one.
 *
 * Nothing that identifies a card is copied — the portal's transaction list has
 * no card number, and if a column ever brings one it is simply not read.
 *
 * @returns {{ok:true, txns:object[], skipped:object} | {ok:false, reason:string}}
 */
function parsePortalRows({ cols, rows }) {
  const ix = columnIndex(cols);
  const missing = REQUIRED_COLUMNS.filter((f) => ix[f] < 0);
  if (missing.length) return { ok: false, reason: `The portal's transaction list has no ${missing.join(", ")} column — its layout changed; nothing was recorded.` };
  if (!Array.isArray(rows)) return { ok: false, reason: "The portal returned no rows list." };
  if (rows.length >= MAX_ROWS) return { ok: false, reason: `The portal returned ${rows.length} rows, its limit — the day may be cut short, so nothing was recorded.` };
  const txns = [];
  const skipped = { status: 0, type: 0, unreadable: 0 };
  const seen = new Set();
  const unknown = [];
  rows.forEach((r, i) => {
    if (!Array.isArray(r)) { skipped.unreadable++; return; }
    if (!isSuccess(r[ix.status])) {
      if (!isKnownNotMoney(r[ix.status])) { unknown.push(`status "${String(r[ix.status]).slice(0, 30)}"`); return; }
      skipped.status++; return;
    }
    const kind = txnKind(r[ix.type]);
    if (!kind) {
      if (!isKnownOtherType(r[ix.type])) { unknown.push(`type "${String(r[ix.type]).slice(0, 30)}"`); return; }
      skipped.type++; return;
    }
    const at = Date.parse(String(r[ix.at] || ""));
    const cents = randsToCents(r[ix.amount]);
    // A SUCCESSFUL payment whose time or amount cannot be read is money this
    // cannot place: the source is refused, never short by that amount
    // (CodeRabbit, #837). A zero amount is not money and is only counted.
    if (cents === 0) { skipped.unreadable++; return; }
    if (!Number.isFinite(at) || !Number.isInteger(cents) || Math.abs(cents) > MAX_CENTS) {
      unknown.push(`a successful ${kind} with an unreadable ${Number.isFinite(at) ? "amount" : "time"}`); return;
    }
    const id = ix.id >= 0 && r[ix.id] != null ? String(r[ix.id]).slice(0, 64) : null;
    // The same transaction twice (a page overlap) is one transaction.
    const dedupe = id || `${at}|${r[ix.tid]}|${cents}|${ix.ref >= 0 ? r[ix.ref] : i}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    // Normalised the same way the TID list is (mapPortalTids), so a TID the
    // portal prints with a space or hyphen finds its own transactions
    // (CodeRabbit, #837 — a mismatch here was a false R0.00 day).
    const tidRaw = tidChars(String(r[ix.tid] ?? "")) || String(r[ix.tid] ?? "").trim();
    txns.push({
      id,
      at,
      tid: tidRaw,
      kind,
      amountCents: kind === "refund" ? -Math.abs(cents) : Math.abs(cents),
      number: ix.number >= 0 && Number.isFinite(Number(r[ix.number])) ? Number(r[ix.number]) : null,
      batchNo: ix.batchNo >= 0 && Number.isFinite(Number(r[ix.batchNo])) ? Number(r[ix.batchNo]) : null,
      ref: ix.ref >= 0 && r[ix.ref] != null ? String(r[ix.ref]).slice(0, 32) : null,
      authCode: ix.authCode >= 0 && r[ix.authCode] != null ? String(r[ix.authCode]).slice(0, 16) : null,
    });
  });
  if (unknown.length) {
    return { ok: false, reason: `The portal listed a transaction this cannot read (${[...new Set(unknown)].slice(0, 3).join(", ")}) — nothing was recorded rather than guess what it is.` };
  }
  txns.sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  return { ok: true, txns, skipped };
}

/** A TID the portal lists that is a real machine id, not "Unknown" or blank. */
// A TID as printed may carry a space or a hyphen; those are not part of it
// (canonicalTid strips them too). Anything else odd is "unattributed" money,
// counted in the run status — never silently dropped.
const isTidLike = (raw) => /^[A-Za-z0-9]{2,16}$/.test(tidChars(raw)) && !/^unknown$/i.test(tidChars(raw));

/**
 * The portal's TIDs against the registry. Exact key first, then the
 * Standard Bank forgiving match (O/0, I/1, leading zeros —
 * resolveRegisteredTid). A TID that matches nothing is UNASSIGNED: kept, shown
 * to Junid with the mapping editor, never dropped and never guessed.
 *
 * @returns {{ mapped: Object<string,string>, unassigned: string[] }}  portal TID → registry key
 */
function mapPortalTids(portalTids, registry) {
  const mapped = {};
  const unassigned = [];
  for (const raw of new Set((portalTids || []).map((t) => String(t || "").trim()).filter(isTidLike).map(tidChars))) {
    const key = resolveRegisteredTid(raw.toUpperCase(), registry) || resolveRegisteredTid(raw, registry);
    if (key) mapped[raw] = key; else unassigned.push(raw);
  }
  return { mapped, unassigned };
}

/** The key an unassigned TID is stored under: its canonical form (O/0 folded). */
function unassignedKey(rawTid) {
  const c = canonicalTid(rawTid);
  return c && SAFE_KEY.test(c) ? c : null;
}

/**
 * One terminal's SAST day, from the portal → the extraction buildBatchRecord
 * takes. Lines are numbered 1..n in time order (the portal's own transaction
 * number is per business, not per machine, so it is kept as `uti`-style
 * provenance, not as the TSN).
 */
function portalExtraction({ tid, mid = null, dayYmd, txns }) {
  const win = portalDayWindow(dayYmd);
  if (!win) return null;
  const mine = (txns || []).filter((t) => t.at >= win.openedAt && t.at <= win.closedAt);
  const purchases = mine.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0);
  const refunds = mine.filter((t) => t.amountCents < 0).reduce((s, t) => s - t.amountCents, 0);
  const lines = mine.map((t, i) => ({
    tsn: i + 1,
    at: t.at,
    date: null, time: null,
    uti: t.id || null,
    rrn: t.ref || null,
    authCode: t.authCode || null,
    pan: null,
    type: t.amountCents < 0 ? "refund" : "purchase",
    amountCents: t.amountCents,
  }));
  return {
    tid,
    mid,
    batchNo: null, // decided by planPortalWrite
    openedAt: win.openedAt,
    closedAt: win.closedAt,
    printedAt: null,
    openedText: null, closedText: null,
    txnCount: mine.length,
    purchasesCents: purchases,
    refundsCents: refunds,
    cashCents: 0,
    totalCents: purchases - refunds,
    reconLine: null,
    format: PORTAL_FORMAT,
    windowSource: PORTAL_WINDOW,
    confidence: null,
    lines,
    declined: [],
  };
}

const isPortalRecord = (rec) => !!rec && rec.capturedVia === PORTAL_SOURCE;

/** The ids of a record's lines, as a sorted string — what "the same day" means. */
function lineSignature(linesLike) {
  const arr = Array.isArray(linesLike) ? linesLike : Object.values(linesLike || {});
  return arr.filter((l) => l && typeof l === "object")
    .map((l) => `${l.uti || ""}:${l.at}:${l.amountCents}`).sort().join("|");
}

/** Does the recorded portal record already say exactly this? */
function samePortalFigures(rec, extraction) {
  if (!rec || !rec.slip) return false;
  return rec.slip.totalCents === extraction.totalCents
    && (rec.slip.txnCount ?? null) === extraction.txnCount
    && (rec.slip.refundsCents ?? 0) === extraction.refundsCents
    && lineSignature(rec.lines) === lineSignature(extraction.lines);
}

/**
 * WHERE THE DAY'S PORTAL RECORD GOES.
 *
 * @param {object} p
 * @param {Array<{key:string, record:object}>} p.dayRecords  every record of this terminal whose close is on the day
 * @param {number|null} p.lastBatchNo  the terminal's highest batch number (readLastBatchFor)
 * @param {object} p.extraction  portalExtraction(...)
 * @returns {{action:"noop", key:string} | {action:"new", batchNo:number}
 *           | {action:"revise", batchNo:number, supersedes:string, replacing:"portal"|"other"}}
 *
 *   • the day's portal record already says this → noop (an 18:20 catch-up or a
 *     re-pull never duplicates);
 *   • it says something else (a late transaction) → a revision of it;
 *   • another record is in force for the day (a staff slip recorded before
 *     this shipped, Junid's entry) → the portal record replaces it as a
 *     revision of THAT batch, so the day stays one card and the slip is kept
 *     beside it;
 *   • nothing that day → the terminal's next filing number.
 */
// ─── FROM 7 NOV 2026 THE PORTAL IS A CROSS-CHECK, NEVER THE RECORD ──────────
// Junid, 7 Nov 2026: the photographed end-of-day report is the record for a
// Standard Bank till (lib/card-sb-photo.cjs). The portal had recorded Marathon
// PE Till 2 at R0.00 against R33,440 of card sales (its merchant shows no
// rows), and Concrete short of the till on 3 and 6 Nov. So a pull no longer
// creates a record and never replaces one: it writes the day's portal figure
// onto the record in force as `portalCheck` (Junid's eyes only), and a day
// with no record waits for its photo. A portal record already on file (3–6
// Nov) is still revised by a later pull of the same day — until the photo
// takes the day over, after which its chain is the photo's and the pull is a
// cross-check like any other.
function planPortalWrite({ dayRecords, lastBatchNo, extraction, portalIsRecord = false }) {
  // A record DISPLACED by a photographed report that covers its day
  // (lib/card-sb-photo.cjs) is not the day's any more: it is skipped.
  const recs = (dayRecords || []).filter((r) => r && r.record && Number.isFinite(Number(r.record.batchNo)) && !r.record.displacedBy);
  const latestOf = (list) => list.slice().sort((a, b) => Number(a.record.batchNo) - Number(b.record.batchNo)
    || (Number(a.record.revision) || 1) - (Number(b.record.revision) || 1)).at(-1) || null;
  // A PORTAL RECORD ALREADY ON FILE FOR THE DAY decides, whatever other batch
  // numbers the day holds (Sonnet architect review, #837): its chain is the day.
  const portalBatch = recs.find((r) => isPortalRecord(r.record));
  if (portalBatch) {
    const chain = latestOf(recs.filter((r) => Number(r.record.batchNo) === Number(portalBatch.record.batchNo)));
    // Junid corrected the portal's figure ("Correct these figures"): his
    // correction stands — a later pull never writes over it.
    if (!isPortalRecord(chain.record)) return { action: portalIsRecord ? "noop" : "check", key: chain.key, correctionStands: true };
    if (samePortalFigures(chain.record, extraction)) return { action: "noop", key: chain.key };
    return { action: "revise", batchNo: Number(chain.record.batchNo), supersedes: chain.key, replacing: "portal" };
  }
  // No portal record: the record in force that day (a photographed report,
  // Junid's entry, a typed total) stands, and the portal figure goes beside
  // it. No record at all: nothing is written — the day waits for its photo.
  const inForce = latestOf(recs);
  // A TILL WHOSE RECORD IS THE PORTAL (Concrete — card-terminals.cjs
  // isPortalRecordTerminal): as on 3 Nov, another record in force that day is
  // replaced as a revision of its batch, and a day with none is the next batch.
  if (portalIsRecord) {
    if (inForce) return { action: "revise", batchNo: Number(inForce.record.batchNo), supersedes: inForce.key, replacing: "other" };
    const next = Number.isInteger(lastBatchNo) && lastBatchNo >= 0 ? lastBatchNo + 1 : 1;
    return { action: "new", batchNo: next };
  }
  return { action: "check", key: inForce ? inForce.key : null };
}

/** The portal's figure for a day, as it sits beside the record in force (`portalCheck`). */
function portalCheckOf({ extraction, recordTotalCents = null, merchantNo = null, nowMs }) {
  const total = Number.isInteger(extraction && extraction.totalCents) ? extraction.totalCents : null;
  return {
    totalCents: total,
    txnCount: Number.isInteger(extraction && extraction.txnCount) ? extraction.txnCount : null,
    dayYmd: sastDayYmd(extraction.openedAt),
    merchantNo: merchantNo || null,
    differsCents: Number.isInteger(total) && Number.isInteger(recordTotalCents) ? total - recordTotalCents : null,
    at: nowMs,
  };
}

/** The sentence(s) a portal record carries. */
function portalWarnings({ extraction, replacing = null, supersededKey = null, merchantNo = null }) {
  const out = [
    `Recorded from the SimplyBLU portal (Standard Bank${merchantNo ? `, merchant ${merchantNo}` : ""}) for ${sastDayYmd(extraction.openedAt)}, 00:00–24:00 SAST — the portal's transaction list is the record for this till.`,
  ];
  if (extraction.txnCount === 0) out.push("The portal shows NO card transactions on this machine for the day.");
  if (replacing === "other" && supersededKey) out.push(`This replaces ${supersededKey}, which was on file for the day before the portal was read; it is kept unchanged.`);
  if (replacing === "portal" && supersededKey) out.push(`The portal's figures for the day changed after ${supersededKey} was recorded (a later pull); this revision replaces it.`);
  return out;
}

/** The registry rows (key → row) the portal is the record for on this day. */
function portalTerminalsOn(registry, dayYmd) {
  const start = sastDayStartMs(dayYmd);
  const out = {};
  for (const [tid, row] of Object.entries(registry || {})) {
    if (!row || !row.storeId || !row.tillId) continue;
    if (!isPortalDay(row, dayYmd)) continue;
    if (isRetiredTerminal(row) && row.retiredAt < start) continue;
    // In the estate at some point that day.
    if (!wasActiveAt(row, start + DAY_MS - 1) && !wasActiveAt(row, start)) continue;
    out[tid] = row;
  }
  return out;
}

/**
 * The days a run should (re)pull: today and the two before it, never before
 * the start date. Re-pulling is free (a same-figure day is a noop) and it is
 * what catches a transaction the portal showed late.
 */
function daysToPull(todayYmd, back = 2) {
  const start = sastDayStartMs(todayYmd);
  if (start === null) return [];
  const out = [];
  for (let i = back; i >= 0; i--) {
    const d = sastDayYmd(start - i * DAY_MS + 12 * 60 * 60 * 1000);
    if (d >= PORTAL_EARLIEST_YMD) out.push(d);
  }
  return out;
}

module.exports = {
  PORTAL_SOURCE, PORTAL_WINDOW, PORTAL_FORMAT, PORTAL_FROM_YMD, PORTAL_EARLIEST_YMD, portalFromOf,
  PORTAL_PATH, PORTAL_HELD_PATH, PORTAL_UNASSIGNED_PATH, PORTAL_DAYS_PATH, PORTAL_STATUS_PATH,
  METABASE_ROW_CAP, SAFE_KEY,
  isPortalDay, portalDayWindow, columnIndex, parsePortalRows, randsToCents, isTidLike,
  mapPortalTids, unassignedKey, portalExtraction, isPortalRecord, samePortalFigures, lineSignature,
  planPortalWrite, portalCheckOf, portalWarnings, portalTerminalsOn, daysToPull,
};
