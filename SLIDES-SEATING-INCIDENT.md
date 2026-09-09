# Slides armed at both hubs — what was found, and what was done

**Incident**: on **2026-09-08T12:02:48.962Z** `gunidmoh@gmail.com` armed the
**Slides** category at **hub1 AND hub2**, per-size, keep 3, through
`setCategoryPolicy` (`engine_policy_history/-P1-t_VYDbVyCVI0m-ce`). The entry's
`before` is `undefined` — Slides had never been armed anywhere — and **neither
leg carried `carriedOnly`**.

An unscoped leg is the category map's standing promise: *the category is the
arming act, carriage or not* (`refill-engine.cjs` `categoryPolicyEntry`). So both
hubs were told to keep every slide in the catalogue, including the ones the
other hub keeps. The save's own model said so at the time — 197 requests, 408
units, against a per-scan cap of 75.

## Snapshot

`var/slides-seating-inventory-2026-09-09T10-28-07-223Z.json` (gitignored; `var/` is machine-local working data).
Re-runnable and idempotent: `node scripts/slides-seating-inventory.mjs`.

## What the catalogue actually seats

Seating is **cell existence, zero cells included** — `storeCarries`, the engine's
own predicate. A sold-out slide is still seated.

| | |
|---|---|
| products with `categoryKey: slides` | 64 (63 live and unmerged) |
| seated at hub1 | 30 |
| seated at hub2 | 24 |
| seated at **both** | 3 |
| seated at **neither** | 13 |

Three products in sixty-four are genuinely kept at both hubs. The arming
behaved as though all sixty-four were.

## The damage, measured

| | |
|---|---|
| open refill lines at hub1 / hub2 | **181** (hub1 104, hub2 77), 367 units |
| of those, raised at a hub that does **not** seat the product | **125** |
| already released past a window (pickable work on the floor) | 179 |
| still parked behind the next window | 2 |
| already part-picked out of Central | **1** |
| already fulfilled | 0 |
| parked-in-transit hold lines | 0 |

Every one of the 181 is engine-locked with `source: central`. The earliest was
raised 2026-09-08T12:00:37Z; the latest 2026-09-09T08:30:33Z.

**The 14:00 window did not save this.** The 06:00 window (04:00Z) had already
passed, so 179 of the 181 were released as pickable work before this was
reversed.

## Two populations that are NOT this arming, and were left alone

**1. Thirteen explicit `/stock_targets` rows at hub2.** Three products × sizes
3-6 at keep 2 (2026-09-06T08:20-08:22) and one product at size 9 keep 3
(2026-09-08T11:52) — all `source: policy_target`, all hand-made through the
product-override path, all on products hub2 **already seats**, none of them a
`target: 0` switch-off. All four predate the 12:02 arming. They are the owner's
own rows, they outrank the map (`resolveTarget:468`), and the standing rule is
that explicit rows are edited in place and never deleted. **They stay.** Hub1
has no explicit slides rows at all.

The brief asked for "zero Slides target rows at either hub" after the reversal.
That is reported here as zero rows *attributable to this arming* — which is the
true number, because the arming wrote none: it wrote two legs on the category
map, and the map is what manufactured 180 requests without a single row.

**2. One open line owed to one of those rows.** `-P1-t66z_Nx6JRiKReIJ` —
Givenchy Paris slide red & black, size 9, hub2, raised 12:00:37Z, two minutes
*before* the arming, against the explicit row set at 11:52. It is seated, it is
the owner's own ask, and it survives the reversal.

So the reversal's true scope is **180 lines, 364 units** — 125 of them at a hub
that does not seat the product, 55 at one that does but which nobody asked to
be armed.

## What was done (2026-09-09)

**Reversed** (~10:47Z): the map un-armed through `applyCategoryPolicy(policy: null)`
(history `-P14mpaWvfMqt22j1en2`); **180 lines withdrawn** (104 hub1, 76 hub2, 364
units) through the engine's own withdrawal shape — `cancelled` +
`no_longer_needed`, lock removed — so nothing was recorded as a human rejection
and nothing was taught. One line the 10:45 scan raised in the gap was withdrawn
by the engine's own 11:00 scan. Re-verified: zero open, zero locked. The 13
explicit rows and the Givenchy line they back were not touched.

**Gated**: `gateNewLegsToSeated` in `functions/lib/category-policy-write.cjs` —
every new location leg, category or group, is written `carriedOnly: true`.
Already-armed legs pass through byte-identical.

**Re-armed** (11:17Z, history `-P14yYb5VaHSAptxDUqh`) through the gated path,
the original numbers read back out of `-P1-t_VYDbVyCVI0m-ce`: keep 3 / min 2 /
ask at 1, ten sizes, both legs `carriedOnly: true`.

| resolved by the engine against the gated policy | |
|---|---|
| hub1 only (by policy) | 26 |
| hub2 only (by policy) | 18 |
| both — hub1 by policy, hub2 by the owner's explicit rows | 3 |
| neither | 16 (13 seated nowhere + 3 whose declared sizes resolve nothing here) |
| modelled next scan | **67 requests / 115 units** — the original arming modelled 197 / 408 |

Cells at both hubs: 3. Armed at both: 3. The gate is working.

**Already-armed categories, before and after** (`scripts/census-armed-target-rows.mjs`):
explicit `/stock_targets` rows **8,675 → 8,675**, 0 location/category cells
changed; hub1/sneakers **202 → 202**; every clothing row count identical. The
only map legs that changed are `slides @ hub1` and `slides @ hub2`, absent →
per-size carried-only.

**Still owed to the warehouse**: 1 unit Birkenstock Arizona Orange size 7,
picked Central→hub1 on withdrawn request `-P105pjyNpGzrGzJVl4K` before the
reversal. Everything else was released as pickable work but not picked.
