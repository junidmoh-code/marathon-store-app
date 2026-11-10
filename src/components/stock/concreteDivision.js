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

const validN = (n) => Number.isInteger(n) && n >= 1 && n <= DIVISION_MAX;

// The normalised policy, or null when the key is absent or unusable. A partly
// garbled leg is read as absent (that leg arms nothing), never guessed.
function concreteDivisionPolicy(config) {
  const raw = divisionIsObj(config) ? config[CONCRETE_DIVISION_KEY] : null;
  if (!divisionIsObj(raw)) return null;
  const leg = (r) => (divisionIsObj(r) && validN(r.perSize) && validN(r.oneSize) ? { perSize: r.perSize, oneSize: r.oneSize } : null);
  const shopOnly = leg(raw.shopOnly);
  const fromHub3 = leg(raw.fromHub3);
  const hub3Keep = leg(raw.hub3Keep);
  if (!shopOnly && !fromHub3 && !hub3Keep) return null;
  return {
    shopOnly,
    fromHub3: fromHub3 ? { ...fromHub3, askAt: Number.isInteger(raw.fromHub3.askAt) && raw.fromHub3.askAt >= 0 ? raw.fromHub3.askAt : 0 } : null,
    hub3Keep: hub3Keep ? { ...hub3Keep, on: raw.hub3Keep.on === true } : null,
  };
}

// May this config arm the division at all, for this location?
function isDivisionLocation(loc) {
  return DIVISION_LOCATIONS.includes(loc);
}

// A shop's numbers. { target, minQty, reorderPoint, source }.
function divisionTargetShape(n, reorderPoint) {
  return { target: n, minQty: Math.max(1, n - 1), reorderPoint: reorderPoint === undefined ? null : reorderPoint, source: "concrete_division" };
}

// Has Hub 3 EVER held this product? "By any means": a cell (cells are never
// deleted, whatever its count or trust), an engine lock, units in a held box,
// or an open request into Hub 3.
function hub3PresenceIndex({ hub3Stock, hub3Locks, hub3Held, refillRequests } = {}) {
  const present = new Set();
  for (const pid of Object.keys(hub3Stock || {})) {
    if (pid === "_meta") continue;
    const n = hub3Stock[pid];
    if (n && typeof n === "object" && Object.values(n).some((c) => c != null)) present.add(pid);
  }
  for (const pid of Object.keys(hub3Locks || {})) if (hub3Locks[pid]) present.add(pid);
  for (const line of Object.values(hub3Held || {})) if (line && line.productId) present.add(line.productId);
  for (const r of Object.values(refillRequests || {})) {
    if (r && r.status === "open" && !r.shadow && r.requestingLocation === DIVISION_HUB && r.productId) present.add(r.productId);
  }
  return present;
}

// Is this product SEATED at a division shop? (A seat is the arming act there.)
function isSeatedAtShop(division, dest, pid) {
  return !!division && DIVISION_SHOPS.includes(dest) && divisionIsObj(division.seats?.[dest]?.[pid]);
}

// Does a division shop carry this product: seated, or a cell in the view?
function divisionShopCarries(division, dest, pid, stockView) {
  if (isSeatedAtShop(division, dest, pid)) return true;
  const node = stockView?.[dest]?.[pid];
  return !!node && typeof node === "object" && Object.keys(node).length > 0;
}

// ── WHAT THE ENGINE ASKS, CELL BY CELL ───────────────────────────────────────
// `division` is what divisionContext built for this scan. Returns undefined
// ("not the division's business — carry on down the engine's own order"), null
// ("the division answers: no target here"), or a target. `stockView` is the
// engine's own stock view for this destination (trust mask applied).
function divisionTarget(division, dest, pid, size, products, stockView) {
  if (!division || !isDivisionLocation(dest)) return undefined;
  const product = products?.[pid];
  if (!product || isDivisionFootwear(product)) return undefined;
  const { policy, seats, hub3Present } = division;
  const key = size === null || size === undefined || String(size).trim() === "" ? "_" : String(size);
  if (!divisionSizes(product).includes(key)) return null;
  const one = isDivisionOneSize(product);
  if (dest === DIVISION_HUB) {
    if (!policy.hub3Keep || !policy.hub3Keep.on) return null;
    if (!seats?.[dest]?.[pid]) return null;
    return divisionTargetShape(one ? policy.hub3Keep.oneSize : policy.hub3Keep.perSize);
  }
  // A shop arms what is SEATED there (Junid, 10 Nov 2026: seating, not the
  // trust mask, decides — a till-deducted shop shelf is counted stock), or,
  // with no seat, what it carries in the engine's own (trust-masked) view.
  if (!divisionShopCarries(division, dest, pid, stockView)) return null;
  if (hub3Present.has(pid)) {
    const owner = seats?.[DIVISION_HUB]?.[pid]?.owner;
    if (owner && owner !== dest) return null;
    if (!policy.fromHub3) return null;
    return divisionTargetShape(one ? policy.fromHub3.oneSize : policy.fromHub3.perSize, policy.fromHub3.askAt);
  }
  if (!policy.shopOnly) return null;
  return divisionTargetShape(one ? policy.shopOnly.oneSize : policy.shopOnly.perSize);
}

// Where a shop's non-sneaker refill comes from: Hub 3 once Hub 3 has held it,
// else Central. undefined for anything else.
function divisionSourceFor(division, dest, pid, product, central) {
  if (!division || !DIVISION_SHOPS.includes(dest) || !product || isDivisionFootwear(product)) return undefined;
  return division.hub3Present.has(pid) ? DIVISION_HUB : central;
}

// The non-sneaker products the division manages at a destination this scan.
function divisionManagedPids(division, dest, stockView, products) {
  if (!division || !isDivisionLocation(dest)) return [];
  if (dest === DIVISION_HUB) {
    if (!division.policy.hub3Keep || !division.policy.hub3Keep.on) return [];
    return Object.keys(division.seats?.[dest] || {}).filter((pid) => products?.[pid] && !isDivisionFootwear(products[pid]));
  }
  const pids = new Set([...Object.keys(stockView?.[dest] || {}), ...Object.keys(division.seats?.[dest] || {})]);
  return [...pids].filter((pid) => pid !== "_meta" && !!products?.[pid] && !isDivisionFootwear(products[pid])
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
  divisionTargetShape, hub3PresenceIndex, isSeatedAtShop, divisionShopCarries, divisionTarget, divisionSourceFor, divisionManagedPids,
  SNEAKER_SOLVE_HUBS, sneakerSolvePairAllowed, otherMarathonHub, marathonHubSeated, marathonSolveRefusal,
};
