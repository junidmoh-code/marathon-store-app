// ─── THE HUB 1 SNEAKER RUN — one copy, two consumers ─────────────────────────
//
// The owner's per-size run for the Hub 1 sneaker policy (2026-08-25 brief):
// targets by ENCODED size key, minQty = ceil(target/2) (the engine's own
// default ratio), reorderPoint 1 = ask when a cell drops to 1.
//
// Imported by scripts/model-hub1-sneaker-policy.mjs (the dry run) and
// scripts/arm-hub1-sneaker-tranche.mjs (the daily armer) so the numbers that
// were modelled and the numbers that get written can never drift.
// functions/test/hub1-sneaker-policy.test.cjs keeps its OWN literal copy on
// purpose — the test pins the owner's numbers; an armer edit must break it.
export const HUB1_RUN = { 3: 2, 4: 2, 5: 2, "5_5": 2, 6: 3, 7: 3, 8: 3, 9: 2, 10: 2, 11: 2 };

export const runRow = (k) => ({ target: HUB1_RUN[k], minQty: Math.ceil(HUB1_RUN[k] / 2), reorderPoint: 1 });

// Daily tranches, sized from the measured first-scan lines per size
// (3:19 4:17 5:19 5.5:25 │ 6:69 │ 7:82 │ 8:80 │ 9:82 │ 10:83 │ 11:62) so each
// day lands ≈62-83 lines ≈ a normal window's workload across two windows.
export const TRANCHES = [["3", "4", "5", "5_5"], ["6"], ["7"], ["8"], ["9"], ["10"], ["11"]];
