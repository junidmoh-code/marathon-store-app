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
| this Solve's OWN qty-0 Hub 2 seeds | written in the same atomic update as the request; listed on it as `createdFrom.hub2Seeded` | — | **no** (they would otherwise make every first batch withdraw itself) |

One definition, two twins pinned equal by test: `firstBatchCore.hub2PresenceSignals`
(client) and `first-batch.cjs hub2PresenceSignals` (server). The repair script
uses the server's.

## 3. Where the guard runs

1. **Solve time** (`NetworkTransfer.jsx`): `firstBatchEligible` now REQUIRES
   `hub2Present === false` and fails closed on anything else. The panel judges
   from the /stock node it holds plus the live lock table (read when the panel
   opens); the WRITE judges again from a fresh lock read — an unreadable lock
   table is the old Solve.
2. **Request creation** (`firstBatchLeg`): before any lock is claimed, and only
   then (judged once — after the shop lock exists the engine may legitimately
   raise Hub 2's own leg and that lock must not read as prior presence), the
   trigger reads Hub 2's node and lock table; presence → Hub 2 seeded first,
   the request withdrawn by CAS with `first_batch_hub2_present` (a reason: an
   engine-style withdrawal, no cooldown, no rejection learned at the shop's
   cell), the normal route takes over.

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
