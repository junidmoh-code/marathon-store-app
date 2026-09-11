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
// answer is always right and an unarmed one may be too pessimistic.
//
// Measured live 2026-09-11 over the whole catalogue: 199 (product, hub) pairs
// out of 9,520 are undecided, and bucket A — armed at BOTH hubs, the defect
// this tab exists for — comes out at 34 either way. So the cheap read answers
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

// The five sections, in the order they are shown. A product may appear in more
// than one — BOTH_HUBS and NOT_SEATED are different defects and a product can
// have both — which is why this is a list of flags and not one verdict.
export const BUCKET = {
  BOTH_HUBS: "both_hubs",
  NOT_SEATED: "not_seated",
  SUPPRESSED: "suppressed",
  HUB1_ONLY: "hub1_only",
  HUB2_ONLY: "hub2_only",
};

export const BUCKET_ORDER = [
  BUCKET.BOTH_HUBS, BUCKET.NOT_SEATED, BUCKET.SUPPRESSED, BUCKET.HUB1_ONLY, BUCKET.HUB2_ONLY,
];

export const BUCKET_TITLE = {
  [BUCKET.BOTH_HUBS]: "Armed at both hubs",
  [BUCKET.NOT_SEATED]: "Armed but not seated",
  [BUCKET.SUPPRESSED]: "Armed, suppressed by seating",
  [BUCKET.HUB1_ONLY]: "Hub 1 only",
  [BUCKET.HUB2_ONLY]: "Hub 2 only",
};

// A/B/C are defects and open themselves. D/E are the full inventory — over a
// thousand rows each — and stay shut until asked for.
export const BUCKET_OPEN_BY_DEFAULT = {
  [BUCKET.BOTH_HUBS]: true,
  [BUCKET.NOT_SEATED]: true,
  [BUCKET.SUPPRESSED]: true,
  [BUCKET.HUB1_ONLY]: false,
  [BUCKET.HUB2_ONLY]: false,
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

// ── THE BUCKETS ──────────────────────────────────────────────────────────────
// Pure: two hub answers in, a list of section keys out. Nothing reads, nothing
// renders, and the classification can be argued with in a test rather than in
// a screenshot.
export function bucketsFor(h1, h2) {
  const out = [];
  if (h1.armed && h2.armed) out.push(BUCKET.BOTH_HUBS);
  // Armed where nothing is on the shelf — the engine will move stock into a hub
  // that does not carry the line. Reported per hub, because it is a fact about
  // a hub and not about the product.
  if ((h1.armed && !h1.hasCell) || (h2.armed && !h2.hasCell)) out.push(BUCKET.NOT_SEATED);
  // The category policy would arm it and a target:0 row kills it. Its own state,
  // so a quiet hub is diagnosed in one look rather than read as "never armed".
  if (suppressed(h1) || suppressed(h2)) out.push(BUCKET.SUPPRESSED);
  if (h1.armed && !h2.armed) out.push(BUCKET.HUB1_ONLY);
  if (h2.armed && !h1.armed) out.push(BUCKET.HUB2_ONLY);
  return out;
}

export function suppressed(h) {
  return !h.armed && !h.deactivated && h.policyWouldArm && h.zeroRows.length > 0;
}

// ── THE INDEX ────────────────────────────────────────────────────────────────
// One pass over the catalogue. Returns only products that land in at least one
// section — a product neither hub is armed for is not an arming fact and does
// not belong on an arming screen.
//
// `pids` is passed in rather than taken from ctx.products so a caller can scope
// the pass (a test, or a future filter) without rebuilding the context.
export function armingIndex(ctx, pids) {
  const rows = [];
  const counts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  let undecided = 0;
  let deactivatedSkipped = 0;

  for (const pid of pids || []) {
    const p = ctx.products?.[pid];
    if (!p) continue;
    const h1 = hubArming(ctx, HUB1, pid);
    const h2 = hubArming(ctx, HUB2, pid);
    if (h1.undecided) undecided += 1;
    if (h2.undecided) undecided += 1;
    const buckets = bucketsFor(h1, h2);
    if (!buckets.length) {
      // A deactivated product that WOULD have been armed is worth counting, so
      // the screen can say how many armed answers the flag is suppressing
      // rather than quietly shrinking.
      if ((h1.deactivated || h2.deactivated) && (h1.policyWouldArm || h2.policyWouldArm)) deactivatedSkipped += 1;
      continue;
    }
    for (const b of buckets) counts[b] += 1;
    rows.push({
      pid,
      name: p.name || pid,
      category: p.category || "",
      categoryKey: p.categoryKey || "",
      photoUrl: p.photoUrl || "",
      hub1: h1,
      hub2: h2,
      buckets,
      // Lower-cased once, here, so the search box filters 4,000 rows on every
      // keystroke without re-lowering 12,000 strings each time.
      haystack: `${p.name || ""} ${p.category || ""} ${p.categoryKey || ""} ${p.brand || ""} ${p.sku || ""}`.toLowerCase(),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, counts, undecided, deactivatedSkipped };
}

// Rows for one section, filtered by the search box. Separated from armingIndex
// so a keystroke re-filters without re-resolving a single target.
export function sectionRows(rows, bucket, query) {
  const q = String(query || "").trim().toLowerCase();
  const inBucket = (rows || []).filter((r) => r.buckets.includes(bucket));
  if (!q) return inBucket;
  // Every word must match somewhere — the same "all terms" rule the product
  // search uses, so a two-word query narrows instead of widening.
  const terms = q.split(/\s+/).filter(Boolean);
  return inBucket.filter((r) => terms.every((t) => r.haystack.includes(t)));
}
