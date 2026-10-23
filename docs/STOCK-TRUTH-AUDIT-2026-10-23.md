# Stock-truth audit — 23 Oct 2026

Question: is marathonclub.co.za offering sizes the app says are gone?

Measured 18:57–19:12 SAST with `node scripts/shopify/stock-truth-audit.mjs`
(read-only; the pusher's own `networkTotals` + `planProduct` over the nightly
sweep's bulk snapshot, plus the public storefront's `/products.json`).

## Answer: the site is not ahead of the app

| | variants | units |
|---|---|---|
| compared (2,106 listed products + 3 listings with no app product) | 10,478 | |
| Shopify **above** the app | **0** | 0 |
| Shopify **below** the app | 2 | 2 |
| sellable on Shopify at zero app stock | 0 | |
| storefront says available at zero app stock | 0 | |

The nightly sweep agrees. It ran every night from 19 to 23 Oct (the last at
02:36 SAST, 2,115 listings, 0 drift, Shopify 24,363 units = app pool 24,363).
The movement pass heartbeat is current, and #589's compare-and-set order
(merged 8 Sep, `9d41fde`) is in the Mac mini's checkout.

## The named slide: the site is right

"Double-strap buckled slide in taupe with cork footbed", R600 =
`p1778146785191` "Birkenstock Arizona Taupe Suede".
`*` marks a location that is excluded from online availability.

| size | central | hub1 | marathon-pe | Pine* | online pool | Shopify | storefront |
|---|---|---|---|---|---|---|---|
| 6 | 1 | 1 | 0 | · | 2 | 2 | available |
| 7 | 0 | 2 | 0 | 1 | 2 | 2 | available |
| 8 | 2 | 6 | 0 | · | 8 | 8 (1 committed) | available |
| 9 | 2 | 0 | 0 | 1 | 2 | 2 | available |
| 11 | 3 | 0 | · | 1 | 3 | 3 | available |
| 3, 4, 5, 5.5, 10 | 0 | 0 | 0 | · | 0 | 0 | sold out |

Hub 1 holds 9 units across sizes 6, 7 and 8. Central holds 8 more, in sizes 6,
8, 9 and 11. Reading Hub 1 alone shows 9 and 11 as gone, but they are at
Central.

The app also has a second record, `p1778146965038` "Birkenstock Arizona Suede
Taupe" (2 units, not listed). It is hidden by the 4-unit review floor.

## What IS wrong: web sales that never reached the app

A web sale is deducted only by a POS slip (before the 21 Oct go-live) or by the
pack (after it). There is no webhook, so a missed slip leaves the unit in the
app, and the next push puts it back on the site.

I matched every fulfilled Shopify order line since 1 Oct against app `sold`
movements, using `node scripts/shopify/web-sales-vs-app.mjs 2026-10-01`.

- Sizes come from the order's variant id through the pusher's id map.
- Quantities are current, so refunds and edits are excluded.
- Each sale is used once.
- A sale counts if it was rung up to 7 days before the order.
- The matcher accepts, in order: the same size, then another size of the same
  product, then a sibling record with the same style code or the same words
  in the name.

| fulfilled lines | 279 |
|---|---|
| same product + size | 234 |
| same product, other size (wrong size rung?) | 15 |
| sibling record | 6 |
| **no app sale at all** | **24** (23 before go-live, the POS-slip era; 1 after) |
| of those, sizes still with app stock online | 12 (39 units in those sizes) |

- Where the pool is 1, the unit on sale may be the very pair already shipped:
  #1627 size 11, #1700 M, #1709 5.5, #1714 8, #1721 S, #1736 4.
- #1761 (`p1782917447848` XXL) was fulfilled on 23 Oct at 13:20 and Trophy
  still holds 2. This is one of the two "below" variants. Tonight's 02:30 sweep
  will push the app's 2 back over Shopify's 1 and re-offer the shipped unit.
- The other "below" variant is #1757 (`p1780741990887` size 5.5). A sale does
  match that line, but the app is still 1 above Shopify.
- After go-live, #1776's perfume line is `packed` in the app with no `sold`
  movement for that product. The pack-path deduction failed for that line.
  Another session's #1776 fixes are on the Mac mini's checkout.

This count is not a floor. A slip rung on an unrelated record, or with a
different name, would not be found. Even so, 23 lines in three weeks with no
sale of the product or of any sibling is evidence that slips are being missed.

**Not corrected.** This is the brief's stop condition. Whether to deduct
the missed units, add an order webhook, or keep slips is the owner's decision.

## Other findings

- **Search index:** 218 of 2,038 docs carry an `inStock` that disagrees with
  Shopify now. `/search_index/docs` caches `availableForSale` at build time.
  The reconciler adds and removes docs but never refreshes one. Repair:
  `node scripts/shopify/build-search-index.mjs --commit`.
- 4 listed products have no id map, and 24 are listed in the app but not
  ACTIVE on Shopify. Both counts are unchanged since the 20 Oct sweep.
- 3 Shopify variants sit at on_hand −1, from admin fulfilments of orders #1761
  and #1776 against 0. They are not sellable, and the sweep sets them to 0.
- `p1777895787590`'s id map names 7 clothing sizes that its listing does not
  have. They cannot be bought.

## The 4-unit review floor

`REVIEW_MIN_UNITS = 4` (`scripts/shopify/reviewStock.mjs:46`).

The floor does not stop a publish. It hides products from the Awaiting tab
(`/config/shopifyReviewHidden`, filtered in `ShopifyPublishView.jsx`) and keeps
them out of the auto-publish queue (`autoPublishOne`). The reconciler never
checks units, so a person who could find the product could still publish it.

From `node scripts/shopify/review-hidden-census.mjs`: 2,178 products are
hidden. Value is online units × retailPrice.

| online units | products | units | retail | otherwise publishable* |
|---|---|---|---|---|
| 0 | 1,120 | 0 | R0 | 997 |
| 1 | 514 | 514 | R230,308 | 458 |
| 2 | 329 | 658 | R295,532 | 282 |
| 3 | 215 | 645 | R290,205 | 181 |
| **1–3** | **1,058** | **1,817** | **R816,045** | **921** |

\* "Otherwise publishable" means the auto-publish agent's own `readiness()`
passes, and the product has a retail price and sizes. `readiness()` checks for
a photo and an acceptable name, that it is merchandise, never live and not
blocked. The grade is not required, because the agent sets Excellent itself.
Only 55 of the 1,058 are graded today.

Of the 1,058 products with 1–3 units, these are not ready:

| reason | products |
|---|---|
| blocked | 36 |
| live before (a person decides) | 16 |
| no photo | 6 |
| no name | 2 |
| no retail price | 78 |

The one-line change to show single pairs is `REVIEW_MIN_UNITS = 1` in
`reviewStock.mjs`. After that, re-run `review-instock-pass.mjs --commit` to
re-judge the hidden node. Not changed here.

## Search: Publishing now matches like the stock screens

Counted Stock uses `productMatchesQuery` (`src/utils/productSearch.js`): every
word must appear, in any order, with typos tolerated, and codes are matched
too. Shopify Publishing matched the whole phrase as one substring. It now uses
the same matcher and keeps its style-code match.
