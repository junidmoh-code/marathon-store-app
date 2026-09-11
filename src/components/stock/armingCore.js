// ─── ARMING — WHERE THE ENGINE THINKS A PRODUCT LIVES ─────────────────────────
//
// The Seating tab answers "where does THIS product sit" for one product at a
// time. This module answers the mirror-image question for the two hubs at once:
// WHICH PRODUCTS does the engine hold Hub 1 responsible for, which does it hold
// Hub 2 responsible for, and where do those two answers overlap when they must
// not.
//
// ── WHY BOTH HUBS AT ONCE IS THE WHOLE POINT ─────────────────────────────────
// Slides are deliberately SPLIT across the hubs (SLIDES-SEATING-INCIDENT.md,
// PR #599): a line lives at one hub or the other, never both. Arming a category
// arms a LEG PER LOCATION, so one careless leg spreads every product in the
// category to both hubs at once and the engine then asks both to hold it. That
// defect is invisible one product at a time — the Seating tab shows a perfectly
// ordinary green row at each hub — and obvious the moment the two answers are
// put side by side. Section A is that comparison.
//
// ── IT RE-DERIVES NOTHING ────────────────────────────────────────────────────
// Every armed answer comes from seatingCore's seatingAt(), which is the
// differentially-fuzzed mirror of the engine's resolveTarget. This file adds
// three things seatingAt does not do, and nothing else:
//
//   1. THE DEACTIVATION GUARD. refill-engine.cjs:498 opens resolveTarget with
//      `if (isDeactivated(products?.[pid])) return null;` — ABOVE the explicit
//      row branch, so neither a stale target row nor a category policy can
//      re-arm a finished line. seatingCore's mirror does NOT carry that guard
//      (checked 2026-09-11; the differential fuzz never generates a deactivated
//      product, so it cannot see the drift). 128 live products carry the flag.
//      Applying it HERE rather than patching the mirror is deliberate: the
//      mirror also feeds ExcessHubToCentral, where flipping every deactivated
//      product's target to null would turn its every unit into "excess" on a
//      screen this change was not asked to touch. The drift is real and is
//      reported for its own PR; this tab must not be wrong in the meantime.
//
//   2. THE POLICY-WITHOUT-ROWS PASS. Section C needs "the category policy WOULD
//      arm this, and a target:0 row kills it" — which is seatingAt run twice,
//      once with the explicit rows and once with them stripped.
//
//   3. THE UNDECIDED FLAG. See below. It is the honest name for the one thing
//      a hub-scoped read genuinely cannot settle.
//
// ── THE ONE THING TWO LOCATION-SCOPED READS CANNOT SETTLE ────────────────────
// The engine's per-size category branch (refill-engine.cjs:416) suppresses a
// size that holds no units ANYWHERE:
//
//     shape(sizeUnitsAnywhere(stock, pid, size) > 0 ? row.target : 0, …)
//
// sizeUnitsAnywhere walks EVERY location. A tab that reads only /stock/hub1 and
// /stock/hub2 therefore knows a size is alive when either hub holds units, and
// cannot tell "dead everywhere" from "alive at Central" when neither does. The
// error is ONE-DIRECTIONAL — hub-scoped units can only UNDER-count, so an armed
// answer is always right and an unarmed one may be too pessimistic. That holds
// for the WHOLE of resolveTarget, not merely for the branch above:
// sizeUnitsAnywhere is the only place ANY branch consults stock outside `dest`,
// and it appears only in the per-size and perSize category branches. Every other
// carriage test — the explicit row, carriedOnly, the footwear rule, the clothing
// size run — asks storeCarries(stock, dest, …), which is exact here because
// `dest` is one of the two hubs this tab reads in full.
//
// Measured live 2026-09-11 through this module over the whole catalogue: 185
// (product, hub) pairs out of 9,520 are undecided — 184 distinct products — and
// bucket A, armed at BOTH hubs and the defect this tab exists for, comes out at
// 34 either way. So the cheap read answers
// the question the tab was built to answer, exactly, and the residue is named
// on screen and resolvable on demand through the Seating tab's own per-(loc,
// pid) reads rather than guessed at or silently swallowed.
//
// `undecided` is computed by asking seatingAt the same question twice: once
// with the stock we actually hold, and once with a PHANTOM location granting
// one unit of every declared size. If the two answers differ, the dead-size
// rule is what is deciding, and we do not hold the stock to decide it.

import { seatingAt, categoryPolicyEntry, engineSizeKey } from "./seatingCore";
import { isDeactivated } from "../../utils/deactivation";

// The two hubs this tab compares. Hub 3 is deliberately absent: it carries no
// armed policy leg and is excluded from ONLINE availability (PR #583); adding
// it would widen the screen without widening the question.
export const HUB1 = "hub1";
export const HUB2 = "hub2";
export const ARMING_HUBS = [HUB1, HUB2];

// ── FOUR PLACES A PRODUCT CAN BE, AND EVERY PRODUCT IS IN EXACTLY ONE ────────
// Hub 1 · Hub 2 · Both · Nowhere. Exclusive and exhaustive, because that is what
// makes them TABS rather than filters: four counts that add up to the
// catalogue, and no product that is in two lists or in none. "Both" is the
// defect — slides are split across the hubs on purpose and arming must never
// spread a line to both.
//
// WHY "NOWHERE" IS A TAB AND NOT AN ABSENCE. It is where a quiet product is
// diagnosed: switched off by hand, deactivated, or simply never armed. The
// first build dropped those 960 products from the screen entirely, and there
// was no way to reach one except by already knowing the answer.
export const BUCKET = {
  BOTH_HUBS: "both_hubs",
  HUB1_ONLY: "hub1_only",
  HUB2_ONLY: "hub2_only",
  NOWHERE: "nowhere",
};

// Defect first. The two inventories next, the quiet pile last.
export const BUCKET_ORDER = [
  BUCKET.BOTH_HUBS, BUCKET.HUB1_ONLY, BUCKET.HUB2_ONLY, BUCKET.NOWHERE,
];

export const BUCKET_TITLE = {
  [BUCKET.BOTH_HUBS]: "Both hubs",
  [BUCKET.HUB1_ONLY]: "Hub 1",
  [BUCKET.HUB2_ONLY]: "Hub 2",
  [BUCKET.NOWHERE]: "Nowhere",
};

// ── AND THE FACTS THAT ARE NOT A PLACE ──────────────────────────────────────
// "Armed but not seated" and "armed then switched off" were sections of their
// own in the first build. They are not places — they are things true of a
// product that is already in one of the four — so they are flags on the row
// instead. Nothing is lost: same products, same counts, one navigation instead
// of five overlapping lists.
export const FLAG = {
  NOT_SEATED: "not_seated",
  SUPPRESSED: "suppressed",
  DEACTIVATED: "deactivated",
  UNDECIDED: "undecided",
};

export const FLAG_LABEL = {
  [FLAG.NOT_SEATED]: "Not seated",
  [FLAG.SUPPRESSED]: "Switched off",
  [FLAG.DEACTIVATED]: "Deactivated",
  [FLAG.UNDECIDED]: "Checking",
};


// ── THE PHANTOM ──────────────────────────────────────────────────────────────
// One unit of every size this product declares, at a location id that cannot
// collide with a real one. Used ONLY to ask "would the dead-size rule change
// this answer" — it is never rendered, never counted and never written.
//
// "_" is added unconditionally: a one-size category policy speaks for the
// no-size cell (seatingSizes' `out.add("_")` branch), and a product declaring
// no sizes at all would otherwise get an empty phantom and read as decided.
const PHANTOM_LOC = "__arming_phantom__";

function phantomStock(products, pid) {
  const cells = { _: { qty: 1 } };
  for (const s of products?.[pid]?.sizes || []) cells[engineSizeKey(s)] = { qty: 1 };
  return { [PHANTOM_LOC]: { [pid]: cells } };
}

// ── ONE HUB, ONE PRODUCT ─────────────────────────────────────────────────────
//
//   { hub, pid, armed, hasCell, reason, label, units, sizes, rows,
//     deactivated, undecided, policyWouldArm, offRows }
//
// `armed`  the engine will ask this hub to hold this product — a positive
//          effective target on at least one size. seatingAt's own `seated`,
//          with the engine's deactivation guard applied over it.
// `hasCell` this hub holds a stock cell for it — storeCarries, the Seating
//          tab's own SEATED-in-fact. Armed without a cell is section B.
export function hubArming(ctx, hub, pid) {
  const product = ctx?.products?.[pid];
  const dead = isDeactivated(product);
  const seat = seatingAt(ctx, hub, pid);

  // Every size the engine resolves a target for here, positive or explicitly
  // zeroed. A size nothing arms is left OUT — absent, not zero. A zero that is
  // a decision (an explicit row) is a different fact from a zero that is the
  // absence of one, and collapsing them is how a switched-off hub reads as an
  // ordinary quiet one.
  const sizes = seat.sizes
    .filter((s) => s.target !== null)
    .map((s) => ({ sizeKey: s.sizeKey, size: s.size, qty: s.qty, target: s.target, source: s.source }));

  const armed = !dead && seat.seated;
  const zeroRows = seat.sizes.filter((s) => s.source === "explicit" && s.target === 0).map((s) => s.sizeKey);

  // Would the category policy arm this hub with every explicit row removed?
  // Section C is the difference between that and `armed`.
  //
  // COMPUTED ONLY WHERE IT CAN CHANGE AN ANSWER. It is a second full target
  // resolution over every size, and the only consumers are suppressed() — which
  // requires an unarmed hub carrying a target:0 row — and the deactivated
  // counter. Running it unconditionally doubled the work of opening the tab
  // (9,520 extra passes) to answer a question 99% of rows never ask.
  // MEANINGFUL ONLY WHEN THE HUB IS UNARMED OR THE PRODUCT IS DEACTIVATED.
  // Everywhere else it is short-circuited to `armed`, which is the same answer
  // for every row that is armed by a policy and a cheap lie for the rare row
  // armed only by a hand-written target. Both consumers guard on !armed or on
  // deactivated, so the lie is unreachable — and it is named here rather than
  // left for the next reader to discover.
  const wouldAsk = dead || (!armed && zeroRows.length > 0);
  const policyWouldArm = wouldAsk ? !!seatingAt({ ...ctx, targets: {} }, hub, pid).seated : armed;

  return {
    hub, pid,
    armed,
    hasCell: seat.hasCell,
    reason: seat.reason,
    label: seat.label,
    units: seat.units,
    sizes,
    rowCount: seat.rowCount,
    offRows: seat.offRows,
    deactivated: dead,
    policyWouldArm,
    // An explicit row a human (or this card's Switch off) wrote at target 0.
    zeroRows,
    // RELATIVE TO WHAT WE HOLD. A product whose stock has been read from every
    // location is decided, full stop — see resolvedPids below.
    undecided: !dead && !seat.seated && !ctx.resolvedPids?.has(pid) && undecidedHere(ctx, hub, pid),
  };
}

// Is the dead-size rule what is answering "no" here, with stock we do not hold?
//
// "THAT WE DO NOT HOLD" IS HALF THE PREDICATE. The phantom asks "would units
// somewhere change this answer", and the answer is yes for a genuinely dead
// size too — so on its own the flag never clears, not even once every location
// has been read. ctx.resolvedPids is the other half: the set of products whose
// stock the caller has gathered from EVERY location (readArmingContext leaves
// it empty; resolveUndecided fills it). A product in that set is decided by
// definition, because there is no further stock to find.
//
// Gated on there BEING a per-size category entry at this hub, because that is
// the only branch of resolveTarget that consults sizeUnitsAnywhere: the uniform
// ("_") branch does not, the clothing size run does not, and the footwear rule
// does not. Without the gate this would run a second full seatingAt for every
// unarmed product at every hub — ~9,000 wasted passes on tab open.
function undecidedHere(ctx, hub, pid) {
  const entry = categoryPolicyEntry(ctx.config, ctx.products, ctx.stock, pid, hub);
  if (!entry || (!entry.sizes && !entry.perSize)) return false;
  const lifted = { ...ctx, stock: { ...ctx.stock, ...phantomStock(ctx.products, pid) } };
  return seatingAt(lifted, hub, pid).seated;
}

// ── THE BUCKET ───────────────────────────────────────────────────────────────
// Pure: two hub answers in, ONE bucket out. Exclusive and exhaustive, so the
// four counts add up to the catalogue and no product can be missing from every
// tab.
export function bucketFor(h1, h2) {
  if (h1.armed && h2.armed) return BUCKET.BOTH_HUBS;
  if (h1.armed) return BUCKET.HUB1_ONLY;
  if (h2.armed) return BUCKET.HUB2_ONLY;
  return BUCKET.NOWHERE;
}

// The facts that are not a place, in the order they are shown on the row.
export function flagsFor(h1, h2) {
  const out = [];
  // Armed where nothing is on the shelf — the engine will move stock into a hub
  // that does not carry the line.
  if ((h1.armed && !h1.hasCell) || (h2.armed && !h2.hasCell)) out.push(FLAG.NOT_SEATED);
  // A policy or rule would arm it and an explicit target:0 row kills it.
  //
  // ANY EXPLICIT ZERO, not only the rows this card's Switch off wrote. The off
  // switch IS the row — `source: "seating_off"` is a stamp saying who wrote it,
  // not what makes it work — and a hand-written zero suppresses the policy just
  // as completely. Keying on the stamp would hide every suppression the
  // Decision Queue's Exclude button made (NoTargetQueue.jsx:325 writes the same
  // row with no such stamp), which is most of them.
  if (suppressed(h1) || suppressed(h2)) out.push(FLAG.SUPPRESSED);
  // A finished line. The engine refuses it above every other branch, so it is
  // armed nowhere by definition — and worth SEEING in Nowhere rather than
  // silently dropped, because "why is this quiet" is the question that tab
  // exists to answer.
  if (h1.deactivated || h2.deactivated) out.push(FLAG.DEACTIVATED);
  if (h1.undecided || h2.undecided) out.push(FLAG.UNDECIDED);
  return out;
}

export function suppressed(h) {
  return !h.armed && !h.deactivated && h.policyWouldArm && h.zeroRows.length > 0;
}

// ── THE INDEX ────────────────────────────────────────────────────────────────
// One pass over the catalogue. Returns EVERY product, because the four buckets
// are exhaustive: a product neither hub is armed for belongs in Nowhere, which
// is where somebody goes to ask why nothing is being sent. The first build
// dropped those 960 products and there was no way to reach one.
//
// `pids` is passed in rather than taken from ctx.products so a caller can scope
// the pass (a test, or a future filter) without rebuilding the context.
export function armingIndex(ctx, pids) {
  const rows = [];
  const counts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  // Every undecided product, collected in the SAME pass as the count so the two
  // cannot disagree.
  const undecidedPids = [];
  let undecided = 0;
  let deactivatedSkipped = 0;

  for (const pid of pids || []) {
    const p = ctx.products?.[pid];
    if (!p) continue;
    const h1 = hubArming(ctx, HUB1, pid);
    const h2 = hubArming(ctx, HUB2, pid);
    if (h1.undecided) undecided += 1;
    if (h2.undecided) undecided += 1;
    if (h1.undecided || h2.undecided) undecidedPids.push(pid);
    const bucket = bucketFor(h1, h2);
    const flags = flagsFor(h1, h2);
    // A deactivated product that WOULD have been armed is worth counting, so
    // the screen can say how many armed answers the flag is holding back.
    if ((h1.deactivated || h2.deactivated) && (h1.policyWouldArm || h2.policyWouldArm)) deactivatedSkipped += 1;
    counts[bucket] += 1;
    rows.push({
      pid,
      name: p.name || pid,
      category: p.category || "",
      categoryKey: p.categoryKey || "",
      photoUrl: p.photoUrl || "",
      hub1: h1,
      hub2: h2,
      bucket,
      flags,
      // Lower-cased once, here, so the search box filters 4,000 rows on every
      // keystroke without re-lowering 12,000 strings each time.
      haystack: `${p.name || ""} ${p.category || ""} ${p.categoryKey || ""} ${p.brand || ""} ${p.sku || ""}`.toLowerCase(),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  // TWO COUNTS, BECAUSE THEY ARE TWO NUMBERS. `undecided` is (product, hub)
  // PAIRS — a product can be undecided at both hubs — and `undecidedProducts`
  // is how many products a resolve pass would have to read. Showing the pair
  // count beside a progress bar that counts products puts "185 undecided"
  // above "184/184" on the same screen. (CodeRabbit, PR #601.)
  return { rows, counts, undecided, undecidedProducts: undecidedPids.length,
    undecidedPids, deactivatedSkipped };
}

// Rows for one section, filtered by the search box. Separated from armingIndex
// so a keystroke re-filters without re-resolving a single target.
export function sectionRows(rows, bucket, query) {
  const q = String(query || "").trim().toLowerCase();
  const inBucket = (rows || []).filter((r) => r.bucket === bucket);
  if (!q) return inBucket;
  // Every word must match somewhere — the same "all terms" rule the product
  // search uses, so a two-word query narrows instead of widening.
  const terms = q.split(/\s+/).filter(Boolean);
  return inBucket.filter((r) => terms.every((t) => r.haystack.includes(t)));
}
