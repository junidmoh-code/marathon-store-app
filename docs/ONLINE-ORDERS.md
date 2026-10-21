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
| Staff-visible feeds (hub picks, display entries, walk-in guard) | `/config/onlineOrders/enabled` | absent = **off** |
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
            pick    → /online_picks/{orderId}_{i}                 (hub Warehouse queue)
            display → /displayChecks_active/{store}/online__{orderId}__{i}  (shop feed)
  hub "Handed over" / shop "Handed to packer"  → line source.status "handed"
  POS Online Orders tab (marathon-pe): basket by scan / tap → Pack
       └─ ONE atomic update: pos/sales/{saleId} (channel "online", tender "online")
          + every hold row for the order → null + order status "packed"
          + fulfilState "pending"
  orders-poll.mjs next tick: bookShipment(order) (→ {skipped:true}) then
       Shopify fulfillmentCreate (notifyCustomer true, tracking if typed)
       failure → fulfilState "failed", "Packed, Shopify not updated", Retry
```

## `/online_orders/{orderId}`

`orderId` is the Shopify order's numeric id (`legacyResourceId`), as a string.

| Field | Meaning |
|---|---|
| `ref` | `WEB-{order number}`; the prefix is `ONLINE_ORDER_PREFIX` (`src/utils/onlineOrders.js`) |
| `orderNumber`, `shopifyGid`, `shopifyName` | Shopify identity |
| `status` | `new` · `picking` · `ready` · `needs_attention` · `packed` · `cancelled` · `fulfilled_elsewhere` (indexed) |
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
| `fulfilState` | `pending` · `done` · `failed` (indexed) |
| `fulfil` | `{ state, attempts, error?, at?, trackingNumber? }` |
| `cancelledAfterPack` | true when Shopify cancelled an order already packed (left alone, flagged) |
| `overrides/{pushId}` | walk-in overrides: `{ by, byName, at, storeId, tillId, productId, size, loc }` |

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

`{ qty, ref, locs: { [locationId]: qty }, at }` — one row per order holding that
pid/size. The **count is the sum of the rows' `qty`**, so two writers never
contend on a counter, and a row is replaced (not incremented), so a re-run is
idempotent. `locs` names where the held units are routed (a `no_stock` unit
counts in `qty`, not in `locs`). Size keys use `stockSizeKey` (`5.5` → `5_5`,
one-size → `_`).

Rows exist for orders in `new`/`picking`/`ready`/`needs_attention`. They are
removed by the pack's atomic update and by cancellation.

Readers:

- **Reconciler** (`inventorySync.mjs`): pushes `on_hand = app − max(0, reserved − committed)`.
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

## Feeds (only while the switch is on)

- `/online_picks/{orderId}_{i}` — `{ kind: "online_pick", orderId, ref, lineIndex,
  locationId, locStatus: "hub1|open", productId, size, qty, title, photoUrl,
  instruction: "Give to Yasmin at Marathon PE", status: open|handed|cancelled, createdAt }`.
  Listed in the hub's Warehouse queue by `orderByChild("locStatus").equalTo("{hub}|open")`.
  "Handed over" is one tap: the pick and the order line flip to `handed` in one
  update. No transfer, no movement.
- `/displayChecks_active/{store}/online__{orderId}__{i}` — a display-check record
  with `kind: "online_pick"`, `ref`, `orderId`, `lineIndex`, `qty`, `instruction`.
  Verdicts "Handed to packer" (`handed`) and "Not found" (`not_found`) go through
  the existing `completeDisplayCheck` callable, which also flips the order line.

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

## Out of scope (seam left)

Courier booking and waybills. `shipping.provider` is null and
`bookShipment(order)` (`scripts/shopify/onlineOrders/shipping.mjs`) returns
`{ skipped: true }`. Waybill numbers are handwritten; the Pack step has an
optional tracking-number field.
