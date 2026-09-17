# First-batch incident — 2026-09-17 evening

Read-only findings. Census: `scripts/audit/first-batch-incident-census.mjs`
(paged /refill_requests, scoped everything else). Read at 21:02Z, ~5h after
PR #607 went live (16:05Z) and ~1h15 after PR #608 (19:48Z).

## What was reported

Source › Trophy (112) and Source › Marathon (113) "full of shop refill
requests sourced from Central" for products that already sit at Hub 2, some
waiting over two days. Working hypothesis: #607 skipped the Hub 2 seed, so
Hub 2 stopped being a valid source and the engine fell through to Central.

## What the data says

| question | answer |
|---|---|
| `/refill_requests` rows tagged `createdFrom.firstBatch` — ever, any status | **0** |
| open requests with `requestingLocation` = a shop | **225** (Marathon PE 113, Trophy 112 — exactly the tab counts) |
| of those, tagged first-batch | 0 |
| of those, declared source (`createdFrom.source`) | `hub2` — all 225 |
| of those, `createdFrom.via` | none — every row is an engine row |
| age | <6h 4 · 6–24h 120 · 24–48h 94 · ≥48h 7 (oldest 60.8h — 2½ days BEFORE the path existed) |
| distinct products | 142 — **142 have a Hub 2 stock node, 142 with units > 0** |
| engine locks at the shops, by source | `hub2` — all 225 |
| shop rows resolved since 16:00Z | 0 |
| `rrf_` movements since 16:00Z / Central→shop refill fulfils | 0 / 0 |
| kill switches | `ruleBasedTargets true`, `footwearTargets null` (sneakers OFF) — unchanged |

## The real mechanism

1. **The engine never sources a shop from Central.** In
   `functions/lib/refill-engine.cjs` a request's source is `routes[dest]`
   (`const src = routes[dest]`, ~1422), and live routes are
   `marathon-pe → hub2`, `trophy → hub2`. A shop deficit whose Hub 2 cell is
   empty goes to *Awaiting Transfer*, never to Central. The hypothesis
   ("Hub 2 un-seeded → falls through to Central") is falsified: there is no
   fall-through in the engine.
2. **The Solve could not have created these rows.** `missingProductsCore`
   marks a card Central-stranded only when Hub 2 has NO cell
   (`ce > 0 && !carries("hub2", pid)`), so a product with Hub 2 presence
   never reaches the first-batch branch; and no first-batch Solve has ever
   run (0 tagged rows).
3. **The defect is the two new Source tabs.** `RefillQueue` filters its rows
   as `status === "open" && requestingLocation === dest` (RefillQueue.jsx
   ~336). Mounted with `dest = "trophy"` / `"marathon-pe"` (#607), that is
   **every open request the ENGINE raised hub2→shop** — Hub 2's whole
   outbound backlog — shown inside Central's Source screen under a tab that
   says Central should pick it. The badge count (App.jsx `hubBadges`) has the
   same shape and put 112/113 on the tabs. The rows are legitimate hub2→shop
   work for Hub 2 staff; they are ordinary, and 7 of them predate the path
   by two days.
4. **Why it matters beyond a display error.** `RefillQueue`'s Fulfil is
   Central's fulfil: `applyMovement transfer_out central → dest`,
   `rrf_{id}`. A tap on one of those 225 rows would have moved a unit OUT
   OF CENTRAL to the shop while Hub 2 kept its unit, and marked the engine's
   hub2→shop request fulfilled. **This did not happen**: 0 shop rows resolved
   and 0 `rrf_` / Central→shop movements since the deploy. No stock moved, no
   stock is mis-placed, nothing at Hub 2 was un-seeded.

## Consequences for the plan

- **Phase 1** (revert): the Solve's first-batch path goes OFF (code switch,
  client and server), and the shop tabs + badges show ONLY first-batch shop
  legs (`isFirstBatchShopLeg`) — today that is nothing. Tabs stay in place.
- **Phase 2** (data repair): there are no #607-created rows to cancel or
  re-source and no skipped Hub 2 seeds (0 first-batch Solves). The repair
  script is written and dry-run for the general case; its live answer is 0.
- **Phase 3** (rebuild): the Hub 2-presence guard is made explicit and
  checked at Solve time and again in the trigger; Hub 2 is ALWAYS seeded at
  Solve time; the shop tabs never show an engine row again.
