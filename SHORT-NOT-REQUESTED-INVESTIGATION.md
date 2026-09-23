# Short but not requested — investigation (2026-09-23)

Owner report: **Nike Tech Fleece Tracksuit Brown 2** (`p1780382141061`) — Marathon PE
keeps 2 × M and has had 0 for weeks; Hub 2 counts 3 M and Central counts 38 M. Why is
no request raised, and how many shop cells are in the same state?

Evidence: the exact snapshot `refillHealthScan` reads (same paths, same 45-day
movement window), pulled 2026-09-23 12:07 SAST, replayed through the real
`computeRefillPlan` from `functions/lib/refill-engine.cjs`.

## 1. PE / M, step by step

| Step | Code | What it decided for `marathon-pe / p1780382141061 / M` |
|---|---|---|
| managed? | `managedPids` / `sizesFor` | Yes — explicit `/stock_targets/marathon-pe/.../M` row (target 2, minQty 1). |
| target | `resolveTarget` explicit branch (`:530`) | `{ target: 2, minQty: 1, reorderPoint: null, source: "explicit" }` — the row has **no** `reorderPoint`, so it is `null`, NOT an inherited category value. |
| deficit | `:1439-1443` | have 0, inbound 0 → deficit 2. |
| reorder-point gate | `:1467` | `reorderPoint` is null → gate inert. |
| confirmed out? | `:1475` | No — there is no Central-level denial. |
| anything upstream? | `:1509` | Yes (Hub 2 3, Central 38). |
| already in flight? | `:1519` | No open lock, no manual order, no held line. |
| **loop guard** | **`:1536-1544`** | **`streakState` → FLAGGED. `/refill_engine/rejectStreak/marathon-pe/p1780382141061/M = { count: 4, by: "hub2", lastTs: 2026-09-17T14:15 }`; `rejectStreakLimit` is live 4; Hub 2 still counts 3; nothing has arrived at Hub 2 since. The cell is pushed to `recountNeeded` and `continue`s — no intent, forever, until a human recounts Hub 2.** |

Replay output for the cell:

```
recountNeeded  marathon-pe M  deficit 2  source hub2  rejections 4  showing 3
  "rejected 4× at hub2 while its count shows 3 — recount, then "Ask again" in Health"
```

### It is not true that no request was ever raised

The engine raised **five** PE/M requests. Hub 2 marked four of them "out of stock"
(insights_log `out_of_stock`, placedAtHub hub2) and one was lost to the daily R-number
recycle:

| Raised (UTC) | Order | Outcome |
|---|---|---|
| 09-09 13:15 | — | fulfilled (the last M PE received) |
| 09-12 08:30 | R008-1 | **Hub 2: out of stock** 11:16 |
| 09-13 11:45 | R028-2 | **Hub 2: out of stock** 09-14 08:31 |
| 09-15 09:00 | R007-1 | `order_lost` (key recycled) — self-healed |
| 09-16 09:00 | R010-1 | **Hub 2: out of stock** 10:00 |
| 09-17 10:15 | R020-3 | **Hub 2: out of stock** 14:06 → 4th strike, cell parked |

So since 17 Sep the cell sits in Health → Recount Needed and nothing fires. Hub 2's
count says 3 mediums; Hub 2's staff have said four times that they are not there.
The engine's only way out is a human recount — and nothing sends Central's 38 mediums
anywhere, because Hub 2 "has" 3 = its own target 3, so Hub 2 never asks Central.

## 2. The four named suspects

1. **Blank ask-at inherits 0 and `on-hand < ask-at` never fires — RULED OUT.** The gate is
   `have > reorderPoint → skip` (`:1467`), so at have 0 a reorder point of 0 still
   fires. And a blank ask-at on an explicit row resolves to `null` (`:539`), not to any
   category value; tracksuits has no category entry anyway.
2. **A stale open request / dedupe key — RULED OUT.** No lock in `/refill_engine/open`,
   no open request, no manual order. `retryState` (`nextRetryAt` 09-18) has expired and
   is inert. The blocker is the reject STREAK — current, not stale: it is four real
   rejections against a count that still reads 3.
3. **Store-leg resize failures at the order transaction (`clothingPlanGen`) — RULED OUT
   for this.** 214 open locks, 0 with a stuck `clothingPlanGen`; today's runs land
   resizes with no `resizeDropped`. It only ever affected resizing an OPEN request,
   and PE/M has none.
4. **Source resolution — CONTRIBUTES.** `routes["marathon-pe"] = "hub2"`, so PE can only
   ask Hub 2. When Hub 2 is the problem, the shop's demand has no second path: nothing
   turns "Hub 2 says it has none" into "Central, send Hub 2 some".

## 3. The second cause the population exposed

The same dead end, without any rejection: shop short, **Hub 2 holds no cell and no
target for the size**, Central holds units. The source gate (`:1591`) parks the shop
leg; `srcCanPull` (`:1622-1623`) is false because Hub 2 resolves no target, so the
cell is labelled "hub2 has no buffer target for this size — set one" (`:1630`) and
waits for a person to set a Hub 2 target. Nobody does; nothing fires.

## 4. Pine

`marathon-pine` is not in `config.routes` and has no `/stock_targets` rows and no rule
run — no "keep" number exists for any Pine cell, so no Pine cell can be "below keep".
Zero Pine cells are in the population. (Pine's refills are the manual Hub 3 flow.)

## 5. The population (before the fix)

`scripts/audit/short-not-requested-census.mjs` — read-only, replays the real engine
over the scan's own reads with every list uncapped. Shop cells below keep (after the
owner's ask-at gate), with the feeding hub or Central counting the size, and nothing
on its way:

| Cause | Broad (nothing open now) | Strict (+ no request in 14 days) | Central holds it |
|---|---:|---:|---:|
| `hub_no_target` — Hub 2 empty, no Hub 2 target, Central holds units | 40 | 40 | 40 |
| `recount` — loop guard parked after 4 Hub 2 rejections | 34 | 3 | 3 |
| `confirmed_out` — denied at Hub 2 AND Central | 15 | 1 | 10 |
| `upstream_blocked` — Hub 2's own Central leg rejected/parked | 9 | 6 | 9 |
| `cooldown` — inside the 24h retry after a rejection | 7 | 0 | 1 |
| `awaiting_upstream` — Hub 2 empty, chain said to be flowing | 3 | 1 | 3 |
| **Total** | **108** | **51** | |

By shop (broad): Marathon PE 53, Trophy 55. Pine 0 (no keep numbers; not routed).
PE / M of the Brown 2 tracksuit is in the BROAD count only — its last request was
raised on 17 Sep, inside the 14-day window, and rejected.

Of the 34 `recount` cells, 31 have **no** units anywhere except Hub 2's disputed count:
there is nothing any automation can send — a recount is the only honest answer, and
the card says so.
