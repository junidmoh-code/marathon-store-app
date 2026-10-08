// ─── CENTRAL-FED CLOTHING — a store that keeps its clothing in the shop ─────
//
// Owner rule, 8 Oct 2026: at the Concrete store, CLOTHING is kept entirely in
// the shop — N of every size the product declares (4 to start) — and refilled
// STRAIGHT FROM CENTRAL, never through Hub 3. Pine clothing is unchanged
// (shop ← Hub 3 ← Central); Concrete's sneakers and perfume are unchanged
// (back stock at Hub 3).
//
// The switch and the number are ONE engine-config key, edited on the Engine
// Policy card (setCategoryPolicy action "setCentralFed"):
//     config/refillEngine/centralFedClothing = { concrete: 4 }
// Absent, garbled or ≤ 0 ⇒ the rule is OFF and every caller behaves exactly as
// before. It never applies to a store config.routes names (Marathon PE,
// Trophy): those are routed by their config entry and nothing else.
//
// TWO COPIES, ONE BODY: functions/lib/central-fed.cjs and this file carry
// the same text between the markers; a parity test pins them. Pure: no
// firebase, no clock, no registry import (the registry is handed in).
// ── BEGIN SHARED BODY ────────────────────────────────────────────────────────
const CENTRAL_FED_KEY = "centralFedClothing";
const CENTRAL_FED_MAX = 99;

function centralFedIsObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Clothing, exactly as the refill engine reads it (refill-engine.cjs
// isClothing): the explicit productType when present, else the legacy letter
// size heuristic. Sneakers, slides, perfume and accessories are not clothing.
function centralFedIsClothing(product) {
  if (!product) return false;
  if (product.productType) return product.productType === "clothing";
  return (product.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
}

// N for this store, or null when the rule is off there.
function centralFedPerSize(config, network, store) {
  const map = centralFedIsObj(config) && centralFedIsObj(config[CENTRAL_FED_KEY]) ? config[CENTRAL_FED_KEY] : null;
  if (!map || typeof store !== "string" || !store) return null;
  const n = map[store];
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > CENTRAL_FED_MAX) return null;
  const routes = centralFedIsObj(config.routes) ? config.routes : {};
  if (Object.prototype.hasOwnProperty.call(routes, store)) return null;
  const loc = network && network.locations ? network.locations[store] : null;
  if (!loc || loc.type !== "store" || loc.retired === true) return null;
  return n;
}

function isCentralFedProduct(config, network, store, product) {
  return centralFedPerSize(config, network, store) !== null && centralFedIsClothing(product);
}

// The sizes a central-fed product is kept in: every size it declares, blanks
// dropped; a product that declares none (or only the one-size "_") is the
// one-size cell "_".
function centralFedSizes(product) {
  const declared = ((product && product.sizes) || []).map((s) => (s === null || s === undefined ? "" : String(s).trim())).filter((s) => s && s !== "_");
  return declared.length ? [...new Set(declared)] : ["_"];
}

// The target a central-fed size resolves to: N, refilled whenever below N.
function centralFedTarget(n) {
  return { target: n, minQty: Math.max(1, n - 1), reorderPoint: null, source: "central_fed" };
}
// ── END SHARED BODY ──────────────────────────────────────────────────────────

export {
  CENTRAL_FED_KEY, CENTRAL_FED_MAX, centralFedIsClothing, centralFedPerSize, isCentralFedProduct, centralFedSizes, centralFedTarget,
};
