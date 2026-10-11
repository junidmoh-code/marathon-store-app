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

## 2. Correction (one-off)

_Filled in by the correction commit._

## 3. Continuous sync

_Filled in by the sync commit._

## 4. Watchdog

_Filled in by the watchdog commit._
