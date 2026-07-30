# PLAN B — Sneakers sell from the hub (POS writes hub inventory)

**Status: SUPERSEDED BY THE IMPLEMENTATION.** Kept as the record of the decision
and the evidence behind it. Where the built system differs from this plan, the
build is right and the differences are marked `CHANGED IN BUILD` below — do not
read this as a description of what shipped.
Prepared 2026-07-29. Supersedes `PLAN-merge-hub1-into-marathon-pe.md` — see §8.

---

## 1. The idea (owner's, 2026-07-29)

Every location stays exactly where it is. Nothing is merged, nothing is
deactivated. What changes is **who deducts the stock**:

- **Sneakers**: the POS writes the sale **directly against the hub's inventory**
  (`hub1` / `hub2` / `hub3`). No stock transfer between hub and shop, ever. Shops
  hold no sneaker stock.

  > **CHANGED IN BUILD — returns.** This said the POS writes *returns* against the
  > hub too. It does not, and must not: an order return is now a NO-OP, because
  > the stock never left the hub's books, so there is nothing to reverse. The
  > Return control was removed entirely. A POS *refund* is different and does
  > credit the hub — that is the refund path, not the order-return path.
  > Implementing both would have double-reversed a single pair.
- **Clothing**: completely unchanged. The shop holds its own stock, the Assistant's
  clothing orders stay real hub→store transfers, and the refill policy and refill
  engine are untouched.

The ordering workflow is unaffected: the Assistant still orders, Source still
picks, order numbers still identify the pick, the item still physically travels.
Only the stock write moves.

---

## 2. The evidence — the current sneaker ledger is fiction

Live figures, 2026-07-29.

### Shops sell sneakers they do not have on their books

| Location | Footwear on hand | Sneaker sales recorded | Negative footwear cells |
|---|---|---|---|
| marathon-pe | **306** | **2,272** | **361 cells / −474 units** |
| trophy | 42 | 233 | 47 cells / −50 units |
| marathon-pine | 883 | 1 | 1 cell / −1 unit |

At PE, **361 of 412 negative cells (88%) are footwear**. Non-footwear accounts for
51 cells and −80 units. The shop's sneaker book goes negative structurally,
because the sale is recorded at the shop while the stock lives at the hub — and
the sale routinely beats the pick transfer.

**The −474 unit hole at PE is not a mis-route. It is what this model produces.**

### Every hub→shop lane is per-sale sneaker picking

| Flow | Moves | Single-unit | Sneaker | Building |
|---|---|---|---|---|
| `hub1 → marathon-pe` | 1,471 | **1,471 (100%)** | 1,463 (99.5%) | B → B |
| `hub3 → marathon-pine` | 511 | **511 (100%)** | 511 (100%) | C → C |
| `hub2 → trophy` | 901 | 700 (78%) | 207 | B → B |
| `hub2 → marathon-pe` | 2,796 | 2,283 (82%) | 630 | B → B |
| `hub1 → trophy` | 39 | 39 (100%) | 39 | B → B |

`hub3 → marathon-pine` is 100% single-unit and 100% sneakers in **Building C**.
This is not a Building B artefact — it is how the whole business runs.

**≈2,850 single-unit sneaker picks** disappear under this model.

### Where footwear actually lives

`central 8,174 · hub1 3,832 · hub2 3,253 · marathon-pine 883 · marathon-pe 306 ·
trophy 42 · hub3 7`

The hubs and Central hold the sneakers. The shops hold rounding error — except
Pine (883), which needs explaining before cutover (§6).

---

## 3. What changes, and where

| Layer | Change |
|---|---|
| **POS (`marathon-pos-app`)** | For a sneaker line, deduct at the product's hub instead of the shop. Same for returns. **This is the whole change.** |
| **store-app** | Stop writing the hub→shop transfer for sneaker order fulfilment. |
| Refill engine | **None.** Clothing-only; sneakers are invisible to it. |
| Display Checks | **None.** Clothing/perfume only. |
| Refill requests (`restock_log`) | **None** in this PR — see §7. |
| RTDB rules | **None.** |

### The routing key already exists

`product.hubs` (`hub1` / `hub2` / `hub3`) is already on every product and is
already what the Assistant routes on. The POS does not need a new mapping — it
needs to read the one that exists.

### The POS invariant this reverses

`marathon-pos-app/src/stock/saleStockMovements.js` states:

> *"The POS writes ONLY shop (sellable) locations — never warehouse/hub stock. A
> line at a non-sellable/unknown store yields a SKIP (reported), never a guess."*

`hub1/2/3` are `sellable: false`. So this is a **deliberate reversal of a stated
design rule**, not a tweak. It must be replaced by an equally explicit rule:

> a sneaker line deducts at `product.hubs[0]`; a clothing line deducts at the
> shop; anything unresolvable still SKIPs and is reported — never guessed.

**This is a two-repo, coordinated change.** Both apps share one database.

---

## 4. Why this beats merging Hub 1 into PE

| | Merge plan | Plan B |
|---|---|---|
| Lanes fixed | 1 of 5 (hub1→PE) | **all 5** |
| Picks eliminated | ~1,470 | **~2,850** |
| Fixes shop footwear negatives | no | **yes — removes the cause** |
| Works for Pine / Building C | no | yes |
| Locations changed | hub1 deactivated | **none** |
| Reconciliation needed | 87 products, negatives | **cutover sweep only** |
| PE inventory jump | 6,510 → ~10,369 | none |
| Reversible | ledger replay | **flip the routing rule** |
| Requires POS change | no | **yes** |

The merge changes *where stock lives*. Plan B changes *who deducts it* — which is
the actual defect.

---

## 5. Open questions — must be answered before building

1. **Which hub does a return go back to** — the one the sale deducted from
   (needs storing on the sale line), or the product's current `hubs[0]`? They
   diverge if a product is re-hubbed. Recommend: **store the deducting location
   on the sale line** and return to exactly that.
2. **A product in more than one hub.** `product.hubs` is an array. Which hub
   does a sneaker sale at Trophy deduct from if the product lists `hub1` and
   `hub2`? Needs a deterministic rule — probably by the shop's serving hub.
3. **Hub cells going negative on sale.** Today a shop cell absorbs the error.
   Under Plan B an uncounted hub cell can go negative — at a hub holding
   thousands of units, where it is harder to spot. Decide: block the sale,
   or allow-negative and surface it (consistent with the A1 dispatch rule).
4. **Pine holds 883 footwear units with ~0 POS sneaker sales.** Either Pine is
   not selling through POS yet, or its sales are recorded elsewhere. **Resolve
   before cutover** — Plan B assumes POS is the only sneaker sale path.
5. **The shops' existing sneaker stock** (PE 306, Trophy 42, Pine 883): swept
   back to the hubs at cutover, or left to drain? Recommend sweeping, so no
   shop holds a sneaker cell that nothing will ever deduct from again.
6. **The 361 + 47 existing negative footwear cells.** Plan B stops new ones but
   does not clear the old. Clearing is a separate reconciliation (the PE −439
   hole is already an open item).

---

## 6. Sequencing

1. Answer §5. Nothing is built before question 4 is resolved.
2. Sweep shop sneaker stock back to the hubs (ledger movements, dry-run first).
3. POS change + store-app change, developed together, reviewed together.
4. Cutover in a closed window with the tills OFF, both apps deployed **together —
   not merely in sequence**. They share a routing contract: for the window
   between the two deploys, one side has stopped writing the hub→shop transfer
   while the other still deducts at the shop, and every sneaker sale in that gap
   lands on a shop cell holding zero. Deploy back-to-back with no trading in
   between; if the second deploy fails, roll the first one back rather than
   leaving the pair split.
5. Watch for a week: hub negatives, sneaker sales landing at the right location.

---

## 7. Explicitly deferred (owner's instruction)

**The refill trigger stays as it is.** Today `App.jsx:8697` writes the refill on
`STATUS.COLLECTED` — the handover — so a shoe fetched, shown and handed over
generates a refill even when it comes straight back, and the return reverses it.

Plan B does **not** change that. But note the coupling honestly: once sneakers
sell from the hub, "refill the shelf" loses its meaning, because the shelf *is*
the hub. Plan B will make the refill-trigger redesign more urgent, not less.
That remains its own PR.

---

## 8. Recommendation

**Adopt Plan B; drop the Hub 1 merge.** The merge treats a symptom in one lane;
Plan B removes the cause in all of them, changes no locations, needs no
reconciliation, and is reversible by flipping a rule.

The cost is real and should not be glossed: it is a **cross-repo change that
reverses an explicit POS design rule**, and it needs a coordinated release.

> **CHANGED IN BUILD — reconciliation.** "No stock is restated" was wrong. The
> cutover DOES require a reconciliation: every sneaker at PE and Trophy is swept
> back to its hub and their negative footwear cells are healed to zero, and that
> sweep must re-run immediately before the deploy because the shops re-accumulate
> while the old system is still running. What the plan meant — and what remains
> true — is that no HUB MERGE is needed and no location is restated. The shop side
> very much is.

**Classification: architecture.** Frozen band under maintenance mode. The
evidence here is the strongest of any change proposed so far, but unfreezing is
the owner's call, and it must land as its own PR pair in its own window.
