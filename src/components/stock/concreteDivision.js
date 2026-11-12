// ─── THE CONCRETE DIVISION — browser twin of functions/lib/concrete-division.cjs ─
// The text between the markers is identical to the server's; a parity test pins it.
// See the server file for the whole story.

// ── BEGIN SHARED BODY ────────────────────────────────────────────────────────
const CONCRETE_DIVISION_KEY = "concreteDivision";
const DIVISION_HUB = "hub3";
const DIVISION_SHOPS = Object.freeze(["concrete", "marathon-pine"]);
const DIVISION_LOCATIONS = Object.freeze([DIVISION_HUB, ...DIVISION_SHOPS]);
const SEATS_PATH = "refill_engine/seats";
const DIVISION_MAX = 99;
// The eight footwear categories (policy-resolve.cjs FOOTWEAR_CATEGORY_KEYS,
// pinned equal by test): the sneaker side of the division's split.
const DIVISION_FOOTWEAR_KEYS = Object.freeze(["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers", "soccer-boots"]);

function divisionIsObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function divisionCategoryKey(product) {
  const key = typeof product?.categoryKey === "string" ? product.categoryKey.trim() : "";
  if (key) return key;
  if (product && product.category === "Footwear" && product.subcategory === "Sneakers") return "sneakers";
  return null;
}

function isDivisionFootwear(product) {
  if (!product) return false;
  return product.category === "Footwear" || DIVISION_FOOTWEAR_KEYS.includes(divisionCategoryKey(product));
}

// The sizes a product is kept in: every size it declares; one that declares
// none (or only the "_" sentinel) is the one-size cell "_".
function divisionSizes(product) {
  const declared = ((product && product.sizes) || []).map((s) => (s === null || s === undefined ? "" : String(s).trim())).filter((s) => s && s !== "_");
  return declared.length ? [...new Set(declared)] : ["_"];
}
const isDivisionOneSize = (product) => divisionSizes(product)[0] === "_";

// WHAT A LOCATION NEVER KEEPS (Junid, 10 Nov 2026): Concrete never keeps
// perfume. Never seated there, never a keep, whatever any other rule says.
const DIVISION_NEVER_KEEPS = Object.freeze({ concrete: Object.freeze(["perfumes"]) });
function divisionNeverKeeps(loc, product) {
  const keys = DIVISION_NEVER_KEEPS[loc];
  if (!keys || !product) return false;
  const key = divisionCategoryKey(product);
  if (key && keys.includes(key)) return true;
  return keys.includes("perfumes") && String(product.category || "").trim().toLowerCase() === "perfume";
}

// HUB 3 IS SNEAKERS ONLY (Junid, 12 Nov 2026: "Hub 3 holds NO non-footwear
// stock"). A rule of the division, so it holds while the division key is on:
// Hub 3 never keeps, is never seated with and is never Solved anything that is
// not footwear, above every row and rule. With the key deleted (the rollback)
// the pre-division routes (the seed's templates, central-fed) come back for
// the engine; the 9–11 Nov Hub 3 clothing code is gone, and a Solve seat or
// the scan's seat pass still refuses Hub 3 non-footwear.
function hub3Refuses(loc, product) {
  return loc === DIVISION_HUB && !!product && !isDivisionFootwear(product);
}
// Everything the division refuses at a location (asked with the key on).
function divisionRefuses(loc, product) {
  return divisionNeverKeeps(loc, product) || hub3Refuses(loc, product);
}

const validN = (n) => Number.isInteger(n) && n >= 1 && n <= DIVISION_MAX;

// The normalised policy, or null when the key is absent or unusable. One leg
// since 12 Nov 2026: the shop keep, from Central. Fields an older key still
// carries (fromHub3, hub3Keep) are ignored — nothing reads them any more.
function concreteDivisionPolicy(config) {
  const raw = divisionIsObj(config) ? config[CONCRETE_DIVISION_KEY] : null;
  if (!divisionIsObj(raw)) return null;
  const r = raw.shopOnly;
  if (!divisionIsObj(r) || !validN(r.perSize) || !validN(r.oneSize)) return null;
  return { shopOnly: { perSize: r.perSize, oneSize: r.oneSize } };
}

// May this config arm the division at all, for this location?
function isDivisionLocation(loc) {
  return DIVISION_LOCATIONS.includes(loc);
}

// A shop's numbers. { target, minQty, reorderPoint, source }.
function divisionTargetShape(n, reorderPoint) {
  return { target: n, minQty: Math.max(1, n - 1), reorderPoint: reorderPoint === undefined ? null : reorderPoint, source: "concrete_division" };
}

// Is this product SEATED at a division shop? (A seat is the arming act there.)
function isSeatedAtShop(division, dest, pid) {
  return !!division && DIVISION_SHOPS.includes(dest) && divisionIsObj(division.seats?.[dest]?.[pid]);
}

// Does a division shop carry this product: seated, or a cell in the view?
// When the caller hands in the shop's seats (the scan, the census), the SEAT
// alone decides: a product moved out and tombstoned must not arm off a counted
// cell it left behind. A caller with no seats for the shop (the Seating-tab
// preview) falls back to the cell.
function divisionShopCarries(division, dest, pid, stockView) {
  if (isSeatedAtShop(division, dest, pid)) return true;
  if (division && divisionIsObj(division.seats?.[dest])) return false;
  const node = stockView?.[dest]?.[pid];
  return !!node && typeof node === "object" && Object.keys(node).length > 0;
}

// ── WHAT THE ENGINE ASKS, CELL BY CELL ───────────────────────────────────────
// `division` is what divisionContext built for this scan. Returns undefined
// ("not the division's business — carry on down the engine's own order"), null
// ("the division answers: no target here"), or a target. `stockView` is the
// engine's own stock view for this destination (trust mask applied).
// THE 12 NOV 2026 MODEL (Junid): every non-footwear item a Pine or Concrete
// shop carries is kept in the shop — 2 per size, 5 per design with no size —
// and supplied straight from Central, as Hub 2 supplies Marathon PE/Trophy.
// Hub 3 keeps no non-footwear at all (hub3Refuses).
function divisionTarget(division, dest, pid, size, products, stockView) {
  if (!division || !isDivisionLocation(dest)) return undefined;
  const product = products?.[pid];
  if (!product || isDivisionFootwear(product)) return undefined;
  if (divisionRefuses(dest, product)) return null;
  const key = size === null || size === undefined || String(size).trim() === "" ? "_" : String(size);
  if (!divisionSizes(product).includes(key)) return null;
  // A shop arms what is SEATED there (Junid, 10 Nov 2026: seating, not the
  // trust mask, decides — a till-deducted shop shelf is counted stock), or,
  // with no seat, what it carries in the engine's own (trust-masked) view.
  if (!divisionShopCarries(division, dest, pid, stockView)) return null;
  const { policy } = division;
  if (!policy.shopOnly) return null;
  return divisionTargetShape(isDivisionOneSize(product) ? policy.shopOnly.oneSize : policy.shopOnly.perSize);
}

// Where a shop's non-footwear refill comes from: Central, always (12 Nov 2026).
// undefined for anything else.
function divisionSourceFor(division, dest, pid, product, central) {
  if (!division || !DIVISION_SHOPS.includes(dest) || !product || isDivisionFootwear(product)) return undefined;
  return central;
}

// The non-footwear products the division manages at a destination this scan.
// Hub 3 manages none.
function divisionManagedPids(division, dest, stockView, products) {
  if (!division || !DIVISION_SHOPS.includes(dest)) return [];
  const pids = new Set([...Object.keys(stockView?.[dest] || {}), ...Object.keys(division.seats?.[dest] || {})]);
  return [...pids].filter((pid) => pid !== "_meta" && !!products?.[pid] && !isDivisionFootwear(products[pid]) && !divisionNeverKeeps(dest, products[pid])
    && divisionShopCarries(division, dest, pid, stockView));
}

// ── HUB + SHOP OF A SOLVE ────────────────────────────────────────────────────
// The two pairs a sneaker Solve may take, and the one it never may.
const SNEAKER_SOLVE_HUBS = Object.freeze(["hub1", "hub2", "hub3"]);
function sneakerSolvePairAllowed(hubs) {
  const h = [...new Set(hubs || [])];
  if (h.length === 0 || h.length > 2) return false;
  if (!h.every((x) => SNEAKER_SOLVE_HUBS.includes(x))) return false;
  return !(h.includes("hub1") && h.includes("hub2"));
}
// ── HUB 1 AND HUB 2 NEVER SHARE A SNEAKER (Junid, 9 Nov 2026) ────────────────
// Refused for one Solve naming both, above, and across separate Solves here: a
// Solve may not seat a product at one of the two while the other has it seated.
// Seated = a stock cell (the engine's own carriage test, sold out included), a
// target row above zero, or a request already on its way; a cell whose row is
// target 0 is switched off, so it does not count.
function otherMarathonHub(hub) {
  return hub === "hub1" ? "hub2" : hub === "hub2" ? "hub1" : null;
}
function marathonHubSeated({ cells, rows, openRequest = false } = {}) {
  if (openRequest) return true;
  const targetRows = divisionIsObj(rows) ? rows : {};
  if (Object.values(targetRows).some((r) => divisionIsObj(r) && Number(r.target) > 0)) return true;
  const off = (k) => divisionIsObj(targetRows[k]) && Number(targetRows[k].target) <= 0;
  return divisionIsObj(cells) && Object.keys(cells).some((k) => cells[k] !== null && cells[k] !== undefined && !off(k));
}
function marathonSolveRefusal(hub) {
  const name = (h) => (h === "hub1" ? "Hub 1" : "Hub 2");
  return `This product is seated at ${name(otherMarathonHub(hub))}, so it cannot be solved to ${name(hub)}.`;
}
// ── END SHARED BODY ──────────────────────────────────────────────────────────

export {
  CONCRETE_DIVISION_KEY, DIVISION_HUB, DIVISION_SHOPS, DIVISION_LOCATIONS, SEATS_PATH, DIVISION_MAX, DIVISION_FOOTWEAR_KEYS,
  isDivisionFootwear, divisionSizes, isDivisionOneSize, concreteDivisionPolicy, isDivisionLocation,
  DIVISION_NEVER_KEEPS, divisionNeverKeeps, hub3Refuses, divisionRefuses, divisionTargetShape, isSeatedAtShop, divisionShopCarries, divisionTarget, divisionSourceFor, divisionManagedPids,
  SNEAKER_SOLVE_HUBS, sneakerSolvePairAllowed, otherMarathonHub, marathonHubSeated, marathonSolveRefusal,
};
