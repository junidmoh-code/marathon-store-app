// ─── TEST HELPER — a READY provenance index for engine fixtures ───────────────
//
// WHY THIS EXISTS
// `storeCarries()` used to mean "a /stock cell exists here", so ~40 existing engine
// tests wrote a cell to say "this shop stocks this line" and then went on to test
// something else entirely — throttles, reorder points, the Central→hub2→store
// cascade, subcategory policy, cadence. The predicate now reads the derived
// provenance index instead, so those fixtures would all arm nothing and fail for a
// reason that has nothing to do with what they assert.
//
// `provenanceFor(stock)` restores their INTENT: every (loc, pid) that has a cell in
// the fixture is declared to have genuine stocking provenance. That is what those
// authors meant by writing a cell.
//
// ⚠ READ THIS BEFORE USING IT IN A NEW TEST ⚠
// This helper deliberately CANNOT be used to test the predicate itself. It maps
// cell-existence → carries, which is precisely the bug that was removed. Any test
// about what does and does not count as carrying must state `provenance` and
// `provenanceMeta` LITERALLY, so the fixture says "this shop sold N / stocked N /
// had N undone" in the index's own terms. See provenance-carries.test.cjs — every
// case there is written out by hand for exactly this reason.
//
// The counters are large and arbitrary (`k: 999`) on purpose: a fixture that
// happens to satisfy the predicate by a margin can never be read as making a claim
// about a threshold. Thresholds are tested where they belong.

"use strict";

const { INDEX_VERSION } = require("../../lib/provenance-index.cjs");

const NON_SHOPS = new Set(["in_transit", "base", "studio"]);

/** Every (loc, pid) present in a stock fixture, declared as genuinely stocked. */
function provenanceFor(stock) {
  const out = {};
  for (const loc of Object.keys(stock || {})) {
    if (NON_SHOPS.has(loc)) continue;
    const pids = Object.keys(stock[loc] || {});
    if (!pids.length) continue;
    out[loc] = {};
    for (const pid of pids) out[loc][pid] = { k: 999 };
  }
  return out;
}

/**
 * A READY sentinel for every location named. Locations are taken from the stock
 * fixture AND from an explicit extra list, because a destination can legitimately
 * hold no stock at all and still has to be armable — a shop with an empty node is
 * "ready with nothing", not "not ready".
 */
function readyMetaFor(stock, extraLocs = []) {
  const locs = new Set([...Object.keys(stock || {}), ...extraLocs].filter((l) => !NON_SHOPS.has(l)));
  const out = {};
  for (const loc of locs) {
    out[loc] = { at: "2026-08-17T10:00:00.000Z", pairs: Object.keys(stock?.[loc] || {}).length, version: INDEX_VERSION };
  }
  return out;
}

/**
 * Mix the two defaults into a snapshot, WITHOUT overriding anything the caller set
 * explicitly. A test that passes its own `provenance` or `provenanceMeta` — which
 * every predicate test does — keeps it untouched.
 */
function withProvenance(snapshot, extraLocs = []) {
  const s = { ...snapshot };
  if (!("provenance" in snapshot)) s.provenance = provenanceFor(snapshot.stock);
  if (!("provenanceMeta" in snapshot)) s.provenanceMeta = readyMetaFor(snapshot.stock, extraLocs);
  return s;
}

module.exports = { provenanceFor, readyMetaFor, withProvenance, INDEX_VERSION };
