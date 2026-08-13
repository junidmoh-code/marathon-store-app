# Category standing policy — rollout & 136-row reconcile (2026-08-13)

The engine and Solve now resolve `/config/refillEngine/categoryPolicy` live
(see refill-engine.cjs `categoryPolicyTarget` and solvePlan.js `categoryRun`).
Deploying the code changes nothing until the owner writes map entries. This
document records the arming order, the day-one numbers modelled with the real
`computeRefillPlan` against live data, and the reconcile of the 136 rows armed
at the superseded numbers. The runnable payloads and commands live OUTSIDE the
repo, in the owner's home directory (`~/category-policy-README.md` is the
runbook; nothing here was executed).

## The map (owner decisions 2026-08-13, settled)

| categoryKey  | marathon-pe        | hub2               | mode                          |
|--------------|--------------------|--------------------|-------------------------------|
| `perfumes`   | 8 / rp 3 / min 4   | 10 / rp 5 / min 5  | one-size `"_"`                |
| `caps-beanies` (beanies + caps + bucket hats — ONE live key) | 5 / rp 0 / min 3 | 10 / rp 0 / min 5 | one-size `"_"` |
| `fitted-caps`| 2 per size / rp 0  | 5 per size / rp 0  | per-size; dead sizes explicit 0 |

Trophy and marathon-pine are not named — they get nothing (decision 5).

The slugs `beanies` / `caps` / `bucket-hats` do NOT exist in the catalogue.
The live key `caps-beanies` holds all three (135 beanies, 73 caps, 16 bucket
hats) — identical numbers, so one entry serves — **and all 7 visors**, which
must stay excluded. That is why arming `caps-beanies` is gated on the visor
re-key (7 records → categoryKey `visors`, payload prepared): a pure
categoryKey map cannot exclude them any other way.

**The off switch** for any mapped category: delete
`/config/refillEngine/categoryPolicy/<categoryKey>`. Live, no deploy, one
edit; the very next scan reverts that category to the pre-map branches.
Deleting a `/stock_targets` row is NO LONGER an off switch for mapped
products — an explicit row only ever *overrides* the map, and removing it
drops the product back onto the map, not to nothing.

## Day-one model (live data, real engine, 2026-08-13)

First scan after arming the FULL map: **36 intents** (30 caps-beanies + 6
perfume, all central→hub2, 339 units) — under `maxIntentsPerRun` 75, not
throttled. Standing demand behind it (drains over subsequent scans):

| category | leg | at target | silent (rp) | request | parked | notes |
|---|---|---|---|---|---|---|
| perfumes | central→hub2 | 23 | 3 | 6 (60u) | 33 (309u) | parked = Central dry for those pids |
| perfumes | hub2→PE | 6 | 30 | 2 (8u) | 27 (193u) | cascade fills as hub2 receives |
| caps-beanies | central→hub2 | 0 | 0 | 98 (~950u) | 144 (1,440u) | Central CAN serve the 950u |
| caps-beanies | hub2→PE | 0 | 0 | 0 | 242 (1,210u) | flows after hub2 receives |
| fitted-caps | central→hub2 | 3 | 3 | 0 | 177 (501u) | **Central holds zero fitted caps — supplier buying list** |
| fitted-caps | hub2→PE | 88 | 17 | 1 (1u) | 77 (97u) | shop nearly full already |

Fitted caps: 325 declared-but-dead size cells (XXXL/4XL and the unstocked cm
sizes) resolve **explicit 0** — the garment run can no longer target them.
79 fitted caps still carry introduce-existing LETTER rows; explicit beats the
map, so those sizes keep hub2 3 / PE ~2 until the owner also deletes those
rows (deliberately not prepared — separate decision).

Pre-collapse caveat for `caps-beanies`: ~174 uncollapsed letter-cell records
park their `"_"` cells as Missing-Sizes / awaiting-supplier NOISE (the engine
cannot move letter stock into `"_"` cells, so nothing ships wrongly). Arming
after the collapse avoids the noise; arming before it is safe but untidy.

## The 136-row reconcile

136 rows carry batchId `headwear-onesize-policy` at the superseded numbers:
68 × hub2 `_` 15/8 (no rp, eager) and 68 × marathon-pe `_` 5/3 rp 0. Because
an explicit row beats the map, these 68 products would keep 15/8 forever.

Prepared to disk, NOT run: `~/headwear-136-delete.json` (136 multi-path
nulls), `~/headwear-136-rollback.json` (exact rows as read). **Order is
load-bearing:** all 68 hub2 rows have OPEN engine requests raised under them
on 2026-08-11 (67 × qty 10, 1 × qty 15). Deleting before `caps-beanies` is
armed strands that open work target-less (the engine withdraws it); deleting
after, they fall through to the map's identical hub2 target 10 (the qty-15
one resizes next scan). The moment they fall through: hub2 15/8-eager →
10/5-rp0 — hub2 buffers stop topping up until they hit empty (owner's rp 0),
PE numbers unchanged.

## Arming order (the short version)

1. Deploy `functions:refillHealthScan`, then hosting (code is inert unarmed).
2. Arm `perfumes` — 6 intents, the stranded Aug-11 perfumes start moving.
3. Arm `fitted-caps` — ~1 unit moves; the rest is a stated buying list.
4. Run the visor re-key (7 records + 1 ABSENT-key bucket hat).
5. Arm `caps-beanies` — ideally after the collapse runs.
6. Run the 136-row delete (only after step 5). Rollback restores exactly.
