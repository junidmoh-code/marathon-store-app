// ─── MOVEMENT PROVENANCE — WHAT A LEDGER RECORD PROVES ABOUT A SHOP ───────────
//
// THE ONE CLASSIFIER. The provenance study, the backfill and their tests all
// import this module, so "what counts as carrying a line" has exactly one
// definition and the study can never describe a rule the backfill does not apply.
// Same house rule as headwearCollapseCore.mjs and customerMergeCore.mjs.
//
// ── THE PREDICATE (owner, 2026-08-17) ────────────────────────────────────────
// A location CARRIES a product if it has ever SOLD it there, or has ever received
// it via a STOCKING-class movement — a refill fulfil, a receive, or a deliberate
// stock transfer. A unit routed through for a named customer collection counts for
// NOTHING, and neither does a cell that merely exists.
//
// ── WHY THE CLASSIFICATION IS KEYED ON `link`, NOT ON `reason` ────────────────
// `reason` is free text. 69 distinct values live in the ledger today and several
// are one-off migration prose carrying dates and audit-doc references
// ("location_merge: base+studio consolidated into central (2026-07-25)"). A map
// keyed on that string is a curated allow-list: the 70th value, written by some
// future script, lands silently in whatever the default is. So `reason` is used
// here as a LABEL for humans and for exactly one thing in the logic — recognising
// the four explicit UNDO reasons, which are code constants, not prose.
//
// The classification proper reads `type` and the SHAPE OF `link`, both of which
// applyMovement writes structurally on every record:
//
//   link.orderId  && !link.refillId  → a CUSTOMER ORDER dispatch. Measured across
//                                      all 3,338 such records (3,119 with a null
//                                      reason + 219 reasoned `clothing_order`):
//                                      every one carries the `disp_` id prefix and
//                                      every one resolves to a customer order, none
//                                      to a Shop Refill. This is the collection leg.
//   link.orderId  &&  link.refillId  → a CR refill fulfil (`cr_`/`crundo_`).
//   link.refillId (alone)            → hub auto-refill, source refill, hold release.
//   link.transferId                  → a deliberate stock transfer.
//   link.saleId                      → a sale or a customer return.
//
// ── WHY /orders IS NEVER JOINED ──────────────────────────────────────────────
// `link.orderId` holds the DAILY counter ("001"–"999", reused every day), so
// joining a movement to /orders by that value silently matches the wrong day's
// order for anything older than today. Measured: a naive join reports 3,119/3,119
// "found" and 0 missing while mismatching the destination on the older records.
// Everything here is decided from the movement record alone.
//
// ── WHY `adjustment` AND `return` ESTABLISH NOTHING ──────────────────────────
// This is a deliberate policy choice, not an oversight, and it is what keeps the
// classifier free of prose. Neither type is one of the three stocking classes the
// predicate names. It also avoids a trap: 532 POSITIVE adjustments sit at
// marathon-pe and trophy whose own reason text says the shop does NOT hold the
// goods — 443 `shop_sneaker_negative_heal` ("shop no longer holds sneaker stock;
// negative cleared to zero") and 89 `health_negative_zero_fix`. They are
// arithmetically identical to a genuine `recount: corrected on the spot` (+849)
// and separable ONLY by reading the sentence. Treating the whole type as neutral
// decides all 1,470 of them without guessing at any of them.
//
// Returns are neutral for the same reason plus a measured one: 21 movements exist
// solely to correct no-slip returns that were restocked at the WRONG shop (POS
// store-label bug, PR #219). A return proves a sale happened somewhere, and the
// sale record itself is what proves where.
//
// ── LOCATIONS THAT ARE NOT SHOPS ─────────────────────────────────────────────
// `in_transit` is a holding, not a shelf. `base` and `studio` were consolidated
// into `central` on 2026-07-25. None of them can carry anything.

export const NON_STOCKING_LOCATIONS = new Set(["in_transit", "base", "studio"]);

// The four UNDO reasons are CODE CONSTANTS (App.jsx:1388-1400,
// utils/clothingSold.js:37-42), not free text — safe to match exactly.
export const UNDO_REASONS = new Set([
  "clothing_cr_undo",
  "clothing_cr_uncounted_undo",
  "clothing_refill_undo",
  "source_refill_undo",
]);

// A dispatch reversal carries link.reverses; it returns goods from a shop to a hub
// and must not be read as stocking the hub off a customer's cancelled collection.
const isDispatchReversal = (m) => m?.link?.reverses != null;

export const STOCKING = "STOCKING";       // establishes carriage at `to`
export const COLLECTION = "COLLECTION";   // routed through `to` for a named buyer
export const SALE = "SALE";               // proves carriage at `from`
export const UNSTOCK = "UNSTOCK";         // reverses a STOCKING into `from`
export const NEUTRAL = "NEUTRAL";         // proves nothing either way

/**
 * Classify ONE ledger record. Returns { cls, loc, qty, why } where `loc` is the
 * location the record speaks about (null when it speaks about none) and `why`
 * names the recorded field that decided it — so a report can show its work.
 */
export function classifyMovement(m) {
  if (!m || typeof m !== "object") return { cls: NEUTRAL, loc: null, qty: 0, why: "not a record" };
  const qty = Number(m.qty) || 0;
  const link = m.link || {};
  const shop = (loc) => (loc && !NON_STOCKING_LOCATIONS.has(loc) ? loc : null);

  // A sale is the strongest possible evidence and needs no link at all.
  if (m.type === "sold") return { cls: SALE, loc: shop(m.from), qty, why: "type=sold" };

  // An undo of a stocking movement retracts what that movement established. The
  // reason is a code constant; `from` is the shop the units are leaving again.
  if (UNDO_REASONS.has(m.reason)) return { cls: UNSTOCK, loc: shop(m.from), qty, why: `reason=${m.reason} (code constant)` };

  // A named customer's parcel routed to a collection point. orderId WITHOUT a
  // refillId is the discriminator; a CR refill fulfil carries both.
  if (link.orderId != null && link.refillId == null) {
    if (isDispatchReversal(m)) return { cls: NEUTRAL, loc: null, qty, why: "link.reverses — dispatch reversal" };
    return { cls: COLLECTION, loc: shop(m.to), qty, why: "link.orderId && !link.refillId" };
  }

  // Corrections and returns establish nothing — see the block comment above.
  if (m.type === "adjustment") return { cls: NEUTRAL, loc: null, qty, why: "type=adjustment (corrections establish nothing)" };
  if (m.type === "return") return { cls: NEUTRAL, loc: null, qty, why: "type=return (the sale record proves the shop)" };

  // Everything remaining that ADDS units to a real shop is one of the three
  // stocking classes: a receive, a refill fulfil, or a deliberate transfer.
  if (m.type === "received" || m.type === "opening") {
    return { cls: STOCKING, loc: shop(m.to), qty, why: `type=${m.type}` };
  }
  if (m.type === "transfer_out" || m.type === "transfer_in") {
    const to = shop(m.to);
    if (!to) return { cls: NEUTRAL, loc: null, qty, why: `to=${m.to ?? "none"} is not a shop` };
    if (link.refillId != null) return { cls: STOCKING, loc: to, qty, why: "link.refillId — refill fulfil" };
    if (link.transferId != null) return { cls: STOCKING, loc: to, qty, why: "link.transferId — deliberate transfer" };
    // An empty-link transfer into a real shop is a scripted relocation (the perfume
    // moves, the location merge, the one-off fixes). A human decided the goods
    // belong there, which is exactly "deliberate stock transfer".
    return { cls: STOCKING, loc: to, qty, why: "transfer into a shop, no orderId — scripted relocation" };
  }
  return { cls: NEUTRAL, loc: null, qty, why: `unhandled type=${m.type}` };
}

/**
 * Fold a whole ledger into per-(loc,pid) provenance counters.
 * Returns Map<"loc|pid", {sold, stockedUnits, unstockedUnits, collectedUnits,
 *                          stockingEvents, firstStockingAt, lastStockingAt}>.
 *
 * `stockedUnits` is NET of undos on purpose. The 2026-08-17 Lacoste case is why:
 * the engine's own wrongly-armed fulfil put real units into marathon-pe under a
 * STOCKING-class reason, and if that alone established carriage the predicate
 * would ratify the very demand it exists to refuse. The undo returned every unit,
 * so netting takes the pair back to zero and the loop breaks. A PARTIAL undo
 * leaves a real remainder, and a real remainder is real stock the shop kept.
 */
export function foldProvenance(movements) {
  const acc = new Map();
  const get = (loc, pid) => {
    const k = `${loc}|${pid}`;
    let e = acc.get(k);
    if (!e) {
      e = { loc, pid, sold: 0, stockedUnits: 0, unstockedUnits: 0, collectedUnits: 0, stockingEvents: 0, firstStockingAt: null, lastStockingAt: null };
      acc.set(k, e);
    }
    return e;
  };
  for (const m of movements) {
    if (!m || !m.productId) continue;
    const { cls, loc, qty } = classifyMovement(m);
    if (!loc) continue;
    const e = get(loc, m.productId);
    const ts = m.appliedAt || m.ts || null;
    if (cls === SALE) e.sold += 1;
    else if (cls === STOCKING) {
      e.stockedUnits += qty; e.stockingEvents += 1;
      if (ts && (!e.firstStockingAt || ts < e.firstStockingAt)) e.firstStockingAt = ts;
      if (ts && (!e.lastStockingAt || ts > e.lastStockingAt)) e.lastStockingAt = ts;
    } else if (cls === UNSTOCK) e.unstockedUnits += qty;
    else if (cls === COLLECTION) e.collectedUnits += qty;
  }
  return acc;
}

/** THE PREDICATE. True iff the location carries the product. */
export function carriesByProvenance(entry) {
  if (!entry) return false;
  if (entry.sold > 0) return true;
  return entry.stockedUnits - entry.unstockedUnits > 0;
}
