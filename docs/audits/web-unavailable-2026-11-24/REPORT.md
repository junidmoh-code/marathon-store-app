# Why website order lines go unavailable — 21 October to 24 November 2026

For Junid. Orders #1768 to #2405: 638 orders, 1,285 lines.

## Bottom line

Since order #1768, **231 of 1,285 website lines (18%) were rejected, not found, damaged or unavailable at least once**, across 191 of 638 orders, and in 228 cases the customer did not get the item they ordered. Half of all first-time rejections come from one thing: **the website sold the last piece the system showed at a shop or hub, and that piece was not there**. A last piece fails 26% of the time against 9% when the system shows two or more, and a last piece whose shelf count has not been touched for more than 14 days fails 42% of the time (57% at Marathon PE). The second cause is that **nothing happens to the count when a place says "not here"**: the system keeps showing the piece, the website keeps selling it, and 46 failures (18%) were the same size being sold again from a shelf that had already rejected it, 21 of them in the week of 15 to 21 November alone. Staff error is the smaller part: 26 lines (10%) are proven false unavailables, where the item left the same shelf afterwards. Central-only stock, damaged stock, twin product names and till sales taking the unit are each under 5%. Jamie's alternatives work: **184 of 220 decided offers (84%) were accepted**, and what separates accepters from decliners is the channel (WhatsApp 87%, email 68%), the number of options in the first message (three: 87%, two: 73%) and price (all options at the price paid: 89%), not speed, photos or the model that wrote the message.

## How this was measured

- **Line records**: every `/online_orders` record from #1768 (read once, in pages).
- **Rejections**: every website hub order (`/orders`, 854 of them, found through the code registry), every website pick on the shops' Display Checks strip (660 archived records), the packer's Not here / Damaged requests, walk-in overrides, and the order agent's log.
- **Stock**: the stock movement ledger from 18 October for every product a website line ever named. Each movement carries the count before and after, so "what the system showed at 10:14 on the day" is read from the ledger, not guessed.
- **Jamie**: Jamie's own offer, send, delivery and message tables, read from its database file with no write access.
- **Shopify**: note, cancellation and refund records for the 191 affected orders (queries only).
- One row per line and product that failed: 261 rows, because 30 lines failed a second time with the alternative that replaced the first product. The dataset is `unavailable-lines.csv`; Jamie's offers are `jamie-offers.csv`; every number below is in `stats.json`.
- Database cost of the whole investigation: about 51 MB downloaded, once, kept in a local cache. The movement ledger was read twice (17.6 MB each) because the first pass left out products that only appeared on old pick records. Listing the Marathon PE single pieces for section 9 read a further 1.7 MB, twice (the trial run and the real one).

What could not be measured: who was at fault on 130 lines (50%) where nothing happened to that shelf afterwards, so there is no proof either way; and how long a shelf had gone untouched before 18 October for lines that were picked successfully.

## 1. The unavailable lines and their reasons

The full list is Appendix A (261 rows) and the CSV. By what was recorded:

| What happened | Lines |
|---|---|
| A hub marked the pick Out of Stock | 107 |
| A shop pressed Not found on the website strip | 104 |
| Damaged, found by the packer after hand-over | 9 |
| Not here, found by the packer after hand-over | 7 |
| A walk-in sale was let through over the website hold (manager PIN) | 7 |
| Routing found the size at no shop or hub | 7 |
| No rejection record survives (the line was already unavailable when it was swapped or settled) | 21 |

Some lines have more than one. Time from order to first rejection: median 10 hours, 90% within 79 hours.

How each ended:

| Outcome | Lines | Share |
|---|---|---|
| Customer took an alternative | 185 | 71% |
| Found later (the same item was picked after all) | 28 | 11% |
| Still open on 24 November | 24 | 9% |
| Store credit | 10 | 4% |
| Order or line cancelled | 8 | 3% |
| Refund paid or requested | 6 | 2% |

The failed lines were worth about R128,700 at the prices paid. Shopify itself shows 6 of the 191 orders cancelled and refund records on 13 failed lines; the refunds were paid outside Shopify, so its refund totals read R0.

By week the rate has not improved: 15% (21 to 31 October), 26% (1 to 7 November), 21% (8 to 14 November), 21% (15 to 21 November), 17% so far for 22 to 24 November.

## 2. Where they come from

Rate = rejections and after-hand-over failures against every pick the place was asked for.

| Place | Rejected | Failed after hand-over | Picked | Rate |
|---|---|---|---|---|
| Marathon PE | 94 | 4 | 402 | 19.8% |
| Hub 1 | 63 | 4 | 363 | 15.7% |
| Hub 2 | 42 | 4 | 272 | 14.6% |
| Trophy | 10 | 2 | 72 | 14.6% |
| Hub 3 | 9 | 2 | 84 | 11.8% |
| Concrete | 1 | 0 | 61 | 1.6% |
| Pine | 0 | 0 | 5 | 0% |

Marathon PE is both the largest source and the worst rate. Concrete and Pine only joined the route on 12 November and their counts were reset on 11 November, which is the likely reason they are clean: a fresh count.

By person (five or more picks):

| Who | Picked | Rejected | Rate |
|---|---|---|---|
| Marathon PE · Zee | 394 | 81 | 17.1% |
| Hub 1 · Alli ibro | 328 | 59 | 15.2% |
| Hub 2 · Mike | 181 | 23 | 11.3% |
| Hub 2 · Ayob | 49 | 11 | 18.3% |
| Hub 2 · Ahmed | 35 | 6 | 14.6% |
| Trophy · Sphe | 71 | 10 | 12.3% |
| Hub 3 · Mike | 78 | 6 | 7.1% |
| Hub 1 · Mike | 32 | 3 | 8.6% |
| Concrete · Ayanda | 59 | 1 | 1.7% |
| Marathon PE · the POS login | 8 | 13 | n/a |

No one person stands out once the place is taken into account. The same person (Mike) rejects 7% at Hub 3, 9% at Hub 1 and 11% at Hub 2, so the place and its count matter more than who is picking. The POS login's rejections are the packer closing lines by hand in the first days.

## 3. What the system showed when the order was placed

Each row of the CSV has the count at the place the line was sent to, the counts everywhere else, and Central's count, at the minute of the order.

- **The system showed stock.** Only 5 failed lines (2%) were sent to a place that showed zero at order time, and no line was sold while the whole network showed zero. The website sync is doing what it was built to do: it shows what the app holds. The app's count is what is wrong.
- **Last single piece**: 144 failed lines (55%) were sent to a place showing exactly one free piece.
- **Central only**: 11 failed lines (4%) were ordered when no shop or hub on the route held the size and Central did. Across all lines, 9 were sold on Central-only stock; 4 failed, and the ones that came good waited a median of 41 hours for the refill to land.

Failure by how many free pieces the place showed (first place asked only):

| Shown free at that place | Picked | Rejected | Rate |
|---|---|---|---|
| 1 (the last piece) | 310 | 109 | 26.0% |
| 2 | 409 | 42 | 9.3% |
| 3 to 4 | 217 | 23 | 9.6% |
| 5 or more | 104 | 7 | 6.3% |

And the last piece, by how long its shelf count had sat untouched (no sale, transfer, delivery or count):

| Last piece, shelf last touched | Picked | Rejected | Rate |
|---|---|---|---|
| In the last 3 days | 68 | 2 | 2.9% |
| 3 to 7 days ago | 58 | 13 | 18.3% |
| 7 to 14 days ago | 84 | 21 | 20.0% |
| More than 14 days ago | 100 | 73 | 42.2% |

A last piece that moved this week is real. A last piece nobody has touched for two weeks is close to a coin toss. By place, for the last piece untouched over 14 days: Marathon PE 31 of 54 rejected (57%), Hub 1 23 of 55 (42%), Trophy 7 of 19 (37%), Hub 2 11 of 32 (34%), Hub 3 1 of 7, Concrete 0 of 6.

## 4. False unavailables

For each failed line the ledger was checked for what happened to the same product and size at the same place after the rejection. The verdict and its proof (movement ids, order numbers) are in the CSV columns `verdict` and `proof`.

| Verdict | Lines | Share |
|---|---|---|
| No proof either way (nothing touched that shelf since) | 130 | 50% |
| Genuine: counted to zero or written off there | 43 | 16% |
| The system showed stock at another pickable place when it was rejected, and the item was not found later | 28 | 11% |
| **False**: the item left the same shelf afterwards (till sale, another website pick, transfer) with nothing delivered in between | 21 | 8% |
| Found later at a different place | 19 | 7% |
| Damaged | 9 | 3% |
| **False**: found later at the same place that rejected it | 5 | 2% |
| Routed nowhere / Central only | 6 | 2% |

- **26 proven false unavailables (10%)**, listed with proof in Appendix B. Example: #2146 Air Jordan 4 Retro Fear size 3, marked Out of Stock at Hub 2 on 14 November, sold at a Hub 2 till on 22 November with no delivery in between. Marathon PE has 11 of the 26, Hub 2 has 7, Hub 1 has 4, Trophy 3 and Hub 3 one.
- **28 lines (11%) where another pickable place showed stock** (Appendix C). This has largely been dealt with already: since the order agent and Jamie began re-picking elsewhere before telling the customer (14 November), "found at a different place" went from 3 lines in four weeks to 16 lines in the week of 19 to 24 November.
- **90 rejections (34%) came from a shelf that showed two or more.** Only 11 of those are proven false. The rest are counts that are wrong by more than one.
- **136 of the 228 lines the customer did not get are still shown in stock today at the place that rejected them.** A rejection changes nothing in the count, so the website carries on offering that piece.

## 5. Common factors, ranked

Share of all 261 failed line-products. A line can have more than one.

| Factor | Lines | Share | Note |
|---|---|---|---|
| Last single piece at the place it was sent to | 144 | 55% | fails 26% of the time against 9% for two or more |
| Shelf not touched for 14 days or more before the order | 101 | 39% | 30 days or more: 67 (26%) |
| Rejected from a shelf showing two or more | 90 | 34% | counts wrong by more than one |
| Sold again from a shelf that had already rejected that size, nothing delivered or counted in between | 46 | 18% | 21 of them in 15 to 21 November |
| Another pickable place showed stock at the time | 28 | 11% | mostly fixed since 14 November |
| Proven false unavailable | 26 | 10% | |
| Failed after hand-over (packer) | 16 | 6% | 9 damaged, 7 not here |
| Central-only stock at order time | 11 | 4% | needs one of Junid's rules changed, see section 7 |
| Damaged stock | 9 | 3% | 6 of the 9 from Hub 1 and Hub 2 sneakers |
| A second website order or a till sale took the unit between order and pick | 7 | 3% | 5 website, 2 till |
| Walk-in sale let through over the hold with a manager PIN | 7 | 3% | all approved by the same manager login |
| Display piece registered at that place | 1 | under 1% | |

Things that turned out **not** to be factors:

- **Twin or near-identical names.** 40% of failed lines have a near-identical name elsewhere in the catalogue, but so do the lines that were picked without trouble: products with a twin fail 17.1% of the time, products without fail 18.0%.
- **A particular staff member**, as in section 2.
- **The website sync showing sizes that were not there.** It showed what the app held every time.
- **Wrong colourway or wrong size sent**: one case recorded (a hub sent a different size).

By category, as a rate against all lines of that kind: Clothing 20.3% (98 of 483), Footwear 17.5% (122 of 699), Accessories 14.6% (6 of 41), Perfume 8.1% (5 of 62). Inside those: sneakers 125 failed lines, T-shirts 39, caps and hats 36, jerseys 15, polos 10.

By brand (share of failed lines): Lacoste 25%, Nike 21%, Adidas 6%, Jordan 5%, Boss 4%, Diesel 3%. That follows what sells; the one product family that stands out is **Lacoste caps**, where a handful of near-identical caps account for 21 failed lines between them.

Repeat offenders: 34 product-sizes failed two or more times (90 failed lines between them), and 28 of the 34 have not been picked successfully since. The worst: Lacoste cap green 2 (8 times), Barcelona Soccer Jersey Black L (5), Lacoste cap (5), Lacoste Powercourt White/Green 7 (4). Appendix D has all 34.

## 6. Alternatives

Jamie offered alternatives on 242 lines. 220 are decided: **184 accepted (84%), 26 declined (12%), 10 no reply (5%)**. Another 8 were found after all, 11 are still inside their first 48 hours.

What separates the groups:

| | Accepted (184) | Declined (26) | No reply (10) |
|---|---|---|---|
| Median time from rejection to first offer | 12 minutes | 18 minutes | 6 minutes |
| Offer sent on WhatsApp | 83% | 69% | 50% |
| Offer sent by email | 15% | 31% | 50% |
| Options in the first message (average) | 2.8 | 2.4 | 2.3 |
| Every option at the price paid | 47% | 32% | 33% |
| Rounds of options (average) | 1.7 | 2.5 | 1.6 |

Acceptance rate by each thing that was compared:

| | Offers | Accepted |
|---|---|---|
| **Channel**: WhatsApp | 175 | 86.9% |
| **Channel**: email | 41 | 68.3% |
| **Options in the first message**: 3 | 159 | 87.4% |
| **Options in the first message**: 2 | 45 | 73.3% |
| **Options in the first message**: 1 | 5 | 60.0% |
| **Price**: every option at the price paid | 96 | 88.5% |
| **Price**: dearer options only | 70 | 84.3% |
| **Price**: same or cheaper | 38 | 76.3% |
| **Delay**: offered within 1 hour | 113 | 84.1% |
| **Delay**: 1 to 6 hours | 29 | 79.3% |
| **Delay**: 6 to 24 hours | 18 | 83.3% |
| **Brand**: every option the same brand | 90 | 84.4% |
| **Brand**: no option the same brand | 58 | 82.8% |
| **Photos**: WhatsApp with photos | 91 | 85.7% |
| **Photos**: WhatsApp, no photos logged | 84 | 88.1% |
| **Model**: Sonnet | 120 | 81.7% |
| **Model**: MiMo | 35 | 82.9% |
| **Time of day**: 09:00 to 12:00 | 99 | 87.9% |
| **Time of day**: 12:00 to 15:00 | 54 | 85.2% |
| **Time of day**: 15:00 to 18:00 | 46 | 76.1% |
| **Day**: Sunday to Wednesday | 114 | 92.1% |
| **Day**: Thursday to Saturday | 102 | 75.5% |
| **Rounds**: settled in one round | 128 | 90.6% |
| **Rounds**: needed two | 46 | 69.6% |

Read plainly:

- **Speed is already not the problem.** Two thirds of offers go out within the hour and the slower ones do no worse.
- **Channel matters most.** An emailed offer is accepted 68% of the time and ignored 12% of the time; a WhatsApp offer 87% and 3%. Email became the main channel on 21 and 22 November when first WhatsApp messages were held back.
- **Three options beat two.** And when customers pick, 30 of 129 recorded picks (23%) were an option from a later round, so the first three were often not enough.
- **Price matters to the people who decline.** 74% of accepted picks were at the price paid. Offers made only of cheaper items do worst (76%), which fits what decliners say: they want the thing they ordered, not something lesser.
- **Brand, photos and model make no measurable difference.**
- **Late in the day and late in the week do worse**, by about ten points.

What decliners actually said (their words, order numbers only):

- Wants the exact item or their money: "Sorry, nothing seems, I would rather option for a full refund then if you do not have what I order." (#2327). "I want that pink one. I ordered not these one" (#2264). "Please refund me" (#2003).
- Cannot add money: "I dont have R200 so please refund me" (#2279). "I dont have money to add so I need something of the same amount." (#1869).
- The options were not close enough: "Can u please show me another one you have, because its girl" (#1802). "I want something in a dark colour with just one small branded logo or artwork." (#2056). "I never order samba" (#2269).
- Trust: "Why do you guys advertise things you don't have?" (#1931). "It's your guy's fault you don't update your stock. I'm coming to the shop" (#2215). "No it looks like everything on display is not available, I won't be taking any t-shirt" (#2276).

What would raise acceptance, from this evidence: keep offers on WhatsApp; always lead with three options; make sure at least one option, and preferably the first, costs exactly what the customer paid; never send a set made only of cheaper items when a same-price one exists.

## 7. Decisions for Junid

These need one of Junid's standing rules changed, so nothing was built for them.

1. **Central-only sizes are sold on the website but can never be picked from Central.** 9 lines in five weeks were ordered when only Central held the size; 4 failed and the rest waited a median of 41 hours for the scan's refill. Either the website stops counting Central's stock for a size no shop or hub holds (fewer sizes on sale, no waiting orders), or it stays as it is. It is 4% of failed lines, so it is not urgent.
2. **A rejection does not correct the count.** When a hub says Out of Stock or a shop says Not found on a website pick, the app still shows the piece. The fix shipped here only hides that piece from the website; the app's count, the refill scan and the Total Stock card still believe it. Whether a website rejection should also write the count down (as the two-refused-days rule does for refill requests) is Junid's call, because it changes what the scan asks for.
3. **Last pieces in general.** Hiding every last piece would have avoided 109 failures and cost 310 good sales, so it was not done. Only the class that fails more often than it succeeds was hidden (section 9).
4. **Walk-in sales over a website hold.** 7 lines were lost because a manager PIN let a till sale take a unit a website order was holding. The hold worked; the override was used.
5. **Marathon PE's counts.** PE rejects one website pick in five and its untouched last pieces fail 57% of the time. A count of PE's clothing would do more than any code here. Concrete, counted on 11 November, rejects 1.6%.
## 8. What was shipped (24 November 2026, live from about 12:10)

**A shelf that says "not here" comes off the website until it is touched again** (store app PR #980).
When a hub marks a website pick Out of Stock or a shop presses Not found, the pieces the app shows at that one shelf (product, size, place) are no longer counted for the website and no new line is sent there. The moment that shelf has a sale, a delivery, a transfer or a count, it counts again by itself. If the packer finds the item and presses "Order it now", the line goes back to that shelf and the hold is lifted. No stock count is changed, nothing is requested, nothing is picked from Central, and stock still leaves only at the Pack. This is the cause that made 46 of the 261 failures, and 21 of the 80 in the week of 15 to 21 November.

**The nightly check.** The 02:30 stock sweep already compares every listing with the app. It now uses the same rule, so every night each listing is re-checked against stock a shop or hub can actually pick, and holds whose shelf has moved are tidied away.

**The automatic second look** was not built, because it is already running: since 14 November the order agent and Jamie try the other places on the route before the customer hears anything, and "found at a different place" went from 3 lines in four weeks to 16 in six days. A second look at the *same* shelf found the item once in the six times it was tried, so that was not built either. The order agent now reads the same held shelves as the router, so it does not ask for a re-pick at a shelf that has already said no.

**Jamie** (dm-agent PR #202, live 12:16, WhatsApp reconnected in 40 seconds).
- The finding that mattered most was already fixed but not running: the WhatsApp-first change Junid asked for on 22 November (PR #200) had been merged and never pulled onto the Mac mini, so offers were still going out mostly by email (21 November: 39 by email, 7 by WhatsApp; 22 November: 34 and 0; today before the deploy: 9 and 1). It is live now, together with two other merged changes that were waiting (#201, #203).
- The option picker is now told to return three options whenever three are fair swaps, and to make one of them cost exactly what the customer paid when a fair one exists. None of Jamie's standing rules changed: WhatsApp first, no refund offered by Jamie, at least two pieces in the customer's size, never an unavailable or declined product, and a pick that is not a fair swap is still left out.

Reviews: CodeRabbit did not review either pull request (it answered with a spending-cap notice), so a substitute Sonnet line review was run beside the Sonnet architect review, and a third Sonnet pass re-checked the fixes. Each PR carries a comment saying so. The reviews found one blocking fault (a hold would have defeated "Order it now") and five smaller ones; all were fixed and tested before the merge.

## 9. What was hidden, and how to bring it back

Nothing was deleted, unpublished or set to draft. A size's website quantity is lower by the pieces below; where that was the only piece, the size shows sold out.

**1. Shelves that rejected a website pick and have not been touched since: 95 shelves, 161 pieces.**
The bar: every product, size and place where a hub said Out of Stock or a shop said Not found on a website order since #1768, and where the count has not moved since that rejection. This covers every size that failed twice or more and was not picked successfully since. Of the 161 shelves that ever rejected a pick, 19 were left alone because they have moved since (trusted again) and 47 already showed zero.
- List and rollback: `~/marathon-rollbacks/cell-holds-2026-11-24T10-09-08-954Z.json` on the Mac mini.
- Restore all: `node scripts/shopify/onlineOrders/cell-holds.mjs --rollback <that file> --commit`
- Returns by itself: the next sale, delivery, transfer or count on that shelf.

**2. A single piece at Marathon PE that has not moved for more than 14 days: 514 sizes on 355 products.**
The bar: the one clearly defined class with at least 10 lines and at least half of them unavailable. 54 website lines were sent to such a piece and 31 (57%) were rejected. No other place reaches the bar (Hub 1 42%, Trophy 37%, Hub 2 34%), so only Marathon PE is included. 249 of the 514 sizes are sold out online because that was the only piece; the other 265 are still on sale from another place.
- List and rollback: `~/marathon-rollbacks/stale-single-2026-11-24T10-11-24-984Z.json` on the Mac mini.
- Restore all: `node scripts/shopify/onlineOrders/cell-holds.mjs --stale-off <that file> --commit` (or set `/config/onlineOrders/pickable/staleSingle/off` to true).
- Returns by itself: the next sale, delivery, transfer or count on that piece. The days and the places are settings (`staleSingle/days`, `staleSingle/locations`).

What this costs, said plainly: over the five weeks, 23 of the 54 lines sent to such a piece were picked without trouble (about R7,600), against 31 that failed (about R9,900). Hiding them gives up the first to avoid the second. With Black Friday this week, 249 sizes showing sold out is a real number; one command above brings them back.

Both switches at once: `/config/onlineOrders/pickable/holdsOff = true` turns the first rule off.

## 10. What to expect, and what was not solved

- The repeat failures (18% of all, and rising) should stop, and the Marathon PE stale singles (12%) should stop arriving. Together that is roughly a quarter to a third of the failures seen in the last two weeks.
- The largest cause is only partly dealt with: a last piece still fails about one time in four everywhere else, because the count is wrong and nothing here corrects a count. That is decisions 2, 3 and 5 in section 7.
- The acceptance figures for alternatives should be read again in two weeks, now that offers go on WhatsApp again and lead with three options. The CSVs and the scripts under `scripts/audit/web-unavailable/` rebuild every number in this report.

## Appendix A: every unavailable line and its reason

| Order | Product | Size | Sent to | What happened | Shown there then | Outcome |
|---|---|---|---|---|---|---|
| #1772 | Lacoste cap | one size | Marathon PE | 2026-10-23 14:45 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Lacoste cap navy blue 2# at Marathon PE |
| #1773 | Air Jordan 4 Retro University Blue | 9 | Hub 1 | 2026-10-22 10:03 routed_nowhere by system (routing) | 0 | found later: at Hub 1 |
| #1776 | Giorgio Armani acquadi perfume | one size | Marathon PE | 2026-10-23 10:57 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Calvin Klein one essence perfume at Marathon PE |
| #1780 | Lacoste Slip-On White Stripe | 6 | Hub 1 | 2026-10-23 10:40 hub_out_of_stock at Hub 1 by Alli ibro | 3 | found later: at Marathon PE (no pick record) |
| #1781 | T-shirt white DIESEL w443# | S | Marathon PE | 2026-10-23 14:54 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Karl Lagerfeld t-shirt white S at Marathon PE |
| #1781 | Karl Lagerfeld t-shirt white | S | Marathon PE | 2026-10-23 16:45 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: replaced at the till: Fear Of God Essentials T-Shirt Cream S at Marathon PE |
| #1782 | Lacoste L.12.12 perfume | one size | Marathon PE | 2026-10-23 14:47 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Calvin Klein one essence perfume at Marathon PE |
| #1794 | Nike Shox TL Full Black | 7 | Hub 1 | 2026-10-25 11:04 hub_out_of_stock at Hub 1 by Alli ibro | 0 | alternative accepted: customer picked: Nike Shox TL Brown Black 7 at Hub 1 |
| #1797 | Lacoste Slip On Green Tweed | 7 | Hub 1 | 2026-10-25 09:27 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Lacoste slip on navy with Lacoste print 7 at Hub 1 |
| #1798 | Lacoste Powercourt White/Green | 6 | Hub 1 | 2026-10-30 13:39 hub_out_of_stock at Hub 1 by Junid (sent by mistake: size 6 not available) | 1 | alternative accepted: customer picked: Lacoste Powercourt White/Green 7 at Hub 1 |
| #1798 | Lacoste Powercourt White/Green | 7 | Hub 1 | 2026-11-07 09:11 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Lacoste Powercourt White/Green 7 at Hub 1 |
| #1802 | Nike Air Force 1 Low Drake NOCTA Certified Lover Boy Palest Purple | 4 | Hub 1 | 2026-10-25 11:22 hub_out_of_stock at Hub 1 by Alli ibro | 1 | open |
| #1815 | Lacoste Slip On White Black | 6 | Hub 1 | 2026-10-26 15:44 hub_out_of_stock at Hub 1 by Alli ibro / 2026-10-28 11:08 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Lacoste slip on  Navy White 6 at Hub 1 |
| #1818 | Louis Vuitton bag black end brown  | M | Trophy | 2026-10-27 14:24 shop_not_found at Trophy by Sphe | 1 | alternative accepted: customer picked: Alo bag brown at Trophy |
| #1818 | Nike blazer | 9 | Hub 1 | 2026-10-26 16:40 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Nike Air Max Portal Bright Ceramic 9 at Hub 1 |
| #1820 | Brazil world cup jersey yellow | XL | Marathon PE | 2026-10-27 11:53 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Portugal world cup jersey red XL at Marathon PE |
| #1821 | Nike confort cream  | 3 | Hub 1 | 2026-10-27 09:13 hub_out_of_stock at Hub 1 by Alli ibro / 2026-10-28 11:08 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike portal blue  3 at Hub 1 |
| #1829 | Diesel Green Black White Orange | 9 | Hub 2 | 2026-10-27 09:25 hub_out_of_stock at Hub 2 by Mike / 2026-10-27 14:12 hub_out_of_stock at Hub 2 by Mike / 2026-10-28 10:16 hub_out_of_stock at Hub 2 by Mike | 3 | alternative accepted: replaced at the till: Diesel Green Black White Orange 10 at Hub 2 |
| #1832 | Lacoste cap brown 1# | one size | Marathon PE | 2026-10-28 14:27 shop_not_found at Marathon PE by 2POS | 2 | alternative accepted: customer picked: Lacoste cap green 2 at Marathon PE |
| #1839 | DOLCE AND GABBANA BLACK END WHITE  | 6 | Hub 2 | 2026-10-28 11:23 hub_out_of_stock at Hub 2 by Ahmed | 1 | found later: at Hub 2 (no pick record) |
| #1842 | Sox cap  black | one size | Marathon PE | 2026-10-28 14:27 shop_not_found at Marathon PE by 2POS | 1 | cancelled |
| #1842 | Chelsea white soccer jerseys  | S | Marathon PE | 2026-10-28 14:27 shop_not_found at Marathon PE by 2POS | 1 | cancelled |
| #1845 | Nike Portal Bright Ceramic | 4 | Hub 1 | 2026-10-28 10:31 hub_out_of_stock at Hub 1 by Alli ibro | 4 | alternative accepted: customer picked: Nike Air Max Portal Bright Ceramic 5_5 at Hub 1 |
| #1848 | T-shirt cream white Lacoste w610# | L | Marathon PE | 2026-10-28 14:27 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Lacoste T shirts L at Marathon PE |
| #1850 | Diesel Green Black White Orange | 9 | Hub 1 | line was resolving | 0 | alternative accepted: replaced at the till: Diesel Green Black White Orange 10 at Hub 2 |
| #1856 | Lacoste Polo Brown | L | Marathon PE | 2026-10-29 13:52 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Lacoste T shirts 688# L at Marathon PE |
| #1864 | Adidas sambarose cloud white  | 5.5 | Hub 2 | 2026-10-29 09:15 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: Adidas sambarose cloud black  5_5 at Hub 2 |
| #1866 | Nike SB Dunk Low Green White | 7 | Hub 1 | 2026-10-29 09:48 hub_out_of_stock at Hub 1 by Alli ibro / 2026-10-29 15:35 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Jean Shorts BS-9058 M at Marathon PE |
| #1866 | Jean Shorts BS-9058 | M | Marathon PE | 2026-11-03 09:58 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Hydraulic short not for small boys white M at Marathon PE |
| #1876 | T-shirt black 025 YL-BOILING | XXL | Hub 2 | line was resolving | 0 | alternative accepted: customer picked: Short camouflage green 3020#1 XL at Marathon PE |
| #1877 | Lacoste Gripshot Mid Light Green | 7 | Hub 1 | 2026-10-30 09:23 hub_out_of_stock at Hub 1 by Alli ibro | 3 | found later: at Hub 1 |
| #1880 | DOLCE & GABBANA white end black  | 7 | Hub 2 | 2026-10-30 09:26 hub_out_of_stock at Hub 2 by Ayob | 4 | found later: at Hub 2 |
| #1882 | Armani belt black end gold  | L | Trophy | 2026-11-03 11:35 packer_damaged at Trophy by 2POS | 1 | alternative accepted: customer picked: Hermes H belt brown L at Hub 2 |
| #1882 | T-shirt black KARL LAGERFELD PARIS W698# | M | Marathon PE | 2026-10-30 12:07 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: T-shirt Karl Lagerfeld cream white W698# M at Marathon PE |
| #1886 | Lacoste cap | one size | Marathon PE | 2026-11-01 11:12 shop_not_found at Marathon PE by Zee | 5 | alternative accepted: customer picked: Lacoste cap blue at Marathon PE |
| #1891 | Diesel Green Black White Orange | 9 | Hub 1 | line was resolving | 0 | alternative accepted: replaced at the till: Diesel Green Black White Orange 10 at Hub 2 |
| #1894 | Diesel Green Black White Orange | 10 | Hub 2 | 2026-10-30 15:31 hub_out_of_stock at Hub 2 by Mike | 1 | alternative accepted: customer picked: Diesel Green Black White Orange 10 at Hub 2 |
| #1896 | Nike blazer | 9 | Hub 1 | 2026-10-30 15:36 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Lacoste Court Cage White 9 at Hub 1 |
| #1899 | Barcelona Soccer Jersey Black | L | Marathon PE | 2026-11-01 11:11 shop_not_found at Marathon PE by Zee | 2 | alternative accepted: customer picked: Nike Arsenal Fly Emirates White L at Marathon PE |
| #1905 | Boss golf t shirt black BSS12# | L | Marathon PE | 2026-11-01 11:11 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Golf t-shirt black p G6133 L at Trophy |
| #1905 | Boss golf t shirt black: Bs-44337 | L | Marathon PE | 2026-11-02 12:23 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Golf t-shirt black p G6133 L at Trophy |
| #1914 | Dolce & Gabbana Portofino White Beige | 3 | Hub 2 | 2026-11-01 10:01 hub_out_of_stock at Hub 2 by Ahmed | 1 | alternative accepted: customer picked: Gucci Crystal-Embellished GG White Platform Sneaker 3 at Hub 2 |
| #1925 | Converse Chuck Taylor All Star Low White | 5 | Hub 1 | 2026-11-01 10:48 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Adidas forum exhibit low light blue 5 at Hub 2 |
| #1927 | Raw Graphic Tee Grey | L | Marathon PE | 2026-11-02 12:24 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Raw Graphic Tee Grey XL at Marathon PE |
| #1927 | Raw Graphic Tee Grey | XL | Marathon PE | 2026-11-03 09:06 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Raw Graphic Tee Grey XL at Marathon PE |
| #1927 | Graphic T-Shirt Black | L | Marathon PE | 2026-11-05 09:57 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: White Graphic T-Shirt L at Marathon PE |
| #1927 | White Graphic T-Shirt | L | Marathon PE | 2026-11-05 11:32 shop_not_found at Marathon PE by 2POS | 6 | alternative accepted: customer picked: Enfants Riches Déprimés T-Shirt L at Marathon PE |
| #1927 | Enfants Riches Déprimés T-Shirt | L | Marathon PE | 2026-11-06 08:53 shop_not_found at Marathon PE by Zee / 2026-11-10 11:31 shop_not_found at Marathon PE by Zee | 2 | open being picked: at Marathon PE |
| #1931 | Diesel Green Black White Orange | 7 | Hub 2 | 2026-11-02 09:20 hub_out_of_stock at Hub 2 by Mike | 3 | alternative accepted: customer picked: Diesel Big D Green Orange 7 at Hub 1 |
| #1931 | Nike Air Max Motum White Obsidian | 8 | Hub 1 | 2026-11-05 09:56 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Jordan1 white with green  8 at Hub 1 |
| #1932 | Nike Air Max Plus Cream Brown Blue | 3 | Hub 1 | 2026-11-02 10:46 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Air Max Plus White 3 at Hub 1 |
| #1934 | Nike Air Force 1 '07 Essential Summit White | 5.5 | Hub 1 | 2026-11-02 09:46 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Nike Air Force 1 Low Certified Lover Boy Yellow 5_5 at Hub 1 |
| #1935 | Sox fitted cap black | 56 | Marathon PE | 2026-11-02 12:25 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Sox fitted cap black colorway 56 at Marathon PE |
| #1942 | Supreme x Nike air force 1 purple | 9 | nowhere (no stock on the route) | 2026-11-02 08:57 routed_nowhere by system (routing) |  | alternative accepted: customer picked: Timberland  yellow  8 at Hub 1 |
| #1944 | Lacoste white with blue  | 8 | nowhere (no stock on the route) | line was resolving |  | alternative accepted: customer picked: Nike Air Max Plus White 8 at Hub 1 |
| #1944 | Lacoste Powercourt White Black | 7 | nowhere (no stock on the route) | 2026-11-02 12:56 routed_nowhere by system (routing) |  | alternative accepted: customer picked: Adidas Samba White Core Black 7 at Hub 1 |
| #1945 | T-shirt cream white DIESEL W634# | XL | Marathon PE | 2026-11-02 16:44 walkin_sale_over_hold at Marathon PE by ahmed | 1 | alternative accepted: customer picked: Diesel T-Shirt White XL at Marathon PE |
| #1954 | T-shirt cream white DIESEL w617# | XL | nowhere (no stock on the route) | 2026-11-03 06:30 routed_nowhere by system (routing) |  | alternative accepted: customer picked: T shirt cream white BALENCIAGA PARIS W724# XL at Marathon PE |
| #1955 | Lacoste CORDE 317 1 CAM | 6 | Hub 2 | 2026-11-03 09:36 hub_out_of_stock at Hub 2 by Mike | 1 | refund: refunded R850 (both 338912597) |
| #1958 | LA fitted  cap black | 55 | Marathon PE | 2026-11-03 15:34 packer_damaged at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Chicago bulls cap red& black 55 at Marathon PE |
| #1960 | Converse Cold Wall Blue | 4 | Hub 1 | 2026-11-03 14:01 packer_damaged at Hub 1 by 2POS | 2 | alternative accepted: customer picked: Converse Cold Wall Grey 4 at Hub 1 |
| #1960 | Converse Cold Wall Blue | 8 | Hub 1 | 2026-11-03 14:01 packer_damaged at Hub 1 by 2POS | 1 | alternative accepted: replaced at the till: Supreme x Nike air force 1 purple 8 at Hub 1 |
| #1965 | Barcelona Soccer Jersey Black | L | Marathon PE | 2026-11-03 09:57 shop_not_found at Marathon PE by Zee | 2 | alternative accepted: customer picked: Liverpool FC Crown Paints Jersey Red L at Marathon PE |
| #1968 | Lacoste Powercourt White/Green | 7 | Hub 1 | 2026-11-03 09:43 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Lacoste Powercourt White/Green 8 at Hub 1 |
| #1970 | New Balance 1000 Black | 7 | Hub 2 | 2026-11-03 12:30 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: New Balance 9060 Black 7 at Hub 2 |
| #1974 | Hugo boss adjustable cap navy #1 | one size | Marathon PE | 2026-11-05 10:02 shop_not_found at Marathon PE by Zee | 5 | alternative accepted: customer picked: Hugo boss cap white -1 at Marathon PE |
| #1974 | Boss T shirt  658# | XL | Marathon PE | 2026-11-05 11:32 shop_not_found at Marathon PE by 2POS | 1 | alternative accepted: customer picked: T-shirt black DIESEL w617# XL at Hub 2 |
| #1977 | Lacoste cap | one size | Marathon PE | 2026-11-05 09:57 shop_not_found at Marathon PE by Zee | 5 | alternative accepted: customer picked: Lacoste cap green 2 at Marathon PE |
| #1977 | Lacoste cap green 2 | one size | Marathon PE | 2026-11-09 15:04 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #1977 | Lacoste Powercourt White | 8 | Hub 1 | 2026-11-05 09:34 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Lacoste Court Cage White 8 at Hub 1 |
| #1981 | Nike Portal Royal Blue | 4 | Hub 1 | 2026-11-05 09:58 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike portal blue  4 at Hub 1 |
| #1982 | Air Jordan 1 Low Travis Scott Brown Pink | 7 | Hub 2 | 2026-11-05 09:05 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: On Cloudtilt Grey 7 at Hub 1 |
| #1984 | Lacoste Polo Shirt Grey | L | Marathon PE | 2026-11-05 09:31 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Lacoste Golf Polo Grey L at Marathon PE |
| #1984 | Lacoste Polo Brown | L | Marathon PE | 2026-11-05 09:31 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Golf t-shirt Grey p G6160 L at Trophy |
| #1988 | Barcelona Soccer Jersey Black | L | Marathon PE | 2026-11-05 09:31 shop_not_found at Marathon PE by Zee | 2 | alternative accepted: customer picked: FC Barcelona Away Jersey Mint L at Marathon PE |
| #1989 | Adidas sambarose cloud white  | 5.5 | Hub 2 | 2026-11-05 15:22 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: Adidas Samba White Black Gum 5_5 at Hub 2 |
| #1990 | Jordan bag Blue FJ6784-377#M | one size | Trophy | 2026-11-05 10:51 shop_not_found at Trophy by Sphe | 2 | alternative accepted: customer picked: Jordan red bag FJ6784-377#M at Trophy |
| #1992 | Converse Chuck Taylor All Star Black | 5 | Hub 1 | 2026-11-05 09:45 hub_out_of_stock at Hub 1 by Alli ibro | 4 | alternative accepted: customer picked: Nike  Portal Canyon Pink 5 at Hub 1 |
| #2000 | Nike airforce 1 cream white | 7 | Hub 2 | 2026-11-05 09:59 hub_out_of_stock at Hub 2 by Alli ibro | 1 | alternative accepted: customer picked: Nike Air Force 1 Cream Brown Gum 7 at Hub 1 |
| #2003 | Lacoste sweatshirt green | L | Trophy | 2026-11-05 14:01 walkin_sale_over_hold at Trophy by ahmed | 1 | refund: refunded R600 (both 339489247) |
| #2003 | Sweatshirt lacoste nevy blue | M | Trophy | 2026-11-06 11:36 shop_not_found at Trophy by Sphe | 1 | refund: refunded R600 (both 339489247) |
| #2006 | Lacoster underwear men | M | Marathon PE | 2026-11-09 10:07 shop_not_found at Marathon PE by Zee | 2 | open being picked: at Marathon PE |
| #2008 | Nike t shirt black w683# | S | Marathon PE | 2026-11-09 15:04 shop_not_found at Marathon PE by Zee | 1 | open being picked: at Marathon PE |
| #2010 | Lacoste golf t shirt white: LCE-3431 | M | Marathon PE | 2026-11-06 09:30 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Converse Chuck Taylor All Star Black 9 at Hub 1 |
| #2011 | Nike Air Force 1 Low Metalwork Medium Ash Anthracite | 7 | Hub 1 | 2026-11-06 09:20 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Lacoster t clip winter grey 7 at Hub 1 |
| #2014 | Air Jordan 4 Retro Frozen | 7 | Hub 2 | 2026-11-06 09:01 hub_out_of_stock at Hub 2 by Mike | 1 | alternative accepted: customer picked: Nike Air Max Plus Cream Brown Blue 7 at Hub 1 |
| #2017 | Nike Air Vapormax Full Black | 8 | Hub 1 | 2026-11-13 12:02 packer_damaged at Hub 1 by 2POS | 1 | open |
| #2018 | Lacoste Carnaby White | 10 | Hub 1 | 2026-11-06 09:34 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Lacoste Powercourt White Green 10 at Hub 1 |
| #2027 | Hydraulic short black WHERE THE BIG DOGS PLAY 2025# | L | Marathon PE | 2026-11-07 09:31 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Hydraulic short white  L at Marathon PE |
| #2028 | FC Bayern black soccer jerseys  | XXL | Marathon PE | 2026-11-07 09:33 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Adidas Germany 1992 Home Jersey Teal XL at Marathon PE |
| #2032 | Nike t shirt black w683# | M | Hub 2 | 2026-11-07 09:37 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: Nike T shirt white w683# M at Hub 2 |
| #2032 | Nike T shirt white w683# | M | Hub 2 | 2026-11-07 09:46 hub_out_of_stock at Hub 2 by Mike | 3 | alternative accepted: customer picked: Nike max t shirt  white w671## M at Marathon PE |
| #2035 | Nike airforce cream white | 6 | Hub 1 | 2026-11-07 10:40 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Diesel S-Ukiyo Maroon Cream 8 at Hub 2 |
| #2035 | Dolce &GABBANA  BLACK end white  | 8 | Hub 2 | 2026-11-07 10:55 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: DOLCE & GABBANA BLACK END WHITE  8 at Hub 2 |
| #2036 | Lacoste Powercourt White/Green | 7 | Hub 1 | 2026-11-07 12:14 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Lacoster powercourt navy end white 7 at Hub 1 |
| #2037 | Diesel S-Ukiyo V2 Low Green | 9 | Hub 2 | 2026-11-07 12:16 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: Lacoste Powercourt White Green 9 at Hub 1 |
| #2038 | Nike t shirt black w683# | M | Hub 2 | 2026-11-08 12:32 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: G star raw t shirt black w666# M at Marathon PE |
| #2038 | Nike t shirt 1972 black:w686# | M | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: G star raw t shirt black w666# M at Marathon PE |
| #2041 | Hydraulic short black WHERE THE BIG DOGS PLAY 2025# | L | Marathon PE | 2026-11-08 10:25 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Short camouflage blue 438271#1 L at Marathon PE |
| #2043 | New Balance 1000 Black | 6 | Hub 2 | 2026-11-13 12:02 packer_damaged at Hub 2 by 2POS | 1 | alternative accepted: customer picked: Nike Air Max 97 White Denim Red 6 at Hub 1 |
| #2047 | Diesel t shirt white :w662# | L | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: T-shirt cream white DIESEL w617# L at Marathon PE |
| #2053 | Lacoste Gripshot Mid Light Green | 6 | Hub 1 | 2026-11-09 09:14 hub_out_of_stock at Hub 1 by Mike | 2 | alternative accepted: customer picked: Lacoster gripshot mid white and brown 6 at Hub 1 |
| #2058 | FC Barcelona Away Jersey Mint | M | Marathon PE | 2026-11-09 10:42 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Chelsea soccer jerseys Brue color  M at Marathon PE |
| #2058 | Nike x NOCTA Northstar Nylon Tracksuit, cargo khaki brown colorway | M | Marathon PE | 2026-11-09 10:32 shop_not_found at Marathon PE by Zee | 1 | cancelled |
| #2062 | Timberland Premium 6-Inch Black | 7 | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: Timberland Premium 6-Inch Wheat 7 at Hub 1 |
| #2063 | Sweatshirt lacoste nevy blue | M | Trophy | 2026-11-09 10:11 shop_not_found at Trophy by Sphe | 1 | alternative accepted: customer picked: Sweater hoodie dark Grey plane 6062#1 M at Trophy |
| #2065 | Lacoster sneaker navy | 8 | Hub 2 | line was unavailable | 2 | alternative accepted: customer picked: Karl Lagerfeld Kapri White 8 at Hub 2 (old item: return to shelf) |
| #2073 | Hugo boss adjustable cap navy #1 | one size | Marathon PE | 2026-11-10 09:19 shop_not_found at Marathon PE by Zee | 5 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #2073 | Lacoste cap | one size | Marathon PE | 2026-11-16 11:50 shop_not_found at Marathon PE by Zee | 6 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #2073 | Lacoste cap | one size | Marathon PE | 2026-11-17 09:38 shop_not_found at Marathon PE by Zee | 5 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #2073 | Sox cap  black | one size | Marathon PE | 2026-11-19 10:35 shop_not_found at Marathon PE by Zee | 1 | found later: at Concrete |
| #2079 | Lacoste cap  blue | one size | Marathon PE | 2026-11-10 09:19 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: NY cap blue at Marathon PE |
| #2079 | Lacoste cap green 2 | one size | Marathon PE | 2026-11-10 09:19 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #2079 | Lacoste cap | one size | Marathon PE | 2026-11-10 09:47 shop_not_found at Marathon PE by Zee | 5 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #2079 | Lacoste cap | one size | Marathon PE | 2026-11-10 11:31 shop_not_found at Marathon PE by Zee | 6 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #2084 | Manchester united soccer jerseys red | L | Marathon PE | 2026-11-10 09:53 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Adidas Benfica Home Jersey White Red XL at Marathon PE |
| #2084 | Barcelona Soccer Jersey Black | L | Marathon PE | 2026-11-10 09:48 shop_not_found at Marathon PE by Zee | 2 | alternative accepted: customer picked: Paris Saint-Germain Football Club Jersey Black Pink XL at Marathon PE |
| #2085 | G star raw t shirt black w666# | XXL | Marathon PE | 2026-11-12 12:18 walkin_sale_over_hold at Marathon PE by ahmed | 1 | found later: at Marathon PE |
| #2092 | Diesel Green Black White Orange | 8 | Hub 2 | 2026-11-13 12:16 packer_damaged at Hub 2 by 2POS | 1 | alternative accepted: customer picked: Diesel Black White 8 at Hub 2 |
| #2093 | Versace EROS perfume | one size | Marathon PE | 2026-11-11 10:09 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: Dior Sauvage perfume at Marathon PE |
| #2094 | CVT-30 ENFANTS RICHES DEPRIMES BLACK | M | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: Saint Michael Neon Logo T-Shirt Black M at Marathon PE |
| #2094 | Nike Air Force 1 Low Metalwork Medium Ash Anthracite | 7 | Hub 1 | 2026-11-11 12:50 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Air force LV blue  7 at Hub 1 |
| #2095 | Lacoster gripshot full white | 8 | Hub 1 | 2026-11-20 10:38 packer_damaged at Hub 1 by 2POS | 1 | alternative accepted: customer picked: Lacoste Gripshot Mid Green 8 at Hub 1 |
| #2095 | G star raw jean 922# | M | Marathon PE | 2026-11-11 10:09 shop_not_found at Marathon PE by Zee | 3 | alternative accepted: customer picked: Diesel Jeans Black M at Marathon PE |
| #2097 | Boss golf t shirt black: Bs-44337 | L | Marathon PE | 2026-11-23 14:04 packer_not_here at Marathon PE by yusuf | 1 | open |
| #2097 | Lacoste Polo Brown | L | Marathon PE | 2026-11-11 14:28 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Golf t-shirt green p G 6122#1 L at Trophy |
| #2108 | Nike Air Force 1 shell  Cream Brown | 6 | Hub 1 | 2026-11-12 11:33 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: The North Face Verto Alpha Blue Black 6 at Hub 2 |
| #2108 | Nike Air Force 1  Shell Green | 6 | Hub 3 | 2026-11-13 11:07 hub_out_of_stock at Hub 3 by Mike | 1 | found later: at Hub 3 |
| #2111 | Boss slide black end white | 9 | Hub 2 | 2026-11-12 09:52 hub_out_of_stock at Hub 2 by Ahmed | 1 | alternative accepted: customer picked: Boss slide navy white 9 at Hub 2 |
| #2111 | Boss slide full black | 10 | Hub 2 | 2026-11-12 09:16 hub_out_of_stock at Hub 2 by Ahmed | 1 | alternative accepted: customer picked: Boss slide black end white 9 at Hub 2 |
| #2116 | Hydraulic short black WHERE THE BIG DOGS PLAY 2025# | L | Marathon PE | 2026-11-12 12:30 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Hydraulic short white  L at Marathon PE |
| #2119 | Lacoste white with blue  | 6 | Hub 1 | 2026-11-12 15:09 hub_out_of_stock at Hub 1 by Mike | 3 | alternative accepted: customer picked: Diesel Black White 6 at Hub 2 |
| #2122 | Essentials bag black: #9155 | one size | Trophy | 2026-11-13 14:55 shop_not_found at Trophy by Sphe | 1 | alternative accepted: customer picked: Essential bag black #1 at Trophy |
| #2133 | Saint Michael T-Shirt Black | M | Marathon PE | 2026-11-14 09:44 shop_not_found at Marathon PE by Zee | 1 | found later: at Concrete |
| #2133 | T-shirt Nike coral pink W671# | L | Marathon PE | 2026-11-14 12:41 walkin_sale_over_hold at Marathon PE by ahmed | 2 | alternative accepted: customer picked: Nike max t shirt  cream white w671# L at Marathon PE |
| #2133 | Nike t-shirt black w551# | L | Marathon PE | 2026-11-15 12:31 walkin_sale_over_hold at Marathon PE by ahmed | 2 | alternative accepted: customer picked: Nike t shirt 1972 black:w686# L at Concrete |
| #2133 | T-shirt black essentials fear of god w354# | S | Marathon PE | 2026-11-13 10:56 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Nike t shirt 1972 black:w686# S at Concrete |
| #2133 | Adidas dress | L | Trophy | 2026-11-14 11:45 shop_not_found at Trophy by Sphe | 1 | alternative accepted: customer picked: Nike max t shirt  white w671## M at Marathon PE |
| #2133 | Alo Yoga Airlift Solar Visor Brown | M | Marathon PE | 2026-11-13 10:56 shop_not_found at Marathon PE by Zee | 8 | found later: at Concrete |
| #2133 | Nike dri- fit cap khaki | one size | Marathon PE | 2026-11-13 10:56 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Nike dri-fit Fly cap orange &green colorway M at Concrete |
| #2138 | Lacoste golf t shirt white: LCE-3431 | M | Marathon PE | 2026-11-13 10:56 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Lacoste Polo Shirt Grey L at Marathon PE |
| #2138 | Lacoste Polo Shirt Grey | L | Marathon PE | 2026-11-14 09:44 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Lacoste Golf Polo Orange XL at Marathon PE |
| #2138 | Lacoste Golf Polo Orange | XL | Marathon PE | 2026-11-17 09:38 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Lacoste Golf Polo Grey XL at Marathon PE |
| #2139 | Nike airforce cream white | 6 | Hub 1 | 2026-11-13 13:23 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Air Force 1 Low Drake NOCTA Certified Lover Boy Palest Purple 6 at Hub 1 |
| #2145 | Nike Air force nocta | 3 | Hub 1 | 2026-11-13 16:55 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Waffle Racer White Blue Green Yellow 3 at Hub 1 |
| #2146 | Air Jordan 4 Retro Fear | 3 | Hub 2 | 2026-11-14 09:17 hub_out_of_stock at Hub 2 by Ahmed | 3 | found later: at Hub 2 (no pick record) |
| #2149 | Lacoste Marice Slip-On Black White | 7 | Hub 1 | 2026-11-16 10:49 walkin_sale_over_hold at Hub 1 by ahmed | 2 | alternative accepted: customer picked: Lacoste slip on  Navy White 7 at Hub 1 |
| #2156 | Air Jordan 1 High OG Lost And Found | 9 | Hub 2 | 2026-11-15 09:49 hub_out_of_stock at Hub 2 by Mike | 1 | alternative accepted: customer picked: Nike Air Flightposite "Sail/Black" 9 at Hub 1 |
| #2157 | Pant jean BS061 BOSS BLUE | L | Trophy | 2026-11-15 14:13 shop_not_found at Trophy by Sphe | 1 | alternative accepted: customer picked: Pant jean LP705 LAIA PIANA NAVY L at Trophy |
| #2160 | Barcelona Soccer Jersey Black | L | Marathon PE | 2026-11-15 13:00 shop_not_found at Marathon PE by Zee | 2 | alternative accepted: customer picked: Nike Barcelona Home Jersey Red White L at Marathon PE |
| #2161 | Dolce & Gabbana Portofino White Beige | 6 | nowhere (no stock on the route) | 2026-11-14 15:27 routed_nowhere by system (routing) |  | store credit: store credit R1 200 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2161 | Dolce & Gabbana Portofino White Pink Metallic | 7 | Hub 2 | 2026-11-14 15:35 hub_out_of_stock at Hub 2 by Ahmed | 1 | store credit: store credit R1 200 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2161 | DOLCE  GABBANA WHITE END GOLD  | 6 | nowhere (no stock on the route) | 2026-11-14 15:27 routed_nowhere by system (routing) |  | open |
| #2164 | Lacoste cap green 2 | one size | Marathon PE | 2026-11-15 09:16 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: Lacoste cap Oregon at Concrete |
| #2169 | Nike Air Max Motum White Obsidian | 6 | Hub 1 | 2026-11-15 09:51 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Nike portal lame white 6 at Hub 1 |
| #2172 | Nike t shirt 1972 khaki :w686# | L | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: Nike t shirt 1972 white :w686# L at Concrete |
| #2174 | My cap white & blue | 58 | Marathon PE | 2026-11-15 09:35 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Sox black cap 58 at Marathon PE |
| #2174 | Sox black cap | 58 | Marathon PE | 2026-11-20 11:29 packer_not_here at Marathon PE by 2POS | 1 | alternative accepted: customer picked: Sox fitted cap black colorway 58 at Marathon PE |
| #2178 | Yomo stylish golf t shirt 4303# | L | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: Golf t-shirt green p G 6122#1 L at Trophy |
| #2179 | T-shirt black DIESEL w646# | L | Marathon PE | 2026-11-15 13:01 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: T-shirt black DIESEL w617# L at Marathon PE |
| #2181 | Lacoste Carnaby White Navy | 11 | Hub 3 | 2026-11-20 11:31 packer_damaged at Hub 3 by 2POS | 1 | store credit: store credit R700 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2182 | Lacoste cap green 2 | one size | Marathon PE | 2026-11-16 09:54 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: SD cap black  logo white at Marathon PE |
| #2182 | SD cap black  logo white | one size | Marathon PE | 2026-11-19 10:16 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Sox cap  black at Marathon PE |
| #2182 | Sox cap  black | one size | Marathon PE | 2026-11-21 12:09 shop_not_found at Marathon PE by Zee | 1 | open being picked: at Marathon PE |
| #2187 | Boss golf t shirt black BSS12# | XL | Marathon PE | 2026-11-16 10:19 shop_not_found at Marathon PE by Zee | 3 | alternative accepted: customer picked: Lacoste Golf Polo Grey XL at Marathon PE |
| #2193 | Nike Air Force 1 White Blue Laces | 5.5 | Hub 1 | 2026-11-16 09:37 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Air Max Plus White 5_5 at Hub 1 |
| #2204 | T-shirt white Karl Lagerfeld w699# | M | Marathon PE | 2026-11-19 15:10 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: T-shirt cream white Karl Lagerfeld W699# M at Marathon PE |
| #2204 | T-shirt cream white Karl Lagerfeld W699# | M | Marathon PE | 2026-11-20 09:46 shop_not_found at Marathon PE by Zee | 2 | refund: refunded R350 (shopify) |
| #2209 | Adidas Real Madrid Tiro black tracksuit  | M | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: Adidas Retro Remix Padded Tracksuit, black featuring a prominent back  M at Marathon PE |
| #2213 | Adidas tracksuit | XL | Trophy | 2026-11-17 09:45 shop_not_found at Trophy by Sphe | 1 | open |
| #2215 | Nike Mind 002 Black | 11 | Hub 1 | 2026-11-17 09:34 hub_out_of_stock at Hub 1 by Alli ibro | 1 | cancelled |
| #2216 | Lacoste cap green 2 | one size | Marathon PE | 2026-11-17 09:32 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: Lacoste cap  blue at Marathon PE |
| #2216 | Lacoste cap  blue | one size | Marathon PE | 2026-11-17 11:20 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: LA cap green at Marathon PE |
| #2218 | Diesel Black White | 6 | Hub 2 | 2026-11-20 11:35 packer_not_here at Hub 2 by 2POS | 2 | alternative accepted: customer picked: Lacoste L-Guard Breaker Black 6 at Hub 1 |
| #2218 | Air Jordan 1 Retro High OG Gore-Tex Olive | 6 | Hub 3 | 2026-11-17 10:09 hub_out_of_stock at Hub 3 by Kalid | 1 | alternative accepted: customer picked: Nike Air Force 1 Cream Brown Gum 6 at Hub 3 |
| #2221 | FC Bayern black soccer jerseys  | XXL | Marathon PE | 2026-11-19 10:29 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Fc bayarn red white soccer jersey XXL at Marathon PE |
| #2227 | Replay Jeans Black Distressed | S | Marathon PE | 2026-11-17 11:20 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Replay jean black B 1117# S at Concrete |
| #2228 | Nike Air Force 1 '07 Essential Summit White | 5.5 | Hub 1 | 2026-11-17 11:08 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Nike Blazer Low Platform White Pink 5_5 at Hub 1 |
| #2233 | Under armor hovr white and gray  | 10 | Hub 2 | 2026-11-20 12:01 packer_not_here at Hub 2 by 2POS | 2 | alternative accepted: customer picked: Jordan1 white with green  10 at Hub 1 |
| #2235 | Nike  Portal Canyon Pink | 8 | Hub 1 | 2026-11-17 14:04 hub_out_of_stock at Hub 1 by Alli ibro | 6 | alternative accepted: customer picked: Nike Portal Lilac Bordeaux Sail 8 at Hub 1 |
| #2239 | Replay Field Speed Brown | 10 | Hub 3 | 2026-11-17 15:47 hub_out_of_stock at Hub 3 by Kalid / 2026-11-17 15:47 hub_out_of_stock at Hub 3 by Kalid | 2 | alternative accepted: customer picked: Lacoste white with blue  10 at Hub 1 |
| #2239 | Replay Field Speed Brown | 10 | Hub 3 | line was unavailable | 2 | alternative accepted: customer picked: Lacoste white with blue  10 at Hub 1 |
| #2242 | Lacoste Powercourt White Black | 7 | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: Lacoste power court black green 7 at Hub 3 |
| #2247 | Adidas Tracksuit Pink #2516 | XXXL | Trophy | 2026-11-20 13:20 packer_not_here at Trophy by yusuf | 1 | alternative accepted: customer picked: Alo Yoga Set Navy XXL at Trophy |
| #2248 | Lacoste T-Clip Winter Outdoor Green Black | 7 | Hub 1 | 2026-11-18 13:26 hub_out_of_stock at Hub 1 by Mike | 2 | alternative accepted: customer picked: Lacoste power court black green 7 at Hub 1 |
| #2252 | Lacoste cap  blue | one size | Marathon PE | 2026-11-19 09:05 shop_not_found at Marathon PE by Zee | 1 | store credit: store credit R180 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2252 | Lacoste cap green 2 | one size | Marathon PE | 2026-11-19 09:05 shop_not_found at Marathon PE by Zee | 4 | store credit: store credit R180 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2256 | Adidas AC Milan Away Jersey White | XL | Concrete | 2026-11-20 10:25 shop_not_found at Concrete by Ayanda | 1 | found later: at Pine |
| #2256 | Nike Zoom Orange White | 9 | Hub 1 | 2026-11-18 16:46 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Versair Yellow 9 at Hub 1 |
| #2257 | Adidas Samba White Core Black | 5 | Hub 2 | 2026-11-18 14:43 hub_out_of_stock at Hub 2 by Ayob | 1 | alternative accepted: customer picked: Adidas Samba White Green Stripe 5 at Hub 2 |
| #2257 | Air Jordan 1 Retro High OG Chicago Red | 6 | Hub 3 | 2026-11-18 14:57 hub_out_of_stock at Hub 3 by Mike | 1 | alternative accepted: customer picked: Air Jordan 1 High OG Bred Toe 6 at Hub 2 |
| #2259 | Dior Sauvage perfume | one size | Marathon PE | 2026-11-19 13:32 walkin_sale_over_hold at Marathon PE by ahmed | 5 | found later: at Hub 2 |
| #2261 | On Cloud 6 Navy White | 6 | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: On Cloudzone White Navy 6 at Hub 1 |
| #2262 | FC Barcelona Away Jersey Mint | M | Marathon PE | 2026-11-19 10:46 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Nike Barcelona Home Jersey Red White M at Marathon PE |
| #2264 | Adidas Samba White Pink Red | 5 | Hub 2 | 2026-11-19 09:03 hub_out_of_stock at Hub 2 by Ayob | 3 | cancelled |
| #2266 | Lacoste T-Clip Winter Outdoor Green Black | 7 | Hub 1 | 2026-11-19 09:01 hub_out_of_stock at Hub 1 by Alli ibro | 2 | found later: at Hub 3 |
| #2268 | Lacoste T-Clip Winter Outdoor Green Black | 7 | Hub 1 | 2026-11-19 09:01 hub_out_of_stock at Hub 1 by Alli ibro / 2026-11-23 12:17 packer_not_here at Hub 3 by yusuf | 2 | open |
| #2269 | Comme des Garçons Play Converse Chuck Taylor All Star High Black Red | 7 | Hub 1 | 2026-11-19 09:01 hub_out_of_stock at Hub 1 by Alli ibro | 1 | store credit: store credit R600 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2269 | Adidas Lightweight Circuit White Pink | 5 | Hub 2 | 2026-11-19 09:03 hub_out_of_stock at Hub 2 by Ayob | 1 | alternative accepted: customer picked: Adidas samba cream with pink stripes 5 at Hub 2 |
| #2269 | NY cap | one size | Marathon PE | 2026-11-19 09:10 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: LA cap black  logo white at Marathon PE |
| #2272 | Nike x Drake NOCTA Northstar Nylon Tracksuit green | L | Marathon PE | 2026-11-19 09:52 shop_not_found at Marathon PE by Zee | 1 | store credit: store credit R850 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2273 | Lacoste Polo Shirt Cream White | XXXL | Marathon PE | 2026-11-19 10:14 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: Lacoste Golf Polo Shirt Khaki XXL at Marathon PE |
| #2275 | Adidas Samba White Halo Blue | 5 | Hub 2 | 2026-11-19 12:35 hub_out_of_stock at Hub 2 by Ayob | 1 | alternative accepted: customer picked: Adidas Samba White Green Stripe 5 at Hub 2 |
| #2275 | Adidas Samba White Green Stripe | 5 | Hub 2 | 2026-11-23 11:19 hub_out_of_stock at Hub 2 by Ayob | 2 | found later: at Hub 3 |
| #2276 | Adidas Samba White Pink Red | 5 | Hub 2 | 2026-11-19 13:54 hub_out_of_stock at Hub 2 by Ayob | 3 | alternative accepted: customer picked: Adidas Samba OG Preloved Red Leopard 5 at Hub 2 |
| #2276 | Nike Air Force 1 '07 SE All Petals | 3 | Hub 1 | 2026-11-19 13:42 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Air force1 white  3 at Hub 1 |
| #2276 | Balmain cream white t shirt  w196# | M | Marathon PE | 2026-11-20 10:16 shop_not_found at Marathon PE by Zee | 2 | refund requested: refund requested by the customer — waiting for Junid |
| #2277 | Air Jordan 4 Black Red | 8 | Hub 2 | 2026-11-19 14:07 hub_out_of_stock at Hub 2 by Mike | 1 | found later: at Hub 3 |
| #2279 | Air Jordan 1 High OG Lost And Found | 9 | Hub 2 | 2026-11-19 16:03 hub_out_of_stock at Hub 2 by Alli ibro | 1 | cancelled |
| #2281 | Air Jordan 4 Retro University Blue | 5 | Hub 2 | 2026-11-20 15:22 hub_out_of_stock at Hub 2 by Mike | 1 | alternative accepted: customer picked: Air Jordan 3 Retro Pink Crackle 5 at Hub 2 |
| #2288 | T-shirt cream white Karl Lagerfeld W699# | M | Marathon PE | 2026-11-20 09:17 shop_not_found at Marathon PE by Zee | 2 | found later: at Hub 2 |
| #2290 | Adidas Real Madrid Tiro black tracksuit  | S | nowhere (no stock on the route) | line was unavailable |  | alternative accepted: customer picked: Tommy Hilfiger Tracksuit Black M at Trophy |
| #2292 | Lacoste Powercourt White Green | 6 | Hub 1 | 2026-11-20 09:43 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Lacoste power court black green 6 at Hub 1 |
| #2292 | Lacoste power court black green | 6 | nowhere (no stock on the route) | line is resolved |  | refund: refunded R700 (shopify) |
| #2294 | Lacoste cap green 2 | one size | Marathon PE | 2026-11-20 08:53 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #2294 | Lacoste cap | one size | Marathon PE | 2026-11-20 09:46 shop_not_found at Marathon PE by Zee | 5 | found later: at Concrete |
| #2297 | Madam Moiselle | one size | Marathon PE | 2026-11-20 09:46 shop_not_found at Marathon PE by Zee | 1 | store credit: store credit R200 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2300 | Air Jordan 1 High OG Lost And Found | 8 | Hub 2 | 2026-11-20 15:04 hub_out_of_stock at Hub 2 by Mike | 1 | alternative accepted: customer picked: Nike Air Max Plus Grey Red 8 at Hub 1 |
| #2302 | Lacoste cap green 2 | one size | Marathon PE | 2026-11-20 08:53 shop_not_found at Marathon PE by Zee | 4 | alternative accepted: customer picked: Lacoste cap at Marathon PE |
| #2302 | Lacoste cap | one size | Marathon PE | 2026-11-20 13:44 shop_not_found at Marathon PE by Zee | 5 | found later: at Concrete |
| #2308 | Nike Air Max Plus Cream Brown Blue | 7 | Hub 1 | 2026-11-20 13:30 hub_out_of_stock at Hub 1 by Alli ibro | 2 | open |
| #2308 | Nike Air Max Plus Cream Brown Blue | 6 | Hub 1 | 2026-11-20 13:30 hub_out_of_stock at Hub 1 by Alli ibro | 2 | open |
| #2310 | T-shirt black KARL LAGERFELD PARIS W698# | M | Marathon PE | 2026-11-21 11:52 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: G star raw t shirt black w663# M at Marathon PE |
| #2317 | T-shirt black DIESEL w617# | S | Marathon PE | 2026-11-21 11:53 shop_not_found at Marathon PE by Zee | 1 | alternative accepted: customer picked: T-shirt cream white DIESEL w617# S at Marathon PE |
| #2318 | Nike Air Max Plus Grey Red | 7 | Hub 1 | 2026-11-21 09:28 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Portal Bright Ceramic 7 at Hub 1 |
| #2320 | Lacoste Powercourt White/Green | 6 | Hub 1 | 2026-11-21 09:20 hub_out_of_stock at Hub 1 by Alli ibro | 1 | found later: at Hub 3 |
| #2324 | Lacoste bucket hat navy blue | one size | nowhere (no stock on the route) | line is resolved |  | store credit: store credit R180 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2327 | Nike dri- fit cap khaki | one size | Marathon PE | 2026-11-21 11:53 shop_not_found at Marathon PE by Zee | 1 | cancelled |
| #2327 | Emporio Armani White and black | 8 | Hub 3 | 2026-11-21 09:38 hub_out_of_stock at Hub 3 by Mike | 2 | cancelled |
| #2329 | Umbro England Long Sleeve Soccer Jersey White Red Navy | L | Marathon PE | 2026-11-21 13:43 packer_not_here at Marathon PE by yusuf | 1 | found later: at Marathon PE |
| #2331 | Adidas Real Madrid Tiro 25 Competition tracksuit  | M | nowhere (no stock on the route) | line is unavailable |  | open |
| #2337 | Air Jordan 1 Retro High OG Gore-Tex Olive | 7 | Hub 2 | 2026-11-21 12:31 hub_out_of_stock at Hub 2 by Mike / 2026-11-21 12:39 hub_out_of_stock at Hub 3 by Mike | 2 | alternative accepted: customer picked: Air Jordan 1 Retro High OG SP Dusted Clay 7 at Hub 2 |
| #2341 | New balance 1000 black  | 6 | Hub 2 | 2026-11-22 10:00 hub_out_of_stock at Hub 2 by Mike | 2 | alternative accepted: customer picked: Nike Air Max Plus Black 6 at Hub 1 |
| #2341 | Nike SB dunk low grey small | 34 | Hub 3 | 2026-11-21 15:19 hub_out_of_stock at Hub 3 by Mike | 2 | alternative accepted: customer picked: Jordan 4 small black and red 34 at Hub 3 |
| #2344 | Nike blazer | 10 | Hub 1 | 2026-11-22 09:36 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Phylon Cushion Black White 10 at Hub 1 |
| #2347 | Nike Air Force 1 Low Chocolate | 7 | Hub 1 | 2026-11-22 09:37 hub_out_of_stock at Hub 1 by Alli ibro | 1 | found later: at Hub 3 |
| #2348 | Converse Chuck Taylor All Star Black | 5 | Hub 1 | 2026-11-22 10:33 hub_out_of_stock at Hub 1 by Alli ibro | 4 | alternative accepted: customer picked: Puma Speedcat Pink 5 at Hub 2 |
| #2353 | T-shirt F7123# EXTREME CAUSE BLACK | M | nowhere (no stock on the route) | line is unavailable |  | open |
| #2353 | Nike Versair Black Olive | 8 | Hub 1 | 2026-11-22 13:15 hub_out_of_stock at Hub 1 by Alli ibro | 2 | alternative accepted: customer picked: Nike Air Zoom Spiridon UNDFTD Green Black 8 at Hub 1 |
| #2360 | Lacoste bag black  | M | Trophy | 2026-11-23 09:39 shop_not_found at Trophy by Sphe | 1 | store credit: store credit R400 issued (ship without the missing line + store credit (Junid, 20 Nov 2026)) |
| #2361 | Nike Portal Royal Blue | 4 | Hub 1 | 2026-11-23 09:25 hub_out_of_stock at Hub 1 by Alli ibro | 1 | found later: at Hub 3 |
| #2362 | Lacoste Powercourt White/Green | 7 | Hub 1 | 2026-11-23 09:12 hub_out_of_stock at Hub 1 by Alli ibro | 2 | found later: at Hub 3 |
| #2365 | DIOR LEATHER NAVY BLUE | 8 | Hub 2 | 2026-11-23 09:25 hub_out_of_stock at Hub 2 by Ayob | 3 | alternative accepted: customer picked: Dior Granville Loafer White 8 at Hub 2 |
| #2370 | Nike shoe  | 3 | Hub 1 | 2026-11-23 09:46 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Air Force 1 Low Stüssy Cream White 3 at Hub 1 |
| #2374 | Adidas Real Madrid Tiro black tracksuit  | XXL | nowhere (no stock on the route) | line is unavailable |  | open |
| #2379 | Lacoste full black | 6 | Hub 2 | 2026-11-23 16:30 hub_out_of_stock at Hub 2 by Ayob | 3 | open |
| #2380 | Jordan 6 | 6 | Hub 2 | 2026-11-23 16:31 hub_out_of_stock at Hub 2 by Mike | 1 | alternative accepted: customer picked: Lacoste Gripshot Off White 6 at Hub 1 |
| #2383 | Lacoste bag navy  | S | Trophy | 2026-11-24 09:45 shop_not_found at Trophy by Sphe | 1 | open |
| #2384 | lacoste black leather | 8 | Hub 2 | 2026-11-24 09:54 hub_out_of_stock at Hub 2 by Ayob | 1 | open waiting for customer: pick an alternative |
| #2386 | Soccer jerseys Real Madrid white bs-95985 | M | Marathon PE | 2026-11-24 09:53 shop_not_found at Marathon PE by Zee | 1 | open waiting for customer: pick an alternative |
| #2387 | HUGO Boss short white HB301# | M | Marathon PE | 2026-11-24 09:16 shop_not_found at Marathon PE by Zee | 2 | open being picked: at Concrete |
| #2387 | Nike Air Max 95 Grey Black | 7 | Hub 1 | 2026-11-24 09:35 hub_out_of_stock at Hub 1 by Alli ibro | 1 | alternative accepted: customer picked: Nike Air Max Plus White Black Olive 7 at Hub 1 |
| #2388 | Nike blazer | 9 | Hub 1 | 2026-11-24 10:06 hub_out_of_stock at Hub 1 by Alli ibro | 2 | found later: at Hub 3 |
| #2388 | Nike airforce 1 black | 9 | nowhere (no stock on the route) | 2026-11-24 06:31 routed_nowhere by system (routing) |  | alternative accepted: customer picked: Nike blazer 9 at Hub 1 |
| #2388 | Nike SB Dunk Low Grey White | 5 | Hub 3 | 2026-11-24 09:43 hub_out_of_stock at Hub 3 by Mike | 1 | open |
| #2391 | Nike Air Max Plus A-COLD-WALL Black | 4 | Hub 1 | 2026-11-24 09:35 hub_out_of_stock at Hub 1 by Alli ibro | 1 | open waiting for customer: pick an alternative |
| #2392 | Nike blazer | 6 | Hub 1 | 2026-11-24 09:35 hub_out_of_stock at Hub 1 by Alli ibro | 1 | found later: at Hub 3 |
| #2395 | Nike SB Dunk Low Black Orange Purple | 7 | Hub 1 | 2026-11-24 09:35 hub_out_of_stock at Hub 1 by Alli ibro | 1 | found later: at Hub 3 |
| #2396 | Lacoste Powercourt White | 10 | Hub 1 | 2026-11-24 09:20 hub_out_of_stock at Hub 1 by Alli ibro | 1 | found later: at Hub 3 |
| #2399 | Lacoste full black | 8 | Hub 2 | 2026-11-24 09:53 hub_out_of_stock at Hub 2 by Ayob | 5 | open |
| #2401 | Affliction Tiamatcair Purple T-Shirt | XXL | Marathon PE | 2026-11-24 09:54 shop_not_found at Marathon PE by Zee | 1 | open waiting for customer: pick an alternative |

## Appendix B: false unavailables, with the proof

| Order | Product | Size | Rejected | Proof it was there |
|---|---|---|---|---|
| #1820 | Brazil world cup jersey yellow | XL | 2026-10-27 11:53 shop_not_found at Marathon PE by 2POS | 2026-10-27 11:37 counted at Marathon PE: 0, as it was rejected (movement -P4wi9GyWj1ItMFlCF-K) / 2026-11-11 11:11 sold at a till from Marathon PE (movement sold:-P68sHp-935L-Womipa3:marathon-pe:p1783083758562:XL) |
| #1842 | Sox cap  black | one size | 2026-10-28 14:27 shop_not_found at Marathon PE by 2POS | 2026-11-20 14:44 picked and packed for website order #2182 from Marathon PE (movement sold:-P6szCuwMX9wwtwTWynp:marathon-pe:p1789550398230:_) |
| #1877 | Lacoste Gripshot Mid Light Green | 7 | 2026-10-30 09:23 hub_out_of_stock at Hub 1 by Alli ibro | 2026-11-01 09:58 found: sent by Hub 1 — the SAME place that rejected it (orders/SLJ) / 2026-11-01 12:44 sold at a till from Hub 1 (movement sold:-P5LhlrzD-qmATwBQIhX:hub1:p1778917330378:7) / 2026-11-09 12:05 sold at a till from Hub 1 (movement sold:-P5zlZMohVxgJuBASNi7:hub1:p1778917330378:7) — after new stock arrived there / 2026-11-12 16:27 sold at a till from Hub 1 (movement sold:-P6F9DB3dniR0dhQ4g46:hub1:p1778917330378:7) — after new stock arrived there |
| #1880 | DOLCE & GABBANA white end black  | 7 | 2026-10-30 09:26 hub_out_of_stock at Hub 2 by Ayob | 2026-10-30 10:34 found: sent by Hub 2 — the SAME place that rejected it (orders/FRR) |
| #1894 | Diesel Green Black White Orange | 10 | 2026-10-30 15:31 hub_out_of_stock at Hub 2 by Mike | 2026-11-01 11:57 picked and packed for website order #1921 from Hub 2 (movement sold:-P5LXk3X0Iv4po2DF02y:hub2:p1778144748126:10) / 2026-11-01 09:42 picked at Hub 2 for website order #1921 (orders/LAZ) |
| #1927 | Raw Graphic Tee Grey | XL | 2026-11-03 09:06 shop_not_found at Marathon PE by Zee | 2026-11-03 16:41 transferred to Concrete from Marathon PE (movement -P5Wqu7RdBA5Mh_aoWwv:p1782383013207:XL) |
| #1931 | Diesel Green Black White Orange | 7 | 2026-11-02 09:20 hub_out_of_stock at Hub 2 by Mike | 2026-11-09 11:33 picked and packed for website order #2054 from Hub 2 (movement sold:-P5zdsrIDns1wBkL2LT4:hub2:p1778144748126:7) / 2026-11-09 14:42 sold at a till from Hub 2 (movement sold:-P6-KRw8hFZptp9Uc3j1:hub2:p1778144748126:7) / 2026-11-15 14:34 counted at Hub 2: 0 (movement -P6UBoBNcJCPShYqRZYf) / 2026-11-09 09:02 picked at Hub 2 for website order #2054 (orders/GUW) |
| #1945 | T-shirt cream white DIESEL W634# | XL | 2026-11-02 16:44 walkin_sale_over_hold at Marathon PE by ahmed | 2026-11-02 16:47 sold at a till from Marathon PE (movement sold:-P5RiquaCPCzu_kxVyC3:marathon-pe:p1787659636406:XL) |
| #1977 | Lacoste Powercourt White | 8 | 2026-11-05 09:34 hub_out_of_stock at Hub 1 by Alli ibro | 2026-11-07 11:35 sold at a till from Hub 1 (movement sold:-P5pM8H6_vTYc-w-iYlO:hub1:p1777981957810:8) / 2026-11-14 12:57 sold at a till from Hub 1 (movement sold:-P6OhSnjkzfN3UZRxBp9:hub1:p1777981957810:8) — after new stock arrived there / 2026-11-24 08:53 picked at Hub 1 for website order #2400 (orders/KVT) |
| #1982 | Air Jordan 1 Low Travis Scott Brown Pink | 7 | 2026-11-05 09:05 hub_out_of_stock at Hub 2 by Mike | 2026-11-11 14:27 counted at Hub 2: 3 (movement -P69ZqVEHAiJ_Eq2v5x5) |
| #1990 | Jordan bag Blue FJ6784-377#M | one size | 2026-11-05 10:51 shop_not_found at Trophy by Sphe | 2026-11-14 12:36 sold at a till from Trophy (movement sold:-P6OcLG8RVuOCkJ-Q_MA:trophy:p1786967534408:_) |
| #2003 | Lacoste sweatshirt green | L | 2026-11-05 14:01 walkin_sale_over_hold at Trophy by ahmed | 2026-11-05 14:03 sold at a till from Trophy (movement sold:-P5f_rZ-DqQFBlsDOY2a:trophy:p1786452976912:L) |
| #2014 | Air Jordan 4 Retro Frozen | 7 | 2026-11-06 09:01 hub_out_of_stock at Hub 2 by Mike | 2026-11-20 14:34 picked and packed for website order #2266 from Hub 2 (movement sold:-P6swq_6pZ8TgHx4W8iY:hub2:p1778143772998:7) / 2026-11-20 08:30 picked at Hub 2 for website order #2266 (orders/QGC) |
| #2032 | Nike T shirt white w683# | M | 2026-11-07 09:46 hub_out_of_stock at Hub 2 by Mike | 2026-11-07 13:42 transferred to Marathon PE from Hub 2 (movement cr_R007-12_2026-11-07T11_00_32_231Z_g0) / 2026-11-09 13:13 counted at Hub 2: 0 (movement -P6--wdq5Nr1Op28Cwnu) |
| #2053 | Lacoste Gripshot Mid Light Green | 6 | 2026-11-09 09:14 hub_out_of_stock at Hub 1 by Mike | 2026-11-23 14:26 sold at a till from Hub 1 (movement sold:-P77N26Sl3Ssx5nIy_BR:hub1:p1778917330378:6) |
| #2073 | Sox cap  black | one size | 2026-11-19 10:35 shop_not_found at Marathon PE by Zee | 2026-11-19 11:08 found: handed over at Concrete (displayChecks/concrete/2026-11-19/-P6n-bfbUJKT4BHoVc4T) / 2026-11-20 14:44 picked and packed for website order #2182 from Marathon PE (movement sold:-P6szCuwMX9wwtwTWynp:marathon-pe:p1789550398230:_) |
| #2085 | G star raw t shirt black w666# | XXL | 2026-11-12 12:18 walkin_sale_over_hold at Marathon PE by ahmed | 2026-11-12 13:54 found: handed over at Marathon PE — the SAME place that rejected it (displayChecks/marathon-pe/2026-11-12/-P6DkApOhmh4KtjtP0Gk) / 2026-11-12 12:38 sold at a till from Marathon PE (movement sold:-P6EKx57mEicJwmtLKZF:marathon-pe:p1792840573874:XXL) |
| #2095 | G star raw jean 922# | M | 2026-11-11 10:09 shop_not_found at Marathon PE by Zee | 2026-11-12 11:21 picked and packed for website order #2106 from Marathon PE (movement sold:-P6E31Azppy_ij8le_AP:marathon-pe:p1783508654095:M) / 2026-11-23 12:23 picked and packed for website order #2372 from Marathon PE (movement sold:-P76vTPzBLDhcyHPJOuo:marathon-pe:p1783508654095:M) / 2026-11-12 10:09 picked at Marathon PE for website order #2106 (displayChecks/marathon-pe/2026-11-12/-P6AMzXS0H2dMrC6PNgr) / 2026-11-23 12:03 picked at Marathon PE for website order #2372 (displayChecks/marathon-pe/2026-11-23/-P76iz-JCCCrRdrID8ZU) |
| #2108 | Nike Air Force 1  Shell Green | 6 | 2026-11-13 11:07 hub_out_of_stock at Hub 3 by Mike | 2026-11-15 11:52 found: sent by Hub 3 — the SAME place that rejected it (orders/HYH) |
| #2122 | Essentials bag black: #9155 | one size | 2026-11-13 14:55 shop_not_found at Trophy by Sphe | 2026-11-13 16:22 counted at Trophy: 2 (movement -P6KHN0vMiMmQ2aWUvuo) |
| #2133 | Nike t-shirt black w551# | L | 2026-11-15 12:31 walkin_sale_over_hold at Marathon PE by ahmed | 2026-11-15 12:34 sold at a till from Marathon PE (movement sold:-P6TlVdWT-G_SWgLcTQf:marathon-pe:p1792916539856:L) |
| #2146 | Air Jordan 4 Retro Fear | 3 | 2026-11-14 09:17 hub_out_of_stock at Hub 2 by Ahmed | 2026-11-22 10:38 sold at a till from Hub 2 (movement sold:-P71P-B4aZJaRpqw-g1r:hub2:p1778680483192:3) |
| #2149 | Lacoste Marice Slip-On Black White | 7 | 2026-11-16 10:49 walkin_sale_over_hold at Hub 1 by ahmed | 2026-11-16 10:57 sold at a till from Hub 1 (movement sold:-P6YZwXW68bLJ5yGLVPr:hub1:p1777988146649:7) |
| #2182 | SD cap black  logo white | one size | 2026-11-19 10:16 shop_not_found at Marathon PE by Zee | 2026-11-21 10:58 sold at a till from Marathon PE (movement sold:-P6xKIV7Tho8XwONDlab:marathon-pe:p1789477429007:_) |
| #2276 | Balmain cream white t shirt  w196# | M | 2026-11-20 10:16 shop_not_found at Marathon PE by Zee | 2026-11-21 12:58 picked and packed for website order #2095 from Marathon PE (movement sold:-P6xkMiNM_V0L0FToKQZ:marathon-pe:p1792845515310:M) |
| #2329 | Umbro England Long Sleeve Soccer Jersey White Red Navy | L | 2026-11-21 13:43 packer_not_here at Marathon PE by yusuf | 2026-11-22 09:08 found: handed over at Marathon PE — the SAME place that rejected it (displayChecks/marathon-pe/2026-11-22/-P6wdKBl8yJ5O1OwEIqd) |

## Appendix C: stock the system showed at another pickable place when the line was rejected

| Order | Product | Size | Rejected | Shown elsewhere | Outcome |
|---|---|---|---|---|---|
| #1772 | Lacoste cap | one size | 2026-10-23 14:45 shop_not_found at Marathon PE by 2POS | Hub 2 6 | alternative accepted |
| #1776 | Giorgio Armani acquadi perfume | one size | 2026-10-23 10:57 shop_not_found at Marathon PE by 2POS | Pine 3 | alternative accepted |
| #1782 | Lacoste L.12.12 perfume | one size | 2026-10-23 14:47 shop_not_found at Marathon PE by 2POS | Pine 8 | alternative accepted |
| #1886 | Lacoste cap | one size | 2026-11-01 11:12 shop_not_found at Marathon PE by Zee | Hub 2 5 | alternative accepted |
| #1927 | Graphic T-Shirt Black | L | 2026-11-05 09:57 shop_not_found at Marathon PE by Zee | Concrete 3 | alternative accepted |
| #1927 | White Graphic T-Shirt | L | 2026-11-05 11:32 shop_not_found at Marathon PE by 2POS | Concrete 3 | alternative accepted |
| #1927 | Enfants Riches Déprimés T-Shirt | L | 2026-11-06 08:53 shop_not_found at Marathon PE by Zee / 2026-11-10 11:31 shop_not_found at Marathon PE by Zee | Hub 2 2 | open being picked |
| #1977 | Lacoste cap | one size | 2026-11-05 09:57 shop_not_found at Marathon PE by Zee | Concrete 5 | alternative accepted |
| #1977 | Lacoste cap green 2 | one size | 2026-11-09 15:04 shop_not_found at Marathon PE by Zee | Pine 2 | alternative accepted |
| #2006 | Lacoster underwear men | M | 2026-11-09 10:07 shop_not_found at Marathon PE by Zee | Hub 2 2, Pine 3, Central 3 | open being picked |
| #2027 | Hydraulic short black WHERE THE BIG DOGS PLAY 2025# | L | 2026-11-07 09:31 shop_not_found at Marathon PE by Zee | Pine 1 | alternative accepted |
| #2041 | Hydraulic short black WHERE THE BIG DOGS PLAY 2025# | L | 2026-11-08 10:25 shop_not_found at Marathon PE by Zee | Pine 1 | alternative accepted |
| #2073 | Lacoste cap | one size | 2026-11-16 11:50 shop_not_found at Marathon PE by Zee | Concrete 4 | alternative accepted |
| #2073 | Lacoste cap | one size | 2026-11-17 09:38 shop_not_found at Marathon PE by Zee | Concrete 5 | alternative accepted |
| #2079 | Lacoste cap green 2 | one size | 2026-11-10 09:19 shop_not_found at Marathon PE by Zee | Pine 2 | alternative accepted |
| #2079 | Lacoste cap | one size | 2026-11-10 09:47 shop_not_found at Marathon PE by Zee | Concrete 5 | alternative accepted |
| #2079 | Lacoste cap | one size | 2026-11-10 11:31 shop_not_found at Marathon PE by Zee | Concrete 4 | alternative accepted |
| #2093 | Versace EROS perfume | one size | 2026-11-11 10:09 shop_not_found at Marathon PE by Zee | Hub 2 10, Pine 4, Central 16 | alternative accepted |
| #2111 | Boss slide black end white | 9 | 2026-11-12 09:52 hub_out_of_stock at Hub 2 by Ahmed | Hub 3 1 | alternative accepted |
| #2111 | Boss slide full black | 10 | 2026-11-12 09:16 hub_out_of_stock at Hub 2 by Ahmed | Hub 3 1 | alternative accepted |
| #2174 | Sox black cap | 58 | 2026-11-20 11:29 packer_not_here at Marathon PE by 2POS | Concrete 2 | alternative accepted |
| #2182 | Sox cap  black | one size | 2026-11-21 12:09 shop_not_found at Marathon PE by Zee | Concrete 1 | open being picked |
| #2204 | T-shirt cream white Karl Lagerfeld W699# | M | 2026-11-20 09:46 shop_not_found at Marathon PE by Zee | Hub 2 1 | refund |
| #2248 | Lacoste T-Clip Winter Outdoor Green Black | 7 | 2026-11-18 13:26 hub_out_of_stock at Hub 1 by Mike | Hub 3 3, Central 1 | alternative accepted |
| #2264 | Adidas Samba White Pink Red | 5 | 2026-11-19 09:03 hub_out_of_stock at Hub 2 by Ayob | Hub 3 1 | cancelled |
| #2268 | Lacoste T-Clip Winter Outdoor Green Black | 7 | 2026-11-19 09:01 hub_out_of_stock at Hub 1 by Alli ibro / 2026-11-23 12:17 packer_not_here at Hub 3 by yusuf | Hub 3 3, Central 1 | open |
| #2337 | Air Jordan 1 Retro High OG Gore-Tex Olive | 7 | 2026-11-21 12:31 hub_out_of_stock at Hub 2 by Mike / 2026-11-21 12:39 hub_out_of_stock at Hub 3 by Mike | Hub 3 5 | alternative accepted |
| #2387 | HUGO Boss short white HB301# | M | 2026-11-24 09:16 shop_not_found at Marathon PE by Zee | Concrete 2, Central 6 | open being picked |

## Appendix D: sizes that failed two or more times

| Times | Product | Size | Orders | Picked successfully since? |
|---|---|---|---|---|
| 8 | Lacoste cap green 2 | one size | #1977 #2079 #2164 #2182 #2216 #2252 #2294 #2302 | no |
| 5 | Barcelona Soccer Jersey Black | L | #1899 #1965 #1988 #2084 #2160 | no |
| 5 | Lacoste cap | one size | #1977 #2073 #2079 #2294 #2302 | yes |
| 4 | Lacoste Powercourt White/Green | 7 | #1798 #1968 #2036 #2362 | yes |
| 3 | Nike blazer | 9 | #1818 #1896 #2388 | yes |
| 3 | Diesel Green Black White Orange | 9 | #1829 #1850 #1891 | no |
| 3 | Sox cap  black | one size | #1842 #2073 #2182 | no |
| 3 | Lacoste Polo Brown | L | #1856 #1984 #2097 | no |
| 3 | Lacoste cap | one size | #1886 #2073 #2079 | no |
| 3 | Hydraulic short black WHERE THE BIG DOGS PLAY 2025# | L | #2027 #2041 #2116 | no |
| 3 | Lacoste cap  blue | one size | #2079 #2216 #2252 | no |
| 3 | Lacoste T-Clip Winter Outdoor Green Black | 7 | #2248 #2266 #2268 | no |
| 2 | Lacoste Powercourt White/Green | 6 | #1798 #2320 | yes |
| 2 | Adidas sambarose cloud white  | 5.5 | #1864 #1989 | no |
| 2 | T-shirt black KARL LAGERFELD PARIS W698# | M | #1882 #2310 | no |
| 2 | Boss golf t shirt black: Bs-44337 | L | #1905 #2097 | no |
| 2 | Nike Air Force 1 '07 Essential Summit White | 5.5 | #1934 #2228 | no |
| 2 | Lacoste Powercourt White Black | 7 | #1944 #2242 | no |
| 2 | Hugo boss adjustable cap navy #1 | one size | #1974 #2073 | no |
| 2 | Nike Portal Royal Blue | 4 | #1981 #2361 | yes |
| 2 | Lacoste Polo Shirt Grey | L | #1984 #2138 | no |
| 2 | Converse Chuck Taylor All Star Black | 5 | #1992 #2348 | yes |
| 2 | Sweatshirt lacoste nevy blue | M | #2003 #2063 | no |
| 2 | Lacoste golf t shirt white: LCE-3431 | M | #2010 #2138 | no |
| 2 | Nike Air Force 1 Low Metalwork Medium Ash Anthracite | 7 | #2011 #2094 | no |
| 2 | FC Bayern black soccer jerseys  | XXL | #2028 #2221 | no |
| 2 | Nike t shirt black w683# | M | #2032 #2038 | no |
| 2 | Nike airforce cream white | 6 | #2035 #2139 | no |
| 2 | FC Barcelona Away Jersey Mint | M | #2058 #2262 | no |
| 2 | Nike dri- fit cap khaki | one size | #2133 #2327 | no |
| 2 | Air Jordan 1 High OG Lost And Found | 9 | #2156 #2279 | no |
| 2 | T-shirt cream white Karl Lagerfeld W699# | M | #2204 #2288 | no |
| 2 | Replay Field Speed Brown | 10 | #2239 #2239 | no |
| 2 | Adidas Samba White Pink Red | 5 | #2264 #2276 | no |
