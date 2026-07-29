# PLAN — Merge Hub 1 into Marathon PE (one inventory)

**Status: PLAN ONLY. Nothing built, nothing written, no data touched.**
Author: prepared 2026-07-29 at the owner's request. Read-only investigation.

---

## 1. What this is

Hub 1 and Marathon PE stop being two stock locations and become **one inventory
pool**. A sale deducts from that pool directly; a return goes straight back into
it; no transfer is written between them ever again.

Everything else — how orders are routed, picked, numbered and fulfilled — stays
**exactly** as it is today.

### In scope

- `/stock/hub1` is folded into `/stock/marathon-pe` and `hub1` is deactivated as
  a **stock location**, following the exact pattern of PR #278 (Base + Studio →
  Central).
- The one code path that writes stock *into* hub1 is repointed (see §6).

### Explicitly NOT in scope — separate PR, owner's instruction

- **Changing what triggers a sneaker refill request.** Today the refill is
  written when an order is marked COLLECTED — the physical handover — not when
  the POS records a sale. An item that is fetched, shown and handed over
  generates a refill even if it is returned an hour later, and the return
  reverses it. The owner intends to move this to "POS sale writes the refill,
  POS writes directly to and from hub inventory". **That is a different PR and
  this plan must not drift into it.**
- Hub 2, Hub 3, Trophy, Pine, Central: untouched.
- The refill engine: untouched (see §5).

---

## 2. The evidence this is the right call

All figures read live from RTDB on 2026-07-29.

**They are already the same building.** `src/components/stock/transitLanes.js:11`
records the physical map: `Building B: marathon-pe, trophy, hub1, hub2`.

**The transfers between them are ceremonial.** From the movement ledger:

| Flow | Movements | Units | Units per move |
|---|---|---|---|
| `hub1 → marathon-pe` | 1,466 | 1,466 | **exactly 1.00** |
| `marathon-pe → hub1` | 1,351 | 2,431 | 1.80 |

One unit per move, 1,466 times, is not replenishment — it is a staff member
fetching a single pair for a customer and logging a transfer for it. The reverse
flow is the put-back. Together **2,817 movements, ~7% of all 39,154 movements
ever recorded**, are spent moving stock between two rooms of one building.

**They hold different things, so the merge has almost nothing to reconcile.**

| Location | Units | Products | Composition |
|---|---|---|---|
| `hub1` | 3,859 | 478 | **99.9% Footwear** (3,855 units; 4 accessories) |
| `marathon-pe` | 6,510 | 1,450 | Clothing 5,412 · Accessories 567 · Footwear 290 · Perfume 208 |

Hub 1 is the shoe room; PE is the floor. **Only 87 products appear in both.**

---

## 3. The architectural fact that makes this safe

`hub1` exists in **two independent namespaces that merely share a name**:

| Namespace | Where | Used for |
|---|---|---|
| `/locations/hub1` | location registry, `/stock/hub1/...` | **a stock location** |
| `order.hub`, `product.hubs` | order + product records | **a routing label** — Assistant routing, Source tab, dispatch |

**Nothing maps one to the other.** `/stock` is only ever addressed through
`stockCellPath(loc, …)` with a location id. `product.hubs` never indexes stock
(verified: every `.hubs` reference in `src/` is catalogue/routing only).

So hub1 can be retired as a *stock location* while surviving completely as a
*routing label*. That is precisely the outcome asked for.

---

## 4. What stays identical (verified, not assumed)

| Behaviour | Stays? | Why |
|---|---|---|
| Central's team "transfers to Hub 1" | ✅ | becomes a transfer to the merged pool; the workflow and the label can stay |
| Assistant routes sneaker orders to Hub 1 | ✅ | `order.hub` / `product.hubs`, never a stock read |
| Source screen's Hub 1 tab | ✅ | order-filtered by `order.hub`, not by stock |
| Order number identifies the pick | ✅ | untouched |
| **Sneaker refill request → Source** | ✅ | `App.jsx:8697` `logRestock({hub: order.hub})` on COLLECTED → `/restock_log` + `/restock_requests`. **Never reads or writes `/stock`.** |
| Refill reversal on return | ✅ | same order-driven path |
| POS sells from Marathon PE | ✅ | now from one pool instead of two |

---

## 5. The refill engine is not affected

- Engine routes are `{hub2: central, marathon-pe: hub2, trophy: hub2}` —
  **hub1 does not appear**.
- `hub1` has **0 explicit refill targets**.
- hub1's stock is footwear → `productType: "sneaker"` → the engine's `isClothing`
  gate ignores it entirely.

**One exception to handle:** the 4 accessory units at hub1 are
`productType: "clothing"`, so after the merge they become engine-visible at
marathon-pe. Trivial in size, but it must be a deliberate decision, not a
surprise. Recommend clamping/excluding them in the merge script.

---

## 6. The one real coupling — Source "Transfer & Fulfil"

`src/App.jsx:11263` — Transfer & Fulfil moves real stock **into** the Source hub:

```js
applyMovement({ type: "transfer_out", from: pick, to: destHub, … })
```

`destHub` is `hub1` or `hub2` **as a stock location**. If hub1 is deactivated
without changing this, fulfilment into Hub 1 writes to a dead location.

**Fix:** map `destHub === "hub1" → "marathon-pe"` at the single call site. One
mapping, one place. This is the only code change the merge strictly requires.

Two more places name hub1 as a stock destination and need updating so they stop
offering a dead location:

- `src/components/stock/distributionSuggest.js:30,48,55` — hub1 is in
  `DISTRIBUTION_DESTS` with a shoe run of 2; the Initial Distribution Wizard
  would keep suggesting sends to it.
- `src/components/stock/transitLanes.js:37` — hub1 is mapped to Building B for
  the transit/QR lanes.

---

## 7. Work items

1. **Reconciliation dry-run script** (read-only) producing a per-product,
   per-size before/after table: hub1 qty, PE qty, merged qty. Saved as a CSV
   artefact, reviewed by the owner **before** anything is written.
2. **Decide the negatives.** hub1 currently holds ~125 negative cells
   (≈ −146 units). Merging them as-is drags that error onto PE's books.
   Recommend clamping to 0 and recording the clamped total in the report, the
   same call taken in the PE reconciliation work.
3. **Merge script**, modelled on `_merge-base-studio-into-central.mjs` (#278):
   ledger-paired `transfer_out`/`transfer_in` movements per cell — never a raw
   qty write — so the merge is auditable and reversible from the ledger.
4. **Repoint `destHub`** in Source Transfer & Fulfil (§6).
5. **Update** `distributionSuggest.js` and `transitLanes.js`.
6. **Deactivate** `/locations/hub1` (`active: false`) — never delete. History
   referencing it must keep resolving, exactly as Base and Studio do.
7. **Drain in-flight work first**: no open transfers or in-transit parcels
   to/from hub1 at cutover.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| PE's on-hand jumps 6,510 → ~10,369 units overnight | **Operational, certain** | Nothing is created — it is stock already owned, now on the right books. Brief staff before they see it; every stock report and value figure moves. |
| A stock write to hub1 after cutover | Medium | Deactivate the location; `applyMovement` validates against `/locations`. Cut over in a closed window. |
| Historical reports reading hub1 movements | Low | Ledger is append-only; hub1 stays resolvable while inactive (the #278 precedent already proves this works). |
| The 87 overlapping products merge incorrectly | Medium | Dry-run table reviewed before the write; per-size sums, not per-product. |
| Source fulfilment into a dead location | **High if missed** | §6 — the single `destHub` mapping. Must ship in the same PR. |

**Rollback:** the merge is a set of ledger movements. Reversing it is the
mirror set plus reactivating the location. The dry-run CSV is the exact recipe.

---

## 9. Governance (maintenance-mode evidence questions)

1. **What breaks today?** 2,817 phantom movements (~7% of all stock movements)
   recording stock "moving" between two rooms of the same building. Staff time,
   ledger noise, and two sets of books for one physical inventory.
2. **What is the evidence?** §2 — measured, not asserted. 1.00 units per move.
3. **Who is affected?** PE floor + Hub 1 shoe room staff; Central dispatch
   unchanged; POS unchanged.
4. **What is the blast radius?** One store's stock. No engine change, no rules
   change, no POS change.
5. **What is the rollback?** §8.
6. **Can it wait?** Yes — this is an architecture change, the frozen category.
   It should be scheduled deliberately, not bundled with feature work.

**Classification: architecture.** Under maintenance mode this is the lowest
priority band and is frozen by default. The evidence is unusually strong, but
the decision to unfreeze is the owner's, and it should land as its own PR in its
own window — never bolted onto the taxonomy work.

---

## 10. Recommended sequence

1. Owner approves this plan.
2. Dry-run reconciliation → owner reviews the CSV.
3. Separate branch + PR, full 5-stage review.
4. Cutover in a closed window; reconciliation report committed.
5. **Then, separately:** the POS-triggered refill redesign (§1, out of scope).
