# Shopify stock truth — why the website sold stock the app does not hold

Junid's report, 2026-10-11: the app product **"John Richmond Black Leather Logo
black"** shows 0 in the Total Stock card, but its live Shopify listing **"Black
leather platform sneaker with white collar"** (R1,300) let customers buy sizes
6, 7, 8, 9 and 10.

The rule this work enforces: **the app's inventory is the only source of
Shopify quantities, all the time, automatically. No size can be bought online
unless the app holds it.**

---

## 1. Diagnosis (measured 2026-10-11, ~21:00 SAST)

### a) The John Richmond product, per location and size

App product `p1787221095186`, sizes `6 7 8 9 10`. Read per product, one
`/stock/{location}/p1787221095186` read per location:

| Location | 6 | 7 | 8 | 9 | 10 | Notes |
|---|---|---|---|---|---|---|
| Central | 0 | 0 | 0 | 0 | 0 | all sent out 22–28 Aug |
| Hub 1 | — | — | — | — | — | no cells |
| Hub 2 | 0 | 0 | 0 | 0 | 0 | last pair sold 4 Sep (POS sales) |
| Hub 3 | — | — | — | — | — | no cells |
| In Transit | 0 | 0 | 0 | 0 | 0 | |
| Marathon PE | — | — | — | — | — | no cells |
| Trophy | — | — | — | — | — | no cells |
| Pine | — | — | — | — | — | no cells |
| Concrete | — | — | — | — | — | no cells |
| Base / Studio (retired) | — | — | — | — | — | no cells |

**The app holds zero of every size, everywhere** — including the three
locations the Total Stock card leaves out.

Shopify (`gid://shopify/Product/9346035777685`, ACTIVE, on Online Store and
Facebook & Instagram):

| Size | available | committed | tracked | policy | last quantity write |
|---|---|---|---|---|---|
| 6 | **−1** | 1 | **false** | DENY | 2026-10-11 15:25 UTC — web order **#1682** (unfulfilled) |
| 7 | 0 | 0 | **false** | DENY | 2026-09-05 06:48 UTC — the 5 Sep manual correction run |
| 8 | 0 | 0 | **false** | DENY | 2026-09-05 06:48 UTC — same run |
| 9 | 0 | 0 | **false** | DENY | 2026-09-05 06:48 UTC — same run |
| 10 | 0 | 0 | **false** | DENY | 2026-10-03 05:34 UTC — **the reconciler's inventory backstop** ("40 checked · 1 corrected", 07:36 SAST) after web order **#1632** took it to −1 |

So the app's numbers **did** reach Shopify: every size was 0 on Shopify. The
reconciler last wrote this product on 3 Oct, triggered by its own backstop
sweep, and it wrote the correct number. **Shopify ignored it because inventory
tracking is off on all five variants.** With `tracked: false` a quantity is
decorative — Shopify sells the size regardless. That is how #1632 (size 10,
2 Oct) and #1682 (size 6, today) were sold against an app count of zero.

### b) Which cause is true

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Inventory is pushed only on publish/intent, never on later stock changes | **False (now).** It was true until #559; since then markers (Cloud Function on every `/stock` write) + a backstop walk push on every tick. | JR's size 10 was corrected by the backstop on 3 Oct. Across the live set, **0** tracked units were above the app. |
| The mini's reconciler stopped or is failing | **False.** | `launchctl list` shows `com.marathon.shopifyreconcile` loaded, last exit 0. Log tail: a run every 2 minutes until 19:00, every one `run end: OK`, then the hourly idle line (trading hours 07:00–19:00). |
| Shopify counts locations the app view excludes | **False.** | Shopify has exactly one location (enforced by `requireSingleLocation`). The push sums the online pool (Central, Hub 1, Hub 2, PE, Trophy); for JR every location in the app, counted or not, is 0. |
| **Something else: inventory tracking is OFF on Shopify** | **TRUE — the cause.** | 66 Shopify products have untracked variants. **All 66 were created on 24 Aug 2026 between 12:17 and 20:33 UTC**, and their inventory items have not been modified since. The Mac mini was cloned on 14 Aug at `93c5fe4` and **not pulled until 25 Aug 12:41** (`git reflog`), so on 24 Aug it was publishing with code from before #373 (17 Aug), which created variants untracked. #373's backfill ran before 24 Aug and never again, and tracking is only checked when a product is published — so these listings were never re-checked. |

A second, smaller hole found on the way:

- **Switched-off products are still on Facebook & Instagram.** Switching a
  product off removes it from the Online Store only. **33** products the app
  has switched off are still ACTIVE and published to Facebook & Instagram, and
  every inventory path skipped them because they were not "on". They offer
  **145** units, **34** of them more than the app holds, and **12** of the 33
  are also untracked.
- **Three hand-made listings with no app product.** "Men's tracksuits tech
  fleece" ×3 (created in Shopify by hand in May and July, no SKU) are on the
  Online Store with 6 units each — 18 units the app has no record of at all.
- Not an oversell, recorded for completeness: 13 products the app calls live
  were deleted from Shopify (the reconciler already shouts about 6 of them
  every tick), and 1 is archived.

### c) Blast radius (live-ON products only, per product)

Method: every Shopify product read through the Admin API (4,265), then for each
of the **1,725** app products that are live and on: one `/shopify_sync/{pid}`
read and one `/stock/{location}/{pid}` read per location — **6.74 MB** of RTDB
reads in 99 s for the whole live set (switched-off listings included), no
whole-node read. "Buyable" is Shopify's own rule: a tracked DENY variant sells
up to its quantity; an untracked one sells without limit.

| | Products | Sizes | Units |
|---|---|---|---|
| Live-ON listings where Shopify will sell more than the app holds | **54** | **337** sizes unlimited (tracking off) | unlimited; **191** of those sizes have app = 0 |
| …of which tracked sizes above the app | 0 | 0 | **0** |
| Switched-off listings still on Facebook & Instagram | 33 | 12 products untracked | 145 offered, **34** above the app |
| Listings with no app product at all | 3 | 12 | **18** |

Totals across the live set: Shopify offers 18,718 tracked units; the app's
online pool holds 19,428.

The 20 worst offenders (every one is a fully untracked listing, so every size
is unlimited; app quantity per size shown):

| App product | Shopify title | App holds (size: qty) |
|---|---|---|
| p1787221095186 | Black leather platform sneaker with white collar | 6:0 7:0 8:0 9:0 10:0 |
| p1778142338746 | Black and white low-profile trainer with gum sole | 3:1 4:5 5:2 6:2 7:0 8:3 9:3 10:3 |
| p1785936765299 | Rope-lace patent low trainer in triple black | 3:0 4:0 5:0 6:0 7:0 8:1 9:0 10:1 |
| p1785937096595 | Cup-sole embossed trainer with heart lock tag | 3:0 4:0 5:0 6:1 7:0 8:0 9:0 10:0 |
| p1785937290663 | Contrast-stitched black patent and matte leather trainer | all 0 |
| p1785937525867 | Low-top court silhouette in monochrome mauve brushed leather | all 0 |
| p1785937781350 | Camouflage canvas low-top with gum outsole | all 0 |
| p1785937936741 | Brushed nubuck low-top trainer with translucent side overlay | 6:1 9:1, rest 0 |
| p1777897514529 | Chrome pod mesh runner in neon green | 10:1, rest 0 |
| p1777898265684 | Grey futuristic low-top with bright blue side accents | 8:2 9:1 10:1, rest 0 |
| p1777898350156 | Translucent heel clip chunky low-tops in pale grey | 6:2 7:2 8:4 9:3 10:1 11:1 |
| p1777902809280 | Knit road racer with gradient foam sole | 6:2 7:6 8:3, rest 0 |
| p1777903990443 | Sneaker White Blue Orange | all 0 |
| p1777904069507 | Bright orange knit runner with chunky foam midsole | 6:1, rest 0 |
| p1777972768933 | Technical mesh runner in grey with coral trim | 7:1 8:2, rest 0 |
| p1777972868051 | Cream and crimson lightweight mesh running shoe | 6:8 7:14 8:10 9:10 10:6 11:2 |
| p1777972914825 | Chunky foam-sole mesh runner with bold diagonal stripes | all 0 |
| p1777973102966 | Chunky-sole mesh road runner in triple black | 6:6 7:7 8:9 9:6 10:3 11:1 |
| p1777973699838 | Translucent gum sole low-top trainer with perforated toe | 6:1 8:2 10:2 11:1 |
| p1777973797045 | Low-profile indoor silhouette in sky blue with gum sole | 6:2 7:4 8:2 9:1 10:2 11:1 |

### d) Does the quantity definition agree everywhere?

The online pool — what may be sold to a web customer — is defined once in
`scripts/shopify/inventory.mjs` (`networkTotals` + `ONLINE_EXCLUDED_LOCATIONS`:
**excludes** In Transit, Hub 3, Pine and Concrete; counts only the sizes the
product record declares; negative cells count 0). The Cloud Function trigger
(`functions/lib/shopify-inventory-dirty.cjs`) and the social generator
(`functions/lib/social-select.cjs`) carry byte-identical copies, already pinned
by tests (`inventorySync.test.mjs`, `socialStockParity.diff.test.js`). The
earlier social bug (summing every cell) is fixed and pinned. The storefront is
Shopify itself, so it shows exactly what is pushed.

The **Total Stock card** is a different number on purpose: Junid's reorder
research view (owner decision 2026-08-22) sums every cell that exists at every
live location except Pine and Hub 3, **including In Transit**. It is "what we
own", not "what a web customer may buy". It does not cause this bug (for JR
both read 0), so its pool was not changed; section 3 says how the two relate.

---

## 2. Correction (one-off, 2026-10-11 22:45 SAST)

Run on the Mac mini: `node scripts/shopify/stock-truth-sweep.mjs --commit`
(section 3 describes the tool, which is also the nightly sweep).

**What a correction is.** For every Shopify listing the app knows (all 1,832
with `state: "live"`, on the Online Store or switched off), every size is SET
to the app's online pool, tracking is switched on and the policy is DENY.
Variants the id map does not name are set to 0. The three listings with no
app product behind them are set to 0.

**Measured with the final definition** (Shopify `on_hand` against the app,
see "on hand, not available" below). The dry run just before the commit:

| | |
|---|---|
| Listings checked | 1,830 (1,807 ACTIVE on Shopify; 25 not active: deleted, archived or draft) |
| Listings out of step | 99 published + 43 unpublished (142 corrected) |
| Sizes Shopify was not limiting (tracking off) | **406** |
| Tracked units on Shopify above the app, on published listings | **75** |
| Listings with no app product | 3 (the "tech fleece" listings, 18 units) |
| Units taken off sale | 384 of 20,409 on hand (**1.9%**, far below the 25% stop) |

The 406 is higher than §1's 337 because this pass also reads the variants the
id map does not name (sizes like `5.5` and `11` that were on the listing but
not in the map) and the switched-off listings.

- Rollback file: `~/marathon-rollbacks/stock-truth-2026-10-11T20-45-00-596Z.json`
  on the mini (165 KB — the quantity and tracking state of every item
  changed). `--rollback <file>` restores it, compare-and-set against what the
  correction wrote, so a sale since then is never overwritten.
- Re-read of the 142 corrected listings straight after: **0** oversellable
  units, **0** unlimited sizes.
- A fresh full read afterwards: **0 drifted, 0 oversellable, 0 unlimited**;
  Shopify on hand 20,099 = the app's online pool 20,099.

**John Richmond, before and after.** Before: all five sizes untracked (sold
without limit). After: all five tracked and DENY, on hand 0; the live product
JSON on marathonclub.co.za reports every size `available: false` (sold out).
Size 6 shows available −1 because web order #1682 is still committed against
it — staff must decide what to do about that order; nothing here touches
orders.

### On hand, not available

The push writes Shopify's **on_hand**, not `available`. `available` is
on_hand minus `committed`, and committed is a web order taken but not yet
fulfilled — which the app does not know about until staff ring it through
the POS (there is deliberately no order webhook). Writing the app's count to
`available` hands the committed unit back to the storefront: the app holds 2,
one sells online, Shopify shows available 1 / committed 1, and "available 2"
offers two pairs while one is left. Writing on_hand keeps available = app −
committed. What it does not close, stated plainly: if staff **fulfil** the
web order in Shopify before ringing it through the POS, Shopify lowers on
hand itself and the next push writes the app's not-yet-lowered count — that
unit is offered again until the POS sale lands (minutes, if the order is rung
as it is packed). And if the POS sale lands **first**, Shopify is one unit
short for that size until the order ships. Ringing web orders through the POS
before fulfilling them in Shopify keeps the window closed.

## 3. Continuous sync

Three paths now keep every listing true; all of them SET absolute
quantities through `syncProduct` and none reads a whole node.

| Path | Trigger | What it reads | Fixes |
|---|---|---|---|
| **Movement ledger** (new, `movementSync.mjs`) | every reconciler tick, first thing in the tick | `/stock_movements` by its `ts` index from a stored cursor (90-min lookback for offline tills — worst lag measured over 7 days was 61 min); then per moved product: its id map + one cell set per counted location | every product that moved since the last clean pass |
| Dirty markers (existing, `inventorySync.mjs`) | every tick | the marker node | products the Cloud Function marked on a `/stock` write |
| **Nightly sweep** (new, `stock-truth-sweep.mjs`) | 02:30 SAST, `com.marathon.shopifystocksweep` | one bulk read of every ACTIVE Shopify product, the listed set, per-product app stock | anything the per-tick paths missed — late rows, a trigger that never fired, a hand edit in the Shopify admin, tracking switched off |

The existing 40-per-sweep backstop still runs too.

**The cursor** (`/shopify_sync/_movementCursor`) never advances on a failure:
with a retryable failure (a transport error, a sale landing mid-push, a
tracking read that failed) it stays put, and the rows are read and pushed
again next tick. A permanent answer — product deleted from Shopify, an id map
Shopify does not recognise — is not a failure a tick can fix: it is counted
done, reported every time the product moves, and the nightly sweep reports
it. A product that keeps failing stops holding the cursor 6 hours after its
first failure (the nightly sweep owns it from there), so one stuck product
can never make every tick re-read a growing window.

**Every listing, not only "on".** Both per-tick paths now cover every product
with a Shopify listing. Switching a product off removes it from the Online
Store only; on 2026-10-11, 33 switched-off products were still on Facebook &
Instagram with quantities nothing corrected.

**Tracking on every touch.** `syncProduct` reads every variant on the listing
(paged) and switches tracking on / DENY wherever Shopify was not limiting a
size, before it writes the numbers. A stale id map on a listing that still
exists holds every variant at 0 until it is re-mapped (5 such listings today).

**One definition.** What may be sold online is `networkTotals` in
`scripts/shopify/inventory.mjs`: Central, Hub 1, Hub 2, Marathon PE and
Trophy; never In Transit (not pickable) or Hub 3, Pine and Concrete (counts
not trusted online — Junid's decision of 2026-09-08); only the sizes the
product lists; negatives count 0. The trigger, the social generator and the
app's screens (`src/utils/onlinePool.js`) carry copies pinned to it by tests.
**The Total Stock card** keeps its own number — Junid's reorder total, which
deliberately includes In Transit and every cell — and now shows **"online N"**
beside it: the exact number Shopify is told, from the same reads. Pine and
Hub 3 are excluded from both, so the card was not "wrongly" excluding them;
Concrete has no `/stock` location of its own (its stock is Hub 3's).

**Cost.** The nightly sweep read 6.0–7.0 MB of RTDB per run (measured, four
runs) and finishes in about 2 minutes (one Shopify bulk read, ~20 s). The
per-tick figures are in §5.

## 4. Watchdog

`shopifyInventoryHealthScan` — a named Cloud Function on Google's scheduler,
every 5 minutes, so it keeps working when the mini or its reconciler is dead.
It reads `/shopify_inventory_health` and prints `SHOPIFY_STOCK_ALARM …`, which
a Cloud Monitoring log-match policy (`scripts/shopify/install-stock-alarm.mjs`)
emails to Junid **with the line's own text**. Email only.

It alarms when:
- **a product has failed to sync for 6+ hours** (the per-tick path has
  stopped retrying it; the email names the products);
- **no clean inventory pass for 15 minutes** while the reconciler is meant to
  be working (07:15–19:02 SAST). A clean pass is a movement-ledger pass with
  no retryable failure; the reconciler stamps `lastPassAt` after each one.
  Outside those hours the reconciler is idle by design (and shop movements
  stop by 19:00 — measured), so silence at night is not an outage;
- **the nightly sweep found anything oversellable**, was refused by its 25%
  guard, could not read or correct a listing, or left anything wrong after
  correcting — the email names what it found, how many listings it corrected,
  the worst offenders and the rollback file;
- **no sweep has reported for 26 hours** (the nightly job is dead).

One email per incident; a reminder every 6 hours while it lasts.

No database rule is needed: `/shopify_inventory_health`,
`/shopify_inventory_sweeps` and `/shopify_sync/_movementCursor` are written
and read only with the Admin SDK.
