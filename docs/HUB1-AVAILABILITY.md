# Hub 1 Availability — the five-piece build (2026-08-25)

One PR: negative cells zeroed network-wide, a shared availability resolver,
the shop ordering grid gated on Hub 1 availability, the data-driven Tomorrow
action, and the Hub 1 per-size sneaker engine policy behind a new carriage
scope gate. Owner decisions baked in (do not relitigate): negatives become
zero; displays ARE available stock; no missed-demand logging; unlisted sizes
stay unarmed (no row, no target-0 row).

## Piece 1 — negative cells zeroed

`scripts/scan-negative-cells.mjs` (read-only, paged) found **1,001 negative
cells / 1,622 units below zero** across 7 locations (hub3 435 cells/774u,
marathon-pe 252/361, hub1 120/142, trophy 88/225, hub2 87/101, central 18/18,
marathon-pine 1/1). `scripts/zero-negative-cells.mjs --commit` brought each to
zero through real `adjustment` movements (deterministic ids
`negzero_20260825_<loc>_<pid>_<sizeKey>`, reason on every row, before/after,
CAS re-read guard — never a raw cell write). Rollback:
`~/negative-zero-rollback-20260825.json` + `/reports/stock_corrections` push.

## Piece 2 — the availability definition and the investigation

`src/components/stock/availabilityCore.js` is THE resolver:

    available = max(0, cellQty) − visible ready-order promises, floored at 0

Measured at Hub 1 on 2026-08-25:

| promised-out population | measured | in the resolver? |
|---|---|---|
| ready-but-uncollected orders | 45 units / 43 cells (of 2,807) | **subtracted where visible** — footwear is not deducted at dispatch (`footwear_sells_from_hub`), so a Ready pair has physically left while still booked |
| fulfilled-but-uncollected refill lines | 0 held lines to hub1 | nothing to subtract by construction — fulfil deducts the source at fulfil; a held line credits `in_transit`, never the hub |
| layby pulls | 215 items `sentToStore` (~4% of hub1's 5,150 booked units) | **cannot be** — `/laybyPulls` carries an itemCount only, no productId/size. Known aggregate residual; availability may overstate by at most that much, never traceably per cell |

Store-assigned devices read only their own shop's `/orders` (rule-enforced),
so the shop grid's promised map is partial there — the error direction is
"shows available", which is exactly yesterday's behaviour, never a false ✕.

## Piece 3 — shop ordering grid

A sneaker size Hub 1 has none available of renders as a disabled ✕ on all
three assistant surfaces (mobile size sheet, desktop hover quick-add, desktop
quick-view), enforced again inside `addToCart`/`quickAdd`. HUB 1 ONLY:
hub2/hub3-routed sneakers, clothing, and Pine behave exactly as before —
pinned by the deep-equal engine test and the clothing branch being untouched.
Data: one `stock/hub1` subscription (the exact pattern the clothing grey-out
already uses for hub2), gate keyed on `settled` so loading never blanks a grid.

## Piece 4 — the Tomorrow action (and the Refinement A cost decision)

`TomorrowActionButton` + `src/components/stock/tomorrowGate.js`. Options
measured (hub1, 17-day insights_log means: ~84 warehouse rows/day, ~25
Tomorrow taps/day, one cell ≈ 250 B, `/stock/central` = 1.05 MB):

1. prefetch Central for products on screen → ≥1.05 MB per load;
2. read only at tap → 6 KB/day but the ROW cannot offer "Out of stock";
3. **chosen hybrid** — one single-cell read per rendered row for the label +
   a fresh single-cell re-read at the tap: ≈ 27 KB/day/device, with a 60 s
   cache for scroll remounts.

The tap NEVER sends a promise the data no longer supports: fresh read at tap;
Central at 0 → the existing out-of-stock outcome (same `rder_out_of_stock`
template, same insight row, same hold-release — nothing new was created);
stock reappeared → the Tomorrow promise stands. Unresolvable rows and read
failures keep today's Tomorrow (a false OOS messages a customer wrongly; a
false Tomorrow merely keeps the human's promise).

## Piece 5 — Hub 1 sneaker policy and the carriage scope gate

Run: 3→2, 4→2, 5→2, 5.5→2 (stored `5_5`), 6→3, 7→3, 8→3, 9→2, 10→2, 11→2;
`reorderPoint: 1` on every size (ask when a cell drops to 1, top up to target).

**The scope gate.** Category policies deliberately have no carriage gate, so a
plain per-size `sneakers` entry would arm all **1,242** sneaker products at
Hub 1. New optional location-entry flag `carriedOnly: true` — gated at
`categoryPolicyEntry`, the one choke point (managedPids, sizesFor, the class
filter, the decision gate, categoryPolicyTarget), mirrored in `seatingCore.js`,
validated (boolean-only) in the callable, surfaced and editable in the Engine
Policy card ("Carried only" / "All products" per location). Live count passing
the gate: **608 products** (the owner's ~260 guess was low — verified, not
trusted). Kids sizes 26-33 and slides/other footwear categories are simply not
named and stay unarmed; existing explicit rows (including target-0 seating
exclusions) outrank the policy as before.

Proofs: `functions/test/hub1-sneaker-policy.test.cjs` (scope gate, others
deep-equal, reorder-point-1 tops to target and no further, 5_5 encoding,
target-0 wins, negative cells clamp both sides) and
`scripts/mutation-proof-hub1-scope-gate.mjs` (4 mutation shapes, all proven:
gate deletion, flag-reader weakening, per-size pass-through drop, and the
leak-sideways mutation caught by the frozen clothing snapshot).

**Deploy order is load-bearing:** the OLD deployed engine ignores
`carriedOnly` — writing the policy before `functions:refillHealthScan` is
deployed would arm all 1,242 products. Deploy first, verify, then arm.

## Refinement B — first batch and the stagger

The release-window gate needed nothing built: a request is released iff
`createdAt <=` the most recent release instant
(`src/components/stock/releaseWindows.js`), so everything a scan raises after
06:00 holds until 14:00 by itself. No second holding mechanism, no
`earlyRelease` stamp.

Full first-scan demand, measured through the real engine on the live snapshot
(`scripts/model-hub1-sneaker-policy.mjs`): **538 lines / 857 units**, all
fillable by Central by construction (the engine's source gate caps every
intent at what Central actually holds). Against a normal window's 12-45
lines / 24-82 units that is an order of magnitude over — so the policy is
armed in **size tranches, one per day**, each ≈62-83 lines ≈ 31-42 per window:

| day | sizes | first-scan lines / units |
|---|---|---|
| 1 | 3, 4, 5, 5.5 | 80 / 105 |
| 2 | 6 | 69 / 135 |
| 3 | 7 | 82 / 173 |
| 4 | 8 | 80 / 163 |
| 5 | 9 | 82 / 108 |
| 6 | 10 | 83 / 105 |
| 7 | 11 | 62 / 68 |

Mechanism: `scripts/arm-hub1-sneaker-tranche.mjs` (dry-run default,
`--execute` writes through `applyCategoryPolicy` — the card's own path, so
every tranche lands in the card and the history), scheduled on the Mac mini
(never sleeps) by `scripts/launchd/com.marathon.hub1sneakertranche.plist` at
04:30 SAST daily. Once all ten sizes are armed the script no-ops and prints
the removal command. Rollback of any tranche: the card, or the daily
`~/hub1-sneaker-tranche-rollback-*.json`.

## Odd sizes the owner asked about

Hub 1 cells at 6.5 / 7.5 / 8.5 / 9.5 / 10.5 / 12 / 13: exactly two, both size
12 Timberlands (`p1777990658712` qty −1 → zeroed by Piece 1;
`p1777990887813` qty 1). Every other size: none — the owner is right.
