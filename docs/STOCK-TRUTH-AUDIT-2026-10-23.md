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

Shopify orders created since 1 Oct, matched line by line against app `sold`
movements for the same product and size, placed after the order:

- 329 lines, 279 of them fulfilled
- **50 fulfilled lines have no matching app sale.** For 15 of them the same
  product sold in another size, which may be a slip rung at the wrong size.
- **29 of those 50 sizes still have app stock online (78 units)**, so the site
  offers them. Where the pool is 1, that unit may be the one already shipped.
- The two "below" variants are this case, caught before the sweep re-adds them:
  - `p1780741990887` size 5.5, order #1757
  - `p1782917447848` XXL, order #1761 (fulfilled 23 Oct 13:20, Trophy still 2)

  Tonight's 02:30 sweep will push the app's number back up and re-offer both.

The matcher is generous: any sale of that product and size after the order
counts. The true gap is therefore at least this large. Re-run with
`node scripts/shopify/web-sales-vs-app.mjs 2026-10-01`.

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

From `node scripts/shopify/review-hidden-census.mjs`: 2,178 products are hidden.

| online units | products | units | retail | otherwise publishable* | already graded |
|---|---|---|---|---|---|
| 0 | 1,120 | 0 | R0 | 1,099 | 109 |
| 1 | 514 | 514 | R230,308 | 474 | 17 |
| 2 | 329 | 658 | R295,532 | 303 | 23 |
| 3 | 215 | 645 | R290,205 | 196 | 15 |
| **1–3** | **1,058** | **1,817** | **R816,045** | **973** | **55** |

\* Has a photo, a retail price, sizes and a name the publisher accepts. The
grade is not counted, because the auto-publish agent sets Excellent itself.

The one-line change to show single pairs is `REVIEW_MIN_UNITS = 1` in
`reviewStock.mjs`. After that, re-run `review-instock-pass.mjs --commit` to
re-judge the hidden node. Not changed here.

## Search: Publishing now matches like the stock screens

Counted Stock uses `productMatchesQuery` (`src/utils/productSearch.js`): every
word must appear, in any order, with typos tolerated, and codes are matched
too. Shopify Publishing matched the whole phrase as one substring. It now uses
the same matcher and keeps its style-code match.
