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
// productType. Since 2026-09-17 the Missing Products list admits every
// non-footwear record (perfume, typeless, mis-typed), so the guard is no
// longer the cards list: it is NetworkTransfer's `runFor`, which hands this
// file an EMPTY size run and no subcategory run for a product that is not
// clothing in the engine's sense (`ruleEligible`), leaving only the category
// policy and explicit rows — exactly the branches the engine would apply. Any
// FUTURE entry point into Solve must do the same, or it will offer to seed
// products the engine will not manage. (Senior-architect review, PR #305;
// spec review, PR #608.)

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
// A NON-FINITE target is still an EXPLICIT ROW, and must not fall through.
// The engine's gate is `typeof explicit.target === "number"` and it then passes
// the value through `num()`, which maps anything non-finite to 0 — so to the
// engine a NaN row reads as "explicit, target 0" and WINS over the size run.
// Requiring Number.isFinite here would have returned null instead, letting the
// run re-enable a size the engine had already settled at 0. Mirroring `num()`
// exactly keeps the two in step in both value AND branch. Unreachable today —
// RTDB refuses to store NaN/Infinity, and every write path in the app writes a
// validated numeric literal — but a mirror that is only right on reachable input
// is a mirror waiting to drift. (Sonnet review, PR #342.)
export function explicitTarget(targets, loc, pid, size) {
  const row = targets?.[loc]?.[pid]?.[encodeSizeKey(size)];
  if (!row || typeof row.target !== "number") return null;
  return Number.isFinite(row.target) ? row.target : 0;
}

// ── CATEGORY POLICY — /config/refillEngine/categoryPolicy (2026-08-13) ───────
// The engine's second owner-armed source (resolveTarget's branch right after
// explicit rows): the CATEGORY a product carries is what arms it, with no
// per-product row. This mirror must speak it or every mapped-but-row-less
// product (a freshly imported perfume) would render a greyed Solve over a
// target the engine is actively serving — the exact lie this module exists to
// prevent, in the opposite direction from the usual false-solve.
//
// The validation is BYTE-FOR-BYTE the engine's categoryPolicyEntry /
// categoryPolicyTarget: non-empty string categoryKey, object entry, per-
// location object, positive finite numeric target — anything else arms
// NOTHING (fail-safe, both sides). Two size modes, same meanings:
//   one-size (default)  — speaks for the "_" sentinel ONLY; letters fall
//                         through to the rule standards below it.
//   perSize: true       — speaks for every declared size; a size holding ZERO
//                         units anywhere resolves an explicit 0 (dead size —
//                         the run must not re-arm it), and units arriving
//                         anywhere re-arm it with no config change.
// `unitsAnywhere(size)` is the caller's live network sum for this product —
// NetworkTransfer closes it over the same allStock map everything else reads.
// The locations a category-policy entry validly governs for one categoryKey —
// the SAME validation as categoryRun below (and the engine), answered as a
// membership question. Exists for callers that must not treat a mapped product
// as "unmanaged": the Introduce Existing migration used to see only explicit
// rows, so it would happily stamp generic standard-run rows onto a mapped
// product — rows that then outrank the map FOREVER and quietly break its off
// switch (delete-the-entry no longer restores anything for that product).
// (Sonnet review, PR #352.)
// A per-location SIZE MAP (policy-resolve.cjs locationEntryMode "per-size"):
// `{ sizes: { "<encodedSize>": { target, minQty, reorderPoint } } }` in place
// of one collapsed number, valid only under `perSize: true` and only when at
// least one row carries a positive finite target — byte-for-byte the engine's
// locationPolicyFor. Live for soccer-jerseys and underwear (hub2 + PE).
const posTarget = (t) => typeof t === "number" && Number.isFinite(t) && t > 0;
// An entry carrying BOTH a collapsed `target` and a `sizes` map is a garbled
// node: locationEntryMode calls it "invalid" and the engine arms NOTHING for
// it. Mirror the refusal exactly — treating it as a map would light Solve up
// over cells the engine never refills. (Sonnet delta review, PR #608.)
const isMapEntry = (entry) => !!entry && typeof entry === "object" && !Array.isArray(entry)
  && entry.sizes && typeof entry.sizes === "object" && !Array.isArray(entry.sizes);
const isGarbledEntry = (entry) => isMapEntry(entry) && entry.target !== undefined;
const mapUsable = (cat, entry) => cat.perSize === true
  && Object.values(entry.sizes).some((row) => row && typeof row === "object" && posTarget(row.target));

export function categoryPolicyLocs(policy, categoryKey) {
  if (typeof categoryKey !== "string" || !categoryKey) return [];
  const cat = policy && typeof policy === "object" && !Array.isArray(policy) ? policy[categoryKey] : null;
  if (!cat || typeof cat !== "object" || Array.isArray(cat)) return [];
  return Object.entries(cat)
    .filter(([loc, entry]) => loc !== "perSize" && entry && typeof entry === "object" && !Array.isArray(entry)
      && !isGarbledEntry(entry)
      && (isMapEntry(entry) ? mapUsable(cat, entry) : posTarget(entry.target)))
    .map(([loc]) => loc);
}

export function categoryRun({ policy, categoryKey, sizes, unitsAnywhere }) {
  if (typeof categoryKey !== "string" || !categoryKey) return {};
  const cat = policy && typeof policy === "object" && !Array.isArray(policy) ? policy[categoryKey] : null;
  if (!cat || typeof cat !== "object" || Array.isArray(cat)) return {};
  const at = typeof unitsAnywhere === "function" ? unitsAnywhere : () => 0;
  const out = {};
  for (const [loc, entry] of Object.entries(cat)) {
    if (loc === "perSize") continue;   // the mode flag, not a location
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    // ── PER-LOCATION SIZE MAP (2026-09-17, first batch for every category) ──
    // The engine walks exactly the sizes the map names, intersected with the
    // product's declared sizes; a named size with zero units anywhere is a
    // dead 0 (a stop, never a fall-through); an unnamed size resolves nothing
    // here and falls through to the run. Outside perSize mode, or with no
    // usable row, the entry arms nothing — locationPolicyFor refuses it too.
    // (Adversarial review, PR #608: soccer-jerseys and underwear are live in
    // this shape, and without this branch their Solve stayed greyed.)
    if (isGarbledEntry(entry)) continue;   // both target and sizes: the engine refuses it too
    if (isMapEntry(entry)) {
      if (!mapUsable(cat, entry)) continue;
      const run = {};
      for (const sz of sizes || []) {
        if (String(sz) === "_") continue;
        const row = entry.sizes[encodeSizeKey(String(sz))];
        if (!row || typeof row !== "object" || Array.isArray(row) || !posTarget(row.target)) continue;
        run[String(sz).toUpperCase()] = at(sz) > 0 ? row.target : 0;
      }
      if (Object.keys(run).length) out[loc] = run;
      continue;
    }
    const t = entry.target;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
    // Per-size mode REFUSES the "_" sentinel (a per-size product declaring
    // one-size is a data error; the engine falls through for it too — the two
    // must refuse in lockstep or Solve would arm a cell the engine never
    // refills). (CodeRabbit, PR #352.)
    out[loc] = cat.perSize === true
      ? Object.fromEntries((sizes || []).filter((sz) => String(sz) !== "_").map((sz) => [String(sz).toUpperCase(), at(sz) > 0 ? t : 0]))
      : { "_": t };
  }
  return out;
}

// The run map Solve should actually decide on: effectiveStandard (subcategory
// policy over the size run) with the kill switch applied per location, the
// category policy overlaid above it, and the explicit rows overlaid on top —
// resolveTarget's whole priority order, folded into the ONE
// { loc: { SIZE: target } } shape qualifyingSizes/solvePlan already speak, so
// neither needs a new argument or a new meaning.
//
// Order inside a location is exactly the engine's: rule/subcategory standards
// FIRST (and only where the kill switch is on), the category policy NEXT (it
// survives the kill switch, like the explicit rows it generalises), explicit
// rows LAST so they win.
export function resolvedRun({ std, subRun, subcategory, sizes, targets, pid, ruleBasedTargets, categoryPolicy, categoryKey, unitsAnywhere }) {
  const base = effectiveStandard({ std, subRun, subcategory, sizes });
  const catRun = categoryRun({ policy: categoryPolicy, categoryKey, sizes, unitsAnywhere });
  // A location can be reachable through an explicit row alone — or through the
  // category policy alone (a mapped perfume has no run at all) — so the
  // location set is the union of all three sources.
  const locs = new Set([
    ...Object.keys(base),
    ...Object.keys(catRun),
    ...Object.keys(targets || {}).filter((loc) => targets?.[loc]?.[pid]),
  ]);
  const out = {};
  for (const loc of locs) {
    // Rule-based and subcategory standards die with the kill switch. The
    // category policy and explicit rows below do not — that asymmetry IS
    // resolveTarget's branch order.
    const run = ruleTargetsEnabledFor(ruleBasedTargets, loc) ? { ...(base[loc] || {}) } : {};
    Object.assign(run, catRun[loc] || {});     // map beats the rules, incl. its dead-size 0s
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
