// ─── CLIENT ↔ FUNCTIONS DAY-KEY PARITY (Display Checks PR-5 gate) ─────────────
// Two SA-date implementations exist across the ESM/CJS boundary and CANNOT
// share a module today:
//   • client:    saDateOf(iso)            src/utils/clothingSold.js:60-64
//   • functions: saDateStringFromMs(ms)   functions/lib/sa-time.cjs
// The functions copy computes the day key the onClothingSale trigger WRITES
// (/displayChecks/{store}/{DAY}); the client copy computes the day key the
// Today feed will READ (PR 5). If they ever disagree, the feed reads an empty
// node while the trigger populates another — an outage that exists only
// between 00:00 and 02:00 SAST and is never reproducible in daylight.
//
// This test pins them to identical output at the boundary instants. It imports
// BOTH real modules — it is not a mirror of either. If either side changes,
// this fails loudly in `npm test` before anything ships.

import { describe, it, expect } from "vitest";
import { saDateOf } from "./clothingSold";
import { saDateStringFromMs } from "../../functions/lib/sa-time.cjs";

// Boundary instants (UTC) and the SA calendar day both sides must agree on.
// SA midnight is 22:00Z the previous evening (UTC+2, no DST).
const CASES = [
  ["2026-07-15T21:59:59.999Z", "2026-07-15"], // last ms of the SA day
  ["2026-07-15T22:00:00.000Z", "2026-07-16"], // SA midnight — the flip instant
  ["2026-07-15T22:00:00.001Z", "2026-07-16"], // first ms after the flip
  ["2026-07-15T22:01:00.000Z", "2026-07-16"], // 00:01 SAST
  ["2026-07-16T00:00:00.000Z", "2026-07-16"], // UTC midnight (02:00 SAST) — mid-day-node
  ["2028-02-28T21:59:59.999Z", "2028-02-28"], // leap year: eve of the leap day
  ["2028-02-28T22:00:00.000Z", "2028-02-29"], // leap day begins (SA midnight)
  ["2028-02-29T21:59:59.999Z", "2028-02-29"], // last ms of the leap day
  ["2028-02-29T22:00:00.000Z", "2028-03-01"], // leap day ends
];

describe("client/functions SA day-key parity (trigger writes ↔ feed reads)", () => {
  it.each(CASES)("%s → %s on BOTH sides", (iso, expected) => {
    expect(saDateOf(iso)).toBe(expected);
    expect(saDateStringFromMs(Date.parse(iso))).toBe(expected);
  });

  it("agree at every minute across a full SA day boundary window (22:00Z ± 90min)", () => {
    const base = Date.parse("2026-07-15T22:00:00.000Z");
    for (let m = -90; m <= 90; m++) {
      const ms = base + m * 60_000;
      const iso = new Date(ms).toISOString();
      expect(saDateOf(iso)).toBe(saDateStringFromMs(ms));
    }
  });
});
