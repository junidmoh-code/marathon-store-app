// ─── MISSING PRODUCTS — SOLVE PLAN (pure, testable) ───────────────────────────
// The decision logic behind the "Solve" action: which locations to seed as
// "carried", and the confirm-estimate arithmetic. Pulled out of NetworkTransfer
// so the load-bearing rule — a CENTRAL-stranded product must seed Hub 2 AND the
// store, or the engine's first leg (central→hub2) never fires — is unit-pinned.
//
// Solve writes only qty-0 carriage cells (seed-if-absent); it raises no requests.
// The engine's standard policy (defaultRunByStore) + cascade does the refilling,
// so these numbers are an ESTIMATE of what the engine will then want, not a
// command.
//
// ── SUBCATEGORY POLICY (2026-08-03) ──────────────────────────────────────────
// The engine gained a second source of standards — subcategoryRunByLocation,
// "keep N of every product in this subcategory" (see refill-engine.cjs). This
// file must mirror it, because the Solve button's enabled/disabled state IS the
// question "will the engine refill what I am about to seed?". Left un-mirrored,
// every watch would stay greyed out with a live policy sitting behind it.
// effectiveStandard() folds the two sources into the ONE run map the rest of
// this file already speaks, so qualifyingSizes/solvePlan need no new arguments
// and keep their existing meaning.
//
// ONE MIRROR GAP IS LOAD-BEARING AND LIVES ELSEWHERE: the engine nests its
// subcategory branch inside isClothing(product), and nothing in this file checks
// productType. That composes correctly only because NetworkTransfer's `cards`
// list applies its own isClothing filter before any row can reach Solve — so a
// non-clothing product can never be offered here in the first place. Any FUTURE
// entry point into Solve (a "solve from search", say) must apply that same
// filter, or it will offer to seed products the engine will not manage.
// (Senior-architect review, PR #305.)

import { encodeSizeKey } from "../../utils/sizeKey";

// Is the engine's rule-based targeting on at this destination? A BYTE-FOR-BYTE
// mirror of ruleTargetsEnabled() in refill-engine.cjs, including its fail-safe:
// true = everywhere, an object = per-destination with absent meaning off, and
// anything else — false, missing, garbage, or a config node that could not be
// read — meaning OFF.
//
// Solve MUST consult this. Seeding is only ever justified by "the engine will
// then refill it", and with the kill switch off the engine refills nothing by
// rule, so every seeded cell would sit at qty 0 forever while its row vanished
// from Missing Products looking handled. That hole predates the subcategory
// policy — it applied to ordinary clothing too — and is closed here because the
// policy makes one-size products depend on the same guarantee.
export function ruleTargetsEnabledFor(ruleBasedTargets, dest) {
  if (ruleBasedTargets === true) return true;
  if (ruleBasedTargets && typeof ruleBasedTargets === "object" && !Array.isArray(ruleBasedTargets)) {
    return ruleBasedTargets[dest] === true;
  }
  return false;
}

// Which locations get a qty-0 carriage seed. Central-stranded needs BOTH Hub 2
// (so the engine raises central→hub2) and the nominated store (so it raises
// hub2→store once Hub 2 receives). Hub2-stranded needs the store only.
export function seedLocations(source, store) {
  return source === "central" ? ["hub2", store] : [store];
}

// Fold the two standard sources into one { loc: { SIZE: target } } map for ONE
// product. Where the product's subcategory has a policy at a location, that
// policy replaces the size run for this product at that location — mirroring
// resolveTarget's "more specific wins" ordering exactly. Everywhere else the
// size run is returned untouched, so a product with no subcategory policy (all
// clothing today) is byte-for-byte unaffected.
//
// The policy value is applied to EVERY catalog size, which is what makes a
// one-size product solvable at all: its only size is the "_" sentinel, which by
// definition has no entry in a garment-letter run.
export function effectiveStandard({ std, subRun, subcategory, sizes }) {
  const locs = new Set([...Object.keys(std || {}), ...Object.keys(subRun || {})]);
  // Non-empty STRING, matching the engine's subcategoryRun() exactly. A truthy
  // check would accept a numeric subcategory (say 7) that the engine refuses,
  // and the mirror has to be exact in BOTH directions or Solve lies.
  const sub = typeof subcategory === "string" && subcategory ? subcategory : null;
  const out = {};
  for (const loc of locs) {
    // `typeof t === "number"`, NOT Number(t): this must accept EXACTLY what the
    // engine's subcategoryRun() accepts. A coercing check would take a stringy
    // "2" from config, light the Solve button up, seed the cells — and then the
    // engine would reject the same value and never refill them. That is the
    // false-solve this whole module exists to prevent, so the two validations
    // have to be byte-for-byte the same rule.
    const run = (subRun || {})[loc];
    const t = sub && run && typeof run === "object" && !Array.isArray(run) ? run[sub] : undefined;
    out[loc] = typeof t === "number" && Number.isFinite(t) && t > 0
      ? Object.fromEntries((sizes || []).map((sz) => [String(sz).toUpperCase(), t]))
      : ((std || {})[loc] || {});
  }
  return out;
}

// ── EXPLICIT /stock_targets ROWS — the engine's PRIORITY-1 SOURCE ────────────
// resolveTarget's very first branch is an explicit row, and it is the branch
// this file did not have. Everything below it (footwear, the kill switch, the
// subcategory policy, the size run) is only reached when NO explicit row exists.
// Two consequences, both of which Solve got wrong by omission:
//
//   1. An explicit row OUTRANKS the size run, so a size the run says nothing
//      about is still refilled when a human wrote a row for it. That is the ONLY
//      path a ONE-SIZE product can ever have a target on: its single size is the
//      "_" sentinel, and adding "_" to defaultRunByStore was explicitly REJECTED
//      by the owner (refill-engine.cjs: "_" is shared by every one-size product,
//      so it would silently arm sunglasses, belts and jewellery alongside the
//      intended class). With explicit rows invisible here, one-size products were
//      structurally locked out of Solve — no reachable policy could ever enable
//      them, whatever an operator configured. Beanies are that class.
//
//   2. An explicit row SURVIVES the kill switch, because resolveTarget returns
//      it BEFORE `if (!ruleTargetsEnabled(...)) return null`. Switching rule-based
//      targets off reverts the engine to explicit-rows-only — it does not stop
//      the engine refilling them — so Solve must not grey those rows out either.
//
// EXPLICIT TARGET 0 IS "DELIBERATELY EXCLUDED" AND STILL WINS. The engine takes
// the row and stops; it does NOT fall through to the size run. So a 0 must be
// overlaid as 0 (which fails the `> 0` qualifying test), never dropped — dropping
// it would let the run re-enable a size a human deliberately switched off.
//
// encodeSizeKey ON THE LOOKUP IS LOAD-BEARING. /stock_targets is keyed by the
// ENCODED size (useStock.js:145, and resolveTarget encodes on the way in), while
// the sizes flowing through this file are RAW catalogue sizes. Letters encode to
// themselves and "_" is already "_", so the two agree today — but a half size
// would not: a raw "5.5" would look for a key that cannot exist (RTDB rejects "."
// in a key) and read as "no row". That is the ENCODED-vs-DECODED class that
// silently zeroed the sneaker Solve's sizes; it is written correctly here at the
// first opportunity rather than waiting to be found again.
export function explicitTarget(targets, loc, pid, size) {
  const row = targets?.[loc]?.[pid]?.[encodeSizeKey(size)];
  return row && typeof row.target === "number" && Number.isFinite(row.target) ? row.target : null;
}

// The run map Solve should actually decide on: effectiveStandard (subcategory
// policy over the size run) with the kill switch applied per location and the
// explicit rows overlaid on top — resolveTarget's whole priority order, folded
// into the ONE { loc: { SIZE: target } } shape qualifyingSizes/solvePlan already
// speak, so neither needs a new argument or a new meaning.
//
// Order inside a location is exactly the engine's: rule/subcategory standards
// FIRST (and only where the kill switch is on), explicit rows LAST so they win.
export function resolvedRun({ std, subRun, subcategory, sizes, targets, pid, ruleBasedTargets }) {
  const base = effectiveStandard({ std, subRun, subcategory, sizes });
  // A location can be reachable through an explicit row alone — it need not
  // appear in defaultRunByStore at all — so the location set is the union.
  const locs = new Set([
    ...Object.keys(base),
    ...Object.keys(targets || {}).filter((loc) => targets?.[loc]?.[pid]),
  ]);
  const out = {};
  for (const loc of locs) {
    // Rule-based and subcategory standards die with the kill switch. Explicit
    // rows below do not — that asymmetry IS resolveTarget's branch order.
    const run = ruleTargetsEnabledFor(ruleBasedTargets, loc) ? { ...(base[loc] || {}) } : {};
    for (const sz of sizes || []) {
      const t = explicitTarget(targets, loc, pid, sz);
      if (t !== null) run[String(sz).toUpperCase()] = t;   // incl. 0 = excluded
    }
    out[loc] = run;
  }
  return out;
}

// Sum a location's size-standard over a product's catalog sizes.
export function standardUnits(run, sizes) {
  return (sizes || []).reduce((t, sz) => t + (Number((run || {})[String(sz).toUpperCase()]) || 0), 0);
}

// The sizes it's safe to seed: those with a POSITIVE standard at EVERY location the
// seed touches (store for hub2-stranded; Hub 2 AND store for central-stranded). A
// size with no standard would seed a cell the engine never refills, then vanish
// from the list with a false "solved" — so it's excluded. If this returns empty,
// the product is not solvable and Solve must be disabled.
export function qualifyingSizes(sizes, source, store, std) {
  const locs = seedLocations(source, store);
  return (sizes || []).filter((sz) =>
    locs.every((loc) => Number((std?.[loc] || {})[String(sz).toUpperCase()]) > 0));
}

// The confirm estimate for one product/store.
//   std      — { loc: { SIZE: target } } (defaultRunByStore)
//   sizes    — catalog sizes to seed
//   source   — "central" | "hub2"
//   store    — nominated store id
//   availAt(loc, size) — live on-hand at a location for a size (for coverage)
export function solvePlan({ std, sizes, source, store, availAt }) {
  const storeRun = (std && std[store]) || {};
  const storeUnits = standardUnits(storeRun, sizes);
  const at = typeof availAt === "function" ? availAt : () => 0;
  if (source === "hub2") {
    // Store is fed directly from Hub 2 — coverage checked against Hub 2.
    const cover = (sizes || []).reduce(
      (t, sz) => t + Math.min(Number(storeRun[String(sz).toUpperCase()]) || 0, at("hub2", sz)), 0);
    return { sizes, storeUnits, twoLeg: false, cover, coverLoc: "Hub 2" };
  }
  // Central-stranded: the Hub 2 buffer leg pulls from Central.
  const hubRun = (std && std.hub2) || {};
  const hubUnits = standardUnits(hubRun, sizes);
  const cover = (sizes || []).reduce(
    (t, sz) => t + Math.min(Number(hubRun[String(sz).toUpperCase()]) || 0, at("central", sz)), 0);
  return { sizes, storeUnits, twoLeg: true, hubUnits, cover, coverLoc: "Central" };
}
