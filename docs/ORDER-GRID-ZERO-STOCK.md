# Order grid offered sizes no hub holds — findings (3 Oct 2026)

Reported by Junid on Place Order (Assistant view, Pine selected): **Diesel slide
black** (`p1787222538915`, barcodes 00027492–00027497, sizes 6–11) offered all
six sizes, size 10 first, although Hub 1's Counted Stock review read
6=0 · 7=2 · 8=2 · 9=2 · 10=0 · 11=0. Order **#148** (Lorenzo, size 10, 12:17) was
accepted.

## Live data, read cell by cell (3 Oct 2026, ~13:00 SAST)

| Location | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|
| hub1 | 0 | 2 | 2 | 2 | **0** | 0 |
| hub2 | 0 | 0 | 0 | 0 | **0** | — |
| hub3 | 0 | 0 | 0 | 0 | **0** | — |
| central | 0 | 10 | 7 | 2 | **0** | 0 |
| marathon-pine (shop floor) | 8 | 7 | 8 | 8 | 2 | — |

Product record: `category: "Footwear"`, `productType: "sneaker"`,
`hubs: ["hub1","hub3"]`, `sizes: ["10","6","7","8","9","11"]` (stored order).

**Order #148 is not a Pine order.** It was placed by Prince's device
(`2fa1ea29…`) for **Marathon PE** (`destShop: "marathon-pe"`,
`placedStore: "central"`), routed to **Hub 1**. At 12:34 Alli marked it
**Out of Stock** at the hub (`status: "out_of_stock"`). It was not touched by
this work.

**Can #148 be filled?** Not from any hub: size 10 is 0 at Hub 1, Hub 2, Hub 3
and Central. The only size-10 pairs anywhere are **2 on the Pine shop floor**
(`stock/marathon-pine`) — a shop-to-shop move is a people decision, not
something the order screen does.

## How the grid decides what is selectable

* `sizesOf` / `selectedSizes` list `product.sizes` **in stored order** — that is
  why 10 came first.
* A footwear size is ✕ only through `sneakerOut` → `resolveSneakerSourcing`
  (availabilityCore). That resolver answers **only for `hub1`/`hub2`**
  (`gatedSneakerHub`). For any other hub it returns "no answer", and
  `sneakerOut` then returns `false` — **no gate at all**.
* Where it does answer, a zero cell, a missing cell and a cleared
  ("uncounted", `state: "untracked"`, qty 0) cell all read `available = 0` → ✕.
  So for Central the claim "it offers zero cells" is **refuted once the hub
  subtree has loaded**, and **confirmed** in two cases:
  1. **Pine (and anything routed to Hub 3):** `computeHubForItem` returns
     `hub3` for every Pine line, `gatedSneakerHub(…, "hub3")` is `null`, so
     every listed size is offered whatever Hub 3 holds. This is exactly what
     Junid saw — Hub 3 holds 0 of every size of this slide, and all six were
     offered. The code said so in as many words ("Pine/hub3 keeps exactly
     yesterday's behaviour … its grid has never been gated").
  2. **Before the hub read has settled, or after it errors:** the gate is
     deliberately open (`sneakerGateReady` false → no ✕). Prince's device is on
     the offline mirror and its download was incomplete
     (`/mirror_devices/2fa1ea29…`: `complete: false`), so its Hub 1 read could
     have been unsettled or stale at 12:17. The stored data cannot prove which;
     what is certain is that **nothing after the tap re-checked the cell**.

## Routing and submit

* Pine: every footwear line → `hub3` (`computeHubForItem`, `placedHub`).
  Central: the stock-aware resolver between the product's tagged hub and the
  other of hub1/hub2. Unambiguous in code; unchanged by this work.
* `placeOrders` checks deactivation and display-pair claims only. **There was no
  stock check of any kind on submit** — whatever the grid let into the cart was
  written.

## Hub 3 does not hold what fills Pine orders

The obvious Pine fix — gate Pine's grid on Hub 3, the hub its orders go to —
was built and **withdrawn** before shipping, on live evidence (3 Oct 2026,
per-product reads of the 344 products with a `stock/hub3` row):

* Hub 3's cells hold **7 footwear units in total** — 7 positive cells out of
  854, across 343 footwear products.
* Of the **119 Pine orders** on `/orders`, all routed to Hub 3: **48 collected,
  46 ready**, 23 out of stock, 2 incoming. 94 of 119 were filled.

So Pine footwear orders are being picked from stock that Hub 3's cells do not
record (the Pine shop's own cells, `stock/marathon-pine`, do hold stock — e.g.
this slide 8·7·8·8·2 for sizes 6–10). Gating on Hub 3 — in the grid or at
submit — would have ✕'d and refused almost every Pine sneaker sale. Routing in
code is unambiguous (Pine → Hub 3), so this is a **deliberate departure from
the brief's commit 4**, not its "ambiguous routing" branch: what is ambiguous
is **which stock a Pine order should be judged against**, and no model was
invented. Grid and submit agree: neither gates a Pine footwear line.
**Junid's Pine report is therefore not fixed** beyond size order — the sheet
still offers every Pine size, including 11, which is at no Pine location.

Pine clothing customer lines ARE guarded on Hub 3, consistent with the Pine
clothing grid (which already greys on Hub 3 cells, and fails closed while
loading). Hub 3 holds 1 non-footwear product at 0 units, so this changes
nothing Pine can do today; all 119 Pine orders were footwear.

Method: shallow key list of `stock/hub3` (344 ids), then one read per id of
`stock/hub3/{pid}`, `products/{pid}/category` and `products/{pid}/productType`;
Pine orders by `orders?orderBy="destShop"&equalTo="marathon-pine"`.

## What changed

1. **Grid:** sizes shown in numeric order on every Place Order size surface
   (`orderSizesForDisplay`); zero, missing and cleared ("uncounted") cells pinned
   as ✕ by test for Hub 1/Hub 2 — that rule already held, so no grid logic
   changed. The grid is still OPEN while a hub read has not settled (so a slow
   load never blanks it); the submit guard below is what closes that window.
2. **Submit:** before anything is written, every stock-drawing line re-reads the
   one cell it will draw from (`stock/{hub}/{pid}/{size}` — the same hub the
   write uses) inside `placeOrders`. Zero, missing, cleared, negative, short for
   the cart's own count, or unreadable (incl. a 10 s timeout) → the checkout is
   refused on the sheet, the cart stays intact, nothing is placed. Guarded:
   Hub 1/Hub 2 footwear (exactly the lines the grid gates) and clothing customer
   lines (whose grid already reads the same CR-hub cell). Not guarded: Display
   Partner requests, display-pair pulls (own pre-flight), perfume/bags/one-size
   accessories, and Pine footwear (above).

Had this guard existed, #148 would have been refused at 12:17 with "Diesel
slide black size 10 is out of stock at Hub 1".

## Open questions for Junid

1. **Pine footwear availability.** Pine orders go to Hub 3, but Hub 3's cells
   hold almost none of the stock that fills them. If Pine orders are picked
   from the Pine shop's own stock, say so and the grid and guard can read
   Hub 3 + the Pine shop cells for Pine — that is what would have hidden the
   slide's size 11 (none anywhere at Pine) and kept 6–10 (on Pine's floor).
2. **Concrete** is not a shop the order screen knows (`SHOP_TO_UNIVERSE` has
   marathon-pe, trophy, marathon-pine). Unknown shops route as Central
   (Hub 1/Hub 2). Not changed — that is a routing decision.
3. **#148** cannot be filled from any hub (size 10 is 0 at Hub 1, Hub 2, Hub 3
   and Central); the only size-10 pairs are 2 on the Pine shop floor. It is
   already marked Out of Stock and was left untouched.
