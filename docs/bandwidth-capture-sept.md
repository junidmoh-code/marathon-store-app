# Firebase bandwidth — measured 3 September 2026

Read-only investigation. Nothing was written to the database, no rules were
touched, nothing was deployed. Every figure is labelled **measured** (read off
the billing console or a live profiler capture), **stated** (a cadence read
out of code or config), or **derived** (arithmetic on the two). Nothing here
is modelled.

**What this cost to produce:** ~13.4 KB of live reads (one `/config/refillEngine`
read at 5,641 B, made twice, and three `/users/{uid}` records at 531–743 B).
The profiler itself streams operation metadata to the admin, not data, and is
not billed as download.

**What was already known** (from PR #300 and the 4 Aug profiler sessions; the
`docs/insights-log-investigation.md` that PR #300 links was never committed —
it does not exist on any branch, so the 4 Aug numbers below come from the
session transcripts, not a document):

- 4 Aug, 10-min window 09:28 SAST: 122.25 MB → /orders 34.5 MB, /products
  21.1 MB, /refill_requests 16.6 MB, /stock_movements 14.0 MB (100% server),
  /insights_log 11.6 MB. One stale Android client was 62% of the earlier
  window. refillHealthScan was ~31 MB per run, 96 runs/day.
- Since then: #300 (insights_log ranged + shared provider), #309 (scan
  trading-hours only, 49 runs/day), #333 (refill History indexed), #382
  (provenance read scope), POS mirror #275–#286 (29–31 Aug).

---

## 1. The bill, both accounts summed

Source: GCP billing console Reports, grouped by SKU, read for each account
and range separately. **marathon-club moved from account 01014A to account
01FCC9 on 22 August** — 01FCC9 shows $0 for every range before 22 Aug, and
01014A shows one day's worth of RTDB ($16.18) inside 22–31 Aug. Reading either
account alone for August misses 32–46% of the RTDB line.

The RTDB SKU is **"Outgoing Bandwidth" 04F2-6383-80BD, billed at $0.979 per
GiB** (185.66 GiB → $181.79). That is the $1/GB download rate. The $5/GB
storage rate never appears on either bill.

### August 2026, final (measured)

| Account | Project | SKU | Usage | Cost |
|---|---|---|---:|---:|
| 01014A | marathon-club | RTDB Outgoing Bandwidth | 278.14 GiB | $270.05 |
| 01014A | marathon-club | Cloud Storage download (photos) | 205.22 GiB | $12.63 |
| 01014A | marathon-club | Static IP (Compute) | 529 h | $5.28 |
| 01014A | marathon-club | Cloud Vision text detection | 2,864 | $2.80 |
| 01014A | marathon-club | Cloud Storage class B ops | 3.4 M | $1.36 |
| 01014A | Gemini Project | Gemini API (all SKUs) | — | ~$17.3 |
| 01014A | (all) | everything else | — | ~$2.7 |
| **01014A** | | **subtotal** | | **$312.08** |
| 01FCC9 | marathon-club | RTDB Outgoing Bandwidth | 144.34 GiB | $141.53 |
| 01FCC9 | marathon-club | Static IP | 215 h | $2.14 |
| 01FCC9 | Gemini Project | Gemini 3 Pro Image output | 319,200 | $38.30 |
| 01FCC9 | Gemini Project | Gemini API other SKUs | — | ~$5.4 |
| 01FCC9 | (all) | everything else | — | ~$0.4 |
| **01FCC9** | | **subtotal** | | **$187.72** |
| **Both** | | **August total** | | **$499.80** |
| **Both** | marathon-club | **RTDB download, August** | **422.48 GiB** | **$411.58 = $13.28/day** |

July, for the baseline (all on 01014A): total $424.70; RTDB 366.43 GiB
**$355.53 = $11.47/day**; Cloud Storage download 335 GiB $28.21 (the photo
cache-header change in #271 is what cut this to $12.63 in August).

### September to date (measured; only 1–2 Sep have posted)

| Account | SKU | Usage | Cost |
|---|---|---:|---:|
| 01FCC9 | RTDB Outgoing Bandwidth | 41.32 GiB | $40.26 |
| 01FCC9 | Gemini API (all) | — | $2.59 |
| 01FCC9 | Static IP + rest | — | $0.45 |
| 01FCC9 | **1–2 Sep total** | | **$43.30** |
| 01014A | anything | | $0.00 |

**RTDB is $20.13/day for the first two days of September.** 3 Sep had not
posted at 20:00 SAST.

### RTDB download per day, the whole series (measured from the bill)

| Period | Days | RTDB $ | $/day | Note |
|---|---:|---:|---:|---|
| July | 31 | 355.53 | 11.47 | |
| 1–7 Aug | 7 | 92.39 | 13.20 | includes the 4 Aug stale-client bursts |
| 8–14 Aug | 7 | 77.45 | 11.06 | #300, #309, #333 all live |
| 15–21 Aug | 7 | 84.03 | 12.00 | mini reconcile loop installed 14 Aug |
| 22–24 Aug | 3 | 27.18 + ~16 | ~14.4 | account move; 01014A residual counted here |
| 25–26 Aug | 2 | 31.35 | 15.68 | |
| 27–28 Aug | 2 | 37.89 | 18.95 | |
| 29–30 Aug | 2 | 28.77 | 14.39 | Sat–Sun; POS mirror PRs landing |
| 31 Aug | 1 | 16.34 | 16.34 | |
| 1 Sep | 1 | 17.36 | 17.36 | |
| 2 Sep | 1 | 22.90 | 22.90 | highest day on record |

The fixes in the second week of August did work: 8–14 Aug is the cheapest
week. From 22 August the daily rate climbs and does not come back. Section 5
names what climbed.

---

## 2. Live capture — 3 Sep 18:27–19:27 SAST

`firebase database:profile --project marathon-club --duration 5400 --raw`.
The CLI was asked for 90 minutes and emitted exactly 60.0 minutes of events
(first 18:26:57, last 19:26:55 SAST, 35,395 records); the profiler appears to
cap at one hour. **This window is the tail of trading, not the middle of it** —
it was started at 18:26 because that is when this investigation started. It
caught two staff browser sessions and one till. It caught every always-on
reader in full. A second, after-hours capture (19:57–20:57) is in section 2c.

The raw profiler records `remoteAddress` and `userAgent` per operation, which
is how devices are separated below. It records no auth. Identity for the two
browser sessions came from the app's own `/users/{uid}` permissions listen.

### 2a. Totals and by path (measured)

**309.07 MB downloaded in 60 minutes.** Sustained, that is 7.4 GB/day —
which is *less* than the bill's 20 GiB/day, because the daytime browser and
till traffic is mostly absent from this window (see 2d).

| Path | Bytes | Share | Reads | Bytes / read |
|---|---:|---:|---:|---:|
| /shopify_publish | 132,902,775 | 43.0% | 69 | 88 KB – 2.21 MB |
| /stock_movements | 55,863,996 | 18.1% | 3 | 18.6 MB |
| /refill_requests | 28,834,812 | 9.3% | 4 | 7.21 MB |
| /displayChecks_active | 26,768,028 | 8.7% | 24 | PE 1.50 MB, Trophy 0.73 MB |
| /products | 21,085,359 | 6.8% | 15 | 4.17 MB (whole) |
| /stock | 16,518,267 | 5.3% | 16,535 | hub2 1.36 MB, 5.05 MB per scan |
| /orders | 12,878,815 | 4.2% | 65 | 2.58 MB (whole) |
| /stock_targets | 4,966,947 | 1.6% | 3 | 1.66 MB |
| /insights_log | 3,461,261 | 1.1% | 1 | 3.46 MB (ranged, 5 days) |
| /social_posts | 1,335,324 | 0.4% | 61 | |
| /restock_requests | 1,301,491 | 0.4% | 1 | 1.30 MB (whole) |
| /returns_log | 750,784 | 0.2% | 2 | |
| /refill_engine | 722,500 | 0.2% | 10 | |
| /shopify_sync | 469,046 | 0.2% | 300+ | per-product |
| /pos | 452,136 | 0.1% | 114 | |
| /eft_pool | 397,170 | 0.1% | 30 | |
| everything else | 336,000 | 0.1% | | |

### 2b. By client (measured)

| Client | Who / what | Bytes | Share | Paths |
|---|---|---:|---:|---|
| 196.210.73.216, Admin SDK 12.7 darwin | **Mac mini** (its public IP; confirmed over ssh) | 138,920,459 | 44.9% | /shopify_publish 132.9 MB, /products 4.4 MB, /social_posts 1.1 MB, /shopify_sync 0.5 MB |
| 2600:1900:0:4306::, Admin SDK linux | **Cloud Functions — refillHealthScan** (2 runs) | 79,167,734 | 25.6% | stock_movements 37.2, refill_requests 14.4, stock 10.1, products 8.3, orders 5.2, stock_targets 3.3 |
| 2600:1900:0:4304::1, Admin SDK linux | **refillHealthScan** (1 run) | 39,584,432 | 12.8% | same shape: 40.05 MB per run |
| 2600:1900:0:4306::e01, Admin SDK linux | **wakeHeldChecks** (12 runs, every 5 min) | 26,785,188 | 8.7% | displayChecks_active/marathon-pe ×12, /trophy ×12, plus 16,462 per-cell `/stock/{store}/{pid}/{size}/qty` reads at 17 KB total |
| 41.121.174.142, Android 10, Samsung Browser 28 | **Mike** (uid vWfH…, role admin) — one 30-second store-app session | 20,973,212 | 6.8% | refill_requests 7.21, products 4.17, insights_log 3.46 (ranged), orders 2.58, stock/hub2 1.36, restock_requests 1.30, returns_log 0.75 |
| 196.210.73.216, iPhone iOS 18.7 Safari | **Junid** (uid yXTA…, "2POS") — one 4-second session on the shop wifi | 2,576,234 | 0.8% | orders 2.58 (whole) |
| 2600:1900:0:4302::401, Admin SDK linux | Cloud Functions — EFT pool / parked sales readers | 821,160 | 0.3% | /pos/parked_eft_sales, /eft_pool |
| 2600:1900:0:4306::400 | Cloud Functions — social health | 197,612 | 0.1% | /social_posts |
| 196.210.73.216, macOS Chrome 152 | **one POS till** on the shop network | 23,922 | 0.0% | /pos only, 36 ops; no /products, no /pos/sales |
| 196.210.73.216, node | mini — card-recon poller | 11,338 | 0.0% | /config |
| 2600:1900:0:4306::101 | dispatchHoldRevealSweep (60 runs, every minute) | 0 | | indexed `readyNotifyPending == true` on /orders — 0 bytes, correctly bounded |
| 196.210.73.216, client SDK 12.13 node | mini — an unauthenticated node client | 0 | | 84 **denied** reads/hour of `/stock/{loc}/P-shoe` and `/products/P-shoe`, every 5 min — a probe against a placeholder id that the rules reject. Costs nothing; it is a bug in whatever runs it (photo-grabber or the openclaw gateway are the only node clients on the mini) |

Observed but not seen reading anything: nothing from marathon-ai's hosted
site, nothing from a stale bundle (see section 6).

### 2c. After-hours capture — 19:57–20:57 SAST (measured)

Second run, same command, shops closed. **304.83 MB in 59.9 minutes** —
the same rate as the trading-tail hour, with no till and one staff phone.

| Client | Who / what | Bytes | Share | Paths |
|---|---|---:|---:|---|
| Mac mini, Admin SDK | reconcile loop, now with work to do | 241,776,287 | **79.3%** | /shopify_publish 133.0 MB (76 reads), **/stock 80.7 MB (13 whole reads of 6,204,009 B)**, **/shopify_sync 22.5 MB** (root listen + root transaction + broadcast, ~1.0 MB each, every 2 min), /products 4.5 MB (one paged full read), /social_posts 1.1 MB |
| 41.121.179.96, iPhone iOS 18.7 Safari 26.2 (mobile network) | **MC** (uid oBvH…, admin) — store app, Shopify Publishing page and Insights | 32,961,777 | 10.8% | **/insights_log 30,892,916 B, whole node, no query** (20:01:09), /shopify_publish 1.57 MB, /settings/hubSneakerCount 178 KB ×2, 119 per-product `/shopify_publish/{pid}` listens |
| 2600:1900:0:4306::e01 | wakeHeldChecks ×12 | 26,785,188 | 8.8% | identical to 2b |
| 2600:1900:0:4306::1901 | Cloud Functions — search index | 1,934,026 | 0.6% | /search_index/docs, 46 reads |
| other Cloud Functions | EFT/parked, social, style-code index, ai styleKit, card-recon | ~1.4 MB | 0.4% | |
| 196.210.73.216, macOS Chrome | the same till, idle | 21,264 | | /pos |
| 196.210.73.216, FirebaseCLI agent-name/claude_code | **this investigation** | 694 | | two `/users/{uid}` reads |

Two things this hour proves that the first did not:

- **The mini's reconcile loop reads the whole of `/stock` (6.2 MB) once per
  product it processes** — `reconcile.mjs:820`, `Object.keys((await
  db.ref("stock").get()).val())`, to obtain ten location names. MC toggled
  publish intents from her phone at 20:23; the runner then processed products
  at 20:25, 20:27, 20:29, 20:29, 20:31, 20:33, 20:37, 20:45, 20:49, 20:51,
  20:51, 20:53, 20:55 and paid 6.2 MB each time. It also runs a
  **transaction on the `/shopify_sync` root** (`idMap.mjs:96`), which
  downloads the whole ~1 MB map, plus the listen and broadcast around it —
  ~3 MB per tick with work.
- **`/insights_log` is now 30.9 MB and is still read whole from a browser**
  — the shared `InsightsLogProvider` (`src/insights/InsightsLogProvider.jsx:42`)
  that PR #300 deliberately left whole-node for Insights / Customers / Admin.
  The node was 18.7 MB on 2 Aug and 19.4 MB on 4 Aug; it has grown 59% in a
  month. One open of Insights now costs what two did then.

**Always-on floor, measured from this hour with the phone removed:** 271.9 MB/h
= 6.5 GB/day = **~$6.1/day, ~$182/month** while the reconcile loop has work;
**~163 MB/h = 3.9 GB/day = ~$3.6/day, ~$108/month** on idle ticks (2b). The
weekend bill of $14.39/day sits on top of that floor.

### 2d. What the window cannot tell you

The bill says 20 GiB/day. Both windows annualise to ~7.3 GB/day, and the
after-hours one already includes the always-on floor in full. The
difference — roughly 12 GiB/day, **$11–17/day, $330–510/month** — is
trading-hours traffic from staff browsers and tills that neither window
sampled: two or three staff sessions in an hour is not a trading day. What
those sessions cost *each* is measured (section 3, rows 4–8: 4–31 MB per
screen open); how many there are per day is not. Section 9 says what a
trading-hours capture needs. That gap is the single biggest number in this
report and it is **derived, not measured**.

---

## 3. What each line costs per month

Each row is a measured per-operation size × a cadence that is stated in code
or config. The dollar figure is derived at $0.979/GiB.

| # | Line | Measured size | Stated cadence | GiB / month | $ / month | Runs when |
|---|---|---:|---|---:|---:|---|
| 1 | **Mac mini `reconcile-runner.mjs` → `reconcile.mjs --commit`** reads all of `/shopify_publish` twice per run (`readAllPublishNodes` at reconcile.mjs:106 and again at :1020 for the search-index sweep added 17 Aug); on any tick with work it also reads **all of `/stock` per product** (reconcile.mjs:820) and runs a **transaction on the `/shopify_sync` root** (idMap.mjs:96) | idle tick: 1.9–2.2 MB ×2, **133 MB/h** measured in both hours; working tick adds 6.2 MB per product + ~3 MB; **242 MB/h** measured 20:00–21:00 | every 2 min, launchd KeepAlive, no trading-hours gate | 89 idle – 160 busy | **$87 – $160** | 24/7 since 14 Aug |
| 2 | **refillHealthScan** (`functions/refill-scan.cjs`) | 40.05 MB per run measured: stock_movements 18.6, refill_requests 7.2, stock 5.0, products 4.2, orders 2.6, stock_targets 1.7, stock_exceptions 0.5 | every 15 min 07:00–19:00 = 49/day | ~55 | **~$54** | trading hours |
| 3 | **wakeHeldChecks** (`functions/displayChecks/wakeHeldChecks.js:206`) | 2.23 MB per run (whole `displayChecks_active/{pe,trophy}` index) + ~1,370 per-cell qty reads | every 5 min, 288/day | ~18 | **~$18** | 24/7 |
| 4 | **Store app: any refill screen opens `/refill_requests` whole** — `useRefillRequests()` → `usePath("refill_requests")` (useStock.js:167) on RefillQueue, HealthView, MissingFootwear, MoveExcess, ExcessHubToCentral and SourceView (App.jsx:14448) | 7.21 MB per open, measured | per staff visit — not measurable in this window | — | see 2d | trading |
| 5 | **Store app: `/products` whole on every session** (`useProducts`, App.jsx:519) | 4.17 MB per session | every app load, every device | — | see 2d | trading |
| 6 | **Store app: `/orders` whole** — `useOrders()` unscoped in InsightsView (App.jsx:16869); the phone session above pulled it in 4 seconds | 2.58 MB per open | per visit | — | see 2d | trading |
| 6a | **Store app: `/insights_log` whole** — `InsightsLogProvider.jsx:42`, shared by Insights, Customers and Admin; measured from MC's phone at 20:01 | **30.9 MB per session** (grows ~0.35 MB/day) | per Insights/Customers/Admin session, 5-min release | — | see 2d | any time |
| 7 | Store app: `/restock_requests` whole, `/returns_log` whole, `/stock/{hub}` whole per hub screen | 1.30, 0.75, 1.36 MB | per visit | — | see 2d | trading |
| 8 | **Excess Inventory (#547, merged today)** adds another whole-`/stock` `useStockCells()` (ExcessHubToCentral.jsx:80) | 5.36 MB per open (measured 22 Aug) | per visit | — | new today | trading |
| 9 | POS tills **without** the mirror flag: `readWholeNode()` on `/pos/sales` (useSales.js:138) is still the flag-off path for sale search | 13.8 MB (POS PR #278's own figure) | per search session on 4 of 5 tills | — | not seen in window | trading |
| 10 | Cloud Functions: EFT/parked-sale readers, social health, card-recon health, hold-reveal sweep | 0.8 MB/h all together | continuous | ~0.6 | <$1 | 24/7 |

**Always-on total (rows 1+2+3+10): $160–235/month, $5.3–7.8/day** depending
on how often the reconcile loop has work. That is what the weekend of 29–30
Aug ($14.39/day) sits on top of; the remaining $7–9/day on a Saturday and
Sunday is staff and tills.

---

## 4. The three unaudited codebases

**marathon-broadcast-service** — runs on the mini under pm2 (`~/Code/marathon-broadcast-service`).
Re-checked over ssh: no RTDB reference in its `src/`. Firestore only. Clear.

**marathon-ai** — the code is as described: whole-node `/insights_log` +
`/products` + `/returns_log` trios at Dashboard.jsx:134-135 (and the
SlowMovers / Marketing / DistributeOrder equivalents), persistent `onValue`
on `/products` at Dashboard.jsx:99, no bounded query anywhere in `src/`.
Last commit 13 June, last hosting release 10 June. **It cannot be
quantified retroactively:** it reads from a browser with an ordinary Chrome
user-agent, so on a billing statement or a profiler line it is
indistinguishable from the store app, and no capture since 4 Aug has shown a
client with its signature (three whole-node reads in one burst including
`/returns_log`). Zero such bursts in this window. **The `marathon-club-ai`
hosting site was disabled by the owner at 18:22 SAST today** (release type
`SITE_DISABLE`, four minutes before this session began), so from today it
reads nothing. Whatever it cost in August is inside the "browser" residual of
2d and cannot be separated out now.

**The Mac mini** — yes, it can be checked from here, and it was: key-based ssh
works. Everything the mini runs, with its RTDB footprint:

| Process | How it runs | RTDB reads | Verdict |
|---|---|---|---|
| `scripts/shopify/reconcile-runner.mjs` | launchd `com.marathon.shopifyreconcile`, KeepAlive, every 2 min | whole `/shopify_publish` ×2 per run; per product processed: whole `/stock` (6.2 MB) + `/shopify_sync` root transaction (~1 MB ×3) | **row 1 above — the largest single reader in the database, 45–79% of every hour measured** |
| `scripts/cardrecon/poll-runner.mjs` | launchd, KeepAlive, 120 s | keyed reads of its own seen/status nodes, `/config` | 11 KB/h, fine |
| `scripts/social/publish-runner.mjs` → `publish.mjs` | launchd, every 2 min | `/social_posts` (61 reads/h, 1.1 MB); one paged full read of `/products` per hour (10 pages of 500 by key, 4.2 MB, seen at 19:07 and again in the second hour) | small; the hourly `/products` pull is the only fat |
| `publish-watchdog.sh` | launchd, 120 s | `/social_health/publisher/lastTickAt` | bytes |
| marathon-photo-grabber `src/server.mjs` | launchd | none found in its source; but a client-SDK node process on the mini makes 84 denied reads/hour of `P-shoe` cells (above) | harmless, sloppy |
| marathon-broadcast-service | pm2 | none (Firestore) | clear |
| openclaw gateway | launchd | a `claude -p` session was running at the time of the check | not an RTDB reader |

The earlier "MacBook only" caveat is closed. There is no older order-notification
service on the mini.

---

## 5. What grew since 4 August

Path by path, 4 Aug figures from the 09:28 SAST clean window against today.
"Per read" sizes are measured in both captures; whether the *number* of reads
grew is stated where the cadence is known.

| Path | 4 Aug | 3 Sep | Change | Why |
|---|---:|---:|---|---|
| `/shopify_publish` from the mini | **0** — did not exist as a reader | 132.9 MB/h, ~3.1 GB/day | **new, ~$87/mo** | reconcile loop installed on the mini 14 Aug (reconcile-runner.mjs), second whole read added 17 Aug (search-index sweep). Node itself has grown to ~2.2 MB as 373 products went live with photo metadata. |
| refillHealthScan per run | ~31 MB | 40.05 MB | +29% per run, −49% runs/day | net ≈ −$30/mo vs 4 Aug; but `/stock_movements` per run went 14.0 → 18.6 MB — the ledger inside the window is a third bigger |
| `/refill_requests` per whole read | 3.3 MB | 7.21 MB | **+118%** | node has more than doubled (satisfied/withdrawn requests are kept; History was indexed in #333 but the live queue still reads the whole node). Every refill-screen open and every scan run pays it. |
| `/orders` per whole read | ~1.0 MB (36 MB / 35 events) | 2.58 MB | **+150%** | the node grew; nothing prunes it. Paid by InsightsView, phones, and every scan run. |
| `/products` per read | 3.68 MB (22 Aug) | 4.17 MB | +13% | catalogue growth; paid on every session |
| `/displayChecks_active` sweep | not present | 26.8 MB/h | **new, ~$18/mo** | wakeHeldChecks deployed since |
| `/insights_log` ranged (Source) | — | 3.46 MB for 5 days | fixed | #300 holds; the ranged query shape is present on the live bundle |
| `/insights_log` whole (Insights / Customers / Admin provider) | 19.4 MB | **30.9 MB** | **+59% per open** | deliberately left whole-node by #300; the node grows ~0.35 MB/day and nothing ranges or archives it |
| `/pos/sales` whole (POS search) | not in the 4 Aug store-app capture | 13.8 MB per search session on flag-off tills | unchanged for 4 tills | mirror is on one till |

So: the August fixes removed roughly $30–50/month, exactly as the brief says,
and in the same weeks **$105–180/month of new always-on server-side reading
was added** (rows 1 and 3, the mini's reconcile loop being almost all of it),
on top of three nodes that grew 59–150% and are still read whole by browsers
(`/refill_requests`, `/orders`, `/insights_log`). That is the increase.

The 2 Sep spike ($22.90) is not explained by anything in this list; nothing
merged on 1–2 Sep adds a listener (checked the diffs of #540–#546). It is most
likely a heavy browser day — which is exactly the traffic this window did not
sample.

---

## 6. Stale clients

- Mike's Android session issued the post-#300 `orderByKey/startAt` query on
  `/insights_log` (the profiler records the query), so it is on a bundle from
  after 3 Aug. MC's iPhone read `/insights_log` whole — but that is the
  provider path the *current* bundle still has, not a stale signature; she
  also read `/settings/hubSneakerCount` and per-product `/shopify_publish`
  chips, both of which exist only on recent bundles. Junid's iPhone session
  was four seconds and read only `/orders`; nothing distinguishes its bundle.
- **Demonstrably stale: 0 of 3.** That is not "none exist": two hours held
  three browsers, and silence on a path means the screen was not opened, not
  that the bundle is new.
- Since 6 July (`src/update/updateChecker.js`) the store app does not only
  show a banner: it **auto-reloads** when the tab is hidden or idle for
  3 minutes, one attempt per version. A parked tab therefore cannot sit on old
  code past its next idle period unless it is on a screen registered as
  never-reload. The 4 Aug scenario is much less likely than it was.
- The live bundle is `f90ae71`, built 12:32 UTC today; hosting shows **eight
  releases in the last three days**. Every release re-downloads `/products`
  (4.17 MB) on every device that reloads. That is a real, small, recurring
  cost of the deploy cadence.

---

## 7. Fix list, ordered by dollars saved per unit of work

| Rank | Fix | Saves (derived) | Work | Notes |
|---|---|---:|---|---|
| 1 | **Mini reconcile loop.** (a) Read `/shopify_publish` once per run, not twice — pass the map into the search-index sweep. (b) Replace `Object.keys(db.ref("stock").get())` at reconcile.mjs:820 with `db.ref("stock").get({shallow})` via REST `?shallow=true`, or read `/locations` (927 B) — it needs ten keys, not 6.2 MB. (c) Make the `/shopify_sync` root transaction in idMap.mjs:96 a per-product transaction. (d) Tick every 10 minutes, or only when `/shopify_publish` has an intent that differs from confirmed. | **$80–150/mo** | script only, `launchctl kickstart` on the mini | no rules change; every one of these reads grows with the catalogue |
| 2 | **Store app `/insights_log`: the Insights / Customers / Admin provider reads 30.9 MB per session and the node grows every day.** Range it to the period actually on screen (InsightsView already computes one), and give "all time" its own explicit, warned read — or archive months older than the joinable window (`insights_log` before 10 June is unjoinable anyway) into a separate node. | 30.9 MB per open, and rising | app; archive is a one-time script | the size is measured; the daily open count is not |
| 3 | **Store app `/refill_requests`: the live queue must not read the whole node.** Either query `orderByChild("status").equalTo("open")` (needs an `.indexOn` on `status` — a rules change, out of scope here, flagged) or read `/refill_engine/open` (81 KB, already an index of open ids) and fetch per id. | large but unmeasured: 7.2 MB per screen open, six screens | app change | cost per open is measured; opens per day are not |
| 4 | **refillHealthScan: narrow `/stock_movements`.** It reads 18.6 MB of ledger per run, 49 times a day, then filters. Read since the previous run's watermark, or keep a per-run rolling summary. | ~$25/mo | function | also read `/refill_requests` open-only (7.2 MB per run) once fix 2's index exists: another ~$9/mo |
| 5 | **Prune `/orders`.** 2.58 MB whole, read by InsightsView, phones and every scan. Move completed orders older than N days out of the live node, and range InsightsView like the TV already is. | ~$4/mo on the scan alone; more on browsers | function + app | |
| 6 | **wakeHeldChecks: trading hours only and held-only.** 288 runs/day reading the whole active index for two stores; nothing is woken at 03:00. | ~$12/mo | one schedule string + one query | |
| 7 | **Roll the POS mirror to the other four tills.** Each flag-off till pays 13.8 MB per sale-search session. Set `localStorage marathon-pos.offlineMirror=on` on each. | unmeasured; the one mirrored till showed no `/products` or `/pos/sales` read in the window | config, no code | see section 8 on the mirror's own reads |
| 8 | **Excess Inventory (#547): drop the whole-`/stock` `useStockCells()`.** It shipped today; the NETWORK-TOTALS doc already shows the per-product pattern. | 5.4 MB per open | app | |
| 9 | Fix the mini's node client that probes `P-shoe` every 5 minutes. | $0 | hygiene | denied reads are free, but it is a bug |

Fix 1 is the only one whose saving is fully measured end to end (per-read
size × observed ticks × 24 h). Fixes 2–8 have a measured per-open cost and an
unmeasured open count; the trading-hours capture in section 9 turns them into
dollars.

---

## 8. Did the mirror help?

The POS mirror (PRs #275–#286, 29–31 Aug) reads `/products` whole every 4 hours
per till plus on any change under `/price_history_index` or `/specials`,
`/barcodes` by key cursor, the till's own `/stock/{loc}` branch every 4 hours,
and `/pos/sales` forward by `createdAt` in a 60-day window. It also holds
`onValue` on `/price_history_index` and `/specials` as change signals.

In this window one till was visible (macOS Chrome on the shop IP): 36 small
`/pos` operations, **no `/products` read, no `/pos/sales` read**. That is
consistent with the mirror doing its job on that till, and with nobody
searching sales after 18:30. It is not proof — the window is after hours.

What the bill says: the daily rate did **not** fall after 29–31 Aug (14.4 →
16.3 → 17.4 → 22.9). One till's saving is inside the noise of the other lines.
Rolling to five tills is fix 7; what it saves is 4 × (13.8 MB × sale-search
sessions per day) and cannot be stated until a trading-hours capture counts
those sessions.

---

## 9. What could not be determined, and what it would take

1. **Per-device cost during trading.** The dominant line — $11–17/day of
   browser and till traffic — is derived by subtraction from the bill, not
   measured. **To determine it:** run the profiler for 60 minutes at 10:00
   SAST on a weekday (`firebase database:profile --project marathon-club
   --duration 3600 --raw -o capture.jsonl`) and feed it the analyser below.
   The profiler emits 60 minutes regardless of `--duration`; run it twice for
   two hours.
2. **marathon-ai's August cost.** Not separable from the browser residual; the
   site is now disabled, so it is moot going forward.
3. **Screen opens per day** for the whole-node screens (refill queue, Insights,
   Excess). The per-open size is measured; the count needs the same
   trading-hours capture (count `listener-listen` on `/refill_requests` per IP).
4. **The 2 Sep spike.** Nothing in the 1–2 Sep merges adds a reader; it needs
   the trading-hours capture too.
5. **Today's (3 Sep) bill line** had not posted by 20:00 SAST.

### Analyser used (Python, stdlib only)

```python
import json,sys,collections
recs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
SKIP={'realtime-write','realtime-transaction','concurrent-connect','concurrent-disconnect','listener-unlisten'}
tot=0; path=collections.Counter(); client=collections.Counter(); cp=collections.defaultdict(collections.Counter)
for r in recs:
    if r['name'] in SKIP: continue
    b=r.get('bytes') or 0; p='/'+'/'.join((r.get('path') or [])[:1])
    c=r.get('client',{}); ua=c.get('userAgent',{})
    k=f"{c.get('remoteAddress',{}).get('address')} {ua.get('os')}/{ua.get('browser')}/{ua.get('version')}"
    tot+=b; path[p]+=b; client[k]+=b; cp[k][p]+=b
print('total bytes',tot)
for p,b in path.most_common(20): print(f'{p:35s}{b:>14,d}')
for k,b in client.most_common(20): print(f'{b:>14,d} {k}', cp[k].most_common(5))
```
