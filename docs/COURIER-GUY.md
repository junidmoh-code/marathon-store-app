# Courier Guy — what the account and the API actually are

Read on 2026-10-21 from Junid's logged-in portal (https://portal.thecourierguy.co.za)
and from the API documentation linked on its Integrations → API keys page.
Nothing here is assumed from Shiplogic knowledge — every endpoint below is
from TCG's own doc, and every limit marked **measured** came from live
`POST /rates` calls (rates book nothing).

**No shipment was booked while building this.** Booking stays behind
`/config/shipping/live`, which defaults false; nothing in this repo sets it
true. Only Junid flips it, after the box measurement step.

## The key

| | |
|---|---|
| Name in the portal | `marathon-pos` (Integrations → API keys, created 21 Oct 2026 by the account owner) |
| MacBook | `COURIER_GUY_API_KEY` in the git-ignored `.env` at the repo root (chmod 600) |
| Mac mini | `~/.config/marathon/courier.env` (chmod 600), `COURIER_GUY_API_KEY=…` |
| Loader | `scripts/shipping/env.mjs` — real env wins, then repo `.env`, then the mini file |

The value is never printed, committed or logged; `courier-client.mjs`
redacts it (and any `Bearer …`) from every `logs/courier.log` line. A key is
shown once by the portal; to rotate, create a new one there, replace it in
both files, delete the old one.

## The account

| | |
|---|---|
| Account name / code | The Marathon / **MARDRO** |
| Account id (API `account_id`) | **87207** |
| Type | **Prepaid** — every booking draws on the balance ("insufficient funds for the account" is a documented create error) |
| Invoicing | Daily |
| Account users | 1 (the account owner) — the API key acts as that user |
| Predominant delivery type | B2B (account setting) |
| Cost centres | none |
| Approvals setting | "Require approval for shipments created by account users" exists — **off**; not touched |

### Collection addresses (address book, 593 entries)

| Name | Address | Notes |
|---|---|---|
| **Bhoola Centre Shop Nr 9** | 72 Prince Edward Street, Durban Central, Durban, 4001, KZN | **account default** (also the billing address) |
| Marathon club | 340 Monty Naicker Road, Durban Central, Durban, 4001, KZN | used for door collections (e.g. T3494S) |
| Any locker | `collection_pickup_point_id: "CG0000"`, provider `tcg-locker` | how the staff "drop box" shipments are booked today |

### How staff ship today (last 2 weeks, 151 shipments)

* Most are **locker drop-offs**: collection "Any locker", service `L2D* - ECO`
  (locker → door) or `L2L* - ECO` (locker → locker), status `awaiting-dropoff`
  until a staff member puts the parcel in a TCG locker.
* Door collections from the shops use `ECOR`/`ECO` (out of town) or `LPF`
  (Durban local).
* Parcel presets in use: a custom packaging named **"Marathon club" 33×20×11 cm,
  1.5 kg**, and the locker preset **"Locker S" 60×41×8 cm, 5 kg**. Waybill
  numbers are handwritten on parcels.

## Service levels on this account

All prices incl. VAT, from live `/rates` on 21 Oct 2026. Parcel 35×25×13 cm, 1.5 kg.

| Code | Name | Durban (Overport 4067) | Cape Town (Century City 7441) |
|---|---|---|---|
| `LPF` | Local Priority Flyer | R 131.04 | — |
| `LPP` | Local Priority Parcel | R 150.70 | — |
| `LSF` | Local Same Day Flyer | R 156.96 | — |
| `LSP` | Local Same Day Parcel | R 156.96 | — |
| `ECO` | Economy | — | R 143.52 |
| `ECOR` | Economy Regional | (seen on Free State / rural deliveries) | — |
| `PRI` | Priority | — | R 309.23 |
| `SDX` | Same Day Express | R 1,223.40 | R 1,256.73 |
| `L2DXS - ECO` | Locker to Door Extra Small | needs ≤ 60×17×8 | R 86.90 (flat) |
| `L2DS - ECO` | Locker to Door Small | doesn't fit 13 cm | R 97.90 (flat) |
| `L2DM - ECO` | Locker to Door Medium | R 130.90 | R 130.90 (flat) |
| `L2DL - ECO` | Locker to Door Large | R 193.60 | R 193.60 (flat) |
| `L2L{XS,S,M,L} - ECO` | Locker to Locker | needs a `delivery_pickup_point_id` | e.g. L2LM R 79.00 |

Locker → door prices are flat by locker size, not by distance.
Surcharges seen on real waybills: **fuel surcharge** (20% on ECO/ECOR/LPF;
10% "Fuel surcharge - locker door" on L2D*), applied inside the quoted `rate`.

### Drop box (locker / kiosk / point)

TCG has three pickup-point types (`GET /pickup-points?type=`): `locker`
(e.g. CG185 Qualbert Centre), `counter` (TCG branches, e.g. K179 Durban CBD)
and `point` (partner shops, e.g. PP870210). In the API:

* **Drop-off at any locker** (what staff do today): `collection_pickup_point_id:
  "CG0000"` + `collection_pickup_point_provider: "tcg-locker"`, plus a normal
  `collection_address`. Do NOT send a `custom_tracking_reference` — TCG assigns one.
* Delivery to a locker: `delivery_pickup_point_id` (e.g. `CG933`).
* Pickup-point shipments carry **one parcel**, no opt-in rates, no declared value.

**Locker size envelope (measured — the doc does not state it):**

| Size | Fits up to (cm) | Weight | Evidence |
|---|---|---|---|
| XS | 60 × 17 × 8 | ≥ 1 kg ok (cap not found) | 60×17×8 offered XS; 25×20×8 was not |
| S | 60 × 41 × 8 | chargeable ≤ 5 kg | 60×41×8 @2 kg ok; @5.5 kg no S |
| M | 60 × 41 × 19 | ≤ 10 kg actual | @10 kg ok; @15 kg no M |
| L | 60 × 41 × 41 | ≤ 15 kg actual | @15 kg ok; @19 kg no locker rate at all |

Anything bigger or heavier gets no locker rate (`"rates": null`) → door collection.

### Webhook subscriptions (portal tab)

None subscribed (and none added by this build). Topics on offer:
Shipment note · Shipment tracking event · Parcel tracking event · Parcel
dimension changes · Shipment address changes · Shipment file uploaded ·
Invoice generated · Credit note generated. Auth options per subscription.

## The API (from the doc)

Doc: portal → Integrations → API keys → "API documentation" →
https://thecourierguy.co.za/api-docs/ which embeds https://www.shiplogic.com/tcg/api-docs
(its source is the Postman collection `/postman-collections/tcg.postman_collection.json`).

| | |
|---|---|
| Base URL | `https://api.portal.thecourierguy.co.za` (sandbox: `https://api.shiplogic.com`, separate sandbox account) |
| Auth header | `Authorization: Bearer <api key>` |
| JSON errors | some errors are plain text; prefix a path with `/v3` to get JSON errors |
| Rates | `POST /rates` — `collection_address`, `delivery_address`, `parcels[]` (`submitted_length_cm`, `submitted_width_cm`, `submitted_height_cm`, `submitted_weight_kg`); optional `declared_value`, `collection_min_date`, `delivery_min_date`, pickup-point ids |
| Opt-in rates | `POST /rates/opt-in` |
| Create shipment | `POST /shipments` — `collection_address`, `collection_contact`, `delivery_address`, `delivery_contact` (each contact needs email and/or mobile), `parcels`, and `service_level_code` **or** `service_level_id` (a rate's id expires after 5 min). `customer_reference` = our order ref; `customer_reference_name` labels it |
| Get shipments | `GET /shipments?tracking_reference=…` (also `id`, date filters, `status=[…]`) |
| Tracking | `GET /tracking/shipments?tracking_reference=…` |
| Cancel | `POST /shipments/cancel` `{"tracking_reference": "…"}` — charges reversed if not yet collected |
| Waybill PDF | `GET /shipments/label?id=<shipment id>` → signed S3 URL (24 h). Sticker: `/shipments/label/stickers?id=`. **Not used** — waybills stay handwritten |
| Pickup points | `GET /pickup-points?lat=&lng=&order_closest=true&type=locker\|counter\|point` |
| Rate limit | `429` when exceeded (no number published); AUP asks for no excessive automated calls |

### Volumetric divisor

**The doc does not state one.** Responses carry `actual_weight`,
`volumetric_weight` and `charged_weight` (= the max, rounded up to whole kg).
Measured with a 50×40×30 cm (60,000 cm³), 1 kg parcel:

| Service | `volumetric_weight` | Divisor |
|---|---|---|
| ECO, all locker services | 15 kg | **4000** |
| PRI, SDX, LPP, LPF, LSP, LSF | 12 kg | **5000** |

The estimator uses **4000** by default, with per-service overrides in
`/config/shipping`. **Confirmed 6 Nov 2026** from TCG's own re-rating of our
parcels (docs/courier-rate-audit.md): ECO and ECOR ÷4000 (TCG200369959T,
9DBT3G), LPF ÷5000 (RG9SJJ). 4000 is TCG's divisor for what we book, not a
safety margin.

## Where the code lives

| File | What |
|---|---|
| `scripts/shipping/env.mjs` | key loader (never prints) |
| `scripts/shipping/courier-client.mjs` | the thin client; 5xx retries on reads only, never on create/cancel |
| `scripts/shipping/smoke-rates.mjs` | the rates smoke (DBN + CPT) |
| `scripts/shipping/fixtures/` | recorded responses, prices kept, account ids redacted |
| `src/shipping/estimateParcel.js` | pure parcel estimator + default config |
| `scripts/shipping/bookShipment.mjs` | `bookShipment(order)` / `cancelShipment(order)` — dormant while live is false |
| `scripts/shipping/quote-runner.mjs` | Mac mini job that answers the Shipping card's quote requests (rates only) |
| `src/components/admin/ShippingCard.jsx` | the admin card at `#admin/shipping` |

## The Shipping card

Home screen → **Shipping** tile (owner only) → `#admin/shipping`.
Every number the estimator uses is editable there with an **unmeasured**
marker; tick "measured" once a number is real. The live switch is shown
disabled ("Enable after measurement"); nothing on the card books.

"Test an order" takes the order's three-letter code (KQZ — looked up through
`/online_order_refs/{code}`) or its /online_orders key (the Shopify order id). It reads that one order, shows the parcel, and "Get live quotes" asks
the Mac mini's quote runner for door + locker rates.

## Rules (not deployed by this build — paste into database.rules.json)

`/config` already grants read to every signed-in, non-anonymous user, and an
RTDB child rule cannot narrow a parent's read, so `/config/shipping` is
owner-only for **writes**; its contents (box sizes, collection address, the
live flag) are readable by staff like the rest of `/config`.

```json
"config": {
  "shipping": {
    ".write": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
    "live": { ".validate": "newData.isBoolean()" }
  }
},
"shipping_quotes": {
  ".read": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  ".write": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  "answers": { ".indexOn": ["answeredAt"] }
}
```

(`shipping` goes INSIDE the existing `"config"` block, next to `posCutover`.)

## Installing the quote runner on the Mac mini (after this is on main)

```sh
ssh marathonclub@100.64.186.78
cd ~/marathon-store-app && git pull --ff-only
cp scripts/shipping/com.marathon.shippingquotes.plist ~/Library/LaunchAgents/
mkdir -p logs && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.marathon.shippingquotes.plist
tail -f logs/courier.log     # "quote-runner listening"
```

It makes rates calls only. Its key comes from `~/.config/marathon/courier.env`.

## Going live (Junid only, after measuring)

1. Measure the boxes and the per-item weights on the Shipping card; tick each.
2. Fill in the collection contact (a mobile or an email) — live refuses without it.
3. Wire the seam (below) if not already done, and watch a few dry runs in
   `logs/courier.log` (`bookShipment … DRY RUN … would POST /shipments {…}`).
4. Set `/config/shipping/live` to the boolean `true` (Firebase console).
   Anything else — `"true"`, `1` — stays a dry run.

## Wiring into the website-order flow

`feat/online-orders` calls `bookShipment(order)` from
`scripts/shopify/onlineOrders/shipping.mjs` (a stub returning `{skipped:true}`).
The one-line change is that file's body becoming:

```js
export { bookShipment } from "../../shipping/bookShipment.mjs";
```

**Required with it:** `poll.mjs` shipOrder calls `bookShipment(order)` with the
record only, and the record does not contain its own key. bookShipment then
derives the key from `order.shopifyGid` (the ingester always writes it). If
that ever changes, the call must become `bookShipment({ ...order, key: id })`.
Without a key, bookShipment throws before any call; it never falls back to
the WEB- ref.

## Door-to-locker (Junid, 20 Nov 2026) — the default booking

Every Courier Guy booking is **door-to-locker** by default: collected from our
shop door, delivered to the Courier Guy locker nearest the customer's address.
When there is no locker for the parcel it is booked **door-to-door** instead
(Junid, 24 Nov 2026: "No locker → door-to-door" below). Code:
`scripts/shipping/lockerDelivery.mjs` (the plan), `bookShipment.mjs` (the
booking). Exchanges and second parcels follow the same rule outbound.

**The switch** (no deploy): `/config/shipping/deliveryMode`. Absent or
`"locker"` = door-to-locker. `"door"` = the old door-to-door booking, exactly
as before (the parcel rule below, the drop box, the box list). The Shipping
card does not edit it; set it in the database.

| What | Rule |
|---|---|
| How many | **One order is ONE parcel on ONE waybill** (Junid, 20 Nov 2026 evening). The first version booked one shipment per pair of shoes: #2256 (2 pairs) cost R260.62 on two waybills and #2309 (5 pairs) R651.55 on five; one parcel to the same locker is R192.72. Only a person splits an order: `shipping/lockerParcels` on the order (`rebook-locker.mjs --parcels`), N one-shoe shipments to the SAME locker. Above `locker/maxParcels` (10) a person books it. |
| The parcel | At most one pair of shoes in the order: declared as ONE SHOE, 34 x 23 x 13 cm, 1.5 kg (`/config/shipping/locker/parcel`), never estimated from the order's lines. Two or more pairs: declared as the one parcel the parcel rule packs the order in, so Courier Guy quotes a locker size it fits (measured 20 Nov: 2 to 6 pairs is D2LL - ECO, R192.72 flat). A parcel no locker takes goes door-to-door (24 Nov 2026, below); only one that fits no standard box either is not booked and a person decides. Courier Guy measures at collection and re-rates; see "The adjustment" under the reconciliation loop. |
| The locker | The address is placed on the map (OpenStreetMap: the street; when the map does not know the street, which is most of ours, the postal code's own point; failing that the suburb/town), then `GET /pickup-points` nearest first: online, listed, with a compartment a shoe fits. The nearest one Courier Guy prices wins (`locker/tryLockers`, 3). |
| How near | Within `locker/maxKm` (**30 km**) of the address; within `locker/maxTownKm` (**20 km**) when only the postal code or the town could be placed on the map (`deliveryLocker.placedBy` says which: "nearest" is then nearest to that point, not to the customer's door). Further: **door-to-door instead** (24 Nov 2026, below). An address that cannot be placed at all: **not booked**. |
| The service | The cheapest service Courier Guy quotes for that locker (`D2LM - ECO` for a shoe), `excludeServiceCodes` left out. |
| The ceiling | `/config/shipping/maxChargeRand` (R500), per shipment. |
| The phone | A customer with no mobile number is not booked (the locker PIN goes by SMS): "Packed, courier not booked" with that reason. |
| The request | The normal `/rates` and `/shipments` body with the customer's address kept as `delivery_address`, plus `delivery_pickup_point_id` and `delivery_pickup_point_provider`. |

**No locker → door-to-door (Junid, 24 Nov 2026, standing rule).** "If no
Courier Guy locker is near the customer (like #2411 Alistair, Jansenville: 'no
locker within 30 km'), book DOOR-TO-DOOR delivery to their address
automatically instead of failing. Never leave an order unbooked because
there's no locker." This reverses the 20 Nov rule ("no locker, no booking").
`planShipment` books the door-to-door plan (exactly what `deliveryMode: "door"`
books: the estimated parcel, the customer's address, the cheapest door
service) when the locker plan fails for one of these, and only these:

| `doorFallback.kind` | The locker plan's reason |
|---|---|
| `none_near` | "no Courier Guy locker within N km of <town> …" (30 km; 20 km when only the postal code or town was placed) |
| `too_big` | "the parcel is bigger or heavier than the largest Courier Guy locker box" (the door plan then needs a standard box to fit) |
| `none_priced` | "Courier Guy quoted no door-to-locker service to the lockers near <town>" (an answer, not a failed lookup) |

The same ceiling (`maxChargeRand`), cost alert (> R250 email), claim and live
switch apply; over the ceiling it is "Packed, courier not booked" with the
ceiling's own reason, and Junid's line says both. **Still refused exactly as
before:** an address that cannot be placed on the map, a locker a person named
(`lockerChoice`), ruled out (`lockerAvoid`) or split (`lockerParcels` > 1), a
half-booked split (never finished as door), more parcels than
`locker/maxParcels`, any API error or failed lookup, no customer mobile for a
locker that IS near and priced (door-to-door never needed the mobile). Switch (no deploy): `/config/shipping/locker/doorFallback:
false` = the 20 Nov refusal again.

On the order: `shipping/deliveryMode: "door"`, `shipping/doorFallback:
{ reason, kind, at }`, **no** `deliveryLocker`, no `waybills[]`, `priced.mode:
"door"`, `parcel.ruleVersion` set (a real estimate). Junid's line ("#2411:
booked door-to-door: no Courier Guy locker within 30 km of Jansenville … ECO
R185.00, waybill X.") is queued at `shipping_recon/junidLines/<key>-door` (its
own slot: an order refused under the old rule already used `<key>`; a
door-to-door try that was refused too goes to `<key>-door-refused`).

**Orders already refused for no locker** (`fulfilState: "courier_failed"`,
`shipping/booking/noLocker: true`): the poller's tick hands each back to the
ship step ONCE (`poll.mjs retryNoLockerOrders`, `bookShipment.mjs
doorRetryDue`: packed, the current `courierError` one of the three reasons
above, nothing booked, no claim held, nobody steering the locker), taking
`shipping/doorRetry { at, by, reason }` and the hand-back in ONE transaction on
the order (`claimDoorRetry`: re-checked on the order as it is then); nothing is
handed back while live is off, while `locker/doorFallback` is false (the one
try is kept), or while an exchange's `incoming/conditionHold` stands. A
`--commit` booking whose hand-back did not land is handed back by the next
tick (`doorHandBackDue`), never booked again. By hand, to see the prices first:
`node scripts/shipping/retry-no-locker.mjs` (dry run: each order and the door
rate quoted now) and `… --commit` (books through `bookShipment`, then hands
the order to the ship step for the Shopify fulfilment).

**Exchange returns** (`bookReturn.mjs`): with no locker for the return (none
near, too far, no locker rate quoted, a parcel no locker takes) the equivalent
is a courier COLLECTION from the customer's door, delivered to ours: the same
bodies without `collection_pickup_point_id`, the cheapest door service, the
same ceiling and one-booking claim, the customer's SA mobile required.
`returnShipping` then carries `mode: "door_collection"`, `collection { from:
"door", address, contactMobile }`, `doorFallback { reason, kind, at }`, no
`dropOffRef`, no `locker` (a locker booking: `mode: "locker_dropoff"`). It is
**off until `/config/shipping/returnDoorCollection` is `true`** (or
`book-return.mjs --door-collection`): Jimmy tells every customer "drop it at
The Courier Guy locker at …" and must read `mode` first.

**What is written on the order** (`/online_orders/<key>/shipping`):

| Node | What |
|---|---|
| `deliveryMode`, `doorFallback` | `"locker"`; or `"door"` with `doorFallback { reason, kind, at }` when there was no locker (then no `deliveryLocker`). |
| `deliveryLocker` | `{ id, provider, name, address, hours, description, km, placedBy: "street" \| "postcode" \| "town", smsTo, hasCollectionCode: false, collectionCodeNote }`: what Jamie tells the customer. |
| `waybill`, `waybills[]`, `shipments[]` | The first waybill (what every older reader uses), every waybill, and each shipment `{ shipmentId, waybill, trackingReference, service, cost, quoted }`. |
| `cost`, `priced.quoted` | Every shipment added up. `priced.mode` is `door_to_locker` for a locker booking (`door` after a no-locker door-to-door fallback). |
| `doorQuote` | `{ code, rate }`: what door-to-door would have cost for the parcel the old rule declared (one more `/rates` call; `locker/doorQuote: false` switches it off). |
| `parcel` | A locker booking: `{ declaredAs: "one_shoe", parcels: [...], estimated: [...] }`, no `ruleVersion` (a fixed declaration never teaches the parcel table). A door-to-door fallback: the parcel rule's estimate, with `ruleVersion`. |
| `partial` | Only while a split is half booked (a later parcel failed): the parcels already booked. The retry books only the rest, to the same locker. |

**There is no collection code at booking.** Courier Guy SMSes the PIN to the
customer's phone (`deliveryLocker.smsTo`) when the parcel lands in the locker;
the create response carries none (checked on #2257, waybill CC6LNK). The record
says so (`hasCollectionCode: false`); nothing invents one. A wrong phone on the
order means no PIN.

**Shopify** gets the first waybill as the tracking number; a split's other
waybills are on the order only.

### Rebooking to another locker (before collection)

```sh
node scripts/shipping/rebook-locker.mjs <orderKey>                  # DRY RUN: the nearest OTHER locker
node scripts/shipping/rebook-locker.mjs <orderKey> --locker <id>    # DRY RUN: that locker
node scripts/shipping/rebook-locker.mjs <orderKey> --parcels 2      # DRY RUN: as two one-shoe parcels
node scripts/shipping/rebook-locker.mjs <orderKey> --locker <id> --book   # do it (live must be on)
```

Checks at Courier Guy that every shipment is still uncollected, prices the new
locker first (nothing is cancelled if it cannot be booked), cancels, keeps the
old booking under `shipping/rebooks/<ms>`, and books again through
`bookShipment`, pinned to the locker it priced. One rebook at a time per order
(`shipping/rebooking`, a 10-minute lock). If the new booking fails after the
cancel it says so; running it again with `--book` books only (nothing more is
cancelled). `--parcels` is for a parcel Courier Guy refused as too big for
one locker parcel. It does NOT change the tracking number on the Shopify
order.

### First real booking

Order #2257 (Ventersdorp), booked by hand with this request on 20 Nov 2026:
`D2LM - ECO` R130.31 (`D2LL - ECO` R192.72) against `ECOR` R519.62 to the
door.

## An "unknown" booking, and Courier Guy failing to place an address (#2181, 21 Nov 2026)

#2181 (Khomanani, Limpopo 0933) sat "Packed, courier not booked" for an hour: the create came back
HTTP 500 "cannot find a latitude/longitude for the address", which bookShipment read as a lost answer
("unknown") and never retried. Worse, the locker it was for was in Cape Town: OpenStreetMap's only
"Khomanani" was a building in Khayelitsha, and the town fallback ignored the province.

- **Placing the customer.** Shopify's own point for the address (`shipping/geo`, written at ingest when
  Shopify validated it, and asked once before booking for older orders) comes first, used only while the
  address it was made for is unchanged (`geo.sig`). OpenStreetMap hits outside the order's province are
  never used, and the suburb/town tries take only a *place* (not "Khomanani Street"). An address nothing
  places is refused, never booked to a guess.
- **Lockers beyond ~25 km.** `GET /pickup-points` answers `pickup_points: null` beyond its own radius;
  with nothing found it is asked again with `max_distance` (km) out to the limit (50 km for a locker a
  person named).
- **Geocode 500 = definite refusal** (`isGeocodeRefusal`): never "unknown". A door-to-locker create is sent
  once more with the locker's own address and point as `delivery_address` (the customer stays the delivery
  contact; Courier Guy files a locker shipment under the locker's address anyway). The order records
  `shipping/deliveryAddressFallback: "locker"`.
- **"unknown" is checked at Courier Guy** (`scripts/shipping/unknownBooking.mjs`, from the orders tick before
  SHIP and from fast-ship every 5 minutes): `GET /shipments` from the day before the claim, every page
  (offset paging, oldest first — read against the live API), matched EXACTLY on `customer_reference`
  ("#2181", a split "#2181 (1/2)"; "#1941" never matches "#1941-EX") created after the claim minus 5 minutes,
  not cancelled. An answer that is not a shipments list, a repeated page or a page cap reached THROWS: "no
  answer" is never "no shipment".
  - Found → merged with the parcels already on `shipping/partial` (by shipment id) and attached like a
    booking; the claim carries the waybill first (crash-safe), the order goes back to pending so Shopify is
    fulfilled with it. A split with parcels still missing keeps the found ones as the checkpoint and books
    only the rest.
  - None after 10 minutes, live on → the claim is released in a transaction on that very claim and the order
    booked once more. The allowance is counted by bookShipment only when that re-book reaches a create
    (`courierBooking.rebooks`); a re-book refused (ceiling, no locker, live off) spends nothing.
  - Attention, never a guess: more shipments than the order needs (possibly booked twice), a claim written
    before this change (no shipment count on it), and — 30 minutes after every release — a late create that
    made a second shipment (`shipping_recon/unknownReleased`). Nobody is asked to check the portal.
- A door-to-door geocode 500 has no locker to fall back to: the claim is "failed" and the order shows
  "Packed, courier not booked" with the reason (no retry loop). In a split, the fallback is decided once:
  later parcels go straight to the locker's address. Shopify's point is checked against the order's
  province (OpenStreetMap reverse) before it is used.

## The parcel rule (Junid, 23 Oct 2026 — ONE parcel, never split)

An order ALWAYS ships as ONE parcel. The sneaker box is the unit of size —
34 × 23 × 13 cm outer (range 33–35 / 22–24 / 12–14, midpoint until measured;
editable on the Shipping card).

- 1 pair = one shoebox 34×23×13; 2 pairs = two stacked 34×23×26; 3 pairs
  34×23×39; 4 pairs 2×2 side by side 34×46×26 — of every stack / side-by-side
  grid the one with the SMALLEST LONGEST SIDE wins (ties → smaller volume).
- Soft goods (caps, tees, perfume …) are stuffed inside at no extra size until
  the fill budget is used (1.2 kg per pair, editable); past that, each overflow
  bundle (one per fill budget of weight) adds 3 cm to the height (editable). A
  bag or anything else that is neither rides on top the same way.
- No footwear: one flat box from the box list sized to the folded stack.
- Weight = everything in it. Chargeable = max(actual, volumetric) for that one
  parcel. Footwear weight keeps its size bands (1.2 / 1.3 / 1.4 kg).
- Door-to-door for every order (the drop box is off until locker costing rules
  exist; the one parcel may go to a locker only when it fits one).

The 21 Oct rule (N pairs = N shoebox parcels, a "combine pairs" switch) is
gone. `estimateSig` carries `ESTIMATE_RULE_VERSION`, so every open order's
estimate is rewritten on the poller's first tick after the rule changes.

The poller writes the estimate to `online_orders/{id}/shipping/estimate`; the
POS order card shows "Ships as 1 parcel — <dims>, <kg>" before Pack, and
bookShipment sends that one parcel.

## No padding (Junid, 6 Nov 2026) — docs/courier-rate-audit.md

TCG200369959T was declared 34×46×39 (five pairs in a 2 × 3 grid, the sixth
slot empty) and charged R355.68; TCG measured it and re-rated it R249.60.
Junid: stop over-declaring; book the real parcel at the cheapest service.
Since `ESTIMATE_RULE_VERSION` 4:

- a stack never declares an empty slot (5 pairs = 34×46×32.5);
- clothing with no footwear ships in the **flat courier bag** (`flatBag`,
  41×34 cm, as thick as the goods' `flatCm`, 8–18 cm); a box only beyond that;
- overflow on top of shoeboxes adds each item's own `flatCm`, never a 3 cm
  bundle (`shoebox.overflowBundleCm` is ignored);
- shoebox, pair weights and the garment thicknesses are marked measured
  (TCG's dimensioning of 178 of our parcels).

**Every quote is recorded** on the booking (`shipping.quotes`, door and
locker, cheapest first); the cheapest usable door service is booked, as before.

**The R300 ceiling** (`maxChargeRand`, 0 = off): a quote above it is not
booked; Junid gets ONE WhatsApp line with the cheaper option (a locker
drop-off when the parcel fits one), queued at
`/shipping_recon/junidLines/{orderId}_{rand}`.

## The reconciliation loop (scripts/shipping/reconcile.mjs)

**The adjustment (20 Nov 2026).** Every parcel is declared as one shoe, so what
Courier Guy bills after measuring can differ from what was booked. Once a
waybill is delivered and invoiced the pass writes
`/online_orders/<key>/shipping/adjustment = { booked, bookedFrom, billed, diff, pct,
declared [l,w,h,kg], measured [l,w,h,kg], chargedKg, waybills, at }` (booked =
what Courier Guy charged when the shipment was made, `shipping/cost`; diff =
billed minus booked, rand; a split's shipments added up, each in `parts`), on
EVERY reconciled order, and lists each one that is not zero at
`/shipping_recon/adjustments/<key>`. To see them:
`node scripts/shipping/courier-recon.mjs --adjustments` (read only). No screen
in the app shows it yet.

`scripts/shipping/courier-recon.mjs` on the Mac mini (launchd
`com.marathon.courierrecon`, every 3 h; `--dry` writes and sends nothing).
Reads only at TCG (`GET /shipments`).

- **Invoiced:** once a waybill is delivered and invoiced, TCG's final `rate`
  (= the net of its billing transactions) goes to
  `online_orders/{id}/shipping/invoiced` with the charged weight and TCG's
  measurement.
- **Diffs:** more than 5% off our quote → `/shipping_recon/diffs/{waybill}`.
- **Calibration:** each measured parcel is a sample
  (`/shipping_recon/samples/{class}`, measured ÷ declared volume). When the
  latest ≥3 of a class (`shoebox:1|2|3+`, `flatBag`, `box`) are all more than
  5% SMALLER, `/config/shipping/calibration/{class}.factor` is set to their
  median (≥0.75) and every open order is re-estimated. **Down only:** a class
  TCG keeps measuring bigger is recorded at `/shipping_recon/bigger/{class}`,
  never padded (Junid: no multiplier that inflates size).
- **Junid's lines** (over-ceiling, and the Monday weekly line: bookings, our
  quotes vs invoiced, overpaid) go through Jamie: marathon-dm-agent
  `bin/jimmy-send.mjs --kind junid`. A line Jamie refuses is retried next pass.

Install on the mini: `git pull --ff-only`, then
`cp scripts/shipping/com.marathon.courierrecon.plist ~/Library/LaunchAgents/ &&
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.marathon.courierrecon.plist`.
