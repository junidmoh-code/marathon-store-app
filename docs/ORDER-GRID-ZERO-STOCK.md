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

## What changed

1. **Grid:** footwear sizes sorted numerically on every size surface; Pine's
   grid is now gated by Hub 3 — the hub its orders already go to — through the
   same resolver as Hub 1/Hub 2 (no reroute: Hub 3 has no alternate).
2. **Submit:** every footwear and clothing customer line re-reads the one cell
   it will draw from (`stock/{hub}/{pid}/{size}`) inside `placeOrders`, before
   anything is written. Zero, missing, cleared, short-for-the-cart, or an
   unreadable cell → the sheet refuses with a message naming the size and hub;
   the cart is left intact.

## Open questions for Junid

* **Concrete** is not a shop the order screen knows (`SHOP_TO_UNIVERSE` has
  marathon-pe, trophy, marathon-pine). If Concrete staff place orders, they
  currently route as Central (Hub 1/Hub 2), not Hub 3. Not changed here —
  that is a routing decision.
* **Pine sneakers route to Hub 3**, but the topology says Hub 1 is the sneaker
  hub. With the gate on, a Pine sneaker size Hub 3 has none of is now ✕ instead
  of being ordered into Hub 3's queue and marked out of stock there. If Pine
  sneaker orders should go to Hub 1, that is a routing change for you to call.
