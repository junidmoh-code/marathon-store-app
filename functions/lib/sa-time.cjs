// ─── SA-TIME — the ONE functions-side source for SA calendar dates ────────────
// "YYYY-MM-DD" (ISO slice) of an epoch-ms instant in Africa/Johannesburg
// (SAST, UTC+2, no DST — design §0.6). Shift +2h, then date-slice.
//
// Single source on purpose: this function used to exist as byte-identical
// copies in index.js and displayChecks/lib.cjs — the same drift trap as the
// PIN transform (two mirrored files, in sync only by comment). Import it;
// do not copy it.
//
// NOT the same thing as refill-engine.cjs saTodayKey(), which deliberately
// mirrors App.jsx getTodayKey()'s 0-based-month tablet format ("2026-6-17")
// for the refill counter's day comparison — a different, documented contract.

"use strict";

function saDateStringFromMs(ms) {
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

module.exports = { saDateStringFromMs };
