# Inventory was not being tracked

Every variant this program has ever pushed to Shopify had inventory tracking
**off**. Shopify therefore treated every size as infinitely available.

---

## What was actually wrong

Read off the live shop, 2026-08-16:

```
ACTIVE products: 61
variants: tracked=0  untracked=389  nonDENYpolicy=0
```

`inventoryPolicy` was already `DENY` on all 389 — that one defaults correctly.
**Tracking was the whole defect.**

### Why it was off

`reconcile.mjs` creates products with the `productSet` mutation and never
populated `ProductVariantSetInput.inventoryItem`. On that path `tracked`
defaults to **false** — unlike the Shopify admin UI and unlike
`productVariantsBulkCreate`, both of which default it on.

The evidence is unambiguous. Products created before this program existed are
tracked; every product this program created is not:

| created | by | `tracked` | `inventoryPolicy` |
|---|---|---|---|
| 2025-08-10 | by hand / an earlier tool | `true` | `DENY` |
| 2025-08-11 | by hand / an earlier tool | `true` | `DENY` |
| 2026-08-13 → | this program's `productSet` | **`false`** | `DENY` |

### What it cost

- **Nothing ever showed sold out.** A size at zero stock rendered as buyable.
- **The shop could oversell** — sell stock that does not exist, in a business
  where every unit is a single second-hand item.
- **ABC analysis and sell-through stayed empty**, because Shopify has no
  quantity history to compute them from.

### The part that was already right

Two things were working the whole time, and it matters for the fix:

1. **The reconciler pushes every size in the run as a variant, including sizes
   at zero.** It never skips one. `setAvailable()` writes an absolute quantity
   per mapped size, zeros included, and refuses to publish a product whose
   catalogue sizes do not all have a Shopify variant.
2. **The quantities it wrote were correct.** Shopify stored them and ignored
   them. Read back on 2026-08-16, `lace-boot-white-navy` held
   `6:4 7:7 8:8 9:6 10:3 11:1 12:0 13:0` — exactly the `/stock` network totals,
   with the two zero sizes present as real variants.

So the bug is one boolean, and flipping it makes numbers that were already
correct start counting.

---

## The fix

### 1. Tracked at birth

`TRACKED_VARIANT` in `inventory.mjs` is what every pushed variant carries:

```js
export const TRACKED_VARIANT = {
  inventoryPolicy: "DENY",           // never sell past zero
  inventoryItem: { tracked: true },  // and count what is there
};
```

`inventoryItem` deliberately carries **only** `tracked`. The same input accepts
`cost`, and cost here would be `stockPrice` — internal, and not even a real cost
(it is a B2B wholesale *selling* price). It must never reach Shopify.

### 2. Re-checked on every run — self-healing

The reconciler's read-back now fetches `inventoryPolicy` and
`inventoryItem { tracked }` for every variant, and enforces them on **both** the
create and the reconcile path. So a product created before this shipped, or one
whose tracking was switched off by hand in the admin, is repaired the next time
its intent is applied — without anyone remembering to.

Cost for a correct product is **zero mutations**: `untrackedVariants()` returns
nothing and nothing is sent.

It **fails closed**. An untracked variant is a variant that can oversell, so a
failure to enable tracking unpublishes the product and refuses, rather than
listing something that can sell stock the shop does not hold. `enforceTracking`
also reads the mutation's own echo back and throws if tracking did not actually
take — "it returned no errors" is not good enough at this gate.

### 3. Backfill for what the reconciler will not revisit

`scripts/shopify/backfill-inventory-tracking.mjs`. The reconciler only acts when
an intent *changes*, so a settled live product never re-enters its worklist.

```sh
node scripts/shopify/backfill-inventory-tracking.mjs                # dry run
node scripts/shopify/backfill-inventory-tracking.mjs --live-only    # dry run, live products only
node scripts/shopify/backfill-inventory-tracking.mjs --commit       # apply
node scripts/shopify/backfill-inventory-tracking.mjs --commit --pids p1,p2
```

Per product, in order:

1. read the mapped product's variants
2. set `tracked: true` / `inventoryPolicy: DENY` on any that is not already both
3. **re-push the current network quantity** for every mapped size from `/stock`

Step 3 is not optional. Flipping tracking on stale numbers would put the
storefront's idea of stock live without checking it — the same class of bug in
the other direction.

Only variants **this program mapped** are touched. A variant added by hand in
the admin is not ours, and turning its tracking on would put a number on the
storefront that nothing in this system maintains.

Writes Shopify variants and inventory levels **only**. No RTDB writes at all.
Nothing is created, published, unpublished, archived or deleted. Safe to re-run:
an already-correct product costs one read and no mutation.
