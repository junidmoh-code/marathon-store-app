# Realtime Database Schema (marathon-club)

This file is the authoritative map of RTDB paths the app touches. Any PR that
adds or renames a path under one of the documented roots MUST update this file
in the same commit. CI gates on this.

Project: **marathon-club** (europe-west1). The legacy `marathon-store` project
in us-central1 is DEAD — see CLAUDE/SESSION-NOTES.

---

## `/products/{productId}`

Each product is its own node. `productId` is generated client-side as
`"p" + Date.now()` at create time (see `addProduct` in `src/App.jsx`).

| Field             | Type                              | Required | Notes |
|-------------------|-----------------------------------|----------|-------|
| `id`              | string                            | yes      | Mirror of the node key. |
| `name`            | string                            | yes      | Display name. |
| `category`        | string                            | no       | Free-text label (e.g. "Sneakers", "Footwear"). |
| `productType`     | `"sneaker" \| "clothing"`         | yes      | Phase 12A. Drives size system, Hub 1 eligibility, and shoebox eligibility (clothing forces `hasShoeBoxOption` false). Also the admin Sneakers/Clothing list tabs filter on this. |
| `sizes`           | string[]                          | yes      | Sneakers: `"3".."11"`. Clothing: `"S".."XXXL"`. |
| `hubs`            | (`"hub1"`\|`"hub2"`\|`"hub3"`)[]   | yes      | Phase 14A. Clothing cannot include `hub1`. |
| `hub`             | string                            | legacy   | Pre-14A single-hub field. New writes double-write for back-compat. |
| `photo`           | string                            | no       | Legacy data-URL slot — superseded by `photoUrl`. |
| `photoUrl`        | string \| null                    | no       | HTTPS URL into Firebase Storage `products/{id}/photo.jpg`. |
| `stock`           | object \| undefined               | no       | Per-size stock counter, used by some clothing flows. |
| **`stockPrice`**  | **number (ZAR)**                  | **no**   | **POS Phase 2. Wholesale / B2B unit price. Optional — existing products without it remain valid.** |
| **`retailPrice`** | **number (ZAR)**                  | **no**   | **POS Phase 2. Walk-in / consumer unit price. Optional.** |
| **`hasShoeBoxOption`** | **boolean**                  | **no**   | **POS Phase 2. True for footwear that ships with a shoebox add-on. Optional; treat missing as false. ALWAYS false for `productType === "clothing"` — admin write paths force it off and consumers must treat clothing as false regardless of the stored value.** |
| **`barcode`**     | **string** (8-digit zero-padded)  | **no**   | **POS Phase 2 (scanner workflow). Auto-assigned at create time from `/products_meta/lastBarcode`. Format: `"00000001"`..`"99999999"`. Wider than `sku` to leave room for future per-(product, size) variants on the same counter.** |
| **`sku`**         | **string** (4-digit zero-padded)  | **no**   | **POS Phase 2 (scanner workflow). Auto-assigned at create time from `/products_meta/lastSku`. Format: `"0001"`..`"9999"`. Always per-product (no size variants).** |
| **`depletedAt`**  | **ISO string \| null**            | **no**   | **Phase 15 — RETIRED. Was a product-level depletion flag (blurred + un-orderable + Depleted Products tab). The blocking feature is gone: writers no longer set it and readers ignore it; any legacy value is inert. Products are always live & orderable. Safe to ignore / backfill-clear later.** |
| **`depletedBy`**  | **string \| null**                | **no**   | **Phase 15 — RETIRED (see `depletedAt`). Inert legacy field.** |

### Product depletion — RETIRED (was Phase 15)

The product-level depletion **blocking** feature (`depletedAt`/`depletedBy`
flagging a product blurred + un-orderable, the Depleted Products view + tile, and
the "Bring Live" reactivation) has been **removed**. Products are always live and
orderable in the Store Assistant grid.

What remains is the **order-scoped** signal, untouched: when the Warehouse
resolves a Display Refill task as **Stock Depleted**, `setDisplayRefillStatus`
writes `displayRefillStatus: "stockDepleted"` on `/orders/{orderId}` and appends
an `insights_log` entry with `action: "stock_depleted"`. That feeds the
**Insights → Stock Depleted** tab (the "internal insight" record). It no longer
touches the product. Legacy `depletedAt`/`depletedBy` values left on products from
the old feature are inert and have no effect.

### Validation invariants (enforced client-side)

- `name` and `sizes[]` are required to save a new product.
- `hubs[]` must contain at least one value.
- For `productType === "clothing"`, `hubs` may not contain `"hub1"`.
- For `productType === "clothing"`, `hasShoeBoxOption` is always `false`. The admin Add/Edit/bulk-edit surfaces hide the shoebox control for clothing and force the stored value off.
- Price fields, when set, are positive numbers in ZAR (no currency code stored).
- `sku` is exactly 4 zero-padded decimal digits (`/^\d{4}$/`). `barcode` is exactly 8 zero-padded decimal digits (`/^\d{8}$/`). Both are reserved atomically via `runTransaction` on `/products_meta`, so the sequence is gap-free in the happy path. Network failures after reservation can leave a "burned" number (counter advanced but no product written) — gaps are acceptable.
- Manual entry of `sku` / `barcode` is **not** exposed in the admin UI. Both fields are read-only after creation to preserve the sequential invariant the POS scanner workflow depends on.

### Backwards compatibility

`stockPrice`, `retailPrice`, `hasShoeBoxOption`, `barcode`, and `sku` are pure
additions — all read sites must tolerate them being absent. Products that
pre-date the backfill have no `sku` / `barcode` until the one-time backfill
script (PR B) runs. The reader contract is:

```js
const stock   = typeof p.stockPrice  === "number" ? p.stockPrice  : null;
const retail  = typeof p.retailPrice === "number" ? p.retailPrice : null;
const hasBox  = (p.productType !== "clothing") && p.hasShoeBoxOption === true; // clothing never has a shoebox
const barcode = typeof p.barcode === "string" && p.barcode.trim().length > 0 ? p.barcode.trim() : null;
const sku     = typeof p.sku     === "string" && p.sku.trim().length     > 0 ? p.sku.trim()     : null;
```

---

## `/products_meta`

Holds the SKU and barcode counters that back the product-creation auto-assignment.
Single node, two integer fields — wrapped in a `runTransaction` so two concurrent
add-product calls can't collide on the same number.

| Field         | Type             | Notes |
|---------------|------------------|-------|
| `lastSku`     | number (integer) | Last assigned SKU value. Range `1`..`9999`. Absent or non-numeric is treated as `0`. |
| `lastBarcode` | number (integer) | Last assigned barcode value. Range `1`..`99999999`. Absent or non-numeric is treated as `0`. |

**Lifecycle:** Both counters start at `0` (or whatever the backfill script lands at). Each new product *reserves* the next values by reading and incrementing both counters in a single `runTransaction` on `/products_meta`. The reservation transaction serializes cleanly across concurrent adds. The new product node is then written to `/products/{id}` in a **separate follow-up write** (not inside the transaction handler). If that follow-up write fails, the reserved pair is "burned" — the counter has advanced but no product exists at that number. We do **not** roll back the counter on failure: decrementing after another writer has already incremented would silently reassign their reservation. Gaps in the sequence are acceptable.

**Today** the two counters advance in lockstep (product 0001 → barcode 00000001, product 0002 → barcode 00000002, …). **Future per-(product, size) barcode expansion** will advance `lastBarcode` once per size variant while `lastSku` continues to advance once per product, so the two values drift apart over time — that's why `barcode` has 10000× the address space of `sku`. The schema accommodates that today; no further migration needed when the size-variant work lands.

**Overflow:** If `lastSku` would exceed `9999` or `lastBarcode` would exceed `99999999`, the reservation transaction aborts and `addProduct` surfaces a "counter exhausted" error to the admin. SKU runs out first (current product count is ~1026, ~9× runway remaining).

---

## `/orders/{orderId}`

One node per order, keyed by a daily 3-digit counter (`/orderCounter`). The full
order shape is large; documented here are the **routing / store fields** relevant
to clothing + Hub C ordering (other fields: customer info, status lifecycle,
display-partner + clothing-refill resolution fields — see `placeOrders` /
`placeRefillRequests` / `WarehouseView` in `src/App.jsx`).

| Field         | Type                                         | Notes |
|---------------|----------------------------------------------|-------|
| `productType` | `"sneaker" \| "clothing"`                    | Set explicitly on write. Clothing customer orders and clothing refills both carry `"clothing"`. |
| `hub`         | `"hub1" \| "hub2" \| "hub3" \| "hubC"`        | Legacy fulfilment-hub field. Double-written with `placedAtHub`. |
| `placedAtHub` | `"hub1" \| "hub2" \| "hub3" \| "hubC"`        | Source-of-truth fulfilment hub. `WarehouseView` filters hub3 + **hubC** by this field; hub1/hub2 by `hub`. |
| `placedStore` | `"central" \| "pine"`                         | The operational store the order was placed from. Usually implied by the hub, but **clothing customer orders all route to `hubC`**, so the store is persisted explicitly for tracking. |
| `intent`      | (cart-line only, not persisted)              | Assistant cart lines tag clothing as `"customer"` vs `"refill"` to pick the Checkout vs refill path; not written to the order. |

**Hub C (trial):** clothing ordered *for a customer* routes to the `hubC`
destination regardless of store or the product's `hubs`. The Hub C warehouse view
(Order Queue only) fulfils these. Clothing *refills* keep the existing
`central → hub2` / `pine → hub3` routing.

---

## `/insights_log`

Append-only event log, keyed by Firebase push id (chronological). Written by
`logInsight` in `src/App.jsx` at each order-lifecycle transition; read by the
Insights tabs (in-app) and by `functions/index.js` / the Slow Movers engine for
historical analytics. **Entries are never updated or deleted** — `/orders/{id}`
is ephemeral (daily `orderCounter` wraps and overwrites), so this log is the only
durable record of past-day activity.

| Field             | Type                                                                          | Notes |
|-------------------|-------------------------------------------------------------------------------|-------|
| `timestamp`       | ISO string                                                                    | When the event fired. Primary sort key. |
| `productId`       | string \| null \| **absent**                                                  | The durable `p{timestamp}` product key (see `/products`). **Added 2026-06-10**; **absent** on the ~18.6k events written before. New events always include the key, but its value is `null` when written against a legacy order/batch that itself predates `productId` (the `?? null` keeps the field present rather than letting RTDB drop an `undefined`). Prefer it for joins; fall back to `productName` when absent **or null**. |
| `productName`     | string                                                                        | Product name at event time. The legacy join key — name-matching only resolves ~55–66% of events, which is why `productId` was added. |
| `productCategory` | string                                                                        | May be empty (clothing refills write `""`). |
| `productType`     | `"sneaker" \| "clothing"`                                                     | |
| `size`            | string                                                                        | |
| `customerName`    | string                                                                        | `"Shop Refill"` for clothing/shop refills. |
| `customerPhone`   | string \| null                                                                | `null` for refills. |
| `orderNumber`     | string                                                                        | The daily 3-digit order id (`/orders` key); **not globally unique** — dedupe with a composite `${SA-date}::${orderNumber}` key. |
| `action`          | `"placed" \| "ready" \| "out_of_stock" \| "tomorrow" \| "collected" \| "stock_depleted"` | The lifecycle transition. |
| `placedAtHub`     | `"hub1" \| "hub2" \| "hub3" \| "hubC"`                                        | Fulfilment hub. |
| `displayRefilledBy` | string                                                                       | `stock_depleted` events only — the resolving hub label. |

> **`productId` is the join key going forward.** Every new event carries the
> field (string id, or `null` for a legacy order/batch). Consumers should prefer
> it and only name-match events where it is absent or `null` — this keeps
> attribution backward-compatible while lifting coverage to ~100% for new data.
>
> **Consumer wiring is a follow-up.** As of this change the *writers* emit
> `productId`; the readers (in-app Insights tabs and `functions/index.js`
> aggregation) still join by `productName`. Switching them to the prefer-id /
> fall-back-to-name lookup is tracked separately — there is no rush, since the
> id only helps events written after 2026-06-10 (a small slice until new data
> accumulates).

---

## `/users/{uid}`

One node per staff account, keyed by Firebase Auth UID. Written by the
super-admin User Management UI (`src/components/UserManagement.jsx`) and the
`createStaffUser` Cloud Function. Read by `AuthGate` into `PermissionsContext`.

| Field         | Type                       | Required | Notes |
|---------------|----------------------------|----------|-------|
| `displayName` | string                     | yes      | Shown in staff lists. |
| `username`    | string                     | yes      | Lowercase handle; maps to `{username}@marathon.internal` auth email. |
| `role`        | `"admin" \| "store_assistant" \| "warehouse"` | yes | Drives default permission set. |
| `permissions` | string[]                   | yes      | Editable permission flags (see `ALL_PERMISSIONS`). |
| **`storeIds`** | **(`"central"` \| `"pine"`)[]** | **no** | **Phase 15. Stores this user may place orders against. See semantics below.** |

### `storeIds` semantics (Phase 15)

Per-user store assignment for the order placement flow. Resolved by
`effectiveStoreIds` in `src/utils/stores.js`:

- **Field absent (legacy users)** → all-access. No big-bang migration; existing
  behavior is preserved and the admin narrows each user as needed.
- **Field present, non-empty** → user only sees/selects those stores in the order
  flow. One store → auto-selected, picker hidden. Two → both shown.
- **Field present, empty `[]`** → **no store access**; the order surface blocks
  with a "No store assigned" screen. The admin UI flags this with a warning
  indicator when the user is an order-taker (`shouldWarnNoStore`).
- **Super-admin (`gunidmoh@gmail.com`)** → bypasses; always sees all stores.

The two `storeIds` values map to the existing Central/Pine `storeMode` toggle in
`AssistantView` (`central` → hub1/hub2 routing, `pine` → hub3).

> **Separate from POS.** This is distinct from marathon-pos-app's
> `/users/{uid}/posAccess.storeIds`. Each app tracks its own store scope; do not
> conflate the two.

---

# STOCK / INVENTORY

> Per-size, per-location inventory on a ledger. **`/stock_movements` is the
> append-only source of truth; `/stock` cells are a re-derivable cache.** The
> ONLY writer to `/stock` is `applyMovement`
> (`src/components/stock/applyMovement.js`) — never raw writes. Full design:
> `design/INVENTORY-DESIGN.md`. Write authorization is keyed on
> **`/users/{uid}/stockRole`** (below), NOT the app `role`.

## `/locations/{locationId}` — canonical location registry

Closed set of places stock can physically be. Seeded from `DEFAULT_LOCATIONS`
(`src/components/stock/locations.js`); `useLocations()` reads it live and falls
back to the seed. Write: `stockRole === "admin"` only.

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | mirror of key |
| `label` | string | display name — `warehouse1` is **"Warehouse One"**, `hub2b` "Hub 2B", `marathon-pe` "Marathon PE" |
| `kind` | `"warehouse" \| "store" \| "transit"` | |
| `sellable` | boolean | POS may ring a sale here |
| `active` | boolean | |

Registry: `warehouse1` (top-of-chain receiving), `hub1`, `hub2`, `hub2b`, `hub3`,
`hubC`, `marathon-pe`, `marathon-pine`, `trophy`, `in_transit`.

## `/stock/{locationId}/{productId}/{size}` — balance cell

| Field | Type | Notes |
|-------|------|-------|
| `qty` | number (int) | on-hand; **only a `sold` decrement may go negative** |
| `v` | number | monotonic version (optimistic concurrency guard) |
| `mv` | string | id of the last movement that touched the cell |
| `lastType` | string | last movement type |
| `state` | `"untracked" \| "counting" \| "live"` | rollout gate |
| `updatedAt` / `updatedBy` | ISO / uid | |

Written **only** by `applyMovement`, paired with the ledger entry in one atomic
version-guarded `update()`. Fully re-derivable from `/stock_movements`.

## `/stock_movements/{movementId}` — APPEND-ONLY ledger

Create-only, immutable; `movementId` is the idempotency key. `actor` must equal
`auth.uid`; `productId` must exist in `/products`; `from`/`to` must exist in
`/locations`.

| Field | Type | Notes |
|-------|------|-------|
| `type` | `received \| sold \| return \| adjustment \| transfer_out \| transfer_in` | |
| `productId` / `size` / `qty` | string / string / number (>0) | |
| `from` / `to` | locationId \| null | |
| `actor` / `actorRole` | uid / string | |
| `ts` / `appliedAt` | ISO | real event time / when it hit RTDB |
| `reason` / `link` | string / object | `link = {orderId,transferId,refillId,saleId,deviceId}` |

Cell effects: `received +to`, `sold −from`, `return +to`, `adjustment ±`,
`transfer_out`/`transfer_in` `−from,+to`. **Write authz by `stockRole`:**
`received → warehouse|admin`; `transfer_* → warehouse|store|admin`;
`sold|return → pos|store|admin`; `adjustment → admin`.

### Receiving via the product-add form (rework)
Opening stock is entered in the **admin product-add form** — an optional,
collapsible per-size section, collapsed by default (collapsed = form unchanged).
On save, entered quantities post as `received` movements into **`warehouse1`**.
**Quantities are never required.** The receive requires the actor's `stockRole`
to permit `received` (`warehouse|admin`); if not, the product still saves and the
receive soft-warns. **The same optional per-size receive is also on the product
EDIT page** (`AdminProductDetail`) as its own action, so re-orders for existing
products post `received → warehouse1` too. The standalone Receive screen is
retired.

### One-step transfer (rework)
A transfer is now a **single atomic `transfer_out`** movement carrying a real
`from` + real `to` (no `in_transit` hop, no dispatch→confirm-receive ceremony).
Totals still conserve via the paired `−from/+to`. **Conscious tradeoff: transit
visibility is dropped** — goods in motion show as already at the destination.
`transfer_in`, the `in_transit` location, and `/transfers` docs remain valid in
the schema but are **unused by the reworked one-step flow**. A transfer that
carries a `refillId` still closes its `/refill_requests/{id}` on success.

## `/transfers`, `/refill_requests`, `/stock_alerts`
Per `design/INVENTORY-DESIGN.md`. `/transfers` (dispatch/receive docs) is now
optional — the one-step flow doesn't write it. `/refill_requests/{id}` (Source
chain) is closed (`status:"fulfilled"`) when a transfer fulfils it.
`/stock_alerts` holds reconciler/accuracy alerts.

## `/users/{uid}/stockRole`
`"admin" | "warehouse" | "store" | "pos"` (absent = **no** stock-write access).
Distinct from the app `role`. Assigned in the super-admin **User Management →
Stock Role** control. The super-admin signs in with Google and has **no `/users`
record by default**, so stock writes would be denied — User Management shows a
one-tap **self-grant** banner that materializes a minimal record with
`stockRole:"admin"`.

---

# LAYBY CROSS-APP CONTRACT

> **POS app writes pulls/creation; this app (warehouse) writes
> receiving/sent/reject.** Field-level spec — the marathon-pos-app session
> implements it verbatim, this app reads/writes it verbatim. Neither side invents
> fields the other owns.
>
> **Identity.** A layby's single identity everywhere (contract fields, warehouse
> cards, TV strip, QR payload, search) is the **invoice number** (`invoiceNo`,
> existing `L-00045` format; migrated laybys keep their original old-POS invoice
> numbers, which may not match `L-NNNNN`). The node key is the stable `laybyId`.
> **There is no "LB number" field.**
>
> **Locations.** All location ids are the canonical `/locations` registry ids:
> hubs `hub1`/`hub2`/`hub2b`/`hub3`/`hubC`/`warehouse1`; stores `marathon-pe`/
> `marathon-pine`/`trophy` (see `src/components/stock/locations.js`). The POS side
> **translates its informal `pine`/`pe`/`trophy` vocabulary to these canonical
> ids before writing** `originStore`/`requestingStore`.
>
> **Money.** All amounts are integer **cents** (POS convention) — display as
> `R{(cents / 100).toFixed(2)}`.
>
> **Status lifecycle** (on `/laybys/{laybyId}.status`), happy path then off-ramps:
> `created → labelPrinted → inTransitToStorage → storedAtHub → pullRequested →
> sentToStore → collected`, plus `expired` and `rejected`. Writers per transition
> are marked below.
>
> **Rollout note.** At time of writing the POS writers are not yet committed and
> these paths still need `database.rules.json` entries (out of scope for the
> warehouse PR — `database.rules.json` is not touched here). Until both land, live
> reads return permission-denied and the warehouse queues render **empty**, by
> design (no crash).

## `/laybys/{laybyId}` — layby record + parcel storage state (SHARED)

One node per layby, keyed by the stable **`laybyId`**. `invoiceNo` is the display
identity. The physical parcel is stored at a hub until the customer pays it off
and a store requests it back.

**POS-written** (warehouse reads — every reader must tolerate the field absent):

| Field              | Type                              | Notes |
|--------------------|-----------------------------------|-------|
| `laybyId`          | string                            | Mirror of the node key (stable id). |
| `invoiceNo`        | string                            | **Invoice number** — the layby's identity everywhere (`L-00045`; migrated laybys keep their old-POS number). Shown **big** on the warehouse cards + TV strip; the QR/search key. |
| `saleId`           | string                            | FK → `/pos/sales/{saleId}` (the `type:'layby'` record). |
| `customerName`     | string                            | Display name. Layby UI is customer-centric, not product/size-centric. |
| `customerPhone`    | string \| null                    | |
| `itemCount`        | number                            | Total units in the parcel. |
| `balanceRemaining` | number (**cents**)                | Outstanding balance. Cents — divide by 100 for ZAR. |
| `dueDate`          | string `YYYY-MM-DD`               | Local layby due date (from the POS `layby` block). Drives the expired-layby REJECT path. |
| `createdAt`        | number (epoch ms) \| ISO string   | When the layby was created. |
| `createdBy`        | string \| null                    | POS cashier who created the layby (display name or uid). Shown in the exceptions list so a missing-in-transit parcel can be chased to its creator. |
| `originStore`      | canonical store id                | Store that created/dispatched the layby (`marathon-pe`/`marathon-pine`/`trophy`). POS translates its informal id before writing. |
| `storageHub`       | canonical hub id                  | Storage hub the parcel is routed to (`hub1`/`hub2`/`hub2b`/`hub3`). **Default `hub1`.** The warehouse filters its queues by this against the selected hub. |
| `scanDeadline`     | number (epoch ms) \| ISO string   | When a still-unreceived parcel becomes an **exception**. Set by POS at dispatch. |

**POS-written status transitions:** `created`, `labelPrinted`,
`inTransitToStorage` (at dispatch), `pullRequested` (when a store requests it),
`collected`, and `expired`.

**Warehouse-written** (this app):

| Field              | Type        | Notes |
|--------------------|-------------|-------|
| `status`           | lifecycle   | Warehouse sets `storedAtHub` (scan-receive), `sentToStore` (pull fulfilled), `rejected` (pull rejected). |
| `receivedAt`       | ISO string  | Stamped on scan-receive (→ `storedAtHub`). |
| `receivedBy`       | string      | Receiving hub id. Anonymous auth has no email, so the hub is the meaningful signal — mirrors `depletedBy`/`displayRefilledBy`. |
| `sentToStoreAt`    | ISO string  | Stamped when the parcel is pulled and sent (mirrors the pull's `sentAt`). |
| `rejectedAt`       | ISO string  | Stamped on pull reject. |
| `rejectionReason`  | string      | Mirror of the pull's reason on reject. |

**Exceptions** = `status === "inTransitToStorage"` **and** now is past
`scanDeadline` — the parcel left a store but was never scanned in, i.e.
potentially missing. The warehouse surfaces these prominently so they get found
the **same day**.

## `/laybyPulls/{pullId}` — store→warehouse pull requests (SHARED)

One node per pull request, keyed by Firebase push id. **POS-written** when a store
needs a stored layby parcel pulled back (customer paying off / collecting). The
warehouse writes only the resolution fields.

**POS-written** (warehouse reads — tolerate absence):

| Field              | Type                              | Notes |
|--------------------|-----------------------------------|-------|
| `pullId`           | string                            | Mirror of the node key. |
| `laybyId`          | string                            | FK → `/laybys/{laybyId}` (the stable id; used to flip the parcel's status on fulfilment/reject). |
| `invoiceNo`        | string                            | Invoice number — displayed **huge** so staff find the parcel on the shelf. |
| `saleId`           | string                            | FK → `/pos/sales/{saleId}`. |
| `customerName`     | string                            | |
| `customerPhone`    | string \| null                    | |
| `itemCount`        | number                            | |
| `balanceRemaining` | number (**cents**)                | |
| `dueDate`          | string `YYYY-MM-DD`               | Used to flag **expired** laybys (past due) for the REJECT path. |
| `requestingStore`  | canonical store id                | Store that wants the parcel (`marathon-pe`/`marathon-pine`/`trophy`). |
| `storageHub`       | canonical hub id                  | Hub holding the parcel (mirror of the layby's `storageHub`). Warehouse filters by this. Default `hub1`. |
| `requestedAt`      | number (epoch ms) \| ISO string   | When the pull was requested. |

**Warehouse-written** (this app):

| Field             | Type                                          | Notes |
|-------------------|-----------------------------------------------|-------|
| `status`          | `"pending" \| "sentToStore" \| "rejected"`    | POS writes `"pending"`. Warehouse → `"sentToStore"` (Sent) or `"rejected"`. |
| `sentAt`          | ISO string                                    | On Sent. |
| `sentBy`          | string                                        | Acting hub id, on Sent. |
| `rejectedAt`      | ISO string                                    | On Reject. |
| `rejectedBy`      | string                                        | Acting hub id, on Reject. |
| `rejectionReason` | string                                        | **Required** on reject; flows back to the POS so the store sees why (expired laybys past `dueDate`). |

On **Sent** the warehouse atomically also patches `/laybys/{laybyId}` →
`status: "sentToStore"` + `sentToStoreAt`. On **Reject** it atomically patches
`/laybys/{laybyId}` → `status: "rejected"` + `rejectedAt` + `rejectionReason`.
Pull and parcel state never diverge.

### QR payload (parcel label)

The parcel-label QR encodes JSON: `{ "v": 1, "laybyId": "...", "invoiceNo": "L-00045" }`.
The warehouse scanner matches on `laybyId` first, then `invoiceNo`; manual entry
accepts a typed invoice number. (`v` is the payload schema version for forward
compat.)

## `/laybyPullsBoard/{pullId}` — anon-safe TV projection (SHARED, follow-up)

> **Not yet implemented — separate follow-up PR (see `LAYBY-INTEGRATION-CHECKLIST.md`).**
> `/laybyPulls` is **non-anonymous read** because it carries `customerName` /
> `customerPhone`, which must never be anon-readable. But the hub TV strip runs
> under the anonymous `#tv` session, so it cannot read `/laybyPulls`. This board
> is the anon-safe projection the TV reads instead.

One node per pull request, **keyed by the same `pullId`** as `/laybyPulls/{pullId}`.
Written **atomically by the same writers** that maintain `/laybyPulls` (the POS
creates/updates both in one multi-path write; the warehouse Sent/Reject updates
both). Carries **only** non-PII display fields:

| Field       | Type                                        | Notes |
|-------------|---------------------------------------------|-------|
| `invoiceNo` | string                                      | The invoice number shown on the TV strip. |
| `status`    | `"pending" \| "sentToStore" \| "rejected"`  | TV shows `pending` only. Mirrors the pull's status. |

**No customer name, phone, balance, or any other field** — that is the whole
point, and the rules enforce it: `.read: auth != null` (anonymous allowed) on the
board only; `.write` non-anonymous; `.validate` restricts children to exactly
`invoiceNo` + `status` (any other field is rejected), so PII can never leak in.
The TV strip switches from `/laybyPulls` to `/laybyPullsBoard` when this lands.

---

## `/marketing/campaigns/{campaignId}`

> **Owned by marathon-ai, not this app.** The marathon-store-app PWA never reads
> or writes `/marketing`. It is written exclusively by the **Marathon AI**
> Marketing view (weekly advertising campaigns). The authoritative, field-level
> schema lives in **`marathon-ai/SCHEMA.md`** — this entry is a cross-reference
> so the RTDB map here stays complete.

One node per weekly advertising campaign, keyed `"c" + Date.now()` at confirm
time. Campaigns run **Wednesday → Wednesday** (SA-local). Each holds the
advertised 15–20 `picks` with a frozen `baseline` snapshot, a ~15-product
un-advertised `control` cohort for measurement, and a `results` field
(`null` until the campaign week elapses, then computed and cached by Marathon AI).

| Field         | Type                 | Notes |
|---------------|----------------------|-------|
| `campaignId`  | string               | Mirror of the node key (`"c{ms}"`). |
| `status`      | `"active"`           | Stored at write; displayed status is derived from dates + `results`. |
| `pickedAt`    | ISO string           | When the campaign was confirmed. |
| `weekStart` / `weekEnd` | `"YYYY-MM-DD"` | SA dates of the campaign's opening and closing Wednesdays (7 days apart). |
| `coveragePct` | number \| null       | Name-match coverage snapshot at pick time. |
| `picks`       | object[]             | Advertised products, each with `productId`, `name`, `photoUrl`, `productType`, `sizes[]`, `reason`, and a `baseline` snapshot. |
| `control`     | object[]             | Un-advertised comparison products (`productId`, `name`, `category`, `baseline`). |
| `results`     | object \| null       | Computed after `weekEnd` (lift vs baseline + control). See marathon-ai/SCHEMA.md. |

Marketing reads `/products` (documented above) plus `/insights_log` (documented
above) and `/returns_log` through the shared Slow Movers engine. Those log paths
are written by this app's order flow (`src/App.jsx`) and read by
`functions/index.js`; `/returns_log` is not yet broken out as its own section in
this file. The only path Marketing **writes** is `/marketing`.
