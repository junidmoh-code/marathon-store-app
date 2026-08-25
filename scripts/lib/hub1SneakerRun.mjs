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

// Daily tranches, re-sized 2026-08-25 for the UNSCOPED policy (owner order:
// every sneaker, no carriage gate). Surviving-the-source-gate lines per size,
// measured through the real engine on the live snapshot:
//   3:66 4:82 5:69 5.5:76 │ 11:80 │ 10:131 │ 9:150 │ 6:157 │ 7:185 │ 8:194
// Day 1 (sizes 3-5.5) was armed scoped on 2026-08-25 and is WIDENED in place
// (the armer's scrub step); the remaining six sizes land one per day,
// smallest demand first. Daily creation is additionally held by the
// maxFootwearIntentsPerRun rollout throttle (see the feature doc) — the
// tranche order spreads the shortage surface, the throttle bounds the queue.
export const TRANCHES = [["3", "4", "5", "5_5"], ["11"], ["10"], ["9"], ["6"], ["7"], ["8"]];
