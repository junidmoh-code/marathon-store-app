# FULFIL-CREDIT-GAP — Diesel Slide Full Black, Hub 1, size 6

Investigation date: 2026-09-11. Branch `fix/fulfil-credit-gap`.
Probe: `scripts/probe-fulfil-credit-gap.mjs` (read-only, one-off; whole-ledger read is
deliberate forensics and never ships into the bundle). Raw output below is the probe's
own markdown, generated from a paged snapshot of the live database taken 2026-09-11
~12:40 SA.

## Verdict in one paragraph

The unit moved. Central's size-6 cell decremented 1 → 0 and Hub 1's cell was credited
+1 in the same atomic write (movement `rrf_-P151_2zzLyo57i8j7Ll`, 10 Sep 08:01:49Z).
The Hub 1 cell was **−1 before the credit**, so the credit paid off a phantom debt and
the cell reads 0 while the physical unit is on the shelf. The −1 came from three POS
`sold` movements on 28 Aug written 20 seconds apart against a cell holding 2. Owner
policy (2026-08-25, `scripts/zero-negative-cells.mjs`, `availabilityCore.js`) already
says a negative cell is a count artifact and reads as zero — but `applyMovement` still
lands an arrival on top of the negative, so whether the unit shows depends on whether
the periodic zeroing ran before or after the box arrived. That ordering dependence is
the defect. The hold lane was OFF (switched off 9 Sep 09:48Z, before the fulfil) and is
not involved; the movement id did not collide; the engine's qty of 1 was the source
gate working (Central held exactly 1 at the 14:00 window on 9 Sep, need was 3).

"In Transit (2)" is a different product entirely: two New Balance 9060 units
(`p1783251345522`, sizes 7 and 8) parked on 4 Sep by a hub2 fulfil while the hold lane
was on. The owner released that shipment at 11:51Z the same day and the archive says
so, but **no release movement exists** and the in_transit cells still hold the units.
The product record has since been deleted from `/products` (barcodes still point at
it; no merge record). The live rules refuse any movement for a product that does not
exist, which is consistent with the release write being rejected — but the archive
entry should then not exist either. The mechanism is not reproducible from current
source; the state is what it is and is handled in Phase C/E below.

## Phase A — the live evidence

| Question | Answer (from data) |
|---|---|
| pid from barcodes 00005410..15 | `p1778157967464`, one record, no same-name twin |
| Did Central decrement at 10 Sep 10:01? | Yes. `rrf_-P151_2zzLyo57i8j7Ll` before `{central 1, hub1 −1}` after `{central 0, hub1 0}` |
| Where is the unit now? | Booked nowhere: central 0, hub1 0, in_transit 0. Physically at Hub 1 (owner). The +1 was absorbed by the −1 |
| In Transit (2) | `p1783251345522` (New Balance 9060 cream & white, record DELETED) size 7 and size 8, 1 unit each, parked 2026-09-04 08:09Z (171 h), destination hub2, shipment `2026-09-04_1400`, released archive present, release movement absent |
| `settings/stockHold/config/enabled` | `false` (since 2026-09-09 09:48:56Z, by the owner). Held lines now: 0 |
| Movement id collision? | No. The record under the derived id carries this request's `link.refillId`, product, size and instant. No tranche ids |
| Central size 6 at 9 Sep 14:00 SA | 1 (last prior move: 28 Aug transfer to Pine 4 → 1). Now: 0 |
| Policy at Hub 1 size 6 | target 3, minQty 2, reorderPoint 1 (category policy). Hub 1 had −1 → reads 0 → need 3 → capped by Central's 1 → **qty 1 = gate worked** |

Hub 1 size 6 ledger (the whole story):

| when (Z) | movement | effect on hub1 |
|---|---|---|
| 22 Aug 08:22 | hold release, +3 | 0 → 3 |
| 22 Aug 12:04 | sold | 2 |
| 23 Aug 10:27 | hold release, +1 | 2 → 3 |
| 24 Aug 13:40 | sold | 2 |
| 25 Aug 07:36 | source refill, +1 | 2 → 3 |
| 28 Aug 08:54 | sold | 2 |
| 28 Aug 11:21:58 / 11:22:13 / 11:22:18 | sold ×3 (three sale ids, one till, 20 s) | 2 → **−1** |
| 10 Sep 08:01 | auto refill, +1 | −1 → 0 |

## Phase B — blast radius, last 30 days, all locations

**B1 — fulfilled refill requests with no corresponding destination credit**

| cause | requests | units |
|---|---|---|
| credit absorbed by a negative destination cell | 12 | 13 |
| parked in in_transit, stranded (deleted product) | 2 | 2 |
| movement swallowed by idempotency | 0 | 0 |
| credit write failed independently of the deduct | 0 | 0 |

3,858 store-leg requests (Trophy / Marathon PE ← Hub 2) were closed by the engine on
order dispatch; their stock moves under the order's dispatch movement, not the request
id. Not a gap; not traceable per request from the ledger.

**B1b — the wider class** (any relocation or receipt landing on a negative shelf;
adjustments excluded because a count adjustment states an absolute intent):
81 movements, 85 units absorbed in 30 days. Largest buckets: hold releases at Hub 1 (19)
and Hub 2 (14), clothing CR dispatches to Marathon PE (23) and Trophy (3), manual
transfers (9), refill fulfils (7), excess rebalances into Central (4). Reported, not
repaired in this PR (see Phase E cap).

**B2 — stock/in_transit older than 24 h:** 2 cells, 2 units — the two New Balance cells above.

**B3 — engine requests granted less than the policy need** (policy evaluated with
today's config; on-hand reconstructed at the request instant; reservations by other
open requests not reconstructed): considered 7,389; asked the full gap 6,408; capped by
source on-hand 859; unexplained 122 (footwear 16, clothing 106). The 16 footwear rows
are listed in the probe output; none is the Diesel pattern (all had Central stock ≥ the
gap, and were granted a smaller tranche — consistent with same-scan reservations and the
25 Aug tranche armer, which this probe does not model).

## Phase C — fix at cause (commit 2)

The cause is neither of the three hypotheses in the brief. It is a fourth: the credit
landed atomically but onto a negative destination cell. So:

- **`applyMovement` (the single /stock writer):** an arrival at a real shelf
  (received, opening, return, or the +leg of a transfer) now credits from
  `max(cell, 0)`. The phantom debt it cleared is written into the movement as
  `negativeCleared: { loc: −n }`. Not clamped, deliberately: `adjustment` (a count's
  delta is derived from the live negative and must net), a +leg landing at
  `in_transit` (a negative transit cell is an unmatched-leg signal), and every
  negative leg (the `sold` / `allowNegative` contract is unchanged).
- **`releaseShipment`:** the archive under `released/` is written only after re-reading
  the release movement from the ledger. A release that "succeeds" with no ledger row
  now stays held and reports a visible failure. Never success-with-no-move.
- **`strandedTransitSweep` (new Cloud Function, hourly 07:00–19:00 SA):** the timer the
  hold lane never had. Every unit parked in `stock/in_transit` by the hold lane lands
  at its destination on its own: a held line once holding is off (it is) or 24 h past
  its window; an archived-but-unmoved line under the same `rel_{lineId}` movement id
  the tap uses (a tap that did land is a no-op); an orphan cell after an hour. A
  deleted product is refused and listed at `/stock_exceptions/strandedTransit` for the
  owner to place. Server-side writer `functions/lib/admin-movement.cjs` mirrors the
  client contract (atomic, idempotent, v+1 via read-recheck, negative base). This is
  not the refill engine and the engine still never writes /stock.
- **Holding:** `settings/stockHold/config/enabled` was already `false` (owner, 9 Sep).
  Nothing to switch. With it off the sweep releases anything that ever parks.
- Deploy: `firebase deploy --only functions:strandedTransitSweep` then
  `firebase deploy --only hosting:marathon-club`. No rule change is needed (the
  function uses the Admin SDK; `negativeCleared` is an extra child the movement
  rule does not constrain).

## Phase D — the qty calculation (commit 3)

Central held exactly 1 at the request instant; need was 3; the engine asked
`min(need, Central on-hand) = 1`. The gate worked. Pinned in
`functions/test/fulfil-credit-gap-qty.test.cjs` (full gap when Central can supply it;
−1 and 0 destination cells ask the same; Central 0 asks nothing). Engine unchanged.

## Phase E — data repair (commit 4)

`scripts/repair-fulfil-credit-gap.mjs`, run 2026-09-11 ~13:15 SA with `--commit`.
Rule: credit only where the credit movement's own snapshot shows the source deducted,
the cell was negative before the credit, the product still exists, and no count
adjustment touched the cell after the credit. Nine real `adjustment` movements, reason
`fulfil_credit_repair`, ids `fcr_{creditMovementId}`, before-state at
`/reports/stock_corrections/-P1FA0VhRmYpeV4ODlD5` (and `repair-before-state.json`
alongside the dump).

| dest | product | size | before | after | +units | repairs |
|---|---|---|---|---|---|---|
| hub1 | Lacoste L-Guard Breaker Light Grey Orange | 9 | 0 | 1 | +1 | rel_rrf_onhold_2026-08-15_021 |
| hub2 | Adidas Samba Kseniaschnaider Colorful | 6 | 1 | 2 | +1 | rel_rrf_onhold_2026-08-30_097 |
| hub2 | Air Jordan 1 Low Travis Scott Brown Pink | 7 | 1 | 2 | +1 | rel_rrf_-P0aAEj3P9ya_xyg6vCg |
| hub2 | Adidas Campus Brown Orange | 9 | −1 | 0 | +1 | rel_rrf_-P0a6ntJUkGK_TlrnHiJ |
| hub2 | Adidas Adizero Adios Pro 4 Black Red | 6 | 2 | 3 | +1 | rel_rrf_-P0aHCj8muf-YSyTqi62 |
| hub1 | DIESEL slide brown with black C151593 | 7 | 2 | 3 | +1 | rrf_-P10G0Zdv04lAoaBUYRf |
| hub1 | **Diesel Slide Full Black** | **6** | **0** | **1** | +1 | rrf_-P151_2zzLyo57i8j7Ll |
| hub2 | Diesel Big D Green Orange | 8 | 0 | 2 | +2 | rrf_-P1A0r_TWD_a0VAs-9tX |
| hub2 | Diesel slide black | 9 | 2 | 3 | +1 | rrf_-P1Aib3O0pFGYedRT3yr |

Refused (evidence rule): Air Jordan black red hub2 size 5 (merged since — the merge
counted the cell); Lacoste L-Guard Breaker White orange sole hub1 size 9 and Adidas
Samba White Core Black hub2 size 4 (a count adjustment touched the cell after the
credit; the count settled the truth).

**Not repaired, owner decision needed:**
- The two New Balance 9060 units in `stock/in_transit` (`p1783251345522` sizes 7 and 8).
  The product record is deleted; the owner released that box on 4 Sep so the pairs are
  physically at Hub 2, but under which surviving record they were shelved is not in the
  data (candidates by name: "New balance 9060 creem " `p1784973765907`, "New balance 9060
  Grey white and cream " `p1783414315014`). The sweep lists them hourly under
  `/stock_exceptions/strandedTransit` until placed. Once the owner names the record,
  the fix is one adjustment out of in_transit and one into the twin's hub2 cell.
- The wider class (Phase B1b): 85 units absorbed in 30 days across every arrival type,
  ~72 of them outside the refill-request lens (hold releases, clothing CR dispatches,
  manual transfers, excess rebalances). Above the 50-write cap; the same repair rule
  applies and the probe already lists them. Ask and it runs.

## Phase F — proof (commit 5 and the review rounds)

Tests: `applyMovementNegativeBase.test.js`, `stockHoldReleaseVerify.test.js`,
`fulfilMovementId.test.js` (the "swallowed-id transfer is impossible" property),
`applyMovementMirror.fuzz.test.js` (2,000 seeded sequences through both writers),
`functions/test/transit-sweep.test.cjs` (21), `functions/test/fulfil-credit-gap-qty.test.cjs` (4).

**Mutation kill count: 17/17** (`scripts/mutation-proof-fulfil-credit-gap.mjs`, clean tree,
final head): negative base · adjustment exemption · in_transit exemption · release verify ·
sweep hold-off · sweep timer · window floor · retirement · apportioning · server size fold ·
cold-null transaction · in-flight resume · client in-flight refusal · deleted product ·
server negative base · qty source cap · qty negative destination.

Pre-existing failures on main, unrelated to this branch: `hubIsolation.test.js` (an App.jsx
string assertion from #600), `homeRails` / `themeStrings` / `priceHearts` (Shopify theme
files), `socialSchedule` and six social-caption tests.

## Review rounds (what each found, what changed)

| reviewer | outcome |
|---|---|
| CodeRabbit | check SUCCESS with "Review rate limited" — a spending-cap notice, no review. Substituted below. |
| Fable-vs-spec | 7 gaps, all closed: the stranded-transit report had no reader (Health card + screen added); an archived claim could be spent on a newer parking on the same cell (guard: the cell's last parking must be that line); the swallowed-id property had no test; vitest fakes left empty parents; kill count was not in this report. |
| Sonnet architect | CRITICAL: the server writer's read → recheck → update window could overwrite a POS sale landing in between (Admin SDK bypasses the v+1 rule). Closed: each cell is an RTDB transaction, legs run debit-first, cells carry in-flight stamps, the ledger row is last. |
| Kimi | out of monthly quota (403). Codex excluded by instruction. |
| Substitute second-brain pass (Opus) | 11 findings, all closed: server size fold ("Free Size" → "_"); a held line whose movement already landed is now RETIRED instead of sitting held forever; never release before the window (a switch flipped off must not credit a box still at Central), not-arrived lines wait for the box they were carried to; one cell is apportioned across its lines; the run summary survives a malformed line; probe reconstruction backs out snapshot-less returns; repair evidence rule replaced by an allow-list + freshness gate + `--audit`. |
| Delta review (Sonnet, on the fix rounds) | 2 CRITICAL, both closed: the client's in-flight guard returned an early "idempotent" success that could abandon the second leg (now a retryable refusal); the transaction's cold-null first callback could abort every debit on a cold function (now judged against a pre-read; the fake models the SDK's abort). Its HIGH (release id reuse across shipments) does not apply: a line id IS one parking movement, create-once, and a not-arrived line carries the same units. |

**Phase E audit under the stricter rule** (fresh dump 2026-09-11 ~14:05 SA, `--audit`):
all nine written corrections stand; the three refusals stand (one merged away, two counted
since). One row to read carefully: Adidas Campus Brown Orange hub2 size 9 went −1 → 0 —
the arrived unit was sold after the 4 Sep release (0 → −1), so the phantom debt that
absorbed it is now cleared and 0 is the true count.

**Phase B re-run with the corrected reconstruction:** B1 unchanged (12 requests / 13 units;
2 stranded); B1b unchanged (81 / 85); B3 considered 7,389, full gap 6,408, capped by
source 859, unexplained 122 (footwear 16, clothing 106) — same 16 footwear rows.

## Residuals, stated

- `negativeCleared` is written on every clamped arrival but nothing reads it yet; on such
  rows `before + qty ≠ after` — derive deltas from `qty`. A Health line for units created
  this way is a follow-up.
- The sweep detects orphan cells through the cell's last parking pointer only; a cell
  holding two parkings exposes the newer — self-reporting via the apportioned refusal.
- Product deletion leaves stock cells behind (the New Balance case); refusing a delete
  while cells hold units is outside this PR.

## Probe output (verbatim)

# Fulfil-credit gap probe — 2026-09-11T10:57:54.613Z

## Phase A — Diesel Slide Full Black (p1778157967464) size 6
- barcodes resolve to: p1778157967464; same-name records: p1778157967464
- fulfil movement: {"id":"rrf_-P151_2zzLyo57i8j7Ll","type":"transfer_out","from":"central","to":"hub1","qty":1,"before":{"central":1,"hub1":-1},"after":{"central":0,"hub1":0},"appliedAt":"2026-09-10T08:01:49.727Z","actor":"vWfHqbLEPvRMItXhH0B9NvYW0LG3","reason":"hub1_auto_refill"}
- Central decremented: true; destination credited by arithmetic: true; destination cell was NEGATIVE before the credit: true
- cells now: central 0, hub1 0, in_transit 0
- hold enabled: false (config {"delegates":{"oBvHU5gjelRbnyFW2KnNLP9Rofy2":"mc"},"enabled":false,"updatedAt":"2026-09-09T09:48:56.322Z","updatedBy":"yXTAJTbTewXDXzm1H9akQP3f4vQ2"}); held lines now: 0
- id collision: {"collided":false,"recordedRefillId":"-P151_2zzLyo57i8j7Ll","recordedProductId":"p1778157967464","recordedAppliedAt":"2026-09-10T08:01:49.727Z","trancheIds":[]}
- in_transit cells with units (2):
  - (product record missing) [p1783251345522] size 7 qty 1, parked 2026-09-04T08:09:39.657Z (171h) by rrf_-P0aagkr9NqZbJgFACHK, dest hub2, shipment 2026-09-04_1400, held line false, released archive true, release movement exists false, product exists false
  - (product record missing) [p1783251345522] size 8 qty 1, parked 2026-09-04T08:09:43.329Z (171h) by rrf_-P0aagkxRjUo5_1HV9Q8, dest hub2, shipment 2026-09-04_1400, held line false, released archive true, release movement exists false, product exists false
- Central size 6 at raise (2026-09-09T12:00:04.905Z): 1; now: 0; hub1 at raise: -1
- policy: {"target":3,"minQty":2,"reorderPoint":1,"source":"category_policy"}; need at raise: 3; granted: 1 → source gate worked: qty = min(need, central on-hand)
- hub1 size 6 ledger:
  - 2026-08-22T08:22:41.447Z transfer_in 3 in_transit→hub1 before 0 after 3 stock_hold_release (rel_rrf_-P-US1wiMuBUuPHhgX_8)
  - 2026-08-22T12:04:29.678Z sold 1 hub1→ before null after null  (sold:-P-dLts0nGPyXR5GRMGJ:hub1:p1778157967464:6)
  - 2026-08-23T10:27:50.934Z transfer_in 1 in_transit→hub1 before 2 after 3 stock_hold_release (rel_srcful_2026-08-22_p1778157967464_6_0)
  - 2026-08-24T13:40:11.803Z sold 1 hub1→ before null after null  (sold:-P-o-4BzXHJavf3BKmBX:hub1:p1778157967464:6)
  - 2026-08-25T07:36:03.069Z transfer_out 1 central→hub1 before 2 after 3 source_refill (srcful_2026-08-24_p1778157967464_6_0)
  - 2026-08-28T08:54:30.185Z sold 1 hub1→ before null after null  (sold:-P06ZxsZLLtvIJPcXafU:hub1:p1778157967464:6)
  - 2026-08-28T11:21:58.801Z sold 1 hub1→ before null after null  (sold:-P075mPddbVJqIIlCgVk:hub1:p1778157967464:6)
  - 2026-08-28T11:22:13.972Z sold 1 hub1→ before null after null  (sold:-P075mhOeDDCC0WkKwL-:hub1:p1778157967464:6)
  - 2026-08-28T11:22:18.035Z sold 1 hub1→ before null after null  (sold:-P075mw7h50c5MsV_Nq8:hub1:p1778157967464:6)
  - 2026-09-10T08:01:49.727Z transfer_out 1 central→hub1 before -1 after 0 hub1_auto_refill (rrf_-P151_2zzLyo57i8j7Ll)

## Phase B — last 30 days (from 2026-08-12T10:57:54.613Z)
### B1 fulfilled requests with no corresponding destination credit
| cause | requests | units |
|---|---|---|
| credit_absorbed_by_negative_destination_cell | 12 | 13 |
| parked_in_transit_stranded | 2 | 2 |

| resolved | dest | product | size | qty | cause | units | detail |
|---|---|---|---|---|---|---|---|
| 2026-08-16T08:01:54.482Z | hub2 | Air Jordan black red [p1784540770678] | 5 | 1 | credit_absorbed_by_negative_destination_cell (at release) | 1 | before -2 → after -1, cell now 0 |
| 2026-08-16T10:40:29.252Z | hub1 | Lacoste L-Guard Breaker White orange sole [p1783425331495] | 9 | 1 | credit_absorbed_by_negative_destination_cell (at release) | 1 | before -1 → after 0, cell now 1 |
| 2026-08-16T11:05:44.160Z | hub1 | Lacoste L-Guard Breaker Light Grey Orange [p1779527525476] | 9 | 1 | credit_absorbed_by_negative_destination_cell (at release) | 1 | before -1 → after 0, cell now 0 |
| 2026-08-28T10:00:17.899Z | hub2 | Adidas Samba White Core Black [p1777974765700] | 4 | 1 | credit_absorbed_by_negative_destination_cell (at release) | 1 | before -1 → after 0, cell now 0 |
| 2026-08-31T08:52:43.477Z | hub2 | Adidas Samba Kseniaschnaider Colorful [p1778145299004] | 6 | 1 | credit_absorbed_by_negative_destination_cell (at release) | 1 | before -1 → after 0, cell now 1 |
| 2026-09-04T08:09:40.073Z | hub2 | (product record missing) [p1783251345522] | 7 | 1 | parked_in_transit_stranded | 1 | archived as released 2026-09-04T11:51:02.888Z (rel_rrf_-P0aagkr9NqZbJgFACHK, movement absent); in_transit now 1; product exists false |
| 2026-09-04T08:09:44.085Z | hub2 | (product record missing) [p1783251345522] | 8 | 1 | parked_in_transit_stranded | 1 | archived as released 2026-09-04T11:51:09.779Z (rel_rrf_-P0aagkxRjUo5_1HV9Q8, movement absent); in_transit now 1; product exists false |
| 2026-09-04T09:21:47.376Z | hub2 | Air Jordan 1 Low Travis Scott Brown Pink [p1778140291773] | 7 | 1 | credit_absorbed_by_negative_destination_cell (at release) | 1 | before -1 → after 0, cell now 1 |
| 2026-09-04T09:39:17.351Z | hub2 | Adidas Campus Brown Orange [p1777974404100] | 9 | 1 | credit_absorbed_by_negative_destination_cell (at release) | 1 | before -1 → after 0, cell now -1 |
| 2026-09-04T09:43:47.780Z | hub2 | Adidas Adizero Adios Pro 4 Black Red [p1778858152415] | 6 | 3 | credit_absorbed_by_negative_destination_cell (at release) | 1 | before -1 → after 2, cell now 2 |
| 2026-09-09T07:29:29.200Z | hub1 | DIESEL slide brown with black C151593 [p1787224894681] | 7 | 3 | credit_absorbed_by_negative_destination_cell | 1 | before -1 → after 2, cell now 2 |
| 2026-09-10T08:01:49.940Z | hub1 | Diesel Slide Full Black [p1778157967464] | 6 | 1 | credit_absorbed_by_negative_destination_cell | 1 | before -1 → after 0, cell now 0 |
| 2026-09-11T07:48:52.759Z | hub2 | Diesel Big D Green Orange [p1778150021679] | 8 | 2 | credit_absorbed_by_negative_destination_cell | 2 | before -2 → after 0, cell now 0 |
| 2026-09-11T08:00:13.622Z | hub2 | Diesel slide black [p1787222538915] | 9 | 3 | credit_absorbed_by_negative_destination_cell | 1 | before -1 → after 2, cell now 2 |
- store legs closed by the engine on order dispatch (no per-request movement, not a gap): 3858

### B1b the wider class — arrivals onto negative shelves (30 days, adjustments excluded): 81 movements, 85 units absorbed
| destination · type · reason | movements | units |
|---|---|---|
| marathon-pe · transfer_out · clothing_cr | 20 | 23 |
| hub1 · transfer_in · stock_hold_release | 19 | 19 |
| hub2 · transfer_in · stock_hold_release | 14 | 14 |
| marathon-pe · transfer_out · (no reason) | 5 | 5 |
| central · transfer_out · excess_rebalance | 4 | 4 |
| trophy · transfer_out · clothing_cr | 3 | 3 |
| hub2 · transfer_out · hub2_auto_refill | 2 | 3 |
| hub1 · transfer_out · (no reason) | 2 | 2 |
| hub1 · received · display_registration | 2 | 2 |
| hub1 · transfer_out · hub1_auto_refill | 2 | 2 |
| trophy · transfer_out · (no reason) | 1 | 1 |
| central · received · (no reason) | 1 | 1 |
| trophy · transfer_out · bags_belts_trophy_owned: bags and belts become Trophy-owned (owner | 1 | 1 |
| trophy · transfer_out · clothing_order | 1 | 1 |
| hub2 · transfer_out · seating_move | 1 | 1 |
| marathon-pe · transfer_out · seating_move | 1 | 1 |
| hub1 · transfer_out · source_refill | 1 | 1 |
| hub2 · transfer_out · source_refill | 1 | 1 |

### B2 stock/in_transit units older than 24h: 2 cells, 2 units
- (product record missing) [p1783251345522] size 7 qty 1, 171h, parked by rrf_-P0aagkr9NqZbJgFACHK, dest hub2, shipment 2026-09-04_1400
- (product record missing) [p1783251345522] size 8 qty 1, 171h, parked by rrf_-P0aagkxRjUo5_1HV9Q8, dest hub2, shipment 2026-09-04_1400

### B3 engine requests granted below the policy need (policy = today's config)
- considered 7391; no target today 118; asked the full gap 6413; capped by source on-hand 857; unexplained 121 (footwear 16, clothing 105)
  - FOOTWEAR 2026-08-25T14:30:07.054Z hub1←central Lacoste Slip-On White Stripe size 7: target 5 (explicit), dest had 0, src had 16, gap 5, asked 3
  - FOOTWEAR 2026-08-25T14:30:07.054Z hub1←central Lacoste Slip-On White size 7: target 5 (explicit), dest had 1, src had 12, gap 4, asked 2
  - FOOTWEAR 2026-08-25T14:30:07.054Z hub1←central Lacoste Slip-On White size 8: target 5 (explicit), dest had 1, src had 20, gap 4, asked 2
  - FOOTWEAR 2026-08-25T14:30:07.054Z hub1←central Lacoste Slip-On Powder Blue size 6: target 5 (explicit), dest had 1, src had 13, gap 4, asked 2
  - FOOTWEAR 2026-08-25T15:15:18.967Z hub1←central Lacoste Marice Slip-On Black White size 10: target 5 (explicit), dest had 1, src had 9, gap 4, asked 1
  - FOOTWEAR 2026-08-25T15:15:18.967Z hub1←central Lacoste Slip-On White Stripe size 10: target 5 (explicit), dest had 1, src had 2, gap 4, asked 1
  - FOOTWEAR 2026-09-03T07:15:04.806Z hub2←central Adidas Samba White Core Black size 10: target 2 (category_policy), dest had 0, src had 2, gap 2, asked 1
  - FOOTWEAR 2026-09-03T07:30:04.799Z hub2←central Air Jordan 1 Retro Low OG Zion Williamson Grey Blue size 6: target 3 (category_policy), dest had 1, src had 2, gap 2, asked 1
  - FOOTWEAR 2026-09-03T07:45:04.819Z hub2←central Air Jordan 4 Retro Military Black White size 5: target 2 (category_policy), dest had 0, src had 2, gap 2, asked 1
  - FOOTWEAR 2026-09-03T08:45:05.600Z hub2←central adidas Adizero Adios Pro 4 Lucid Red Black size 11: target 2 (category_policy), dest had 0, src had 5, gap 2, asked 1
  - FOOTWEAR 2026-09-05T12:30:06.751Z hub2←central Air Jordan 4 Retro Black Cat size 7: target 2 (category_policy), dest had 0, src had 12, gap 2, asked 1
  - FOOTWEAR 2026-09-05T13:45:04.806Z hub2←central Air Jordan 4 Retro Military Black White size 10: target 2 (category_policy), dest had 0, src had 2, gap 2, asked 1
  - FOOTWEAR 2026-09-07T12:01:15.150Z hub2←central Diesel Green Black White Orange size 6: target 3 (category_policy), dest had 1, src had 3, gap 2, asked 1
  - FOOTWEAR 2026-09-08T13:15:17.435Z hub1←central Diesel slide red  size 7: target 3 (category_policy), dest had 0, src had 4, gap 3, asked 1
  - FOOTWEAR 2026-09-08T13:45:04.845Z hub1←central Diesel slide black size 11: target 3 (category_policy), dest had 0, src had 4, gap 3, asked 1
  - FOOTWEAR 2026-09-10T09:45:04.852Z hub1←central Timberland GreenStride Motion 6 Low Wheat size 8: target 3 (category_policy), dest had 1, src had 2, gap 2, asked 1

