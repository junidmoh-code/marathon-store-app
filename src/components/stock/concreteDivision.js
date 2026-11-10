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
function divisionTarget(division, dest, pid, size, products, stockView) {
  if (!division || !isDivisionLocation(dest)) return undefined;
  const product = products?.[pid];
  if (!product || isDivisionFootwear(product)) return undefined;
  if (divisionNeverKeeps(dest, product)) return null;
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
    if (hub3ServesSize(division, pid, key)) {
      if (!policy.fromHub3) return null;
      return divisionTargetShape(one ? policy.fromHub3.oneSize : policy.fromHub3.perSize, policy.fromHub3.askAt);
    }
  }
  if (!policy.shopOnly) return null;
  return divisionTargetShape(one ? policy.shopOnly.oneSize : policy.shopOnly.perSize);
}

// ── NO DEADLOCK WHILE HUB 3 CLOTHING IS OFF (Junid, 10 Nov 2026) ─────────────
// With the Hub 3 non-sneaker keep OFF nothing ever refills Hub 3's clothing, so
// "Hub 3 has held it, so the shop asks Hub 3" would starve a size Hub 3 has run
// out of. While the keep is off the exists-at-Hub-3 rule applies only to a size
// Hub 3 actually holds (a cell with qty > 0 that Hub 3 can supply from — its
// COUNTED view: an uncounted Hub 3 cell is no source the engine will ever pick
// from, so routing a shop to it would park the shop until someone counts it);
// every other size the owning shop asks Central for, under its own keep. With the keep ON it is Hub 3 for every
// size, as before. `division.hub3Stock` is Hub 3's raw stock node; absent, the
// answer is "Hub 3 serves" (the older rule — never a guess the other way).
// A size with units already ON THEIR WAY into Hub 3 (`division.hub3Inbound`:
// a Solve's first batch, an engine lock, a held box) counts as held: the shop
// waits for that box rather than pulling a second one from Central.
const divisionSizeKey = (size) => {
  const raw = size === null || size === undefined || String(size).trim() === "" ? "_" : String(size).trim();
  return raw.replace(/[.#$/[\]\s]/g, "_");
};
function hub3HoldsSize(division, pid, size) {
  const enc = divisionSizeKey(size);
  if (division?.hub3Inbound && typeof division.hub3Inbound.has === "function" && division.hub3Inbound.has(`${pid}|${enc}`)) return true;
  const node = division?.hub3Stock?.[pid];
  if (!divisionIsObj(node)) return false;
  const raw = size === null || size === undefined || String(size).trim() === "" ? "_" : String(size).trim();
  return [raw, enc].some((k) => divisionIsObj(node[k]) && (Number(node[k].qty) || 0) > 0);
}

// Units on their way into Hub 3, per "<pid>|<sizeKey>": open engine locks, open
// requests into Hub 3, and held boxes (the hold lane). A lock or request older
// than `maxAgeMs` (the engine's staleIntentHours) no longer counts: a box that
// never came must not hold the shop's size forever. Held boxes are physically
// on the way and always count. No `nowMs` → no age bound.
function hub3InboundIndex({ hub3Locks, hub3Held, refillRequests, nowMs = null, maxAgeMs = 48 * 3600e3 } = {}) {
  const out = new Set();
  const fresh = (iso) => nowMs == null || (Number.isFinite(Date.parse(iso)) && nowMs - Date.parse(iso) <= maxAgeMs);
  for (const [pid, bySize] of Object.entries(hub3Locks || {})) {
    for (const [k, lock] of Object.entries(divisionIsObj(bySize) ? bySize : {})) if (lock && fresh(lock.createdAt)) out.add(`${pid}|${k}`);
  }
  for (const line of Object.values(hub3Held || {})) {
    if (line && line.productId) out.add(`${line.productId}|${line.sizeKey != null ? String(line.sizeKey) : divisionSizeKey(line.size)}`);
  }
  for (const r of Object.values(refillRequests || {})) {
    if (r && r.status === "open" && !r.shadow && r.requestingLocation === DIVISION_HUB && r.productId && fresh(r.createdAt)) out.add(`${r.productId}|${divisionSizeKey(r.size)}`);
  }
  return out;
}
function hub3ServesSize(division, pid, size) {
  if (!division || !division.hub3Present.has(pid)) return false;
  if (division.policy?.hub3Keep?.on) return true;
  if (!division.hub3Stock) return true;
  return hub3HoldsSize(division, pid, size);
}

// Where a shop's non-sneaker refill comes from: Hub 3 once Hub 3 has held it
// (per size while the Hub 3 keep is off — hub3ServesSize), else Central.
// undefined for anything else. Asked with no size, the product-level answer.
function divisionSourceFor(division, dest, pid, product, central, size) {
  if (!division || !DIVISION_SHOPS.includes(dest) || !product || isDivisionFootwear(product)) return undefined;
  if (!division.hub3Present.has(pid)) return central;
  if (size === undefined) return DIVISION_HUB;
  return hub3ServesSize(division, pid, size) ? DIVISION_HUB : central;
}

// The non-sneaker products the division manages at a destination this scan.
function divisionManagedPids(division, dest, stockView, products) {
  if (!division || !isDivisionLocation(dest)) return [];
  if (dest === DIVISION_HUB) {
    if (!division.policy.hub3Keep || !division.policy.hub3Keep.on) return [];
    return Object.keys(division.seats?.[dest] || {}).filter((pid) => products?.[pid] && !isDivisionFootwear(products[pid]));
  }
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
  DIVISION_NEVER_KEEPS, divisionNeverKeeps, divisionTargetShape, hub3PresenceIndex, isSeatedAtShop, divisionShopCarries, hub3HoldsSize, hub3ServesSize, hub3InboundIndex, divisionTarget, divisionSourceFor, divisionManagedPids,
  SNEAKER_SOLVE_HUBS, sneakerSolvePairAllowed, otherMarathonHub, marathonHubSeated, marathonSolveRefusal,
};
