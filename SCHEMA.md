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
| **`barcode`**     | **string**                        | **no**   | **POS Phase 2 (scanner workflow). Physical scannable code — EAN-13, UPC, or custom in-house format. Free-text, not validated. Optional.** |
| **`sku`**         | **string**                        | **no**   | **POS Phase 2 (scanner workflow). Stock keeping unit for inventory cross-reference. Free-text. Optional.** |

### Validation invariants (enforced client-side)

- `name` and `sizes[]` are required to save a new product.
- `hubs[]` must contain at least one value.
- For `productType === "clothing"`, `hubs` may not contain `"hub1"`.
- Price fields, when set, are positive numbers in ZAR (no currency code stored).
- `barcode` and `sku`, when set, are non-empty trimmed strings. No format validation — empty/whitespace trimmed input is omitted on create and cleared (written as `null`) on edit.

### Backwards compatibility

`stockPrice`, `retailPrice`, `hasShoeBoxOption`, `barcode`, and `sku` are pure
additions — all read sites must tolerate them being absent. The reader contract
is:

```js
const stock   = typeof p.stockPrice  === "number" ? p.stockPrice  : null;
const retail  = typeof p.retailPrice === "number" ? p.retailPrice : null;
const hasBox  = p.hasShoeBoxOption === true;
const barcode = typeof p.barcode === "string" && p.barcode.length > 0 ? p.barcode : null;
const sku     = typeof p.sku     === "string" && p.sku.length     > 0 ? p.sku     : null;
```
