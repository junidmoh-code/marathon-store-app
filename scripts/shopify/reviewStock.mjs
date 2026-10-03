// ─── THE REVIEW LIST SHOWS ONLY WHAT CAN BE SOLD ─────────────────────────────
// docs/SHOPIFY-REVIEW-INSTOCK.md is the design. In short: a product that is not
// on the storefront sits in the Shopify Publisher's review list, and a product
// with no sellable stock must not sit there, because photo, name and review work
// on it is wasted. Such a product is HIDDEN by an entry in
// /config/shopifyReviewHidden/{pid}. That entry is the only thing this module
// writes. Its /shopify_publish node, which holds the photos, name, condition
// and proposals, is never written, so nothing is lost and nothing on the
// storefront moves. When stock returns, the entry is removed and the product is
// back on the list.
//
// ── "SELLABLE" IS THE WEBSITE'S ANSWER, NOT A SECOND ONE ────────────────────
// networkTotals (inventory.mjs) is what Shopify is told. It covers every
// location that counts toward online availability, clamps negatives to 0 and
// counts only sizes in the record. A product is sellable when any size's total
// is above zero. Location names come from inventorySync.locationNames, the same
// filtered list the inventory push reads. If these two answers were computed
// separately, the list and the website could disagree about the same shoe.
//
// ── DRIVEN BY MARKERS ────────────────────────────────────────────────────────
// The /stock trigger (functions/lib/shopify-inventory-dirty.cjs) writes
// /shopify_review_stock_dirty/{pid} when a not-live product's size cell
// crosses zero at a counted location. This sweep drains those markers on the
// reconcile tick. Each costs a handful of point reads and never reads /stock
// whole. A marker is cleared by the same revision compare-and-set as the
// inventory markers, so a movement that lands mid-judgement is judged again on
// the next tick.

import { networkTotals } from "./inventory.mjs";
import { clearMarker, locationNames } from "./inventorySync.mjs";
import { isOnOrGoingOn, normalizedState } from "../../src/components/shopify/publishState.js";

export const REVIEW_DIRTY_PATH = "shopify_review_stock_dirty";
export const HIDDEN_PATH = "config/shopifyReviewHidden";

// No Shopify call is made per product, only a few small RTDB reads, so the
// ceiling is wider than the inventory sweep's 40. A mass count that zeroes a
// thousand products takes a few ticks, and nothing is lost by stopping early.
export const MAX_PER_RUN = 200;

/**
 * true = some size has a sellable unit online; false = none; null = cannot be
 * judged (no sizes array — such a record cannot be published either, see
 * reconcile.mjs). null is NEVER treated as "hide".
 */
export function hasSellableStock(stockTree, pid, sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  return Object.values(networkTotals(stockTree, pid, sizes)).some((q) => q > 0);
}

/**
 * Which review bucket a product sits in. This is used for the dry-run report
 * only, and it decides nothing.
 *   blocked   — refused (state "blocked")
 *   in review — a node exists with work on it: name approved, a proposal, a
 *               condition, photos, or once on Shopify and now switched off
 *   awaiting  — never touched (no node, or a bare awaiting node)
 */
export function reviewBucket(node) {
  if (!node) return "awaiting";
  if (normalizedState(node) === "blocked") return "blocked";
  if (normalizedState(node) === "live" || node.nameApprovedAt || node.nameProposal ||
      node.condition || node.photos || node.cleanName) return "in review";
  return "awaiting";
}

/** Should this product be hidden from the review list? */
export function verdictFor({ node, sizes, sellable }) {
  // On the storefront, or on its way: it is not in the review list at all, so
  // a stale entry is removed and nothing is hidden.
  if (isOnOrGoingOn(node)) return { verdict: "show", why: "on or going on the storefront" };
  if (!Array.isArray(sizes) || sizes.length === 0) return { verdict: "show", why: "no sizes — cannot be judged" };
  if (sellable === null) return { verdict: "show", why: "cannot be judged" };
  return sellable ? { verdict: "show", why: "sellable stock" } : { verdict: "hide", why: "no sellable stock online" };
}

/** Judge one product from point reads only. */
export async function judgeProduct(db, pid, locNames) {
  const sizes = (await db.ref(`products/${pid}/sizes`).get()).val();
  const node = (await db.ref(`shopify_publish/${pid}`).get()).val();
  // Read the cells only when the answer could depend on them.
  if (isOnOrGoingOn(node) || !Array.isArray(sizes) || !sizes.length) {
    return { pid, ...verdictFor({ node, sizes, sellable: null }) };
  }
  const tree = {};
  for (const loc of locNames) {
    const cells = (await db.ref(`stock/${loc}/${pid}`).get()).val();
    if (cells) tree[loc] = { [pid]: cells };
  }
  const sellable = hasSellableStock(tree, pid, sizes);
  return { pid, ...verdictFor({ node, sizes, sellable }) };
}

/**
 * Write the verdict. "hide" keeps an existing entry's original time (the
 * product has been hidden since then); "show" removes the entry. Writing null
 * to an absent key is a no-op in RTDB, so "show" is always safe.
 */
export async function applyVerdict(db, pid, verdict, { timestamp }) {
  const ref = db.ref(`${HIDDEN_PATH}/${pid}`);
  if (verdict === "hide") {
    const cur = (await ref.get()).val();
    if (cur == null) { await ref.set(timestamp); return "hidden"; }
    return "already hidden";
  }
  const cur = (await ref.get()).val();
  if (cur == null) return "already shown";
  await ref.remove();
  return "shown";
}

/**
 * Drain the review markers. `timestamp` is the server-time sentinel
 * (admin.database.ServerValue.TIMESTAMP), passed in so the module has no
 * firebase-admin import and the tests need none.
 */
export async function sweepReviewStock(db, { commit = false, max = MAX_PER_RUN, timestamp, log = () => {} } = {}) {
  const markers = (await db.ref(REVIEW_DIRTY_PATH).get()).val() || {};
  const pids = Object.keys(markers).sort();
  const out = { seen: pids.length, hidden: 0, shown: 0, cleared: 0, kept: 0, failed: 0, results: [] };
  if (!pids.length) return out;
  const locNames = await locationNames(db);
  for (const pid of pids.slice(0, max)) {
    const revision = markers[pid];
    try {
      const j = await judgeProduct(db, pid, locNames);
      if (!commit) { out.results.push({ ...j, dryRun: true }); continue; }
      const did = await applyVerdict(db, pid, j.verdict, { timestamp });
      if (did === "hidden") out.hidden++;
      if (did === "shown") out.shown++;
      out.results.push({ ...j, did });
      // Cleared only after the verdict landed, and only if no newer movement
      // re-marked it meanwhile. If it was re-marked, the next tick judges again.
      if (await clearMarker(db, pid, revision, REVIEW_DIRTY_PATH)) out.cleared++; else out.kept++;
    } catch (e) {
      out.failed++;
      out.results.push({ pid, ok: false, why: String(e?.message || e) });
      log(`  ⚠ review stock ${pid}: ${String(e?.message || e)} — marker kept for the next tick`);
    }
  }
  return out;
}
