// ─── /stock_provenance — THE DERIVED CARRIES INDEX ────────────────────────────
//
// WHAT THIS IS FOR
// `storeCarries()` used to ask "does a cell exist at this location", which is not a
// question about trade at all: one customer collection routed through a shop left a
// qty-0 husk that armed that shop's whole size run forever (proven live 2026-08-17,
// two Trophy-owned Lacoste sweatshirts armed at marathon-pe). The replacement asks
// about PROVENANCE — has this location ever sold the product, or ever received it
// via a stocking-class movement — and provenance lives in the ledger.
//
// THE LEDGER CANNOT BE READ AT RUNTIME. The engine wakes every 15 minutes, 49 times
// a day, and already pulls ~31 MB per run of which 14 MB is a 45-day ledger slice.
// Recomputing provenance from 56k+ records on each wake would mean reading the
// WHOLE ledger, not a window — the Outgoing Bandwidth SKU behind the $409 month.
// So provenance is materialised here once and maintained forward by the writers.
//
// SHAPE
//
//   /stock_provenance/_meta/{loc} = { at, pairs, version }   ← readiness sentinel
//   /stock_provenance/{loc}/{pid} = { s, k, u }
//
//     s = SOLD events recorded at this location for this product
//     k = STOCKED units received here via a stocking-class movement
//     u = UNSTOCKED units taken back out again by an explicit undo
//
// The keys are one character each and zero-valued fields are OMITTED, because this
// node is read on every one of those 49 daily runs. Spelled-out keys on ~6,500
// pairs cost roughly 250 KB more per run — 12 MB a day — bought nothing but
// prettier JSON. The legend above is the documentation that buys it back.
//
// COUNTERS, NOT A BOOLEAN. A derived `carries` flag would have to be recomputed and
// rewritten on every movement, and a multi-path update cannot compute one. Counters
// can be maintained with ServerValue.increment() inside the SAME atomic update that
// writes the cell and the ledger record, so the index can never disagree with the
// movement that caused it. The boolean is derived at read time by carriesByIndex().
//
// WHY THE READINESS SENTINEL EXISTS — FAIL CLOSED
// An absent /stock_provenance/{loc} is ambiguous: it means either "this location has
// no provenance for anything" or "the backfill has not run / the read failed". Those
// demand opposite behaviour, and guessing wrong in the arming direction is the
// original bug. So a location is only ever armed when _meta/{loc} exists and names a
// completed backfill. No sentinel → the location arms NOTHING and says so loudly.
// This is the same fail-safe direction as every switch in refill-engine.cjs, and it
// is why the engine must NEVER fall back to cell-existence: that fallback IS the bug.

const PROVENANCE_ROOT = "stock_provenance";
const PROVENANCE_META = `${PROVENANCE_ROOT}/_meta`;
const INDEX_VERSION = 1;

const locPath = (loc) => `${PROVENANCE_ROOT}/${loc}`;
const pairPath = (loc, pid) => `${PROVENANCE_ROOT}/${loc}/${pid}`;
const metaPath = (loc) => `${PROVENANCE_META}/${loc}`;

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * THE PREDICATE, read side. Sold here even once, or a positive net of stocked
 * units, means the location carries the line.
 *
 * MUST stay identical to carriesByProvenance() in
 * src/components/stock/provenanceClass.js — the two live in different module
 * systems (this file is required by refill-engine.cjs, that one is imported by the
 * app and the backfill), so the expression is pinned by
 * test/provenance-index.test.cjs reading both sources. A one-line predicate
 * duplicated across a module boundary is exactly the drift this repo has paid for
 * before; the pin is what makes the duplication safe.
 */
function carriesByIndex(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (n(entry.s) > 0) return true;
  return n(entry.k) - n(entry.u) > 0;
}

/**
 * Is the index usable for arming decisions at this location?
 *
 * Returns false for absent meta, a wrong/absent version, or a meta record that
 * does not name a completed backfill. False means: arm nothing here, log loudly.
 * Deliberately strict — a partially written index that reads as ready would arm
 * against a picture that is missing history, which is the same class of error as
 * the husk it replaces.
 */
function indexReady(meta, loc) {
  const m = meta && typeof meta === "object" ? meta[loc] : null;
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  if (m.version !== INDEX_VERSION) return false;
  return typeof m.at === "string" && m.at.length > 0 && typeof m.pairs === "number" && m.pairs >= 0;
}

/**
 * The entry for one (loc, pid), or null. `index` is the whole per-location map the
 * engine already holds — one lookup, no read, no ledger.
 */
function provenanceEntry(index, loc, pid) {
  const e = index && index[loc] ? index[loc][pid] : null;
  return e && typeof e === "object" && !Array.isArray(e) ? e : null;
}

/** Build the stored record from full counters, omitting zeroes (see SHAPE). */
function toRecord({ sold = 0, stockedUnits = 0, unstockedUnits = 0 } = {}) {
  const r = {};
  if (n(sold) > 0) r.s = n(sold);
  if (n(stockedUnits) > 0) r.k = n(stockedUnits);
  if (n(unstockedUnits) > 0) r.u = n(unstockedUnits);
  return r;
}

module.exports = {
  PROVENANCE_ROOT, PROVENANCE_META, INDEX_VERSION,
  locPath, pairPath, metaPath,
  carriesByIndex, indexReady, provenanceEntry, toRecord,
};
