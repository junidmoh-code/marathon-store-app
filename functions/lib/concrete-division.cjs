// ─── THE CONCRETE DIVISION — seating + non-footwear keeps ────────────────────
//
// THE 12 NOV 2026 MODEL (Junid; supersedes every earlier Hub 3 non-sneaker rule):
//   • Everything that is not footwear at Pine and Concrete is kept in the SHOP
//     and supplied straight from Central — 2 per size, 5 per design with no
//     size — exactly as Hub 2 supplies Marathon PE and Trophy. Concrete still
//     never keeps perfume.
//   • Hub 3 is sneakers only: no non-footwear keep, no non-footwear seat, no
//     shop ever supplied from Hub 3 for a non-footwear item.
//   • Hub 3's sneakers keep 2 per size, ask at 1 (the footwear-all group's
//     Hub 3 leg — config, not this file), seated products only.
// The refill engine asks this file and stays the only planner.
//
// THE KEY — one engine-config key, edited on the Engine Policy card
// (setCategoryPolicy action "setConcreteDivision"):
//   config/refillEngine/concreteDivision = { shopOnly: { perSize: 2, oneSize: 5 } }
// Absent or garbled ⇒ this whole file answers "not mine" and the division runs
// on the older routes (the seed's templates and central-fed clothing), so
// deleting the key is the rollback. It never speaks for Section 2.
//
// SEATING. `refill_engine/seats/{loc}/{pid} = { via, at }`, written by the
// server only (the scan, and the Solve callable). A cell holding units at Pine,
// Concrete or Hub 3 seats the product there (Hub 3: footwear only); a Solve
// seats it too. It stays seated when it sells out; it leaves when the last
// units were moved out by a transfer, or when the Seating tab switches it off.
//
// TWO COPIES, ONE BODY: this file and src/components/stock/concreteDivision.js
// carry the same text between the markers; a parity test pins them. Pure: no
// firebase, no clock.
"use strict";

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
// the older routes come back whole.
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

// ── SERVER ONLY ──────────────────────────────────────────────────────────────

// One scan's context, or null when the key is off. (Extra arguments older
// callers still pass — stock, locks, held boxes, requests — are not needed:
// nothing about Hub 3 decides a shop's non-footwear keep or source any more.)
function divisionContext({ config, seats } = {}) {
  const policy = concreteDivisionPolicy(config);
  if (!policy) return null;
  return { policy, seats: seats || {} };
}

// Movement types that take units OUT of a location by a person's move. A sale,
// a count or a write-off is not one: those leave the product seated.
const MOVED_OUT_TYPES = new Set(["transfer_out", "transfer"]);

// SEATING COVERS SOLD-OUT PRODUCTS (Junid, 10 Nov 2026). Besides a cell holding
// units, a product is seated by an existing cell at zero, or by any sale,
// arrival, return or transfer at the location since this date.
const SEAT_HISTORY_SINCE = "2026-10-30T00:00:00.000Z";
const SEAT_RELEASES_PATH = "refill_engine/seatReleases";
const SEAT_PID_BAD = /[.#$/[\]\s]/;
// Did this movement happen AT this location, in a way that seats a product?
function seatsBy(m, loc) {
  if (!m || String(m.ts) < SEAT_HISTORY_SINCE) return false;
  if (m.type === "sold") return m.from === loc;
  if (m.type === "received" || m.type === "return") return m.to === loc;
  if (MOVED_OUT_TYPES.has(m.type)) return m.to === loc || m.from === loc;
  return false;
}

// ── WHAT THE SCAN WRITES ABOUT SEATS ─────────────────────────────────────────
// Pure. Returns { effective, writes, releaseWrites, seated, released }:
//   effective      the seats the plan should read (written ones plus this scan's)
//   writes         { "<loc>/<pid>": seat | null } under SEATS_PATH
//   releaseWrites  { "<loc>/<pid>": tombstone | null } under SEAT_RELEASES_PATH
// A RELEASE LEAVES A TOMBSTONE. A product moved out keeps its zero cells (cells
// are never deleted), and a zero cell now seats — so without a record of the
// release it would be re-seated the moment the transfer aged out of the ledger
// window. The tombstone holds until something NEW happens to the product there
// (units arrive, a sale, a movement newer than the release); then it is seated
// again and the tombstone goes. `releases` is what SEAT_RELEASES_PATH holds.
// `products` (optional): a movement naming a product that no longer exists
// seats nothing. A product id that is not a valid RTDB key is never written
// (one bad key would fail the whole multi-path update, every scan).
//
// MOVED OUT BEFORE ANY TOMBSTONE EXISTED. A product moved out before this code
// (or more than the ledger window ago) has no tombstone. While its transfer is
// in the window movedOut() says so; once it ages out the cell itself still does:
// every cell left is empty and stamped by a person's transfer out (lastType
// "transfer_out", not a refill "rrf_" movement). Either way the scan writes the
// tombstone then, so the answer never depends on the ledger window again.
function planSeats({ rawStock, seats, movements, nowIso, releases = {}, products = null }) {
  const effective = {};
  const writes = {};
  const releaseWrites = {};
  let seated = 0, released = 0;
  const lastMove = new Map();
  const lastSeating = new Map();
  for (const m of movements || []) {
    if (!m || !m.productId || !m.ts) continue;
    for (const loc of [m.from, m.to]) {
      if (!DIVISION_LOCATIONS.includes(loc)) continue;
      const k = `${loc}|${m.productId}`;
      if (!lastMove.has(k) || String(m.ts) >= String(lastMove.get(k).ts)) lastMove.set(k, m);
      if (seatsBy(m, loc) && (!lastSeating.has(k) || String(m.ts) > lastSeating.get(k))) lastSeating.set(k, String(m.ts));
    }
  }
  const held = (node) => !!node && typeof node === "object" && Object.values(node).some((c) => c && typeof c === "object" && (Number(c.qty) || 0) > 0);
  const hasCell = (node) => !!node && typeof node === "object" && Object.values(node).some((c) => c && typeof c === "object");
  // Nothing left here, and the newest thing that happened to this product here
  // was a person's transfer away (not a refill or order leaving).
  const movedOut = (loc, pid, node) => {
    if (held(node)) return null;
    const m = lastMove.get(`${loc}|${pid}`);
    if (!m || m.from !== loc || !MOVED_OUT_TYPES.has(m.type)) return null;
    if (m.link && (m.link.refillId || m.link.orderId)) return null;
    return m;
  };
  // The cells' own stamp, when the ledger no longer covers the move.
  const cellsSayMovedOut = (node) => {
    if (held(node)) return false;
    const cells = Object.values(node || {}).filter((c) => c && typeof c === "object");
    return cells.length > 0 && cells.every((c) => MOVED_OUT_TYPES.has(c.lastType) && !String(c.mv || "").startsWith("rrf_"));
  };
  for (const loc of DIVISION_LOCATIONS) {
    const here = { ...(divisionIsObj(seats?.[loc]) ? seats[loc] : {}) };
    const node = rawStock?.[loc] || {};
    const gone = divisionIsObj(releases?.[loc]) ? releases[loc] : {};
    const candidates = new Set(Object.keys(node));
    for (const k of lastSeating.keys()) if (k.startsWith(`${loc}|`)) candidates.add(k.slice(loc.length + 1));
    for (const pid of candidates) {
      if (pid === "_meta" || here[pid] || SEAT_PID_BAD.test(pid)) continue;
      if (products && !products[pid]) continue;
      if (products && divisionRefuses(loc, products[pid])) continue;
      const units = held(node[pid]);
      const activity = lastSeating.get(`${loc}|${pid}`) || null;
      if (!units && !hasCell(node[pid]) && !activity) continue;
      if (!units) {
        const out = movedOut(loc, pid, node[pid]);
        const stamped = !out && !activity && cellsSayMovedOut(node[pid]);
        if (out || stamped) {
          if (!divisionIsObj(gone[pid])) releaseWrites[`${loc}/${pid}`] = { at: nowIso, moveTs: out ? String(out.ts) : null };
          continue;
        }
        // Released before, and nothing has happened here since.
        const tomb = gone[pid];
        if (divisionIsObj(tomb) && !(activity && activity > String(tomb.at || ""))) continue;
      }
      here[pid] = { via: units ? "stock" : hasCell(node[pid]) ? "cell" : "history", at: nowIso };
      writes[`${loc}/${pid}`] = here[pid];
      if (gone[pid]) releaseWrites[`${loc}/${pid}`] = null;
      seated++;
    }
    // A category this location never keeps is unseated (no tombstone: the
    // rule itself keeps it out).
    for (const pid of Object.keys(here)) {
      if (products && products[pid] && divisionRefuses(loc, products[pid])) {
        delete here[pid];
        writes[`${loc}/${pid}`] = null;
        released++;
      }
    }
    for (const pid of Object.keys(here)) {
      const m = movedOut(loc, pid, node[pid]);
      if (!m) continue;
      // A Solve newer than the move means it was brought back.
      if (String(m.ts) <= String(here[pid]?.at || "")) continue;
      delete here[pid];
      writes[`${loc}/${pid}`] = null;
      releaseWrites[`${loc}/${pid}`] = { at: nowIso, moveTs: String(m.ts) };
      released++;
    }
    effective[loc] = here;
  }
  return { effective, writes, releaseWrites, seated, released };
}

// ── WHAT THE DIVISION KEEPS — the Engine Policy card's count ─────────────────
// Per location: how many products and cells the division holds a keep for, and
// the units it asks for. Reads what the scan reads (the same targets, the same
// managed list); Hub 3 keeps no non-footwear, so it always counts 0. `stockView`
// is the engine's own trust-masked stock; `seats` the seated products per location.
function divisionKeepCounts({ division, stockView, products }) {
  const out = {};
  for (const loc of DIVISION_LOCATIONS) {
    let cells = 0, units = 0;
    const pids = new Set();
    for (const pid of division ? divisionManagedPids(division, loc, stockView, products) : []) {
      for (const size of divisionSizes(products[pid])) {
        const t = divisionTarget(division, loc, pid, size, products, stockView);
        if (!t) continue;
        cells += 1;
        units += t.target;
        pids.add(pid);
      }
    }
    out[loc] = { products: pids.size, cells, units };
  }
  return out;
}

// ── THE SCAN'S WRITE-TIME TRUST CHECK ────────────────────────────────────────
// At a "solved products only" destination the scan refuses an intent for an
// untrusted cell. A seated cell is counted stock in the division: Hub 3's seated
// sneakers, and a seated non-sneaker on a Pine or Concrete shelf. The plan flags
// exactly those (seatedHub3 / seatedShop), and only for that destination.
function seatedIntentTrusted(intent, dest) {
  if (!intent) return false;
  if (intent.seatedHub3 === true && dest === DIVISION_HUB) return true;
  return intent.seatedShop === true && DIVISION_SHOPS.includes(dest);
}

// ── THE POLICY AUDIT — "Concrete division policy" on Health (Junid, 10 Nov 2026)
// What Junid's policy says a seated product should keep, per size, at Pine,
// Concrete and Hub 3 — computed from his numbers alone, never from the engine's
// answer, so the audit can catch the engine disagreeing. The 12 Nov 2026 model:
//   shop, non-footwear                      → 2 per size / 5 per design, from Central
//   Concrete, perfume                       → nothing (never kept there)
//   shop, footwear                          → nothing (Hub 3 keeps it)
//   Hub 3, footwear                         → 2 per size, ask at 1
//   Hub 3, non-footwear                     → nothing (Hub 3 is sneakers only)
// Returns { target, reorderPoint } or null (no keep).
// JUNID'S NUMBERS, pinned here and NOT read from the config: a key or group leg
// edited away from them shows as wrong_number (config drift), never "correct".
const HUB3_SNEAKER_KEEP = Object.freeze({ target: 2, reorderPoint: 1 });
const JUNID_DIVISION_KEEPS = Object.freeze({
  shopOnly: Object.freeze({ perSize: 2, oneSize: 5, askAt: null }),
});
function divisionExpectedTarget(division, loc, pid, size, product) {
  if (!division || !isDivisionLocation(loc) || !product || product.deactivated) return null;
  const footwear = isDivisionFootwear(product);
  if (loc === DIVISION_HUB) return footwear ? { ...HUB3_SNEAKER_KEEP } : null;
  if (footwear || divisionNeverKeeps(loc, product)) return null;
  const k = JUNID_DIVISION_KEEPS.shopOnly;
  return { target: isDivisionOneSize(product) ? k.oneSize : k.perSize, reorderPoint: k.askAt };
}

// One size's verdict. `effective` is the engine's own armed answer for the cell
// (resolveTarget behind the trust check, null when nothing arms it); `deadSize`
// = no units of this size anywhere (the footwear policy's dead-size rule
// answers 0 there on purpose). Returns { ok, reason }.
//   switched_off  every explicit row is 0 — a Seating-tab switch-off; it wins
//   dead_size     footwear size with no units anywhere — the policy's own 0
//   missing       the policy keeps it, nothing arms it
//   unexpected    the policy keeps nothing, something arms it
//   explicit_row  an explicit /stock_targets row overrides the policy
//   wrong_number  armed, but not with the policy's numbers
//   unrouted      (set by the engine) the policy keeps it, but no live source serves the size
function divisionAuditVerdict({ expected, effective, explicitZero = false, deadSize = false }) {
  if (explicitZero) return { ok: true, reason: "switched_off" };
  const eff = effective && Number(effective.target) > 0 ? effective : null;
  if (!expected) return eff ? { ok: false, reason: eff.source === "explicit" ? "explicit_row" : "unexpected" } : { ok: true, reason: "none" };
  if (!eff) {
    if (deadSize && effective && Number(effective.target) === 0) return { ok: true, reason: "dead_size" };
    return { ok: false, reason: "missing" };
  }
  const rpE = expected.reorderPoint == null ? null : expected.reorderPoint;
  const rpA = eff.reorderPoint == null ? null : eff.reorderPoint;
  const differs = eff.target !== expected.target || rpE !== rpA;
  // An explicit row is always named as the override it is, never "wrong numbers".
  if (differs) return { ok: false, reason: eff.source === "explicit" ? "explicit_row" : "wrong_number" };
  return { ok: true, reason: "kept" };
}

// ── THE SOLVE'S SEAT — the seatDivisionSolve callable ────────────────────────
// `refill_engine` is server-only, so a Solve records its seat through here. The
// sneaker pair rule is enforced HERE as well as on the screen.
class DivisionSeatError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const SEAT_KEY_BAD = /[.#$/[\]\s]/;

async function applyDivisionSeat({ db, callerUid, data, nowIso }) {
  const d = divisionIsObj(data) ? data : {};
  if (!callerUid) throw new DivisionSeatError("unauthenticated", "Sign in first.");
  const role = (await db.ref(`users/${callerUid}/stockRole`).once("value")).val();
  if (!role) throw new DivisionSeatError("permission-denied", "You need a stock role to Solve.");
  const { location, pid, owner, hubs, clear, solveId } = d;
  if (!DIVISION_LOCATIONS.includes(location)) throw new DivisionSeatError("invalid-argument", "Seats are kept for Hub 3, Pine and Concrete only.");
  if (typeof pid !== "string" || !pid || SEAT_KEY_BAD.test(pid)) throw new DivisionSeatError("invalid-argument", "Which product?");
  const path = `${SEATS_PATH}/${location}/${pid}`;
  if (clear === true) {
    const cur = (await db.ref(path).once("value")).val();
    // Only the Solve being undone: never an older Solve's seat.
    const ours = !!cur && cur.via === "solve" && (!solveId || cur.solveId === solveId);
    if (ours) await db.ref(path).remove();
    return { ok: true, cleared: ours };
  }
  const product = (await db.ref(`products/${pid}`).once("value")).val();
  if (!product) throw new DivisionSeatError("not-found", "That product does not exist.");
  if (hubs !== undefined && !sneakerSolvePairAllowed(Array.isArray(hubs) ? hubs : [])) {
    throw new DivisionSeatError("failed-precondition", "Hub 1 and Hub 2 cannot be solved together.");
  }
  // Hub 3 is sneakers only (Junid, 12 Nov 2026); Concrete never keeps perfume.
  if (divisionRefuses(location, product)) {
    throw new DivisionSeatError("failed-precondition", location === DIVISION_HUB
      ? "Hub 3 holds footwear only. Solve this to Concrete or Pine."
      : "Concrete never keeps this category.");
  }
  // There is no owning shop any more: the Pine-or-Concrete chooser is gone.
  if (owner !== undefined && owner !== null) {
    throw new DivisionSeatError("invalid-argument", "A seat has no owning shop.");
  }
  const seat = { via: "solve", at: nowIso, by: callerUid, ...(typeof solveId === "string" && solveId ? { solveId } : {}) };
  await db.ref(path).set(seat);
  return { ok: true, seat };
}

module.exports = {
  applyDivisionSeat, DivisionSeatError,
  CONCRETE_DIVISION_KEY, DIVISION_HUB, DIVISION_SHOPS, DIVISION_LOCATIONS, SEATS_PATH, DIVISION_MAX, DIVISION_FOOTWEAR_KEYS,
  isDivisionFootwear, divisionSizes, isDivisionOneSize, concreteDivisionPolicy, isDivisionLocation,
  DIVISION_NEVER_KEEPS, divisionNeverKeeps, hub3Refuses, divisionRefuses, divisionTargetShape, isSeatedAtShop, divisionShopCarries, divisionTarget, divisionSourceFor, divisionManagedPids,
  SNEAKER_SOLVE_HUBS, sneakerSolvePairAllowed, otherMarathonHub, marathonHubSeated, marathonSolveRefusal, divisionContext, planSeats, divisionKeepCounts,
  SEAT_HISTORY_SINCE, SEAT_RELEASES_PATH, seatsBy, seatedIntentTrusted, HUB3_SNEAKER_KEEP, JUNID_DIVISION_KEEPS, divisionExpectedTarget, divisionAuditVerdict,
};
