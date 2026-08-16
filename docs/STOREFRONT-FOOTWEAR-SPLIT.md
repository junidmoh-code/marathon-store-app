# Footwear lanes, and price records off the publishing page

Two changes, one PR. Both are about the storefront telling the truth about what
it holds.

---

## 1. Footwear was one lane. It is four now.

### What was wrong

Slice 1 shipped a single footwear collection titled **Sneakers** and pointed
every footwear subcategory at it, because it was the only footwear destination
the agreed taxonomy provided. The result on the live shop, read on 2026-08-16:

| Shopify `productType` | active products | collection they were in |
|---|---:|---|
| Boots | 23 | `sneakers` (7 of them) or nothing |
| Sandals & Slides | 15 | nothing |
| Sneakers | 19 | nothing |
| Caps & Hats | 4 | `caps-hats` |

(The active count is a *moving* number — Junid was publishing while this was
written, and it went from 40 to 61 to 100 over the afternoon. What does not
move is the shape: the `sneakers` collection held 7 products, all boots.)

The `sneakers` collection held **7 products, every one of them a boot**, and not
a single actual sneaker. A shopper tapping "Sneakers" in the menu got boots.

### The real footwear subcategory list

Read-only census of all 4,183 visible `/products` records, 2026-08-16.

**By legacy `category|subcategory`** — the field `CATEGORY_MAP` joins on:

| pair | count | lane |
|---|---:|---|
| `Footwear\|Sneakers` | 1224 | `sneakers` |
| `Footwear\|Soccer Boots` | 81 | `soccer-boots` *(new)* |
| `Footwear\|Sandals & Slides` | 49 | `sandals-slides` *(new)* |
| `Footwear\|Boots` | 45 | `boots` *(new)* |
| `Footwear\|`*(no subcategory)* | 3 | `sneakers`, via the `Footwear\|*` row — **see the caveat below** |

> **The `Footwear|*` fallback is a fallback, not a judgement.** The three records
> with no subcategory at all are *"Soccerboot kit"*, *"Kids soccerboot "* and
> *"Labubu"*. Two of the three are soccer boots by name, so sending them to
> Sneakers repeats — at n=2 — the mis-filing this split exists to end. The map
> cannot fix that: it joins on `subcategory`, and these records have none. The
> fix is a **data edit**: give them a subcategory in the app and they route
> correctly with no code change. None of the three is live today. Raised on
> review 2026-08-16 and recorded here rather than papered over.

**By `categoryKey`** — the newer taxonomy registry at
`/settings/productTaxonomy`. It carries four more footwear categories, and none
of them gets a lane:

| categoryKey | products | registry state | why no lane |
|---|---:|---|---|
| `sneakers` | 1237 | active | → `sneakers` |
| `soccer-boots` | 80 | active | → `soccer-boots` |
| `slides` | 48 | active | → `sandals-slides` |
| `designer-shoes` | 4 | active | 4 records, all filed legacy `Footwear\|Boots` → Boots |
| `kids-shoes` | 0 | active | nothing to show |
| `boots` | 0 | **inactive** | the legacy subcategory already carries the 45 real boots |
| `running-shoes` | 0 | **inactive** | nothing to show |
| `loafers` | 0 | **inactive** | nothing to show |

An empty collection is exactly the complaint this change answers, so the
zero-count categories get no collection.

### Why the map still keys on the legacy pair, not `categoryKey`

The cross-tab is the reason:

```text
1195  sneakers        <=  Footwear|Sneakers
  80  soccer-boots    <=  Footwear|Soccer Boots
  48  slides          <=  Footwear|Sandals & Slides
  41  sneakers        <=  Footwear|Boots          ← categoryKey is wrong here
  29  (none)          <=  Footwear|Sneakers
   4  designer-shoes  <=  Footwear|Boots
   3  (none)          <=  Footwear|(none)
   1  (none)          <=  Footwear|Soccer Boots
   1  sneakers        <=  Footwear|Sandals & Slides ← and here
```

42 records whose real subcategory is Boots or Sandals carry `categoryKey:
"sneakers"`. Keying the storefront lane on `categoryKey` would put them straight
back into Sneakers — the exact bug. The legacy `subcategory` is the field that
is right about what the shoe is, so it stays the join.

### What changed in code

- `scripts/shopify/collectionMap.mjs` — three new `COLLECTIONS` entries
  (`boots`, `soccer-boots`, `sandals-slides`), all top-level siblings of
  Sneakers, and three repointed `CATEGORY_MAP` rows. The Sneakers copy no longer
  claims to hold boots and slides.
- Nothing else. No reconciler change, **no handle change** — a product moves by
  collection membership only, which `sync-collections.mjs` re-plans from Shopify
  on every run.

### Applying it (owner-run, in this order)

```sh
node scripts/shopify/ensure-collections.mjs            # dry run — read it
node scripts/shopify/ensure-collections.mjs --commit   # creates the 3 collections
node scripts/shopify/sync-collections.mjs              # dry run — read it
node scripts/shopify/sync-collections.mjs --commit     # moves membership
```

`sync-collections.mjs` is the repair pass: it re-plans every product this
program has ever touched against Shopify's *current* membership, so it both
moves the mis-filed boots out of Sneakers and picks up the products that were
published before the collection step existed and joined nothing.

### The menu consequence — read this

`print-menu-plan.mjs` prints the current plan and the live count on every row.
After the split, the hand-built main menu needs two things done in the admin:

1. **Add rows** for Boots, Soccer Boots and Sandals & Slides.
2. **Check the Sneakers row.** Once the boots leave it, it holds only the real
   sneakers that are live at that moment. That number is climbing as Junid
   publishes, but it was **zero** when the split was written — so verify it is
   non-empty before, not after, the menu points at it.

Menus are built by hand: the app cannot be granted
`write_online_store_navigation` (its `app_url` points at Shopify's placeholder
and it is not embedded, so no consent screen can be presented). `menuCreate`
exists on API 2026-07; only the grant is missing.

---

## 2. Price records are not merchandise

### What was wrong

`/products` holds 35 **price-carrier records** — bookkeeping rows so a cashier
can ring up a loose item at a set price. `p1785900000000` is typical:

```json
{ "id": "p1785900000000", "name": "Entry 30 Line", "barcode": "30",
  "priceProduct": true, "category": "Price Products",
  "subcategory": "Price Products", "retailPrice": 30, "stockPrice": 30 }
```

No sizes, no SKU, no photo, no stock. The Shopify publishing page grouped the
catalogue by `category`, so these appeared under a **"Price Products"** heading,
selectable and nominatable like any product. Junid saw them there.

The old `CATEGORY_MAP` row mapped them to `null`, which is **"unmapped"** — a
status that still lets a product go live and surface in the New In smart
collection. That is not exclusion.

### The identifying rule, and how it fails safe

`isPriceRecord()` in `src/utils/productCategory.js`:

```js
record.priceProduct === true ||
record.category    === "Price Products" ||
record.subcategory === "Price Products"
```

Three signals, **OR-ed, not AND-ed**. All 35 live records carry all three. Each
one alone is sufficient, so:

- re-categorise a price record to "Clothing" → `priceProduct: true` still
  catches it;
- strip the flag → `category` still catches it;
- strip both → `subcategory` still catches it.

The only way to make one publishable is to remove **all three**, which is
indistinguishable from deliberately converting it into a real product. The rule
never fails open by accident, only by explicit intent. The predicate also
requires the literal boolean `true`, so a stray `priceProduct: "no"` cannot
smuggle a real product *out* of the storefront.

Both string comparisons are **normalised** (trimmed, case-folded, whole-label).
That is load-bearing rather than tidiness: `resolveCollection()` trims
`category` before its table lookup, so a record carrying `"Price Products "`
with a trailing space and no flag would otherwise read as *not* a price record
here while still matching the `Price Products|*` row downstream — status
`unmapped`, which publishes. Comparing more loosely than the consumer
downstream is the one way an OR-ed fail-safe can still fail open.

**Known limit, stated honestly.** Nothing in *this* repo ever writes
`priceProduct: true` or creates a `Price Products` record — they arrive from the
POS repo or by hand. So the argument above covers the 35 rows that exist. For
records created *after* a category rename in the other repo, the gate rests on
whichever of the three signals that repo keeps writing. Any one of them is
enough, but they are not pinned across repos by a test.

**Also not gated:** `publishProduct()` and `setDesiredState()` in
`shopifyPublishStore.js` take `(productId, node, …)` and never see the
`/products` record, so they cannot check this themselves. Unreachable from the
UI today (no row, no route, no batch item) and caught by the reconciler
regardless — which is why the enforcement point is deliberately the reconciler
and not the client.

### Enforced in three places, not one

| Where | What it does |
|---|---|
| `ShopifyPublishView.jsx` | Dropped before grouping — no section, no row, no product page, and the `#shopify/{pid}` hash route bounces back to the list. Not counted by the home badge either. |
| `shopifyPublishCore.js` | `batchSelectBlocker` refuses ahead of every fixable gate, with the not-merchandise reason (not "set a condition grade first", which would invite someone to try). |
| **`reconcile.mjs`** | **The enforcement point.** Refuses at apply time, before any Shopify call, even when an intent already exists — written before this shipped, by a script, or by hand in the console. `refuse()`, so it lands in the run log and on the node as `blockedReason`. |
| `sync-collections.mjs` | A price record found confirmed-live reports `excluded-but-live` and exits non-zero. |
| `resolveCollection()` | Returns status `"excluded"` — a fourth status, distinct from `unmapped`. |

### Verified state, 2026-08-16

- 35 price records in `/products`.
- **0** have a `/shopify_sync` entry.
- **0** have a `/shopify_publish` node.
- All 35 titles searched against the shop by exact title: **0 hits**, in any
  status.

None is live, none is in a collection, none exists on Shopify at all. Nothing
had to be removed — the exposure was the publishing page offering them, which
is now closed.
