// ─── THE MARKER THAT CARRIES AN APP PRICE EDIT TO THE WEBSITE ───────────────
//
// WHAT WAS BROKEN (6 Nov 2026). scripts/shopify/reconcile.mjs priced a product
// on Shopify only when it went live. Any later edit to /products/{pid}/
// retailPrice — the Edit price screen, bulk pricing, specials, New Arrivals —
// never reached the website. Junid found Air Jordan 1 Low Travis Scott Brown
// Pink at R700 in the app and R450 on marathonclub.co.za; 140 of 2,222 live
// listings disagreed with the app that day.
//
// This trigger writes ONE small counter key, /shopify_price_dirty/{pid}, when a
// LISTED product's retail price changes; scripts/shopify/priceSync.mjs drains
// it on the Mac mini's commit tick and sets Shopify to the app's price. The
// reconciler's price backstop re-checks every live product on a cadence, so a
// missed mark costs a delay, never a permanent drift.
//
// The value is an incrementing counter for the same reason as the inventory
// marker (shopify-inventory-dirty.cjs): the sweep clears a marker only when it
// still holds the revision it processed, so an edit landing mid-push survives.

const PRICE_DIRTY_PATH = "shopify_price_dirty";

/** Listed on Shopify — the same test as isListedOnShopify in inventorySync.mjs. */
function isListed(node) {
  return node?.state === "live";
}

const cents = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 100));

/**
 * Mark a product's price as needing a push. `deps` = { db, increment, log }.
 * The current price is RE-READ rather than trusted from the event, so a stale
 * or retried delivery cannot prove "nothing changed" (over-marking is cheap).
 */
async function markPriceDirty({ db, increment, log = () => {} }, { pid, before }) {
  if (!pid) return { marked: false, why: "no product id" };
  const after = (await db.ref(`products/${pid}/retailPrice`).get()).val();
  if (cents(before) === cents(after)) return { marked: false, why: "retail price unchanged" };
  const node = (await db.ref(`shopify_publish/${pid}`).get()).val();
  if (!isListed(node)) return { marked: false, why: "not listed on Shopify" };
  await db.ref(`${PRICE_DIRTY_PATH}/${pid}`).set(increment(1));
  log(`shopify price marked dirty: ${pid}`);
  return { marked: true };
}

module.exports = { PRICE_DIRTY_PATH, isListed, markPriceDirty };
