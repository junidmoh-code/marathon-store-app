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

The estimator uses **4000** by default (the services we mostly use, and the
safe side), with per-service overrides in `/config/shipping`.

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
