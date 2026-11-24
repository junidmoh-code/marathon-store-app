# Website orders: Junid's decisions of 24 November, built

**Bottom line.** All eight decisions are built, reviewed, merged and live as of 15:36 on 24 November 2026. A rejected website line now moves to the next place on its chain within about two minutes, a rejected single piece is written to zero at once, Central is a real last stop with its own strip in Source, no PIN can sell a piece held for a website order, and each shop and hub gets a short shelf check every day. The measurements say two things Junid should know before reading the rest: the trust-first routing by itself would have changed only 34 of 1,222 picks, because for most doubtful shelves there was nowhere else to send the line; and 60 days is not a sharper line than 14, so the new website rule still holds 226 sizes off sale (119 at Marathon PE and 107 at Trophy), against 249 under the rule it replaced.

One thing needs Junid today and has nothing to do with this work: **Jamie's AI credit ran out at 14:45.** Jamie is running and WhatsApp is connected, but it cannot write messages until the Anthropic account is topped up.

## 1. What shipped and what is live

| Decision | What it does now | Where |
|---|---|---|
| 1. Most trustworthy place first | Each shelf showing a piece is scored: one piece free, untouched over 14 days, rejected a website pick in the last 30 days. Two points is a doubtful shelf. Trusted shelves are asked first in chain order, doubtful ones next, Central last. The reason is kept on the line and in the poller's log. | store app #982 |
| 2. A rejection moves the line on | A hub's Out of Stock, a shop's Not found or the packer's Not here sends the line to the next place on its chain in the same tick. Only when nothing is left, Central included, does Jamie offer alternatives. | store app #982, Jamie #205 |
| 3. A rejection corrects the count | One piece on the rejecting shelf: written to zero as its own movement type (`web_not_found`) with who, when and the order. It puts itself back if the piece is later sold, picked or found there. Two or more: count untouched, shelf held off the website and put on that place's shelf check. | store app #982 |
| 4. Central is the last stop | A line that reaches Central shows on a website-orders strip inside Source. Found: it travels on the morning run, shows green on the Online orders card, and is deducted from Central at Pack. Not found: decision 3, then Jamie. | store app #982, till #652 |
| 5. No PIN breaks a website hold | The manager override is gone. The cashier sees which order the piece is held for. Other pieces of that size still sell with no prompt. Every block leaves an audit row. | till #652 |
| 6. Old single pieces, narrowly | A size is off the website only when every place holding it shows one piece, each untouched 60 days or more, and nothing is at Central, a hub, a stockroom or in transit. Replaces the 14-day Marathon PE rule. | store app #982 |
| 7. Daily shelf checks | Up to 20 shelves a day per shop and hub, on Display Checks, the Warehouse queue and Source. Wrong-by-more first, then the oldest single pieces. Found, Not found, a scan, or the real number from a picker. Progress per place is in Settings, Online orders. | store app #982 |
| 8. Website orders stand out | The strip, the hub queue and Central's strip are red and bold at the top, longest-waiting first, with the waiting time on each line. | store app #982 |

Live checks made: the first tick on the new code moved order #2269 line 6 from Marathon PE to Concrete in four seconds; a line is on Central's strip; a written-down shelf shows 0 with its movement naming the order.

**First lists.** 29 "wrong by more" shelves are on today's shelf checks (Hub 1: 9, Marathon PE: 8, Hub 2: 8, Hub 3: 4). The single-piece part of each list starts after tonight's 02:30 stock sweep.

## 2. Single pieces by time untouched

Website picks since #1768 that were sent to a shelf showing exactly one free piece: 410. To know how old each shelf was, the stock history was read back to 25 July (one pass, 30 MB).

| Untouched for | Rejected | Of | Failure rate |
|---|---|---|---|
| under 14 days | 23 | 198 | 12% |
| 14 to 29 days | 19 | 61 | 31% |
| 30 to 59 days | 30 | 60 | 50% |
| 60 to 89 days | 14 | 42 | 33% |
| 90 days and over | 18 | 32 | 56% |
| **14 days and over** | 84 | 212 | **40%** |
| **30 days and over** | 65 | 151 | **43%** |
| **60 days and over** | 35 | 91 | **38%** |
| **90 days and over** | 21 | 48 | **44%** |

Per place, 14 days and over: Marathon PE 40 of 78 (51%), Hub 1 26 of 66 (39%), Hub 2 12 of 38 (32%), Trophy 5 of 17 (29%), Hub 3 1 of 7, Concrete 0 of 6. The full table is in `stale-age.json`.

**Is 60 days the right number?** The data does not pick it out. Failure jumps from 12% to about 40% at two weeks and then stays flat; 60 days and over (38%) is no worse than 14 days and over (40%). The bands are small, so the wobble between them is noise. What makes Junid's rule narrow is its other two conditions, not the number of days: the piece stays on sale whenever another piece or any refill could serve the order.

**A correction to this morning's report.** It said a lone piece at Marathon PE untouched over 14 days failed 57% of the time (31 of 54). That count left out shelves whose age could not be told from five weeks of history, and those were mostly successful picks. With the older history the figure is 51% (40 of 78).

## 3. The 249 Marathon PE sizes

The 14-day rule had hidden 514 sizes; 249 of them were sold out on the website because of it. That rule is retired.

- **127 are back on sale.**
- **122 are still sold out**: 119 are caught by the new 60-day rule, 3 have no stock.

| Category | Sold out under the old rule | Back on sale |
|---|---|---|
| Jerseys | 75 | 40 |
| T-shirts | 41 | 24 |
| Caps and hats | 21 | 17 |
| Tracksuits and sets | 21 | 6 |
| Cargos and pants | 18 | 14 |
| Clothing, uncategorised | 14 | 7 |
| Sneakers | 12 | 2 |
| Jeans and denim | 12 | 4 |
| Underwear and socks | 12 | 6 |
| Jackets and coats | 7 | 0 |
| Shorts and vests | 5 | 4 |
| Hoodies and sweatshirts | 4 | 2 |
| Other | 7 | 1 |

By brand as recorded on the product: Nike 19 (3 back), G-Star 17 (12), Armani 8 (3), Jordan 8 (0), Diesel 7 (5), Adidas 6 (3), Boss 6 (4), Versace 4 (1), Lacoste 3 (1), Puma 3 (3). About 60 of the 249 carry a word that is not a brand ("T-shirt", "Jerseys", "Soccer"), so the brand view is partial. Every size is listed in `pe-249-sizes.csv`.

**The new rule reaches Trophy too.** It hides 226 sizes on 181 products in all: the 119 at Marathon PE and 107 at Trophy that the old rule never touched (`old-single-sizes.csv`).

## 4. The new routing, replayed over the five weeks

1,222 first picks could be replayed.

- Trusted shelves: 78 rejected of 989 (8%).
- Doubtful shelves: 103 rejected of 233 (44%).
- **34 lines would have gone to a different place.** 13 of those were rejected where they actually went, so at best 13 failures avoided, about 10 expected once the other place's own failure rate is allowed for. The moves are mostly Hub 1 to Hub 3 (12 lines, 7 of them rejected at Hub 1) and Marathon PE or Trophy to Hub 2 (10 lines). They are listed in `replay-routing-moved.csv`.
- **For 180 of the 233 doubtful picks the doubtful shelf was the only place on the chain that showed the size.** Those failed 47% of the time, and routing cannot help them.

What happens after a rejection matters more. Of the 181 lines whose first place said no, 32 had another shop or hub showing the size at that moment and 14 had only Central. Those 46 now move on within two minutes; before, the 32 waited for the order agent's next round and the 14 went to alternatives. **The other 135 had nowhere to go.** Only correct counts fix those, which is what decisions 3 and 7 are for.

The replay cannot know whether the other place would really have had the piece, and it rebuilds other orders' holds from finished picks only.

## 5. What was written down, what is hidden, and how to restore each

All commands run in `~/marathon-store-app` on the Mac mini.

| What | How much | Restore |
|---|---|---|
| Shelves written to zero (rejected a website pick, untouched since, showed one piece) | 67: Marathon PE 23, Hub 1 22, Hub 2 11, Hub 3 5, Trophy 5, Concrete 1 (`written-down.csv`) | `node scripts/shopify/onlineOrders/cell-holds.mjs --write-down-rollback ~/marathon-rollbacks/write-down-2026-11-24T13-30-35-055Z.json --commit` |
| Count wrong by more than one (count NOT changed, held off the website, on the shelf checks) | 29 shelves, 94 pieces on paper: Hub 1 9, Marathon PE 8, Hub 2 8, Hub 3 4 (`count-wrong-by-more.csv`) | Each ends when staff tap the real number. All at once: `node scripts/shopify/onlineOrders/cell-holds.mjs --rollback ~/marathon-rollbacks/cell-holds-2026-11-24T10-09-08-954Z.json --commit` |
| Sizes off the website under the 60-day rule | 226 sizes on 181 products | `node scripts/shopify/onlineOrders/cell-holds.mjs --old-single-off ~/marathon-rollbacks/old-single-2026-11-24T13-35-44-049Z.json --commit` |

Each written-down piece also puts itself back if it is sold at a till, picked, or marked Found at that place. Each hidden size returns the moment one of its shelves is touched or stock arrives. Nothing was deleted or unpublished on Shopify.

Switches, each a single setting: `/config/onlineOrders/routing/trustOff`, `centralOff`, `chainOff`; `/config/onlineOrders/writeDown/off`; `/config/onlineOrders/pickable/oldSingle/off`; `/config/onlineOrders/shelfChecks/off` and `perDay`.

Jamie's four rewritten rules (R4.1, R4.3, R4.7, R4.27) are in the live rulebook; the old wording is in the rulebook archive, and a copy of the rulebook as it was is in `~/marathon-rollbacks/jamie-rulebook-live-2026-11-24.md`.

## 6. What Junid must decide

1. **Jamie's AI credit.** Out since 14:45. Nothing else can fix it.
2. **The 107 Trophy sizes.** The 60-day rule is built as written and takes them off sale in Black Friday week. The command above switches the rule off; a setting changes the days.
3. **"No open request".** The rule checks that nothing is at Central, a hub, a stockroom or in transit. It does not read the request list: that would put website code inside request data, which the repo's guard reserves for changes Junid asks for by name. The gap is a size whose only backing is a request waiting on a supplier. Say the word and it reads the list.
4. **Central's piece is not held against the refill scan.** A refill can take it before Central pulls it for the website order; Central then taps Not found. Holding it would change what the scan may send, so it was not built.
5. **Returns of a piece that came from Central.** The till still refuses to credit Central on a return and says "Ask Junid". Where should such a piece go back to?
6. **A line can sit on Central's strip with no time limit.** The order agent nudges after four trading hours but nothing moves the line on if Central never answers.
7. **A shelf that really has more than the app says.** With the PIN gone, the extra piece cannot be sold until the count is corrected. The till now logs every block, and the shelf check is the way to fix the count.
8. **Jamie's chat suggestions.** For offers on a failed order line Central is never counted, as before. For ordinary chat suggestions a piece at Central can still be the second of the two pieces. Unchanged; noted because the rule text now says so plainly.

## 7. Reviews and tests

- **Store app #982.** CodeRabbit reviewed it for real (17 comments). The Sonnet architect review said fix first. One real count fault was found and fixed before merge: a Found after a delivery had landed could add a unit too many. 41 hand-written mutants, 37 killed, 4 double guards.
- **Till #652.** CodeRabbit reviewed it for real (4 findings, fixed). The architect review found one fault, fixed: a return line counted as a unit on the sale, so an exchange of a size for the same size was wrongly blocked.
- **Jamie #205.** CodeRabbit answered with its spending-cap notice; a substitute Sonnet line review ran beside the architect review, recorded on the PR. Both said fix first; fixed; 2,161 of 2,161 tests pass.
- Suites fail only where `main` already fails: 13 functions tests, the theme and migrate-refs files in the store app, three files in the till.

**Downloaded from the database:** about 37 MB. The older stock history was 30.2 MB; listing the 60-day rule took 3.3 MB twice (dry run and commit); the replay's missing shelf counts were 0.2 MB.
