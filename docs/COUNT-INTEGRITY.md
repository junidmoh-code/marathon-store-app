# Count integrity — investigation (Commit 1, read-only)

Live data read 2026-08-12 (SA). One bug, three symptoms: the count card asks the
counter to confirm a BOOKED total that includes units which are not on the hub
shelf — displays at shops, ready orders awaiting collection, layby pulls, and
refill boxes that are credited the instant they are fulfilled. An honest counter
adjusts those units away and the system destroys stock that physically exists.

## a) What display registration writes today

`registerDisplayUnit` (src/components/stock/hubCleanupStore.js:180) performs one
atomic `applyMovement`:

- `type: "received"`, `+1` to `stock/{hub1|hub2}/{productId}/{sizeKey}` —
  qty +1, v +1, mv, lastType "received", updatedAt/By.
- Ledger row `stock_movements/dispreg_{hub}_{pid}_{sizeKey}` with
  `reason: "display_registration"` and `link.displayRegisterHub`.
- Progress record at `settings/hubSneakerCount/register/{hub}/{pid}__{sizeKey}`
  ({ productId, productName, size, sizeKey, qty, at, by, movementId, styleCode* }).

**Nothing marks the unit as physically off the hub shelf, and nothing records
which shop the display is at.** That is explicit policy from PR #324 ("displays
are hub stock; we no longer track what is on display" — src/App.jsx:2663). The
old `/settings/displayRegister/{store}/...` node — the only record that ever
carried a store — was deleted in #324. A display at PE and a display at Trophy
registered against hub2 are indistinguishable.

## b) Hub-booked stock NOT on the hub shelf right now (live census)

| Category | Hub 1 | Hub 2 | Attributable per cell? |
|---|---|---|---|
| Display units at shops (register rows) | 401 units (392 on cells still positive, 9 on cells at ≤0) | 405 units (401 positive, 4 at ≤0) | Yes by product+size; **shop unknown for every one of them** |
| Ready footwear orders awaiting collection | 61 units | 43 units | Yes — order rows carry productId + size + destShop |
| Layby pulls outstanding (`sentToStore`) | 119 pulls / **137 items** | 0 | **No.** `/laybyPulls` carries only `itemCount` — no productId, no size |
| In-flight refills (fulfilled since last 06:00 window at probe time) | 0 | 11 lines / 13 units | Yes via request rows, but nothing marks them un-arrived |

What the layby gap means: 137 units are booked somewhere in hub1's cells and
physically at shops, and there is no way — now or ever — to say which cells.
Any hub1 cell can be short by an unknowable layby amount; a per-cell
expected-on-shelf number can never include them. The count card can only say,
at hub level, "some shortfalls here may be layby pulls" and refuse to treat a
layby-shaped shortfall as certainty. (SCHEMA.md:1061 confirms returned pulls
also re-shelve with no ledger entry.)

Also live: 37 display-partner orders in `/orders`; register rows whose cell is
at ≤0 (13 across both hubs) are displays whose booked unit has already been
sold off by POS sales pressure — the register row is stale, not evidence.

## c) What Fulfil writes on the central→hub leg

`fulfilRequest` (src/components/stock/RefillQueue.jsx:361) — three separate
round-trips, NOT one atomic write:

1. Live re-read of the request; abort unless `status === "open"`.
2. **The stock move** (atomic inside applyMovement): counted Central →
   `transfer_out` central −q / hub +q, `reason "{hub}_auto_refill"`,
   `movementId rrf_{requestId}[_{tranche}]`; uncounted Central (avail ≤ 0) →
   `received` hub +q only, `reason "{hub}_refill_uncounted"`, **no central
   deduction**. The destination hub cell rises the moment staff tap Fulfil.
3. Request close (separate update): full send → `status: "fulfilled"`,
   `fulfilledBy {movementId, qty}`, `resolvedAt`; partial → `qty = remaining`,
   `sentQty`, stays open.

`recordDispatchTransfer` (src/App.jsx:9907, was ~8917 when specced) —
**confirmed: returns early for footwear** at App.jsx:9925-9928 with
`{ moved: false, reason: "footwear_sells_from_hub", skipped: true }`. No
movement, no deduction; the POS deducts the sale at the hub till. The transit
lane (`transitLanes.js`, `stock/in_transit`) exists and is ON for manual
Transfer.jsx sends only — RefillQueue never consults it.

## d) How the engine computes INBOUND and when it re-requests

`computeRefillPlan` (functions/lib/refill-engine.cjs:428):

- INBOUND (lines 454–474) = engine locks in `/refill_engine/open/{dest}/{pid}/{sizeKey}`
  (each contributes `qty || 1`) + manual "Shop Refill" order lines. Nothing else:
  not `stock/in_transit`, not `/transfers`, not any held/pending marker.
- Deficit (1155–1162): `target − have − inbound`; the duplicate guard is
  `if (inb > 0) continue;` at refill-engine.cjs:1238 — any inbound on the cell
  suppresses a new ask.
- **The sharp edge:** when a request is closed as `fulfilled`, the same scan
  releases its lock AND its inbound before the deficit loop runs
  (refill-engine.cjs:837–851, applied refill-scan.cjs:418–484 before the intent
  loop), on the explicit assumption "their units are already inside destHave".
  A fulfilled request whose stock has NOT landed leaves `have` low and
  `inbound` zero → **the engine raises a brand-new request in that very scan.**
  This is exactly why holding the destination credit without making held lines
  visible as inbound would double-order every held cell.
- Engine locks also go stale at `staleIntentHours` (48h) — anything that keeps
  a request open longer than that loses its lock and its inbound cover.
- Release windows are presentation-only: `/config/refillEngine/releaseWindows`
  is read by RefillQueue/RefillHistory in the client and by NOTHING in
  functions/ (pinned by src/signedInPillAndHoldMerge.gate.test.js:155). The
  live config key is currently absent → clients fall back to 06:00 / 14:00 SA.

## e) Everything else that reads the destination cell between fulfil and arrival

- **POS sale path** (marathon-pos-app, separate repo): deducts the hub cell at
  the till; `sold` is exempt from the negative floor (applyMovement.js:140), so
  a sale never fails on a low cell — it goes negative.
- **Hub Sneaker Count** (this bug): the counter's `expected` is that same cell.
- **Health** (HealthView.jsx:280): negative-inventory list; a fix writes an
  adjustment.
- **MoveExcess** (MoveExcess.jsx:97–128): `raw = qty − target` — instantly-
  credited in-flight units can be classified as excess and shipped straight
  back to Central.
- **Missing Products / Missing Sneakers** (missingProductsCore.js:67,
  missingFootwearCore.js:117): a single phantom unit at a hub removes the
  product from Missing Sneakers entirely.
- **RefillQueue "already covered"** (refillSatisfied.js:55): open requests are
  retired when the destination cell covers them.
- **The engine** (refill-engine.cjs:165/593/813/1309): same cells everywhere.

## f) How many counted cells have off-shelf units, and completed counts that may have destroyed one

Sessions opened 2026-08-03: hub1 251/2251 cells done (73 adjusts, net **−48
units**; 49 flags pending admin), hub2 77/1819 (28 adjusts, net **−58 units**).

Crossing counted cells against off-shelf sources:

- 50 counted cells carry display register rows (41 hub1, 9 hub2). Of the 19
  register-linked ADJUSTED cells, 12 were adjusted DOWN — but 10 of those were
  counted 2026-08-04, BEFORE their display was registered (07–10 Aug), so the
  registration re-added the unit afterwards (those count records are now stale
  instead). **2 cells were adjusted down AFTER their display registration —
  both hub1, both counted 2026-08-12 (today): Lacoste Audyssol Navy White sz 6
  (5→1) and "Lacoste grey" sz 8 (4→3). Each likely destroyed a registered
  display unit. The damage is live and ongoing, roughly 1 unit per counting
  day at the current pace.**
- 1 down-adjust matches a ready order awaiting collection (hub2
  p1777986611409 sz 6, 5→4).
- 7 flagged register-linked cells (hub1) are queued for admin apply — each
  apply would destroy a display unit if applied against the shelf number.
- Layby exposure (hub1, 137 units) is per-cell unknowable by construction.

Verdict: ~3 confirmed destruction candidates so far (~R2–4k), plus 7 queued in
flags. NOT yet large enough to need a data correction; the fix below stops the
bleeding and the flags queue must be re-checked against off-shelf data before
any admin applies it. No correction is proposed and nothing was written.

## g) Typical central→hub shipment volume

From fulfilled requests bucketed by release window (last 21 days): **hub2:
10–110 lines, 13–200 units per window (median ≈ 40 lines / ≈ 80 units); hub1
(lane opened 2026-08-08): 12–45 lines / 24–82 units.** Two windows a day, so at
most two shipments pending — each release is one tap covering tens of lines.

## The design that follows (commits 2–6)

1. A display is a SLOT: `/settings/displaySlots/{store}/{productId}` holding
   the size currently on that shop's floor, set by registration (which gains a
   store picker) and by the display-refill flow, cleared when the display
   sells. Existing register rows are readable as store-unknown fallbacks only.
2. The count card shows `booked − known off-shelf = expected ON SHELF`, itemised
   in plain language; confirm/adjust move the SHELF figure and can never delete
   an off-shelf unit.
3. Fulfil (behind a config switch, default OFF) parks the credit in
   `stock/in_transit` — source deducts at fulfil (the box has left), destination
   credits at release (it arrived) — with a held-line manifest grouped by
   release-window shipment at `/settings/stockHold/held`.
4. The engine reads the held manifest as INBOUND (small functions change,
   deployed BEFORE the switch is enabled), so a held cell is never re-requested.
5. An owner-only home card lists pending shipments (at most two) with one-tap
   release, per-line not-arrived carry-forward, idempotent movements, loud age.
6. Cells counted before a release resurface for re-confirmation showing what
   changed and when.
