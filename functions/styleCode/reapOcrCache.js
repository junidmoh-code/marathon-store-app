// ─── OCR CACHE CLEANUP — THE OTHER HALF OF THE 90-DAY TTL ────────────────────
// /style_code_ocr_cache rows carry an `expiresAt`, and readStyleCodeLabel does
// LAZY expiry: an expired row is never served, it is simply overwritten on the
// next read of that photo. Lazy expiry alone is not enough, because a photo
// taken once and never taken again is never re-read — so its row would sit
// there forever. This sweep is what actually removes them.
//
// ── WHY IT IS A BOUNDED, CURSORED SWEEP ──────────────────────────────────────
// The obvious implementation — read the whole node, filter, delete — downloads
// every row on every run. RTDB download bandwidth is a live cost problem on this
// project, and "read everything once a day forever" is the same mistake in a
// different costume. So this walks the node in fixed-size pages, ordered by key
// (always indexed — no .indexOn needed, and rules are console-managed anyway),
// and remembers where it stopped. One run reads at most BATCH tiny rows.
//
// The cursor lives at `_cursor` INSIDE the cache node. Every real key is a
// 64-character sha256 hex digest, so a key beginning with an underscore can
// never collide with one; it is skipped explicitly when reaping.
//
// DEPLOY (scoped, when the owner chooses to):
//   firebase deploy --only functions:reapStyleCodeOcrCache

"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { OCR_CACHE_PATH } = require("../lib/style-code-ocr.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const CURSOR_KEY = "_cursor";
const BATCH = 500; // ~60 KB of tiny rows per run — bounded by design

/**
 * One bounded page of cleanup. Injectable db/clock so it is unit-testable.
 *
 * @returns {{scanned:number, deleted:number, wrapped:boolean, nextCursor:string}}
 */
async function runReap(db, { nowMs, batch = BATCH } = {}) {
  const root = db.ref(OCR_CACHE_PATH);
  const cursor = (await root.child(CURSOR_KEY).get()).val();
  const startAfter = typeof cursor === "string" ? cursor : "";

  const page = (await root.orderByKey().startAfter(startAfter).limitToFirst(batch).get()).val() || {};
  const keys = Object.keys(page).filter((k) => k !== CURSOR_KEY);

  // One multi-path update, not N deletes — a single round trip either way.
  const removals = {};
  let deleted = 0;
  for (const k of keys) {
    const row = page[k];
    const exp = Number(row && row.expiresAt);
    // A row with no usable expiresAt is unreapable by TTL. Leave it: deleting
    // data we cannot reason about is worse than keeping a few stale rows.
    if (Number.isFinite(exp) && exp <= nowMs) {
      removals[k] = null;
      deleted++;
    }
  }
  if (deleted) await root.update(removals);

  // Fewer than a full page means the end of the node — wrap for the next run.
  const wrapped = keys.length < batch;
  const nextCursor = wrapped ? "" : keys[keys.length - 1];
  await root.child(CURSOR_KEY).set(nextCursor);

  return { scanned: keys.length, deleted, wrapped, nextCursor };
}

exports.runReap = runReap;
exports.CURSOR_KEY = CURSOR_KEY;

exports.reapStyleCodeOcrCache = onSchedule(
  {
    schedule: "0 3 * * *",              // 03:00 daily
    timeZone: "Africa/Johannesburg",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async () => {
    const out = await runReap(admin.database(), { nowMs: Date.now() });
    console.log(`reapStyleCodeOcrCache: scanned ${out.scanned}, deleted ${out.deleted}` +
      `${out.wrapped ? " (reached the end, cursor reset)" : ""}`);
  }
);
