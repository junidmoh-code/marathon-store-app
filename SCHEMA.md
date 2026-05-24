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
| `productType`     | `"sneaker" \| "clothing"`         | yes      | Phase 12A. Drives size system + Hub 1 eligibility. |
| `sizes`           | string[]                          | yes      | Sneakers: `"3".."11"`. Clothing: `"S".."XXXL"`. |
| `hubs`            | (`"hub1"`\|`"hub2"`\|`"hub3"`)[]   | yes      | Phase 14A. Clothing cannot include `hub1`. |
| `hub`             | string                            | legacy   | Pre-14A single-hub field. New writes double-write for back-compat. |
| `photo`           | string                            | no       | Legacy data-URL slot — superseded by `photoUrl`. |
| `photoUrl`        | string \| null                    | no       | HTTPS URL into Firebase Storage `products/{id}/photo.jpg`. |
| `stock`           | object \| undefined               | no       | Per-size stock counter, used by some clothing flows. |
| **`stockPrice`**  | **number (ZAR)**                  | **no**   | **POS Phase 2. Wholesale / B2B unit price. Optional — existing products without it remain valid.** |
| **`retailPrice`** | **number (ZAR)**                  | **no**   | **POS Phase 2. Walk-in / consumer unit price. Optional.** |
| **`hasShoeBoxOption`** | **boolean**                  | **no**   | **POS Phase 2. True for footwear that ships with a shoebox add-on. Optional; treat missing as false.** |
| **`barcode`**     | **string** (8-digit zero-padded)  | **no**   | **POS Phase 2 (scanner workflow). Auto-assigned at create time from `/products_meta/lastBarcode`. Format: `"00000001"`..`"99999999"`. Wider than `sku` to leave room for future per-(product, size) variants on the same counter.** |
| **`sku`**         | **string** (4-digit zero-padded)  | **no**   | **POS Phase 2 (scanner workflow). Auto-assigned at create time from `/products_meta/lastSku`. Format: `"0001"`..`"9999"`. Always per-product (no size variants).** |

### Validation invariants (enforced client-side)

- `name` and `sizes[]` are required to save a new product.
- `hubs[]` must contain at least one value.
- For `productType === "clothing"`, `hubs` may not contain `"hub1"`.
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
const hasBox  = p.hasShoeBoxOption === true;
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

**Lifecycle:** Both counters start at `0` (or whatever the backfill script lands at). Each new product reads both, increments both by 1, formats them with `String(n).padStart(4|8, "0")`, and writes them to the new product node — all inside the same transaction handler so concurrent adds serialize cleanly.

**Today** the two counters advance in lockstep (product 0001 → barcode 00000001, product 0002 → barcode 00000002, …). **Future per-(product, size) barcode expansion** will advance `lastBarcode` once per size variant while `lastSku` continues to advance once per product, so the two values drift apart over time — that's why `barcode` has 10000× the address space of `sku`. The schema accommodates that today; no further migration needed when the size-variant work lands.

**Overflow:** If `lastSku` would exceed `9999` or `lastBarcode` would exceed `99999999`, the reservation transaction aborts and `addProduct` surfaces a "counter exhausted" error to the admin. SKU runs out first (current product count is ~1026, ~9× runway remaining).
