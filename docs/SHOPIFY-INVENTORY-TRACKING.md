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

### Why it was off — proved, not inferred

`reconcile.mjs` creates products with the `productSet` mutation and never
populated `ProductVariantSetInput.inventoryItem`.

The first draft of this document argued from correlation: products created by
hand in 2025-08 are `tracked: true`, everything this program created from
2026-08-13 on is `tracked: false`. That is suggestive but does not rule out a
shop-level default, so it was replaced with an **isolating probe** — one
`productSet` call, one product, two variants differing in exactly one field,
read back and then deleted:

| variant | `inventoryItem` in the input | read back |
|---|---|---|
| A | *omitted* — what the reconciler used to send | `tracked=false`, `policy=DENY` |
| B | `{ tracked: true }` — what it sends now | `tracked=true`, `policy=DENY` |

Same mutation, same product, same moment. `productSet` leaves `tracked` at
**false** when the field is absent, and `inventoryPolicy` genuinely does default
to `DENY`. The probe product was a DRAFT (never on any sales channel) and was
deleted in the same run.

The correlation still holds and is worth recording:

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

Only variants **this program mapped** are touched by the backfill. A variant
added by hand in the admin is not ours, and turning its tracking on would put a
number on the storefront that nothing in this system maintains.

**The reconciler is deliberately wider.** It enforces tracking on *every*
variant of a product it is about to publish, mapped or not — because a stray
variant on our own product, about to go public, untracked and therefore
infinitely sellable, is an oversell waiting to happen. Tracked at whatever
quantity it holds (usually zero) fails towards *unbuyable*, which is the safe
direction; the alternative is a size nobody can fulfil taking orders.

#### Every catalogue size must still have a variant

`reconcile.mjs` refuses to publish a product whose catalogue sizes do not all
have a Shopify variant. The backfill now carries the same check — because the
reconciler never revisits a settled live product, so a size added to a record
*after* it went live has no variant and nothing else would ever notice. Such a
product is reported `unmapped-size` and skipped rather than quietly having the
subset that happens to be mapped priced as if it were the whole run.

Writes Shopify variants and inventory levels **only**. No RTDB writes at all.
Nothing is created, published, unpublished, archived or deleted. Safe to re-run:
an already-correct product costs one read and no mutation.

#### The size-key guard

`networkTotals` re-applies `stockSizeKey` to whatever size list it is given,
while the ID map's keys came from `encodeSizeKey`. For every token the live
catalogue uses the two agree — but **not** for a literal `"Free Size"`, which
encodes to `Free_Size` in the map and folds to `_` in `/stock`. Given such a
key, `networkTotals` finds no matching cell, returns `0`, and the backfill would
then *track* that variant and set it to zero in the same pass: real stock turned
into a silent, instant sold-out. The same class of bug as the one being fixed,
pointing the other way.

`reconcile.mjs` already refuses that mismatch before publishing. The backfill
reads `/shopify_sync` directly and never goes through that check, so it carries
its own: a product with a divergent mapped key is reported `size-key-mismatch`,
skipped, and the run exits non-zero.

#### Read cost

Location names come from a REST `?shallow=true` read (`shallowKeys`), not a
`db.ref("stock").get()` — that would pull every location × every product × every
size to read off ten top-level keys, and this project has a Firebase
bandwidth-cost incident on record. The per-product stock cells are then fetched
one request per location, **all in flight at once** rather than ten sequential
round-trips per product.

---

## What the operator still has to check (A4)

The code half is done: every size in the run is a variant, zero-stock sizes
included, and after this their quantities finally count. What no code in this
repo can settle is how the **theme** draws a size that has run out.

In the theme editor, on the product page's variant picker, there is a setting
along the lines of *"Show unavailable variants"* / *"Hide unavailable variants"*.
It must be set to **show** them. Hiding a sold-out size makes a nine-size run
look like a seven-size run and tells the shopper nothing; showing it struck
through tells them the shoe exists in their size and is gone.

Check it on a product that genuinely has a zero-stock size — for example
`lace-boot-white-navy`, whose sizes 12 and 13 are at zero while 6–11 are not.
Before the tracking fix, all eight rendered identically.
