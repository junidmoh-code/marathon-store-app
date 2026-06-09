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
| **`depletedAt`**  | **ISO string \| null**            | **no**   | **Phase 15. Product-level depletion flag. Absent/`null` = live & orderable. An ISO timestamp = depleted: blurred + un-orderable in the Store Assistant grid and listed in the Depleted Products tab. Set by `setDisplayRefillStatus` (inline atomic multi-path write); cleared by `clearProductDepleted` ("Bring Live"). WHOLE-product scope — depleted across every hub at once.** |
| **`depletedBy`**  | **string \| null**                | **no**   | **Phase 15. Hub label (`"hub1"`/`"hub2"`/`"hub3"`/`"hubC"`) that depleted the product. Anonymous auth has no email, so the hub is the meaningful signal (mirrors `displayRefilledBy` on orders). Cleared alongside `depletedAt`.** |

### Product depletion (Phase 15)

`depletedAt` is **whole-product** scope — one flag, depleted across every hub at
once. It is distinct from the order-scoped `displayRefillStatus: "stockDepleted"`
on `/orders/{orderId}` (which tracks a single partner-refill task and feeds
Insights). A product is depleted when the Warehouse resolves a Display Refill
task as **Stock Depleted**: `setDisplayRefillStatus` writes the order resolution
fields and `products/{id}/depletedAt`+`depletedBy` together in a single atomic
root-level multi-path `update()`, so the two can't diverge. The depleted state is only
ever cleared by an explicit **Bring Live** (`clearProductDepleted`) from the
Depleted Products tab — it is *not* auto-cleared when a later refill is marked
refilled or undone, so the state stays under explicit human control. Both
`warehouse` and `store_assistant` roles can view the Depleted Products tab and
reactivate products.

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

Marketing reads `/products` (documented above) plus `/insights_log` and
`/returns_log` through the shared Slow Movers engine. Those two log paths are
written by this app's order flow (`src/App.jsx`) and read by `functions/index.js`
but are not yet broken out as their own sections in this file. The only path
Marketing **writes** is `/marketing`.
