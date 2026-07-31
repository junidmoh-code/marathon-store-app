// ─── MISSING SNEAKERS — detection ─────────────────────────────────────────────
// The footwear analogue of the clothing "Missing Products" rule, one level up the
// network. Owner definition (2026-07-30):
//
//   "You see what's there at Central but both hubs don't have it, then we assign
//    it. The only place we look at is Central, since Studio and Base merged into
//    Central. If you're not seeing anything at Hub 1 and Hub 2 but you see it at
//    Central, that's a missing product."
//
// WHY THE SHOPS ARE NOT IN THE TEST. Clothing checks the SHOPS downstream because
// shops hold clothing buffer. Shoes pass through shop → customer and hold no
// buffer by design — which is why 267 shop-shoe cells were zeroed. Measured
// 2026-07-30: Marathon PE holds 16 footwear units across 2,454 cells, Trophy 4
// across 293. Testing the shops would flag essentially the whole catalogue and
// tell you nothing. Hub 1 (3,967 units) and Hub 2 (3,288) are where sneaker
// buffer actually lives, so they are the downstream that matters.
//
// UNITS, NOT CARRIAGE (owner decision). A hub cell that exists but sits at zero
// still counts as missing — "include sold but carried as well so we can assign
// them again, because they were sold out at some point". That is a deliberate
// divergence from the clothing rule, which keys on cell EXISTENCE. Consequence
// worth knowing: a row only clears when real units arrive, so seeding alone will
// not retire it — see `kind` below and MissingFootwear.jsx's action split.
//
// Live counts under this rule (2026-07-30): 635 footwear products have Central
// stock; 121 are missing from both hubs — 95 never introduced, 26 sold out.
import { stockSizeKey } from "../../utils/sizeKey";

// Footwear is CATEGORY, never productType: 1,369 products carry
// category "Footwear" while only 580 carry productType "sneaker", and 858
// records have no productType at all. Same predicate the engine uses.
export const isFootwearProduct = (p) => p?.category === "Footwear";

// THE canonical stock-cell encoder, imported rather than reimplemented.
// (CodeRabbit #291.) The local copy this replaces also TRIMMED, which was not
// merely a divergence but the wrong behaviour: /stock cells are keyed by
// stockSizeKey, which does not trim, so a size stored as " 8" lives in the cell
// "_8" while the trimming copy computed "8" and would have read straight past it
// — both for the Central availability lookup and for the reservation map. One
// encoder, and it must be the one the cells were written with.
export const sizeKeyOf = stockSizeKey;

// Numeric-aware size ordering — the clothing SIZE_ORDER table is letters only and
// ranks every shoe size equal (99), which would render sizes in arbitrary order.
export function footwearSizeRank(s) {
  const n = Number.parseFloat(String(s).replace("_", "."));
  return Number.isFinite(n) ? n : 999;
}

const cellsOf = (allStock, loc, pid) => {
  const node = allStock?.[loc]?.[pid];
  if (!node) return [];
  return Object.entries(node).filter(([k]) => k !== "_meta");
};
const unitsAt = (allStock, loc, pid) =>
  cellsOf(allStock, loc, pid).reduce((t, [, c]) => t + Math.max(Number(c?.qty) || 0, 0), 0);
// Carriage = the stock NODE exists at all, regardless of quantity. Zero cells
// persist forever (applyMovement never deletes them), so this is what tells the
// engine "this location stocks this line" — the same gate as storeCarries().
const carries = (allStock, loc, pid) => cellsOf(allStock, loc, pid).length > 0;

/**
 * Missing-sneaker cards, newest logic in one place so the Health stat card and
 * the drill-in list are computed from the SAME source and can never disagree.
 * (The clothing card does disagree with its own list: its count comes from the
 * scan's unit-based exception buckets while its list is carriage-based, so a
 * solved row leaves the list while the headline keeps counting it.)
 *
 * @param hubs downstream locations that hold sneaker buffer, in display order.
 * @returns cards sorted by stranded units, largest first.
 */
// Normalised name, for spotting duplicate catalogue records of one physical shoe.
const nameKey = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

export function computeMissingFootwear({ allStock, products = [], hubs = ["hub1", "hub2"] }) {
  const byId = products instanceof Map ? products : new Map((products || []).map((p) => [p.id, p]));
  // ── SAME-NAME INDEX ────────────────────────────────────────────────────────
  // NOT a duplicate detector. Owner, 2026-07-30: "the name might be the same but
  // the photo is different" — same-named records are frequently DIFFERENT shoes,
  // so this flags the coincidence for a human to judge and never asserts more.
  // Measured 2026-07-30: 55 footwear names span 125 records, and 40 of those have
  // stock split across more than one record — the same physical shoe entered twice.
  // Where they ARE one shoe entered twice, the row is misleading: record A looks
  // missing from both hubs while record B holds the hub stock. 12 of 122 live rows
  // have a same-named sibling with hub stock (10%), including the largest (Lacoste
  // Marice Slip-On Navy, 81 units, sibling holds 8 at hub1).
  //
  // Rows are BADGED, never filtered — under that record the Central stock really is
  // stranded, and the records may legitimately be two different shoes. The badge
  // says only what is observed ("same name elsewhere") and leaves the call to the
  // person looking at the two photos.
  const idsByName = new Map();
  for (const [pid, p] of byId) {
    if (!isFootwearProduct(p)) continue;
    const k = nameKey(p?.name);
    if (!idsByName.has(k)) idsByName.set(k, []);
    idsByName.get(k).push(pid);
  }
  const twinWithHubStock = (pid, name) =>
    (idsByName.get(nameKey(name)) || []).find((o) => o !== pid && hubs.some((h) => unitsAt(allStock, h, o))) || null;

  const out = [];
  for (const pid of Object.keys(allStock?.central || {})) {
    if (pid === "_meta") continue;
    const p = byId.get(pid);
    if (!isFootwearProduct(p)) continue;
    const centralUnits = unitsAt(allStock, "central", pid);
    if (centralUnits <= 0) continue;
    // Missing = no UNITS at any hub that holds buffer.
    if (hubs.some((h) => unitsAt(allStock, h, pid) > 0)) continue;

    const sizes = cellsOf(allStock, "central", pid)
      .map(([sizeKey, c]) => ({ sizeKey, size: String(sizeKey).replace(/(\d)_(\d)/, "$1.$2"), avail: Math.max(Number(c?.qty) || 0, 0) }))
      .filter((s) => s.avail > 0)
      .sort((a, b) => footwearSizeRank(a.size) - footwearSizeRank(b.size));
    if (!sizes.length) continue;

    // NEVER INTRODUCED vs SOLD OUT drives which actions are offered. Seeding a
    // hub that already has cells is a no-op (seed-if-absent skips them), so a
    // Solve button on a sold-out row would report success having done nothing.
    const carried = hubs.filter((h) => carries(allStock, h, pid));
    out.push({
      pid,
      name: p?.name || pid,
      photo: p?.photoUrl,
      centralUnits,
      sizes,
      kind: carried.length ? "sold_out" : "never_introduced",
      carriedAt: carried,
      missingFrom: hubs.filter((h) => !carries(allStock, h, pid)),
      // Non-null → a same-named record already holds hub stock; likely one shoe
      // entered twice. Surface it, never silently drop the row.
      duplicateOf: twinWithHubStock(pid, p?.name),
    });
  }
  return out.sort((a, b) => b.centralUnits - a.centralUnits);
}

// Sizes it is meaningful to seed at `hub`: the location has a positive footwear
// standard for them AND no cell exists yet. Without a standard the engine would
// never refill the seeded cell, so offering it would be a false success — the
// same trap the clothing Solve guards with qualifyingSizes(). When
// footwearRunByLocation is absent (footwear targeting not configured yet) this
// is empty by construction and the caller must disable Solve.
export function seedableSizes({ allStock, pid, catalogSizes = [], hub, footwearRun }) {
  const run = footwearRun?.[hub] || {};
  const existing = new Set(Object.keys(allStock?.[hub]?.[pid] || {}));
  return catalogSizes
    .map(String)
    .filter((s) => Number(run[sizeKeyOf(s)]) > 0)
    .filter((s) => !existing.has(sizeKeyOf(s)))
    .sort((a, b) => footwearSizeRank(a) - footwearSizeRank(b));
}

// ─── SOLVE PLAN — policy quantity, capped by what Central actually has ────────
// Owner spec 2026-07-30: "the system knows the size policy for that location...
// let's say the policy is two per size and Central only has one piece of size 8 —
// everything will be 2, size 8 will be 1 because there is no stock."
//
// So each size is min(policy, availableAtCentral), and a size Central cannot
// supply at all is dropped rather than requested at zero. Sizes the product does
// not come in never appear, and a size with no policy entry is skipped — the
// standard is what defines "how many should be there", and inventing one here
// would replenish a size nobody approved.
//
// DEDUPE is part of the plan, not the caller's job: a hub's queue groups open
// requests by product, so raising a second request for a size that is already
// open would show the same size twice on one card and let it be picked twice.
//
// RESERVATION IS NETWORK-WIDE, dedupe is per-hub — they are different questions.
// `openSizes` is "already queued AT THIS HUB" and stops a duplicate line on one
// card. `reserved` is "already promised to ANY hub" and stops two hubs claiming
// the same Central units: Central holds 3 of size 8, Hub 1 solves for 2, then Hub
// 2 solves for 2 — without this, 4 units are committed against 3 and whoever
// picks second comes up short. Availability is therefore Central's count MINUS
// everything already owed. (CodeRabbit #291.)
//
// Returns [{ size, qty, want, avail }] in numeric size order — `want` and `avail`
// are kept so the UI can explain a short line ("2 wanted, 1 at Central") instead
// of silently asking for less than policy.
export function footwearSolvePlan({ catalogSizes = [], policy = {}, centralCells = {}, openSizes = [], reserved = {} }) {
  const alreadyOpen = new Set((openSizes || []).map((s) => sizeKeyOf(s)));
  return (catalogSizes || [])
    .map(String)
    .filter((s) => s && s !== "_")
    .map((size) => {
      const key = sizeKeyOf(size);
      const want = Number(policy[key]) || 0;
      const onHand = Math.max(Number(centralCells?.[key]?.qty) || 0, 0);
      const owed = Math.max(Number(reserved?.[key]) || 0, 0);
      const avail = Math.max(onHand - owed, 0);   // free stock, not shelf stock
      return { size, key, want, avail, qty: Math.min(want, avail) };
    })
    .filter((l) => l.want > 0 && l.qty > 0 && !alreadyOpen.has(l.key))
    .sort((a, b) => footwearSizeRank(a.size) - footwearSizeRank(b.size))
    .map(({ size, qty, want, avail }) => ({ size, qty, want, avail }));
}

// ─── REQUEST COVERAGE — is this shoe still "missing"? ─────────────────────────
// Owner rule 2026-07-31: once the sizes have been requested, the shoe is no
// longer missing — it is about to be sent — so its card leaves the list.
//
// COVERAGE IS ALL-OR-NOTHING ON PURPOSE. Clearing the card on the FIRST request
// would strand the rest: someone raising size 6 by hand would make sizes 7-11
// disappear with no way back to them, and the list is the only route to those
// sizes. So the card goes only when every size Central can supply is spoken for;
// a partial request keeps the card and reports which sizes are already raised.
// Solve raises the whole policy run at once, so in the normal flow this clears
// the card immediately, which is the behaviour that was asked for.
//
// `sizes` is the card's supplyable sizes (Central has stock); `openSizes` is
// every size with an OPEN request at any hub. Both go through sizeKeyOf so 5.5
// and " 8" compare on the same key the /stock cell uses.
export function footwearRequestCoverage({ sizes = [], openSizes = [] }) {
  const open = new Set((openSizes || []).map((s) => sizeKeyOf(s)));
  const list = (sizes || []).map(String).filter((s) => s && s !== "_");
  const requested = list.filter((s) => open.has(sizeKeyOf(s)));
  return { requested, covered: list.length > 0 && requested.length === list.length };
}

// ─── PICK PLAN — the operator typed the sizes and quantities themselves ───────
// Owner decision 2026-07-31: the "Move" button must RAISE A REQUEST like Solve
// does, not transfer stock. Moving was the wrong default — it shifted inventory
// silently and had to be reversed twice by hand on the day it shipped.
//
// Same guard rails as footwearSolvePlan, different source of the number: Solve
// asks for the POLICY quantity, this asks for what a human chose. Everything
// below is deliberately identical to Solve so the two paths cannot disagree
// about what Central can supply:
//   • FREE stock, not shelf stock — `reserved` (already promised to ANY hub) is
//     subtracted first, so two hubs cannot both claim the same Central units.
//   • a size already open AT THIS HUB is dropped, never duplicated, because the
//     refill queue groups by product and would show it twice.
//   • a short ask is CAPPED, not refused. The operator gets what exists and the
//     shortfall is reported; refusing the whole line would make them re-enter it.
//
// `asked` is carried through so the UI can say "2 of 3 — Central has 2" rather
// than silently raising less than the operator typed.
export function footwearPickPlan({ picks = [], centralCells = {}, openSizes = [], reserved = {} }) {
  const alreadyOpen = new Set((openSizes || []).map((s) => sizeKeyOf(s)));
  return (picks || [])
    .map((p) => ({ size: String(p?.size ?? ""), asked: Math.floor(Number(p?.qty) || 0) }))
    .filter((p) => p.size && p.size !== "_" && p.asked > 0)
    .map((p) => {
      const key = sizeKeyOf(p.size);
      const onHand = Math.max(Number(centralCells?.[key]?.qty) || 0, 0);
      const owed = Math.max(Number(reserved?.[key]) || 0, 0);
      const avail = Math.max(onHand - owed, 0);
      return { ...p, key, avail, qty: Math.min(p.asked, avail) };
    })
    .filter((l) => l.qty > 0 && !alreadyOpen.has(l.key))
    .sort((a, b) => footwearSizeRank(a.size) - footwearSizeRank(b.size))
    .map(({ size, qty, asked, avail }) => ({ size, qty, asked, avail }));
}
