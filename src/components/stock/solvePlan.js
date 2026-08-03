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
