# Network Totals — where the number can come from, and what it costs

Read-only investigation, run 2026-08-22 against the LIVE `marathon-club` RTDB
(europe-west1). Every number below is **measured**, not estimated: each figure is
the `Content-Length` of a real REST GET, or a byte count over the JSON that GET
returned. Nothing in this investigation wrote anything.

The question the card exists to answer is one number per product: every size at
every location, added together. The whole design question is where that number
comes from, because `/stock` is the most expensive node in this database and the
project already has a bandwidth problem.

---

## (a) What aggregates already exist — nothing usable

Every root node was listed (`?shallow=true`) and each plausible aggregate opened.

| Candidate | Shape | Size | Verdict |
|---|---|---|---|
| `/search_index/docs` | 373 docs: `name`, `image`, `price`, `sizes:[{size,available:bool}]` | — | **No quantities.** `available` is a boolean, and it only covers the 373 products pushed to Shopify out of 4,326. Useless for a total. |
| `/stock_confidence/byLocation` | per (loc, product) `{score, factors:{adjustments30d, negativeCells, staleDays, uncountedSends30d}}` | — | Carries a **count of negative cells** but no `qty`. Cannot produce a total. |
| `/insights/reorderPlan/latest` | one AI reorder plan, `generatedAt` 2026-06-23 | — | A two-month-old one-shot snapshot, not a live aggregate. Dishonest to show as "how many there are". |
| `/inventory/{pe,trophy}` | 13 products, `{size: qty}` | 408 B + 27 B | A POS-side leftover covering 2 locations and 13 products. Not authoritative, not complete. |
| `/reports/stock_corrections` | correction audit rows | — | Not an inventory aggregate. |
| `/products_meta` | `lastSku`, `lastBarcode` | tiny | Counters only. |
| `/refill_engine/*` | runs, locks, open index | — | Intent state, not on-hand. |
| `/stock_targets` | per (loc, product, size) target rows | — | What we **want**, never what we **have**. |

**There is no per-product total anywhere in this database, and nothing close to
one.** The only source of on-hand truth is `/stock/{loc}/{pid}/{sizeKey}.qty`.

## (b) What computing it live from `/stock` costs — measured

| Read | Bytes |
|---|---|
| `/stock` in full (all 10 locations) | **5,361,046** |
| …of which the product subtrees themselves | 5,174,931 |
| `/products` (the app already subscribes to this app-wide) | 3,684,992 |
| `/stock_movements`, last 1 day | 490,710 (1,315 entries) |
| `/stock_movements`, last 7 days | 2,675,411 (6,979 entries) |

Per-location: `marathon-pe` 1,363,308 · `hub2` 1,201,988 · `central` 1,002,087 ·
`hub1` 475,117 · `trophy` 440,457 · `base` 266,077 · `marathon-pine` 240,331 ·
`in_transit` 231,624 · `hub3` 81,994 · `studio` 58,063.

**Compression does not save us.** RTDB's REST endpoint was probed with
`Accept-Encoding: gzip`; the response came back with no `Content-Encoding` and a
`Content-Length` identical to the plain request (1,210,148 B for `stock/hub2`).
The 5.36 MB is what goes over the wire either way, and the Firebase JS SDK's
websocket transport is not compressed either. There is no cheap full read.

**The fat is per cell, and it cannot be projected away.** A cell is
`{qty, v, mv, lastType, state, updatedAt, updatedBy}` — about 158 bytes, of which
the total needs `qty` alone. RTDB has no field projection, so every read of a
cell pays for all seven fields. 30,321 cells exist.

**Per product, though, it is small.** Summed across all ten locations:

| | bytes for one product's cells, everywhere |
|---|---|
| mean | **1,243** |
| p50 | 797 |
| p90 | 2,806 |
| p99 | 5,197 |
| max | 11,493 |

**An incremental top-up from the ledger is not cheaper either.** The obvious
"read it once, then apply deltas" design dies on measurement: one day of
`/stock_movements` is 490 KB, which is the same order as re-reading three
locations outright. Measured, then discarded.

## (c) Recommendation — read only the products he is actually looking at

Whole-catalogue ranking costs 5.2 MB and there is no way to make it cost less
without a new aggregate node, and a new aggregate node needs a writer — a cloud
function or a scheduled job — which this session is explicitly not allowed to
add. So the card does not do it.

What it does instead:

- **The product list is free.** `useProducts()` already holds every product in
  memory; the app subscribes to `/products` on sign-in for every screen. The
  card adds **zero** bytes to get names, photos and search.
- **Totals are read per product, on demand, one-shot.** For each product on
  screen the card issues ten `get()` reads — `/stock/{loc}/{pid}` for each
  registered location — and sums every cell it finds. Mean cost **1,243 bytes
  per product**. A page of 25 rows is **~31 KB**. A search returning 12 hits is
  **~15 KB**.
- **Nothing is read twice.** Totals land in a session cache keyed by product id,
  so re-sorting, re-searching and paging back never re-read a product.
- **No live listeners on stock.** `get()`, not `onValue` — the card does not hold
  a subscription that keeps paying as other people move stock.
- **Ranking is over what is loaded, and says so.** The list sorts by total,
  high to low, across every row whose total has arrived, and the footer states
  how many of the 4,326 products that is. "Load 25 more" extends it. There is
  no hidden full read.

That keeps first open at tens of KB instead of 5.2 MB — 170× cheaper than the
whole-node route, and cheaper than several screens the app already ships
(`Locator`, `AttentionView`, `HealthView`, `BarcodeCatalog`, `MoveExcess`,
`MissingFootwear`, `NoTargetQueue`, `CountedStockReview`, `IntroduceExisting`
each subscribe to the whole of `/stock` today, at 5.36 MB a visit).

## Units sold over a period — deliberately left out

There is no sold-units aggregate. Deriving it means reading `/stock_movements`,
measured above at 490 KB per day and 2.68 MB per week. That is a fresh read of
the sales history and it is 16× the cost of the entire rest of the card, so it
is **not included**. Reported, not smuggled in.

## What the live data looks like, so the card can be honest about it

| | |
|---|---|
| products in `/products` | 4,326 |
| products with at least one stock cell | 4,164 |
| **live products with no cell at any location** | **196** → the card shows `0` |
| live products whose network total is exactly 0 | 512 |
| **live products whose network total is NEGATIVE** | **159** |
| negative cells in the live data | **980**, totalling **−1,583 units** |
| stock cells for product ids no longer in `/products` | 34 (orphans; the card lists products, so these are out of scope) |
| grand network total | 38,234 units |

Per-location net units: `central` 14,190 · `hub2` 9,745 · `marathon-pe` 5,306 ·
`hub1` 4,972 · `trophy` 2,508 · `marathon-pine` 2,482 · `in_transit` 92 ·
`studio` 0 · `base` 0 · **`hub3` −749**.

Two things fall out of this that the card must not paper over:

1. **Negatives are real and they are large.** hub3 is net −749 units on its own.
   Clamping would turn a −749 into a 0 and hide the single loudest signal in the
   data. The card sums raw and flags the product.
2. **`studio` and `base` are `active: false` but still hold cells.** They net to
   zero (they were drained into `central` in July), but "everywhere" cannot mean
   "everywhere except two places I decided not to mention". The card reads every
   location in `/locations`, active or not, and names all ten on screen.

## Rules

No rules change is needed. The live rules grant `.read` at `/stock` to any
signed-in non-anonymous user, and that cascades to every descendant — the
per-product reads this card makes are already permitted. `database.rules.json`
was not touched.
