# Online orders — website orders packed through the POS

Shopify (marathonclub.co.za) orders are pulled onto the Mac mini, held against
stock, picked by the hubs and shops, and packed by Yasmin at Marathon PE through
ONE POS sale. This file is the data contract both repos build against
(marathon-store-app and marathon-pos-app).

## The one rule

**Stock deducts only when the packer confirms Packed.** Order arrival creates a
RESERVATION (a hold row), which is not a stock movement. Picks and display
entries move nothing. A Shopify webhook never deducts anything (there is no
webhook). The pack step is the only writer of an `channel: "online"` sale.

## Switches

| What | Where | Default |
|---|---|---|
| Staff-visible feeds (hub orders, the Display Checks strip, walk-in guard) | `/config/onlineOrders/enabled` | absent = **off** |
| The POS Online Orders tab | `/users/{uid}/permissions` contains `online_orders` **and** `/users/{uid}/permFlags/online_orders === true` (rules read the flag) | Junid only |

Orders poll in and reserve from day one, whatever the switch says. When the
switch goes on, the poller backfills feed entries for every open line that has
none.

## Flow

```
Shopify order (paid, unfulfilled, not cancelled, created after go-live)
  └─ orders-poll.mjs (Mac mini, same launchd tick, BEFORE reconcile)
       ├─ /online_orders/{orderId}           status "new"
       ├─ /online_reservations/{pid}/{size}/{orderId}   the hold
       ├─ routeLine() per line               source {locationId, status}
       └─ when /config/onlineOrders/enabled:
            pick    → /orders/{code}[-n] (customer "Shopify", channel online) — the hub's own Warehouse queue + the TV
            display → /displayChecks_active/{store}/online__{orderId}__{i}  (shop feed)
  hub "Handed over" / shop "Handed to packer"  → line source.status "handed"
  POS Online Orders tab (marathon-pe): basket by scan / tap → Pack
       └─ ONE atomic update: pos/sales/{saleId} (channel "online", tender "online")
          + every hold row for the order → null + order status "packed"
          + fulfilState "pending"
  orders-poll.mjs next tick: bookShipment(order) (→ {skipped:true}) then
       Shopify fulfillmentCreate (notifyCustomer true, tracking if typed)
       failure → fulfilState "failed", "Packed, Shopify not updated", Retry
       live courier booking (docs/COURIER-GUY.md): the waybill is the Shopify
       tracking number, carrier "The Courier Guy", notifyCustomer true; with
       /config/shipping/live on and no waybill → fulfilState "courier_failed",
       "Packed, courier not booked", attention courier_failed (Junid emailed),
       POS Retry re-runs the booking only
```

## `/online_orders/{orderId}`

`orderId` is the Shopify order's numeric id (`legacyResourceId`), as a string.

| Field | Meaning |
|---|---|
| `ref` | a three-letter code (KQZ: A–Z without I/O), unique for 180 days via `/online_order_refs/{code} = {orderId, at}`; the Shopify number is `orderNumber` |
| `orderNumber`, `shopifyGid`, `shopifyName` | Shopify identity |
| `status` | `new` · `picking` · `ready` · `needs_attention` · `packed` · `cancelled` · `fulfilled_elsewhere` · `release_requested` (indexed) |
| `customer` | `{ name, phone, email }` |
| `shipping` | `{ address: {…}, provider, tracking }` — `provider` is null today (RTDB stores null as absent; read it as `shipping?.provider ?? null`) |
| `totals` | `{ subtotalCents, shippingCents, taxCents, totalCents, currency }` |
| `createdAt` | Shopify's createdAt, epoch ms |
| `ingestedAt`, `updatedAt` | server ms |
| `lines` | array, see below |
| `basket` | `{ [lineIndex]: true }` — POS basket confirmation |
| `attention` | `{ kind, reason, at, mailedAt? }` while something needs a person |
| `attentionOpen` | `true` while `attention` is unresolved (indexed — the Settings list) |
| `packClaim` | `{ saleId, by, at }` — the pack's single-flight claim; its saleId is reused by every retry |
| `pack` | `{ saleId, by, at }` after the sale lands |
| `fulfilState` | `pending` · `done` · `failed` · `courier_failed` (indexed). `courier_failed` = live Courier Guy booking did not happen; Shopify waits; POS Retry → `pending` re-runs the booking only |
| `fulfil` | `{ state, attempts, error?, at?, trackingNumber? }` |
| `cancelledAfterPack` | true when Shopify cancelled an order already packed (left alone, flagged) |
| `overrides/{pushId}` | walk-in overrides: `{ by, byName, at, storeId, tillId, productId, size, loc }` |
| `shopifyFulfilledAt` | Shopify shows the order fulfilled (admin) while the switch is on; its holds carry `released` |
| `handledByHand` | `{ by, at }` — Junid pressed "Rung by hand at a till" (status `release_requested` until the poller releases it) |
| `fulfilledElsewhereAt` | when the poller let the order go as handled the old way |

### Line

```
{ lineId: "l0", shopifyLineItemId, variantId, pid, size, sizeKey, qty, title,
  photoUrl, barcode, category, isFootwear, unitPriceCents,
  source: { locationId, status, entryKey?, handedAt?, handedBy? },
  reason? }
```

`source.status`:

| Status | Meaning |
|---|---|
| `pick` | a hub (hub1/hub2) is to pick it |
| `display` | a shop (marathon-pe/trophy) is to take it off the floor |
| `handed` | in the packer's hands |
| `no_stock` | routing found nowhere (`locationId` null) → order needs attention |
| `not_found` | the shop answered "Not found" → order needs attention |
| `needs_attention` | a walk-in sale was let through over this hold (manager PIN) |
| `unresolved` | the Shopify variant is not in `/shopify_sync` → order needs attention |
| `reroute` | Settings → Resolve sent it back; the poller routes it again |
| `cancelled` | the order was cancelled before pack |
| `resolving` | escalating (below); `locationId` is where the units are being sent |
| `unavailable` | the escalation chain ran out; the customer agent has the line |
| `resolved` | settled off the parcel: credit, refund, or Junid's "resolved by hand" |
| `moved` | came good after the order was packed; ships in follow-up `movedTo` |

`resolving`, `unavailable`, `resolved` and `moved` are PARKED: Pack does not
wait for them (no basket tick) and the order is `ready` once every other line
is handed. An order whose lines are all settled (none live, none resolving or
unavailable) is `closed` (terminal).

`entryKey` is the feed entry the poller created; its presence is what makes the
backfill idempotent.

### Order status (the poller recomputes it; `deriveOrderStatus`)

- `packed` / `cancelled` / `fulfilled_elsewhere` never change back.
- **Switch off and Shopify shows the order fulfilled** → `fulfilled_elsewhere`, hold
  released. Until Junid turns the feeds on, staff still ring web sales by hand and
  fulfil them in the Shopify admin; that sale deducted the stock, and a hold left
  standing would hide the unit a second time on every push. With the switch on,
  an admin fulfilment before the pack keeps the hold (that is the gap the hold
  closes) and the walk-in guard stops a hand-rung slip.
- any line `no_stock`/`not_found`/`needs_attention`/`unresolved` → `needs_attention`
- all lines `handed` → `ready`
- switch on and every line has its feed entry → `picking`
- otherwise `new`

POS chips: new/picking → **Waiting on picks**, ready → **Ready to pack**,
needs_attention → **Needs attention**, packed → **Packed** (or **Packed,
Shopify not updated** while `fulfilState` is `failed`).

## `/online_reservations/{pid}/{sizeKey}/{orderId}`

`{ qty, ref, locs: { [locationId]: qty }, released?, at }` — one row per order holding that
pid/size. The **count is the sum of the rows' `qty`**, so two writers never
contend on a counter, and a row is replaced (not incremented), so a re-run is
idempotent. `locs` names where the held units are routed (a `no_stock` unit
counts in `qty`, not in `locs`). Size keys use `stockSizeKey` (`5.5` → `5_5`,
one-size → `_`).

Rows exist for orders in `new`/`picking`/`ready`/`needs_attention`. They are
removed by the pack's atomic update and by cancellation.

Readers:

- **Reconciler** (`inventorySync.mjs`): pushes `on_hand = app − (released + max(0, reserved − released − committed))`.
  `released` is the part of a hold whose order Shopify has already fulfilled (the
  poller stamps it): it comes off in full, because `committed` counts EVERY
  unfulfilled order on the variant — including ones the app never pulled in.
  Shopify already holds an unfulfilled order's units as `committed`
  (`available = on_hand − committed`), so subtracting the whole reservation would
  hide each unit twice. The difference is what Shopify does NOT already hold —
  above all an order fulfilled in the Shopify admin before it was packed, which
  used to put the sold unit back on sale on the next push.
- **POS walk-in guard**: exact-path read of `{pid}/{sizeKey}`, counting the rows'
  `locs[deductingLocation]`.

## Routing (`routeLine`, pure)

Live cell quantity minus units other orders already hold at that location:

```
footwear / slides → hub1 if it has the size, else hub2 if it has it        status "pick"
anything else     → marathon-pe → trophy                                    status "display"
                  → hub2                                                    status "pick"
nothing           → { locationId: null, status: "no_stock" }  order needs_attention
```

A quantity is never split inside one line: qty 2 with one at PE becomes two
lines (PE ×1, then the next location ×1). Footwear that neither hub holds is
`no_stock` rather than a pick sent to an empty hub.

A shop whose own Display Checks switch is off is never routed to: it could
neither see nor close the entry.

## Settings → Online orders: "Rung by hand at a till"

Every open order is listed with a release. It writes `status: release_requested`;
the poller closes the order's feed entries, releases its holds and sets
`fulfilled_elsewhere`. The POS refuses to pack it and the rules refuse a pack
over it. Use it for orders pulled in while staff still rang web sales by hand.

## Poller bookkeeping (`online_orders_meta`, server-only)

`goLiveAtMs` (set once, first run — older orders are never pulled in),
`cursorMs` (updated_at window, re-read 10 min behind), `retry/{orderId}` (an
order that failed is parked and fetched by id every tick; the cursor never
waits for it), `lastRunAt`.

## Feeds (only while the switch is on)

- **Hub orders** (`/orders/{code}`, `{code}-{line}`, `{code}-{line}-{unit}`): the
  EXISTING store-order record the Assistant writes, field for field, one per
  unit, with `customerName: "Shopify"`, `customerPhone: null` (so no customer
  message of any kind), `channel: "online"`, `onlineOrderId`, `onlineLineIndex`.
  Hub 1/Hub 2 Mark as Sent as usual — **no stock moves on Send for channel
  online** (`src/utils/dispatchStockPolicy.js`). The TV shows the code and never
  speaks it. The poller copies the hub's outcome onto the line (sent → handed,
  from that hub; out of stock → no_stock; other size → needs_attention) and
  marks the hub orders collected after the Pack. The POS never sells or indexes
  a channel-online order — the Pack is the one deduction.
- **Display Checks strip** ("Website orders", top of Today): the shop's
  `kind: "online_pick"` display-check records (same gate, same locks), "Pull and
  give to Till 2" (`/config/onlineOrders/handoverText`), Handed over / Not found.

## Pack (POS)

1. Every line In basket (barcode scan; a footwear line by tapping its photo).
2. Claim: transaction on `packClaim` mints the saleId once; every retry reuses it.
3. `writeSale(draft, { saleId, extraUpdates })` — the existing sale path, with
   `channel: "online"`, `tillId: "online"`, one `online` tender for the line total,
   `onlineOrderId`, `onlineOrderRef`, each line's `deductFrom` = its routed
   location. `extraUpdates` puts the hold rows (null) and the order's
   `status/pack/fulfilState/fulfil` in the SAME atomic update as the sale. The sale
   path is create-only, so a retry with the same saleId can never write a second
   sale.
4. Stock deducts afterwards through the normal durable stock queue, each line at
   its `deductFrom` (movement ids carry the location).

The pack sale never raises a display check (`onClothingSale` skips a movement
whose sale has `channel: "online"`), never reaches a cash-up or card
reconciliation (tender `online`, till `online`), and returns through the normal
return flow, which credits the cell the ledger says each line came from.

## Attention and email

`attention.kind`: `unresolved`, `no_stock`, `not_found`, `walkin_override`,
`cancelled_after_pack`, `fulfil_failed`. The poller emails Junid
(junidmoh@gmail.com, the shop mailbox's SMTP — the card-recon path) once per
attention and stamps `attention.mailedAt`. Settings → Online orders lists every
`attentionOpen` order; Resolve sends bad lines back to `reroute` (or a failed
fulfil back to `pending`) and clears the attention.

## Escalation (owner spec 2026-10-21)

A line whose place cannot produce it — a shop's **Not found** on the Website
orders strip, a hub marking the line's hub order **Out of Stock** (the poller
already turns that into `no_stock` at that hub), or routing's `no_stock` —
climbs a fixed chain of the EXISTING request primitives instead of
stopping at "needs attention". Pure machine: `src/utils/onlineEscalation.js`;
IO: `scripts/shopify/onlineOrders/escalate.mjs`, run in the poll tick for every
open order before it is kept, and for packed orders that still have a resolving
line. Only while `/config/onlineOrders/enabled` is true and
`/config/onlineOrders/escalationOff` is not true (kill switch).

```
non-footwear, home = the shop it was routed to
  round 1: Hub 2 → shop (Shop Refill card)  →  Central → Hub 2 (refill row)
  round 2: the shop again, CHECK PROPERLY  →  Hub 2 → shop  →  Central → Hub 2
  → unavailable
non-footwear, home = Hub 2 (no shop had it)
  round 1: Central → Hub 2   round 2: Hub 2 CHECK PROPERLY → Central → Hub 2
footwear, home = the hub that rejected (no_stock: Hub 1)
  round 1: Central → hub
  round 2: Central sent but the hub rejected again → Central once more
           Central rejected → the hub once more, CHECK PROPERLY
  → unavailable
```

- **A request that is fulfilled** moved stock at once, but the box lands next
  morning: the line waits until **11:00 SAST the next working day (Mon–Sat)**
  and then goes back on the normal pick / display path at the place the stock
  was sent (fresh entry key, `routeGen` + 1). Handed → the escalation is done.
  Not found again → the next step.
- **Primitives.** Hub 2 → shop: a manual Shop Refill card at `/orders/R###-1`,
  the exact `placeRefillRequests` shape plus `onlineRef`, `onlineOrderKey`,
  `onlineLineIndex`, `onlineEscalationKey`; Hub 2 answers it on its Clothing
  tab (`clothingRefillStatus` available / rejected). Central → hub: a
  `/refill_requests/web_{orderId}_{i}_r{round}s{step}` row, the on-hold /
  Missing Sneakers shape with `createdFrom.via: "online_escalation"`,
  `earlyRelease` (pickable now) and `onlineRef`; Central answers it on its queue
  (fulfilled / Out of Stock). The refill scan never withdraws an
  `online_escalation` row as `already_in_stock` (refill-engine.cjs) — the
  dispute IS that the cell's count is wrong. A system withdrawal of any other
  kind counts as a rejection. Re-checks are a fresh display entry / fresh hub
  orders (`routeGen` + 1) with `checkProperly: true` — a red **CHECK PROPERLY —
  website order** banner on the Website orders strip, the display-check card
  and sheet, and the hub's Warehouse-queue order card.
- **The ref shows on every receiving feed**: Hub 2's Clothing card and
  Central's queue row carry a green **WEBSITE · {code}** badge; hub orders and
  the strip already show the code.
- **Restart-safe.** A raise writes its intent on the line
  (`escalation.pending`, deterministic `escKey`; a card's R-number is drawn
  once and kept in the intent), then create-if-absent at that key, then commits
  the transition. A crash anywhere re-runs from the intent and finds its own
  record. A recycled R-number held by another card is redrawn, never
  overwritten. Observations are re-read every tick; a repeated one is a no-op.
- **Holds** follow the line: a `resolving` line is held at the destination of
  its current request (`locs`), so the walk-in guard protects the units when
  they land. `unavailable` / `resolved` / `moved` lines hold nothing.
- **Attention.** The order's `not_found` / `no_stock` attention is cleared when
  the chain takes the line over — Junid is not emailed for a line that is
  being escalated. A hub's Out of Stock is turned into `no_stock` by the keep
  step itself, so escalation runs again right after it in the same tick,
  before the attention mailer.
- **After a partial pack** a line that comes good ships as a **follow-up order**
  `/online_orders/{orderId}f{i}` (ref `{code}-F{i+1}` — key-safe, it prefixes
  the follow-up's hub order keys; `followUpOf`, same
  `shopifyGid`, one line): its own hold, pick, pack sale and partial
  fulfilment. The parent line becomes `moved`; `followUps/{id}: true` on the
  parent. A Shopify cancellation cancels the follow-ups with the parent.

### Line fields

```
escalation: { chain: "other"|"footwear", home, round: 1|2, idx, phase,
              request?: { kind: "store_order"|"refill", key, from, to, at },
              pending?: { kind, key, escKey, from, to, at },
              waitUntil?, deliverAt?, checkProperly?, delivered?, centralRejected?,
              attempts: [{ location, action, result, key?, by?, at }] }
escalationOverride: { kind: "unavailable"|"resolved", by, at, appliedAt? }   ← Settings
```

`phase`: `raise` · `await` · `wait` · `deliver` · `unavailable` · `done` · `resolved`.

### `/online_escalations/{orderId}_{i}` (registry)

A mirror of every open escalation for Settings and for the tick (packed
orders are not in the status queries): `{ orderId, lineIndex, ref, title, size,
qty, phase, round, where, next, nextAt, updatedAt, agent? }`. Removed when the
line is found or resolved; an `unavailable` row stays until the customer agent
closes it.

## Partial pack

Pack enables when every line is In basket or PARKED. The pack sale carries only
the basket lines; `packedLines: { [i]: true }` on the order names them. Hold
rows are nulled only for pid/sizes no unpacked line still holds (the poller
re-syncs a packed order's resolving holds every tick anyway). Shopify: the
poller fulfils only the packed lines' Shopify line items
(`partialFulfil.mjs`): a baseline of units already fulfilled per line item is
recorded at `fulfil/baseline` before the first attempt, and each attempt
fulfils `baseline + packed − fulfilled-now`, so an ambiguous 5xx that applied
is never fulfilled twice, even when one Shopify line is split over a shipped
and a resolving app line. A pack that shipped every line fulfils the whole
order exactly as before.

## Out of scope (seam left)

Courier booking and waybills. `shipping.provider` is null and
`bookShipment(order)` (`scripts/shopify/onlineOrders/shipping.mjs`) returns
`{ skipped: true }`. Waybill numbers are handwritten; the Pack step has an
optional tracking-number field.

## Decisions taken without asking (2026-10-21 go-live)

- **No Shopify "fulfilment note" carries the code.** `FulfillmentInput` has no
  note field, and writing an order note or tag needs `write_orders`, which the
  app is not granted. The code reaches the customer as the Courier Guy
  customer reference; Shopify gets the waybill as the tracking number.
- **Uniqueness by registry, not index**: `/online_order_refs/{code}` is claimed
  in one transaction — atomic, exact path, never a scan.
- **Not found takes two taps** on the Display Checks strip: it is not undone by
  the next tap and it emails Junid.
- **Multi-unit hub orders** are keyed `KQZ-{line}`, `KQZ-{line}-{unit}`,
  `KQZ-{line}r{gen}` after a re-route, and `…-b` if a key is already held by
  someone else's record. Scanning any of these labels at the POS confirms like
  the bare code.
- **The TV never speaks a website order** (no customer at the counter), and
  **the Mac mini closes the hub orders** as collected after the Pack (a lettered
  key can never be rung at a till).
- **Remaining gap:** order edits made in Shopify after pull-in are not picked up.
- **Watch after go-live:** the TV's two code ranges also bracket any future
  lettered keys (Pine's `P001`, a Pine refill cart `RP001-…`); they are dropped
  client-side, so they cost a download. None exist today (census 2026-10-21:
  565 numeric, 2,531 `R###-…`).
