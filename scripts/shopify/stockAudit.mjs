// ─── STOCK AUDIT — the arithmetic of "what is the website offering that the app
//     does not hold?", variant by variant ───────────────────────────────────────
//
// Pure functions behind stock-truth-audit.mjs. The sweep (stockTruth.mjs)
// answers "is anything wrong, and how much would correcting it take off sale?";
// this answers the question an owner asks when he sees a size on the website he
// believes is gone: WHICH variants disagree, in WHICH direction, and WHY.
//
// The comparison itself is not re-implemented here: every row comes out of
// planProduct (inventorySync.mjs) fed by networkTotals (inventory.mjs) — the
// pusher's own functions — so the audit and the pusher cannot disagree about
// what the right number is.

/**
 * What a Shopify variant is actually SELLING to a customer.
 *   on_hand − committed when it is tracked and DENY; unlimited otherwise.
 * `onHand` null (no inventory level at the location) sells nothing.
 */
export function sellable({ onHand, committed = 0, tracked, inventoryPolicy }) {
  if (tracked !== true || inventoryPolicy !== "DENY") return Infinity;
  if (onHand == null) return 0;
  return Math.max(0, Number(onHand) - Math.max(0, Number(committed) || 0));
}

/**
 * Why does Shopify hold MORE than the app for this variant? First matching
 * reason wins; the order goes from "explained by policy" to "unexplained".
 *
 *   unmanaged        no app product maps to the listing at all
 *   stale-map        the app's id map does not name this variant (or names
 *                    items Shopify no longer has) — the app holds 0 by definition
 *   untracked        Shopify is not limiting the variant at all
 *   excluded-only    the units exist, but only at locations that do not count
 *                    online (hub3, Pine, Concrete, in transit) — a push from
 *                    before the exclusion, or from a path that ignores it
 *   pending-push     a movement marker is waiting for the reconciler
 *   moved-since-sweep the app moved after the last nightly sweep and no marker
 *                    is waiting: a missed push the next sweep will correct
 *   unexplained      none of the above
 */
export function causeOfOver(row, ctx = {}) {
  if (row.unmanaged) return "unmanaged";
  if (row.unmapped || row.staleMap) return "stale-map";
  if (row.tracked !== true || row.inventoryPolicy !== "DENY") return "untracked";
  if ((Number(row.excludedUnits) || 0) > 0 && (Number(row.app) || 0) + (Number(row.excludedUnits) || 0) >= (Number(row.shopify) || 0)) return "excluded-only";
  if (ctx.dirty) return "pending-push";
  if (ctx.movedSinceSweep) return "moved-since-sweep";
  return "unexplained";
}

/**
 * Fold per-variant rows into the report's totals.
 * rows: { pid, gid, sizeKey, shopify, app, sellable, cause? }
 */
export function auditSummary(rows) {
  const s = {
    variants: 0, staleMap: 0, above: 0, below: 0, equal: 0,
    unitsAbove: 0, unitsBelow: 0,
    sellableAtZero: 0, sellableAtZeroUnits: 0, unlimitedAtZero: 0,
    byCause: {},
  };
  for (const r of rows || []) {
    // An id-map item Shopify does not have was not compared: a mapping fault,
    // counted on its own and never as stock above or below.
    if (r.staleMap) { s.staleMap = (s.staleMap || 0) + 1; continue; }
    s.variants++;
    const shop = Math.max(0, Number(r.shopify) || 0);
    const app = Math.max(0, Number(r.app) || 0);
    if (shop > app) {
      s.above++; s.unitsAbove += shop - app;
      const c = r.cause || "unexplained";
      const b = (s.byCause[c] ||= { variants: 0, units: 0 });
      b.variants++; b.units += shop - app;
    } else if (shop < app) { s.below++; s.unitsBelow += app - shop; }
    else s.equal++;
    if (app === 0 && r.sellable > 0) {
      s.sellableAtZero++;
      if (r.sellable === Infinity) s.unlimitedAtZero++;
      else s.sellableAtZeroUnits += r.sellable;
    }
  }
  return s;
}
