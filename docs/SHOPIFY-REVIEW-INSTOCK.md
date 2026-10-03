# Shopify review list: in-stock only

**Goal.** The Shopify Publisher's review list (the "Awaiting review" tab) shows
only products that can be sold online. A product with no sellable stock in any
size, at any location that feeds the website, is **hidden** from the list. It is
never deleted, and its `/shopify_publish` node (photos, name, condition,
proposals) is not touched. When stock comes back, the product goes back on the
list by itself. Nothing here changes what is live on the website: `liveState`
and `desiredState` are never written, and nothing is published or unpublished.

## 1. Discovery

### The review list

`src/components/shopify/ShopifyPublishView.jsx` → `awaitingAll`. It walks the
in-memory catalogue (`products` prop, the app-wide `/products` subscription),
keeps `isPublishableProduct(p)` (price records are left out), and keeps every
product whose `publishTabFor(nodes[pid])` is `"awaiting"`, meaning **not
`isOn`**. A product with no node at all is included. Node bodies load
**windowed**, only for the rows on screen, so the hidden set must not
live inside the node body. If it did, a row would drop out *after* its body
loaded, shifting the window, which is the feedback loop the page's own comments
warn about. The page needs the set up front, from one cheap read.

The same membership feeds:
- the home badge, `useShopifyAwaitingCount` (products with no node at all),
- the "Suggested names" lane (`loadProposalPage`, `state == "awaiting"` nodes).

### Sellable stock: the website's definition

`scripts/shopify/inventory.mjs`:
- `ONLINE_EXCLUDED_LOCATIONS` = `in_transit` (unsellable) + `hub3`,
  `marathon-pine` (untrusted count, owner decision 2026-09-08).
- `networkTotals(stockTree, pid, sizes)` gives per-size network totals over
  every non-excluded location, with negatives clamped to 0. Only sizes in the
  record ship.

The reconciler pushes exactly this to Shopify (`reconcile.mjs:1058` at publish
time, `inventorySync.mjs` `desiredFor` continuously). Sizes come from
`product.sizes`. A record with no `sizes` array cannot be published at all
(`reconcile.mjs:695`), so it cannot be judged here either, and it is **never
hidden**.

**Sellable** means `Object.values(networkTotals(...)).some(q => q > 0)`. It uses
the function itself, not a copy.

Location names come from `inventorySync.locationNames(db)`: the `/locations`
config node filtered by the same excluded set. It is one small read, never
`/stock`.

### The event to hook into

`functions/index.js` → `shopifyInventoryDirty`: `onValueWritten` on
`/stock/{loc}/{pid}`, deciding in `functions/lib/shopify-inventory-dirty.cjs`.
It already skips excluded locations, re-reads the after side, and compares per
size. Today it reads `/shopify_publish/{pid}` and **stops** for anything that is
not live and on, which is exactly the set the review list holds.

The drain runs on the Mac mini, in `scripts/shopify/reconcile.mjs`'s commit tick
(launchd `com.marathon.shopifyreconcile`, every 2 minutes), beside
`sweepInventoryDirty`.

## 2. Design

```
/stock/{loc}/{pid} write
  └─ shopifyInventoryDirty (existing trigger)
       ├─ live+on → /shopify_inventory_dirty/{pid} ++     (unchanged)
       └─ not live+on, AND a size cell crossed zero
                  → /shopify_review_stock_dirty/{pid} ++  (new)
Mac mini reconcile tick
  └─ sweepReviewStock (new, scripts/shopify/reviewStock.mjs)
       per marked pid: product.sizes + per-location cells → networkTotals
         sellable → remove /config/shopifyReviewHidden/{pid}
         none     → set    /config/shopifyReviewHidden/{pid} = server time
       marker cleared by revision CAS (inventorySync.clearMarker)
Publisher page
  └─ one shallow REST read of /config/shopifyReviewHidden (keys only)
       awaiting list, home badge, suggested-names lane skip hidden pids
```

**Why a zero crossing and not every change.** The network total can only change
between zero and non-zero if, at some location, some size cell changes between
zero and non-zero. A sale of one of three units at PE cannot hide anything. So
the trigger marks only when a cell crosses zero. That is exact (it is never
missed) and much rarer than every movement.

**Why `/config/shopifyReviewHidden`.** The live console rules already let any
non-anonymous user read `/config` (writes are admin-only, and the mini writes
with the Admin SDK). So **no rules paste is needed**, and the feature works the
moment it deploys. Nothing reads `/config` whole (checked with `git grep`).

**Fail-open.** If the hidden-set read fails, the page shows every product, as it
did before this change. A product with no `sizes` is never hidden.

### Known residuals

- A product switched **off** gets no stock event. The reconcile tick therefore
  review-marks every product it takes off, in the same tick, before the sweep.
- A product whose `sizes` array is edited with no stock movement is not
  re-judged until its next zero crossing, or until the full pass is run again
  (`scripts/shopify/review-instock-pass.mjs --commit`, which converges and is
  safe to re-run).
