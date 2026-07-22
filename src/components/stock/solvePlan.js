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

// Which locations get a qty-0 carriage seed. Central-stranded needs BOTH Hub 2
// (so the engine raises central→hub2) and the nominated store (so it raises
// hub2→store once Hub 2 receives). Hub2-stranded needs the store only.
export function seedLocations(source, store) {
  return source === "central" ? ["hub2", store] : [store];
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
