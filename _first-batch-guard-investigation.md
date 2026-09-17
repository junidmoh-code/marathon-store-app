# First batch, rebuilt — the Hub 2-presence guard (Phase 3 of the incident plan)

Follows `_first-batch-incident-2026-09-17.md` (what happened) and PR #609
(the revert). This is what was investigated before the path was switched
back on, and what the path now is.

## 1. The rule (owner, authoritative)

- If the product exists at Hub 2 by ANY means — stock, a cell, a pending
  inbound, any prior presence — the shop requests from Hub 2. Never Central.
- Central-to-shop applies only to a product Hub 2 has never held, and only
  for that first batch. Then the normal route: shop from Hub 2, Hub 2 from
  Central.
- Sneakers and slides are out entirely; every other category is in.
- Hub 2 must remain a valid source for every product at all times.

## 2. What "exists at Hub 2" is, in the data

| signal | where it lives | read scoped? | counts as presence |
|---|---|---|---|
| a stock cell, any qty (qty 0 included — cells are never deleted, so a qty-0 cell is prior presence) | `/stock/hub2/{pid}` | yes (the screen holds /stock; the trigger reads one node) | **yes** |
| a pending inbound / an open Hub 2 request | `/refill_engine/open/hub2/{pid}` (every engine request holds a lock; the trigger's own deferred leg too) | yes | **yes** |
| an open Hub 2 request the caller happens to hold | `/refill_requests` (indexed by time only — a per-product query is a whole-node read; not read for the guard) | n/a | yes when given |
| an explicit target row | `/stock_targets/hub2/{pid}` | yes | **no** — a plan, not presence (#608's owner spec put explicit-row products ON the path); reported as informational |
| a `hubs` tag on the record (4,684 of 4,913 products) | `/products/{pid}/hubs` | yes | **no** — an intention, not existence (memory: "a hubs tag is an intention, a /stock cell is a fact") |
| a qty-0 seed cell stamped AT OR AFTER the request's own `createdAt` — this Solve's own seeds (same `now`), the trigger's, another shop's Solve in the same window | `/stock/hub2/{pid}/{sizeKey}.updatedAt` vs `/refill_requests/{id}.createdAt` | yes | **no** — not PRIOR presence. Judged by shape + stamp, never by a client-supplied list (`createdFrom.hub2Seeded` is information only: the first cut listed only first-batch sizes, so a normal-path size's seed withdrew the request and two shops' Solves withdrew each other — adversarial review) |
| an engine lock at Hub 2 claimed at/after the request's `createdAt` | `/refill_engine/open/hub2/{pid}/{sizeKey}.createdAt` | yes | **no** — the scan running in the trigger's gap (Hub 2 just became managed), not prior presence (Sonnet review). A lock that predates the request is |
| a HELD LINE in the hold lane — Central's fulfil of a Hub 2 request parked at `stock/in_transit`, Hub 2 not yet credited, the engine's lock closed on the next scan | `/settings/stockHold/held/hub2/{lineId}.productId` (a small node, read once) | yes | **yes** — units on the way to Hub 2 (`held_inbound`; Fable review H1) |
| an open Hub 2 request WITHOUT a lock — the on-hold "coming tomorrow" flow (`onHoldRefill.js`) writes `hub2←central` rows and can claim no lock | `/refill_requests` — time-indexed; a per-product read needs `.indexOn: ["productId"]` | only with the index | **yes when readable** — the query runs behind `config/refillEngine.refillRequestsProductIdIndex: true` (client and trigger); until the rule is pasted and the flag flipped it is a documented residual, never a whole-node read |

One definition, two twins pinned equal by test: `firstBatchCore.hub2PresenceSignals`
(client) and `first-batch.cjs hub2PresenceSignals` (server). The repair script
uses the server's.

**RULE TO PASTE** (database.rules.json is never touched by this work), under
`"refill_requests"`:
```json
".indexOn": ["productId"]
```
then set `config/refillEngine/refillRequestsProductIdIndex = true`. Without it
the open-request signal is not read anywhere (the other four signals are).

## 3. Where the guard runs

1. **Solve time** (`NetworkTransfer.jsx`): `firstBatchEligible` now REQUIRES
   `hub2Present === false` and fails closed on anything else. The panel judges
   from the /stock node it holds plus the live lock table (read when the panel
   opens); the WRITE judges again from a fresh lock read — an unreadable lock
   table is the old Solve.
2. **Request creation** (`firstBatchLeg`): before any lock is claimed, and only
   then — "already judged" is decided by the SERVER-OWNED shop lock naming
   this request, never by a field on the row (`firstBatch.lock` /
   `firstBatch.hub2Leg` are client-writable; Fable review M1) — the trigger
   reads Hub 2's node, its lock table, the held lines (and, behind the index
   flag, the open Hub 2 requests); presence → Hub 2 seeded first under the
   CLIENT's cell key (`'Free Size'`/`''` → `_`, never the lock key), the
   request withdrawn by CAS with `first_batch_hub2_present` (a reason: an
   engine-style withdrawal, no cooldown, no rejection learned at the shop's
   cell), the normal route takes over. The client judges the same RAW lock
   node (not the pruned one) plus the held lines (Fable M4).

## 4. Hub 2 is always seeded

`buildFirstBatchSolveUpdate` seeds Hub 2 for EVERY qualifying size in the same
atomic write as the shop's requests. #607 left first-batch sizes un-seeded so
the clothing rule could not raise a second hub2←central; the engine's own lock
was always the real duplicate guard, and an un-seeded Hub 2 is a Hub 2 that is
not a valid source. Consequence, verified against the real `computeRefillPlan`:
the engine raises hub2←central from Central's remainder on its next scan (the
shop's lock reserves the shop's units first — `sourceReserved`), and the
trigger's deferred leg defers to that lock (`deferredTo: engine`). One Hub 2
request stands either way.

## 5. Location history

**Which shop** (unchanged from #608): own positive row > style-code siblings'
shop cells > the category's placement; ties fall through; no signal → today's
default. Live placement 2026-09-17 (products carried per shop): bags Trophy
356 / PE 97; caps-beanies PE 295 / 0; suits 0 / 49; tracksuits 176 / 88;
t-shirts 457 / 23; watches 1 / 44; belts 2 / 21; ladies-tracksuits 2 / 37.

**The split** — what history CAN decide: which SIZES go to the shop first. A
request's quantity is regrown by the engine's reconcile; a size not requested
for the shop is simply the normal route. Per size, at the nominated shop:
siblings' size cells (most specific) else the category's size placement when
≥ 10 lines are kept; a size none of them carries stays at Hub 2 first, with a
sentence on the panel. Live examples: tracksuits XXXL (Trophy 34 lines, PE 13),
t-shirts XXXL (PE 15 of 457, Trophy 6 of 23), suits S (4 of 49 at Trophy).
Style-code siblings are nearly absent for clothing (965 of 4,913 products
carry a stamp), so the category tier is the one that speaks.

## 6. Live scope check (2026-09-17)

28 effective category keys with products; `categoryPolicy` keys bags, belts,
caps-beanies, fitted-caps, gloves, perfumes, slides, sneakers, soccer-jerseys,
sunglasses, underwear. Central-stranded products: 361 — sneakers 84 and slides
6 (out), t-shirts 105, pants 62, hoodies 43, golf-t-shirts 26, tracksuits 10,
watches 6, jackets 5, suits 4, shorts 4, bags 2, chains-bracelets 2,
caps-beanies 1, keyless clothing 1 (in). Pinned as a test.

## 7. What the tests reproduce

- **Half 1 of the incident** — a product with Hub 2 presence never produces a
  standing shop-from-Central request: at the screen (an engine lock at Hub 2
  → the old Solve, no request key minted) and at the trigger (a foreign qty-0
  cell / units / an engine lock / an array-coerced row → withdrawn, Hub 2
  seeded, the real engine then serves the shop from Hub 2).
- **Half 2** — a product whose first batch went to the shop sources its next
  refill from Hub 2: Central fulfils, the deferred leg raises Hub 2's request
  from the remainder, Hub 2 receives, the shop sells, the real engine's next
  plan is `trophy←hub2`, never `trophy←central`.
- 300-creation property (presence ⇒ withdrawn + no lock; none ⇒ claimed; own
  seeds never count; no quantity changes), the 600-world fuzz with a presence
  invariant, the 300-world path-off fuzz, the repair's idempotency.
- Mutation proof: `scripts/mutation-proof-first-batch.mjs`, 85 mutants.

## 8. Review provenance, residuals, owner decisions

- CodeRabbit: "Review rate limited" on every HEAD of PR #610 (green check, no
  review). Substitute per spec: Sonnet architect, Fable-vs-spec, adversarial
  Opus with throwaway repros against the real modules, the two property
  fuzzes through the real trigger + real `computeRefillPlan`, mutation proof.
- Fixed from review: Sonnet MEDIUM (lock claimed in the trigger's gap);
  Fable H1 (hold-lane inbound), H2 (repair's own-seed rule), M1 (judged-once
  on the server lock; own seeds verified by stamp), M4 (raw lock node);
  Opus CONFIRMED 1–2 (own seeds by stamp, not list), 3 (open request without
  a lock — behind the index flag), 5 (tests now compose the real Solve's
  output shape: repros 1 and 2), the seed-key phantom, the all-held panel.
- **Residual until the rule is pasted:** the on-hold flow's lock-less open
  Hub 2 request is not a signal (Opus 3). **Owner decisions flagged:** count a
  POSITIVE explicit `/stock_targets/hub2` row as presence? (Fable M2 — today a
  plan, not presence, per the #608 spec); count `retryState`/`rejectStreak`
  at Hub 2 as prior engagement? (Fable M3). **Accepted:** Central can be
  over-promised by one scan when the engine scans between the Solve's write
  and the trigger's lock claim (Opus 4) — the engine's next scan withdraws
  the shop's request with a reason and serves it from Hub 2; anyone with a
  `stockRole` can already write arbitrary `/refill_requests` rows (this work
  hardens the guard against that, it does not close it).
