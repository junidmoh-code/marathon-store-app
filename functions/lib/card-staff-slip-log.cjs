// ─── EVERY STAFF SLIP THE SERVER KEPT, BY TILL AND TRADING DAY ───────────────
// Junid, 17 Oct 2026: Yasmin said she sent Marathon PE Till 2's slip and he saw
// nothing — not in Card Recon on the desk, not on the phone, and the till did
// not show as submitted anywhere. (Her slip never reached the server; see
// docs/CARD-SLIP-MISSING-2026-10-17.md.) Whatever happened on the phone, the
// answer to "did the slip arrive?" must be one place every screen reads:
//
//   /card_batch_overrides/staff_slips/{storeId}/{tid}/{dayYmd}/{entryId}
//
// One entry per staff slip the server ACCEPTED, written by the server only,
// whatever became of it: the day's record (a typed total), a supporting slip
// beside a better figure, or a photo received and waiting to be read. Each
// entry names the photo, so Junid can open it from that day's row even while
// the photo is still being read — the queue itself (/card_batch_jobs) has no
// client read at all.
//
// WHY /card_batch_overrides: already live, top-level and owner-only for read
// and write (the same reason the Unread markers live there) — no rules paste,
// and no staff login can read it. Staff learn only "today's slip is in", from
// the cardBatchCapture callable (action "slipTills"), never a figure.
//
// THE TRADING DAY is decided here, once, for every screen: a slip sent before
// 06:00 SAST is the previous evening's (no shop opens before 06:00 — the rule
// handleReceive already files photos by). A typed staff slip is filed against
// the batch that closes at the FNB cut-off (18:50 SAST) of that day, so a slip
// sent at 16:24, before the batch closes, carries the rest of that batch's
// card sales too, and the next batch opens where the bank's does.
//
// Pure: no IO, no clock. cardRecon.js does the reads and writes.
"use strict";

const { OVERRIDES_PATH, sastDayYmd, sastDayStartMs, isDayYmd } = require("./card-unread.cjs");

const STAFF_SLIPS_PATH = `${OVERRIDES_PATH}/staff_slips`;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// No shop opens before 06:00 SAST: a slip sent earlier is the evening before.
const DAY_STARTS_AT_HOUR = 6;
// FNB settles its card batches at about 18:50 SAST every day.
const FNB_CUTOFF_MINUTES = 18 * 60 + 50;
const KINDS = new Set(["record", "supporting", "received"]);
const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

const sastHourOf = (ms) => new Date(ms + SAST_OFFSET_MS).getUTCHours();

/** The trading day a slip sent at `nowMs` belongs to, "YYYY-MM-DD". */
function slipTradingDay(nowMs) {
  return sastDayYmd(nowMs - (sastHourOf(nowMs) < DAY_STARTS_AT_HOUR ? (DAY_STARTS_AT_HOUR + 1) * HOUR_MS : 0));
}

/** The FNB cut-off (18:50 SAST) that closes the batch of `dayYmd`, epoch ms. */
function batchCloseOf(dayYmd) {
  const start = sastDayStartMs(dayYmd);
  return start === null ? null : start + FNB_CUTOFF_MINUTES * 60 * 1000;
}

function staffSlipDayPath({ storeId, tid, dayYmd }) {
  if (!SAFE_KEY.test(String(storeId || "")) || !SAFE_KEY.test(String(tid || "")) || !isDayYmd(dayYmd)) {
    throw new Error(`card-staff-slip-log: refusing an unsafe path (${storeId}/${tid}/${dayYmd})`);
  }
  return `${STAFF_SLIPS_PATH}/${storeId}/${tid}/${dayYmd}`;
}

/**
 * One log entry. `kind`: "record" (the day's typed record, `batchKey`),
 * "supporting" (beside a better figure: `batchKey` + `slipId`) or "received"
 * (a photo waiting to be read: `jobId`). No figure is copied here — the
 * figure stays on the record, where the verdict reads it.
 */
function staffSlipEntry({ kind, storeId, tid, tillId = null, label = null, dayYmd, at, byUid, byEmail = null,
                          photos = [], batchKey = null, slipId = null, jobId = null }) {
  if (!KINDS.has(kind)) throw new Error(`card-staff-slip-log: unknown kind ${kind}`);
  return {
    kind, storeId, tid, tillId: tillId || null, label: label || null, dayYmd,
    at, byUid: byUid || null, byEmail: byEmail || null,
    photos: (Array.isArray(photos) ? photos : []).filter((p) => typeof p === "string" && p),
    batchKey: batchKey || null, slipId: slipId || null, jobId: jobId || null,
  };
}

/** The latest entry of one till-day node ({entryId: entry}), or null. */
function latestStaffSlip(dayNode) {
  let best = null;
  for (const e of Object.values(dayNode || {})) {
    if (!e || typeof e !== "object" || !Number.isFinite(Number(e.at))) continue;
    if (!best || Number(e.at) > Number(best.at)) best = e;
  }
  return best;
}

module.exports = {
  STAFF_SLIPS_PATH, FNB_CUTOFF_MINUTES, DAY_STARTS_AT_HOUR,
  slipTradingDay, batchCloseOf, staffSlipDayPath, staffSlipEntry, latestStaffSlip,
};
