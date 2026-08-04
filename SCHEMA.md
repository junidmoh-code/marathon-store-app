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
| `gallery`         | string[]                          | no       | Extra-angle photo URLs kept from the AI photo studio (each a unique permanent Storage URL). `photoUrl` stays the primary/hero; `gallery` holds additional angles saved before a regenerate. Admin-managed; not yet shown customer-facing. |
| `photoUpdatedAt`  | number (epoch ms)                 | no       | When an admin last uploaded/replaced the product photo (Add Product form or edit-photo replace; stamped since 2026-07). AI-studio approvals do NOT stamp it — an approved re-shoot isn't a new upload. Missing on older products: readers fall back to the creation time encoded in the id (`"p" + Date.now()`; every id in the DB conforms). Drives the AI Photo Studio picker's "Recent" view. |
| `stock`           | object \| undefined               | no       | Per-size stock counter, used by some clothing flows. |
| **`stockPrice`**  | **number (ZAR)**                  | **no**   | **POS Phase 2. Wholesale / B2B unit price. Optional — existing products without it remain valid.** |
| **`retailPrice`** | **number (ZAR)**                  | **no**   | **POS Phase 2. Walk-in / consumer unit price. Optional.** |
| **`hasShoeBoxOption`** | **boolean**                  | **no**   | **POS Phase 2. True for footwear that ships with a shoebox add-on. Optional; treat missing as false. ALWAYS false for `productType === "clothing"` — admin write paths force it off and consumers must treat clothing as false regardless of the stored value.** |
| **`barcode`**     | **string** (8-digit zero-padded)  | **no**   | **POS Phase 2 (scanner workflow). Auto-assigned at create time from `/products_meta/lastBarcode`. Format: `"00000001"`..`"99999999"`. Wider than `sku` to leave room for future per-(product, size) variants on the same counter.** |
| **`sku`**         | **string** (4-digit zero-padded)  | **no**   | **POS Phase 2 (scanner workflow). Auto-assigned at create time from `/products_meta/lastSku`. Format: `"0001"`..`"9999"`. Always per-product (no size variants).** |
| **`barcodes`**    | **`{ [sizeKey]: "00000001" }`**   | **no**   | **Per-(product, size) barcode codes (the size-variant expansion the `barcode` field reserved space for). Each value is an 8-digit code reserved from the SAME `/products_meta/lastBarcode` counter the first time that product+size needs a label, then PERMANENT — reused on every reprint, never regenerated/overwritten. Key is the size run through the ONE canonical encoder (`barcodeSizeKey` → `encodeSizeKey`, shared with `/stock` and the POS: `"5.5"` → `"5_5"`, one-size/null → `"_"`); the raw size is preserved in `/barcodes/{code}`. Reserved/stored by `src/components/stock/barcodeStore.js#ensureBarcode`. Rendered as Code 128.** |
| **`styleCode`**   | **string**                        | **no**   | **Manufacturer style code off the inside-tongue label, in the human-readable form the brand prints (`"CT8527-016"`). Display only — never match on it.** |
| **`styleCodeNormalised`** | **string** (`[A-Z0-9]+`)  | **no**   | **THE identity key for sneaker intake: `styleCode` uppercased with every non-alphanumeric stripped (`"CT8527-016"` → `"CT8527016"`). All lookups, the `/sneaker_models` cache key and the duplicate check match on this and only this. Normalisation NEVER truncates — `CT8527-016` and `CT8527-700` are different products. Written by `normaliseStyleCode` (`src/utils/styleCode.js`, server twin `functions/lib/style-code.cjs`). **IMMUTABLE once set** — the live rules let only the super-admin change an existing value; a denial must be shown, never swallowed. Indexed (`.indexOn`) in the live rules.** |
| **`styleCodeSource`** | **`"cache"` \| `"api"` \| `"websearch"` \| `"manual"`** | **no** | **Rules-validated enum — where the suggested data came from. NOTE: a DIFFERENT enum from `/sneaker_models.source`, which has no `cache` member (a cached row records how it was *originally* obtained, not that it was served from cache).** |
| **`styleCodeFetchedAt`** | **number (epoch ms)**      | **no**   | **When the catalogue lookup ran.** |
| **`styleCodeConfirmedBy`** | **string \| null**      | **no**   | **uid of the human who pressed Confirm. Opaque uid only — never an email; `/products` is readable by every signed-in staff member.** |
| **`styleCodeLabelPhoto`** | **string (https URL)**    | **no**   | **The actual photo of the actual tongue label the code was read from — the evidence behind the identity. Stored at `products/_intake/{code}/{productId}.jpg`.** |
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

### Style code — the sneaker intake identity key

Sneakers arrive without boxes, so there is **no box barcode to scan**. What every
shoe does carry is the manufacturer style code on the inside-tongue label, so
that code is the identity key intake routes on.

**Normalisation is exactly two lossless operations** — uppercase, then drop every
character that is not `A–Z` or `0–9`:

```js
normaliseStyleCode("CT8527-016")  // "CT8527016"
normaliseStyleCode("ct8527 016")  // "CT8527016"  — same shoe, same key
normaliseStyleCode("CT8527-700")  // "CT8527700"  — DIFFERENT shoe, different key
```

**It never truncates and never substitutes characters.** `CT8527-016` and
`CT8527-700` share six characters and are two different products; any prefix
match, length cap, or `O`→`0` "correction" would merge them into one catalogue
record and one stock cell, and the damage would only surface weeks later as
unexplained stock drift. The gate is asserted in `src/utils/styleCode.test.js`
and `functions/test/style-code.test.cjs`.

Because the output is `[A-Z0-9]+` only, it is always a legal RTDB key.

**Accepted formats** (recognised shapes, used only to sanity-check a code a
vision model read off a label photo — manual entry is never shape-gated, and the
resolver rejects a code only when it finds nothing for it):

| Format | Example | Normalised |
|---|---|---|
| `nike-alpha-6-3` | `CT8527-016` | `CT8527016` |
| `numeric-6-3`    | `315122-111` | `315122111` |
| `puma-6-2`       | `380190-01`  | `38019001` |
| `new-balance`    | `ML574EVG`   | `ML574EVG` |
| `adidas-block`   | `IE3437`     | `IE3437` |

#### RTDB index

`/products` already carries `.indexOn: ["styleCodeNormalised"]` in the LIVE
rules, so `resolveStyleCode`'s
`products.orderByChild("styleCodeNormalised").equalTo(code)` query is indexed.
**RTDB rules are console-managed in this project — `database.rules.json` in this
repo is not the deployed source of truth and must not be edited.**

`styleCodeNormalised` is **IMMUTABLE once set**: the live rules permit only the
super-admin email to change an existing value. Any write path that could
re-stamp it must surface the permission denial as a **visible error**, never
swallow it — a silently-dropped identity change is how two shoes end up sharing
one record.

`styleCodeSource` on `/products` is an enum: `cache | api | websearch | manual`.
Note this is a **different** enum from `/sneaker_models.source`, which has no
`cache` member (a cached row records how it was originally obtained, not that it
came from the cache).

---

## `/sneaker_models/{NORMALISED_STYLE_CODE}` — the permanent resolve cache

Written **only** by `resolveStyleCode` (Cloud Function, admin SDK). One row per
style code, keyed on the **normalised** code. This is a cache with no expiry by
design: resolve a code once and never pay the vendor for it again, for the
lifetime of the business.

**The cache is load-bearing, not an optimisation.** The KicksDB quota is small,
so the external API is **never** called for a code that already has a row here.
Required fields (`styleCode`, `source`, `fetchedAt`) and the `source` enum are
enforced by the live rules; the node is create-once, and only an admin may
correct an existing row.

| Field | Type | Notes |
|---|---|---|
| `styleCode` | string | The vendor's own readable spelling (`"CT8527-016"`). The **key** stays the normalised form; vendor text never overwrites it. |
| `brand` | string \| null | e.g. `"Nike"`. |
| `model` | string \| null | e.g. `"Nike Dunk Low"`. |
| `colorwayName` | string \| null | e.g. `"Black White"`. |
| `productType` | string \| null | As the vendor reports it (`"sneakers"`, `"apparel"`). **INFORMATIONAL ONLY** — category is set from the intake entry point, never inferred from a code. Nike apparel uses the same style-code format as Nike footwear. |
| `imageUrl` | string \| null | Catalog photo. **Must begin with `https://`** or the rules reject the write — a vendor returning `http://` or a protocol-relative URL loses its image rather than taking the whole cache write down. Shown for confirm/reject; **never** written onto a product without a human decision. |
| `gtin` | string \| null | Variant GTIN/EAN when the catalog returns one. Unusable today (sneakers arrive without boxes, so there is nothing to scan), but a box-barcode lane later is free if we keep the number now and worthless if we discard it. |
| `source` | `"api"` \| `"websearch"` \| `"manual"` | **Rules-validated enum — the KIND of resolution, not the vendor's name.** KicksDB is an external catalog API, so it writes `"api"`; writing `"kicksdb"` is rejected at write time and looks like a silent no-op. Which vendor actually answered is carried on the resolve response and in `/style_code_misses`, not smuggled into a validated field. |
| `fetchedAt` | number (epoch ms) | When the external resolve happened. **Required** by the rules. |
| `raw` | string \| null | The vendor payload **JSON-stringified**, capped at 20 000 chars. Stored as a *string*, never an object: vendor payloads carry price maps keyed by size (`"10.5"`), and a `.` in an RTDB key is illegal and throws at write time. A string cannot contain an illegal key, so the hazard is designed out rather than validated around. |

**Resolution is a three-tier chain behind one signature** (`resolveStyleCode(code)`).
Callers never learn which tier answered, so tiers can be added, reordered or
swapped without touching a call site:

| Tier | Provider | Behaviour |
|---|---|---|
| 1 | `cache` | Reads this node. Free, instant. |
| 2 | `kicksdb` | `GET https://api.kicks.dev/v3/unified/products/{identifier}`, `Authorization: Bearer <KICKSDB_API_KEY>`. Key is a **Firebase secret read inside the function** — it never reaches the client, never enters git, and the client never calls the vendor directly. Skipped entirely when tier 1 has the code. |
| 3 | `web-search` | **Stub.** Always not-found. Wired and ordered now so adding it later touches one function and nothing else. |

A provider that returns `null` means "nothing here, try the next tier". A
provider that **throws** means "this tier is broken" — the error is recorded and
the chain continues, and the response distinguishes the two. A dead vendor must
never be reported to staff as "this shoe does not exist", which would send them
off to create a duplicate product.

**The anti-collapse guard:** external catalogs fuzzy-match. Ask for `CT8527-016`
and a catalog may return `CT8527-700` — same silhouette, wrong shoe. A vendor
record is accepted **only** if its own SKU normalises to the byte-identical key
we asked for. No prefix match, no similarity score.

---

## `/style_code_index/{NORMALISED_STYLE_CODE}` — the ownership claim

**THE authority on which product owns a style code.** Uniqueness here is
**claimed, never checked.**

| Field | Type | Notes |
|---|---|---|
| `productId` | string | **Required.** The product that owns this code. |
| `claimedAt` | number (epoch ms) | **Required.** |
| `claimedBy` | string | Optional, but when present the rules require it to equal `auth.uid`. |

**No other child keys are permitted.** Create-once for any user with a
`stockRole`; only a `stockRole` admin or the super-admin may overwrite.

### Why claim-first, and never check-then-write

A check ("does any product have this code?") followed by a write is a race with
a window: two staff scanning the same shoe on two tablets both read "no", both
create a product, and the catalogue now has two records for one shoe with stock
split across them. The rules close that window — the **second** create-once
write loses, deterministically.

So intake does this, in this order:

1. Mint the product id (`"p" + serverNowMs()`).
2. **Claim** `/style_code_index/{code}` create-once with that id.
3. Claim succeeded ⇒ create the product and stamp `styleCodeNormalised`.
4. Claim **failed** (key exists) ⇒ read its `productId`. A *different* product
   owns this code: write `/duplicate_candidates`, and route the operator to
   **add stock on the existing product**. Never create a second product.

The claim is made as late as possible — immediately before the product write —
so the window in which a claim can outlive a failed product write is as small as
it can be.

### The orphan case

Because the claim precedes the product write, a claim can survive a product
write that failed: `/style_code_index/{code}` names a `productId` that does not
exist. `resolveStyleCode` detects this and returns `claimOrphaned: true`. Intake
must **show** it rather than treat the code as taken — otherwise the code looks
owned and nothing owns it, and no one can proceed. Clearing an orphan requires
an admin (the node is create-once for staff).

`/products.styleCodeNormalised` is a *stamp*, not the authority. A scan of
`/products` still matters — it is how a collision between rows that never
claimed (catalogue rows predating this index, or a backfill) becomes visible —
but the index can only ever hold one claim, so ownership questions go to the
index and collision questions go to the scan. `resolveStyleCode` returns both.

---

## `/duplicate_candidates/{pairId}` — two products, one style code

Written by `resolveStyleCode` and by the intake claim path when a style code is
found on **more than one** `/products` record. One of them is mislabelled, or the
same shoe was added twice — either way it is a data problem a human has to look
at.

**This node is keyed by PAIR, not by code.** The live rules validate it as a pair
record; a row keyed by style code holding a `productIds` **array** is rejected at
write time and shows up in the UI as a silent no-op.

| Field | Type | Notes |
|---|---|---|
| `productIdA` | string | **Required.** The lower-sorted product id. |
| `productIdB` | string | **Required.** The other one. |
| `reason` | `"styleCodeCollision"` \| `"manual"` \| `"heuristic"` | **Required**, rules-validated enum. |
| `detectedAt` | number (epoch ms) | **Required.** |
| `status` | `"open"` \| `"merged"` \| `"dismissed"` | Rules-validated enum. A human closes it; nothing else does. |
| `detectedBy` | string \| null | uid of whoever ran the lookup that surfaced it. |
| `styleCodeNormalised` / `styleCode` | string | Context for the banner. |

`pairId` is **deterministic**: the two ids sorted and joined with `__`
(`"p1__p2"`). Re-detecting the same collision rewrites the same row instead of
piling up duplicates of the duplicate report. N products on one code become N-1
rows, each pairing the lowest-sorted id with one of the others.

**Nothing is ever merged.** No winner is picked, no record is deleted, no field
is rewritten. An automatic merge here would destroy stock history. The flag is a
note and a banner — that is all it is.

---

## `/style_code_ocr_cache/{sha256}` — label-OCR results, 90-day TTL

Written **only** by `readStyleCodeLabel` (Cloud Function, admin SDK). Keyed on a
**sha256 of the image bytes**, so a staff member who retakes the same photo — or
two people photographing the same label — never re-bills the OCR.

| Field | Type | Notes |
|---|---|---|
| `candidates` | string[] | The extracted **normalised style codes**, capped at 8. An empty array is a valid, useful answer: an unreadable photo must not re-bill on every retry either. |
| `source` | `"vision"` \| `"gemini"` | Which tier produced them. |
| `at` | number (epoch ms) | |
| `expiresAt` | number (epoch ms) | `at + 90 days`. |

### This node stores candidates ONLY — never the Vision payload

A full `DOCUMENT_TEXT_DETECTION` response is tens of kilobytes of per-symbol
bounding boxes. Multiplied by every photo taken in every shop, and re-downloaded
on every read, that is exactly the node shape that has already cost this project
real money in RTDB download bandwidth. `buildOcrCacheRecord` **constructs** the
row field by field rather than spreading anything into it, so a fat payload
cannot leak in by accident, and a test asserts one row stays under 200 bytes.

The client also downscales every label photo to **1024px** before upload, for the
same reason — see `src/utils/labelPhoto.js`.

### Cleanup is two mechanisms, not one

1. **Lazy expiry** — `readStyleCodeLabel` never serves a row past `expiresAt`; it
   simply re-reads and overwrites. This is what guarantees correctness.
2. **`reapStyleCodeOcrCache`** (scheduled, 03:00 SAST) — a photo taken once and
   never retaken is never re-read, so lazy expiry alone would leave its row
   forever. The sweep removes those.

The sweep is **bounded and cursored**: it walks the node in pages of 500 ordered
by key and remembers where it stopped in `_cursor` (a reserved child — every real
key is a 64-char sha256 hex digest, so an underscore-prefixed key can never
collide). Reading the whole node once a day would be the same bandwidth mistake
in a different costume. A row with no usable `expiresAt` is **left alone**:
deleting data we cannot reason about is worse than keeping a few stale rows.

---

## `/style_code_misses/{NORMALISED_STYLE_CODE}` — catalog coverage by brand

Written **only** by `resolveStyleCode` (Cloud Function, admin SDK) when every
tier comes back empty-handed. The KicksDB free tier is StockX-sourced, so it is
materially thinner on adidas, Puma and Reebok than on Jordan and Dunk. This node
exists so that gap can be **measured** per brand rather than guessed at — and so
the decision to pay for a tier, or to build the tier-3 web-search fallback, is
made against numbers.

| Field | Type | Notes |
|---|---|---|
| `styleCodeNormalised` / `styleCode` | string | The code that missed. |
| `brandFamily` | string | Brand implied by the code's **shape** (`"Nike/Jordan"`, `"adidas"`, `"New Balance"`, `"Puma"`, `"unknown"`). Observability only — shape NEVER decides what a product is. |
| `format` | string \| null | Which shape matched. |
| `misses` | number | Repeat misses of one code update this row rather than flooding the node. |
| `firstMissedAt` / `lastMissedAt` | number (epoch ms) | |
| `lastMissedBy` | string \| null | uid. |
| `lastErrors` | string \| null | JSON of any tier errors. **Non-null means an outage, not a coverage gap** — "the vendor was down" must never be counted as "the catalog lacks this shoe". |

---

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

**The two counters now drift apart by design.** Product creation still reserves both in lockstep; additionally, the **per-(product, size) barcode feature** advances `lastBarcode` once per size variant via `reserveNextBarcode` (`src/components/stock/barcodeStore.js`) — `lastSku` is untouched there. That's why `barcode` has 10000× the address space of `sku`. Same atomicity model: the number is reserved in a `runTransaction` on `/products_meta`; if the follow-up slot/index write is lost (or a concurrent printer already claimed the same product+size), the reserved number is "burned" — gaps are acceptable.

**Overflow:** If `lastSku` would exceed `9999` or `lastBarcode` would exceed `99999999`, the reservation transaction aborts and the caller surfaces a "counter exhausted" error. SKU runs out first (current product count is ~1026, ~9× runway remaining).

---

## `/barcodes/{code}` — barcode reverse index (POS scan-to-sell)

Maps a scanned barcode value back to the product+size it identifies. Written by
`barcodeStore.ensureBarcode` the first time a product+size barcode is reserved (the
inverse of `/products/{id}/barcodes/{sizeKey}`).

| Field | Type | Notes |
|-------|------|-------|
| `productId` | string | the `/products` key |
| `size` | string \| **absent** | the **raw** size (e.g. `"5.5"`, `"M"`) — not the encoded storage key. **OMITTED for one-size/unsized items** (NOT `null` — RTDB drops null children — and NOT `""`). The resolver reads a missing size as unsized: `barcode.size ?? null` → `null`, valid for a `sizes: []` product. |
| `at` | ISO string | when the code was first reserved |

`code` (the key) is the 8-digit value. **POS resolution:** scan → read
`/barcodes/{code}` → `{ productId, size? }` → sell + deduct the `/stock/{loc}/{pid}/{size}`
cell (a `sold` movement via `applyMovement`). The codes are opaque (sequential), so
this lookup — not parsing — is the resolution path. **The scan-to-sell lookup is a
separate POS build; this app writes the index so it will work.**

**Only per-size codes are indexed** — the product-level `barcode` field is NOT
written to `/barcodes`, so the POS build must not expect product-level codes to
resolve here.

**Rules:** create-only (`!data.exists()` → a code can never be re-pointed), write
gated on `stockRole` existing, readable by any authed non-anon user (so the POS can
resolve a scan), validated to require **`productId` + an existing product** with
`size` **optional** (a per-child `.validate` enforces a non-empty string only when
`size` IS present — so a sized record validates fully while an unsized record omits
it). The index write is **best-effort off the reserve path**: a failure costs only
POS resolvability (heals on the next ensure) and never blocks reserving/storing the
code or the label/preview workflow.

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
| `destShop`    | `"marathon-pe" \| "trophy" \| "marathon-pine"` | The physical **shop** the order is for (the assistant store toggle now picks a shop, not a universe). On dispatch (`markSentAndPrint`) this is the **TO** location of the recorded warehouse→shop `transfer_out`; `placedAtHub` is the **FROM**. Absent on legacy orders (pre-shop-toggle) — legacy pine orders infer `marathon-pine`, legacy central orders skip the transfer (shop unknown). |
| `intent`      | (cart-line only, not persisted)              | Assistant cart lines tag clothing as `"customer"` vs `"refill"` to pick the Checkout vs refill path; not written to the order. |
| `customerId`  | string \| null                                | Canonical `/customers` key (local `0…` phone digits) resolved at order time — the POS loads the customer directly instead of re-resolving by phone. `null` when resolution failed (see `customerPending`) or when the phone had no usable digits (then `customerPending` stays `false` — there is simply no customer to attach). **Absent** on refill orders (written by the separate refill path) and on orders written before this field was added 2026-07. |
| `customerCode` | string \| null                               | The customer's C-number (`C-1042`), claimed race-safely via the shared `/customers_meta/lastCode` counter (same transaction + format as the POS). `null` when resolution failed; absent on legacy orders. |
| `customerPending` | boolean                                   | `true` when customer resolution failed at order time (order still written — placement never blocks on identity); the POS falls back to its own phone-key lookup for these. `false` on success. |
| `displayRefillStatus` | `"stockDepleted" \| "refilled" \| null` | Display-partner refill resolution (Phase 9). `null` = active task; `"refilled"` = display replenished; `"stockDepleted"` = no inventory left. Written by `setDisplayRefillStatus`; the `stockDepleted` value is the **order-scoped depletion signal** that feeds Insights (`insights_log` `action:"stock_depleted"` + Insights → Stock Depleted tab). It is **order-scoped only** — it does NOT flag the product (product-level depletion blocking was retired; see `/products` `depletedAt`). |
| `displayRefillScheduledAt` | ISO string \| null | When the refill task was scheduled (starts the 15-min window). Set on the order's READY transition for a display-partner order; cleared when it leaves READY. |
| `displayRefillHub` | hub id \| null | Hub the refill task is routed to — the product's own hub (= `placedAtHub`). `null` when no task is active. |
| `displayRefilledAt` | ISO string \| null | When the display was marked refilled. |
| `displayRefillStockDepletedAt` | ISO string \| null | When the task was resolved Stock Depleted (the order-scoped depletion timestamp). |
| `displayRefilledBy` | string (hub label) \| null | Hub that resolved the refill task (anonymous auth has no email — hub is the signal). |

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
| `qty`             | number \| **absent**                                                          | Units on this event. Written on **clothing-refill `placed`** events (one refill line carries `qty>1`, unlike sneaker checkout which expands qty into one event per unit). **Absent** on events written before this field and on non-refill events — consumers fall back to `1` (e.g. the Insights Clothing Refills tab sums `qty ?? 1`). |
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

## `/insights/reorderPlan/{status,latest}`

Written by the `analyzeReorderNeeds` Cloud Function (`functions/index.js`); read
by the marathon-ai dashboard (`src/Dashboard.jsx`). The UI fire-and-forgets the
callable (a run can exceed the 70 s callable client timeout) and renders from
these two nodes instead of awaiting the return value.

- **`/insights/reorderPlan/status`** — `{ state: "idle" | "running" | "error",
  startedAt, startedBy, completedAt? | erroredAt?, errorMessage? }`. The
  running-lock is acquired via an RTDB transaction (concurrent-run protection).
- **`/insights/reorderPlan/latest`** — `{ plan, meta, generatedAt, generatedBy,
  durationMs }`. `plan` = `{ summary, recommendations[], topSellers[],
  sleepers[], dataQualityNotes[] }`; each recommendation is
  `{ productId, productName, action: "reorder"|"review"|"skip"|"slow_mover",
  priority: "high"|"medium"|"low", suggestedQuantity: {size→qty}, totalSuggested,
  reasoning }`. `meta.source` is `"demand-engine"` (Phase 3 pure-reasoner path)
  or `"legacy-internal"` (fallback). Keys with `.`/`#`/`$`/`/`/`[`/`]` (e.g.
  sneaker size `"5.5"`) are sanitised to `_` at write time.

### `analyzeReorderNeeds` input contract — `request.data.demand` (Phase 3)

Since Phase 3 the function is a **pure reasoner**: TRUE DEMAND (sold +
out-of-stock, per product **and** per size) is computed client-side by
marathon-ai's shared demand engine (`src/lib/demand.js` → `computeDemand`),
slimmed by `buildReorderPayload` (`src/lib/reorderPayload.js`), and passed in
under `request.data.demand`. The function does **not** re-aggregate sales when it
is present.

| Field           | Type        | Notes |
|-----------------|-------------|-------|
| `schemaVersion` | number      | Must equal `REORDER_DEMAND_SCHEMA_VERSION` (currently `1`); other values fall back to the legacy path. Branch on it. |
| `window`        | string      | Demand window label (`"all"` \| `"30"` \| `"60"` …). |
| `windowDays`    | number\|null| `null` = all-time. |
| `recentDays`    | number      | Width of the recent slice for `recentSold`/`recentOos`. |
| `nowMs`         | number      | Client clock when computed (ms epoch). |
| `cycleDays`     | number      | Reorder horizon = span earliest-sale → now (the **real** catalog window, not a hardcoded 45). |
| `coverage`      | object      | Honest name-match report (`catalogTotal`, `coveragePct`, `matchedProducts`, `unmatchedEvents`, `nameCollisions`, `productIdOnEvents:false`, …). |
| `totals`        | object      | Attributable aggregate `{ sold, oos, placed, returns, trueDemand }` (`trueDemand = sold + oos`). |
| `rows[]`        | object[]    | **One entry per catalog product, UNCAPPED.** Each: `{ id, name, sold, oos, placed, trueDemand, velocityPerWeek, trueDemandPerWeek, recentSold, recentOos, bySize:{[size]:{sold,oos,placed,trueDemand}}, ageDays, sizes[], stores[], lastSaleDate, depleted, retailPrice }`. |

`bySize` keys are the size string exactly as it appears in `/insights_log`
(`"9"`, `"10"`, `"S"`); `suggestedQuantity[size]` is built from
`bySize[size].trueDemand` (OOS included), never from `sold` alone. The full
contract and reasoning live in `functions/lib/reorder-demand.cjs`. The function
still runs when `demand` is **absent** (cron / old client) via the legacy
internal-discovery fallback. Authoritative client-side spec:
`marathon-ai/docs/PHASE3-REORDER-FUNCTION-SPEC.md`.

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
| `label` | string | display name — e.g. `studio` "Studio", `marathon-pe` "Marathon PE", `marathon-pine` "Pine" |
| `kind` | `"warehouse" \| "store" \| "transit"` | |
| `sellable` | boolean | POS may ring a sale here |
| `active` | boolean | |

Registry (`DEFAULT_LOCATIONS`): receiving warehouses `studio`, `central`, `base`;
hubs `hub1`, `hub2`, `hub3`; shops `marathon-pe` ("Marathon PE"), `trophy`,
`marathon-pine` ("Pine"); plus `in_transit` (transfer backward-compat, excluded
from the entry/transfer-target pickers). `RECEIVING_DEFAULT = "studio"` is the
default for the inline product receive and the transfer source. Each location
holds its own per-size count — the same product+size can differ across locations.

## `/stock/{locationId}/{productId}/{size}` — balance cell

> **`{size}` is the ENCODED, dot-free size key** (`encodeSizeKey`, `src/utils/sizeKey.js`):
> `"."`, `"#"`, `"$"`, `"/"`, `"["`, `"]"` and whitespace → `"_"`, so a half-size
> shoe keys as `…/5_5` (RTDB rejects a `"."` in a key). This is the SAME encoding
> marathon-pos-app uses for `/inventory` (its `src/shared/sizeKey.js`, PR #36), so
> both apps key per-size stock identically. `applyMovement`/`setCellState` encode on
> write (via `stockCellPath`); `useStockCells` decodes back to the raw size on read,
> so callers index by the real size (`"5.5"`). The `/stock_movements` ledger keeps
> the RAW size (it's a value there, not a key).

| Field | Type | Notes |
|-------|------|-------|
| `qty` | number (int) | on-hand; **only a `sold` decrement may go negative** |
| `v` | number | monotonic version (optimistic concurrency guard) |
| `mv` | string | id of the last movement that touched the cell |
| `lastType` | string | last movement type |
| `state` | `"untracked" \| "counting" \| "live"` | rollout gate |
| `updatedAt` / `updatedBy` | ISO / uid | |

Written **only** from the `applyMovement` module — `applyMovement` itself (paired
with the ledger entry in one atomic version-guarded `update()`) and its sibling
`setCellState` (state-only flips, no qty change). Both build the cell key via
`stockCellPath` (encoded size). Fully re-derivable from `/stock_movements`.

## `/stock_movements/{movementId}` — APPEND-ONLY ledger

Create-only, immutable; `movementId` is the idempotency key. `actor` must equal
`auth.uid`; `productId` must exist in `/products`; `from`/`to` must exist in
`/locations`.

| Field | Type | Notes |
|-------|------|-------|
| `type` | `received \| opening \| sold \| return \| adjustment \| transfer_out \| transfer_in` | `opening` = one-time opening balance (additive, like `received`) |
| `productId` / `size` / `qty` | string / string / number (>0) | |
| `from` / `to` | locationId \| null | |
| `before` / `after` | `{ locationId: qty }` | old→new on-hand per affected cell (one loc for most movements; both cells for a transfer). Recorded by `applyMovement` from the same reads that compute the write, so the audit never disagrees with the cell. Absent on legacy entries written before this field. |
| `actor` / `actorRole` | uid / string | |
| `ts` / `appliedAt` | ISO | real event time / when it hit RTDB |
| `reason` / `link` | string / object | `link = {orderId,transferId,refillId,saleId,deviceId}` |

Cell effects: `received +to`, `opening +to`, `sold −from`, `return +to`,
`adjustment ±`, `transfer_out`/`transfer_in` `−from,+to`. **Write authz by
`stockRole`:** `received → warehouse|admin`; `opening → warehouse|admin`;
`transfer_* → warehouse|store|admin`; `sold|return → pos|store|admin`;
`adjustment → admin`.

### Receiving via the product-add form (rework)
Opening stock is entered in the **admin product-add form** — an optional,
collapsible per-size section, collapsed by default (collapsed = form unchanged).
On save, entered quantities post as `received` movements into **`warehouse1`**.
**Quantities are never required.** The receive requires the actor's `stockRole`
to permit `received` (`warehouse|admin`); if not, the product still saves and the
receive soft-warns. **The same optional per-size receive is also on the product
EDIT page** (`AdminProductDetail`) as its own action, so re-orders for existing
products post `received → RECEIVING_DEFAULT` too. The standalone Receive screen is
retired.

### Set Qty (admin, location-aware on-hand entry)
The **Set Qty** Stock tab (`src/components/stock/SetQuantity.jsx`, admin-only) is
the one screen for setting per-size on-hand: pick a product + **location**, see each
size's current count at that location, type the new count. It writes the single
`/stock/{loc}/{pid}/{size}` cell through `applyMovement` — same one writer and same
cell every other screen (Locator, Count, POS, barcode card) reads — so
entry/overview/detail can never disagree, and setting a count touches only the
chosen location (each location keeps its own number). A **chip selects the movement
type**: *Received* → `received`, *Opening balance* → `opening` (both additive — may
only raise a count; a decrease is refused with a prompt to use Correction),
*Stock-take* / *Correction* → `adjustment` (signed). The chip is the ledger reason
(plus an optional note); every write records delta + before/after old→new. This is
how stock is received (pick a receiving warehouse) and how one-time opening balances
are entered. NOTE: the `opening` type requires the rules deploy below.

**Inline barcode printing:** after a save, Set Qty offers a **Print barcodes** sheet
(`BarcodePrint.jsx`) for the saved sizes. Opening it ENSURES a permanent code per
size (`barcodeStore.ensureBarcode` — reserve-if-missing / reuse-if-present), previews
each as Code 128 (`BarcodeView.jsx` / pure `barcode.js`), and prints. Copy count
per size defaults to the **units just added** (positive delta) and is overridable.
Transport is a self-contained module (`printers/`): Phomemo M110 (Web Bluetooth,
proven) and Xprinter XP-350B (WebUSB/TSPL, **unproven — pending hardware test**); a
print failure is isolated and blocks nothing (codes are still reserved/stored/indexed
and the on-screen barcode is scannable).

### Dispatch transfer (warehouse → shop on "Mark as Sent")
When the warehouse marks an order **Sent** (`markSentAndPrint` → `recordDispatchTransfer`),
the app records a `transfer_out` from the order's source hub (`placedAtHub`) to the
order's destination shop (`destShop`), so each shop's on-hand is the running total of
its own recorded transfers. Properties:
- **FROM** = `order.placedAtHub` (`hub1`/`hub2`/`hub3`); **TO** = `order.destShop`
  (or `marathon-pine` for legacy pine orders). `hubC` (clothing-customer trials) and
  legacy central orders (shop unknown) are skipped.
- **Idempotent** via a date-scoped `movementId` (`disp_<id>_<createdAt>`) — re-taps
  collapse to one movement (`order.id` alone is the reused daily counter).
- **Non-blocking**: the send (status + label) always completes; an insufficient-hub-stock
  or write failure only raises a non-blocking toast (stock not deducted).
- Reuses `applyMovement` — no parallel write path.

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
> sentToStore → collected`, plus `expired`, `rejected`, and **`returned`**
> (cancelled → return-to-stock). Writers per transition are marked below.
>
> **Rollout note.** At time of writing the POS writers are not yet committed and
> these paths still need `database.rules.json` entries (out of scope for the
> warehouse PR — `database.rules.json` is not touched here). Until both land, live
> reads return permission-denied and the warehouse queues render **empty**, by
> design (no crash).
>
> **Rules to publish (separately, via console — NOT in this PR):** the
> `disposition` field is already permitted by the `/laybyPulls/$pullId`
> `"$other"` catch-all, so no rule change is strictly required for it. To enable
> the new statuses, two enum validates must be widened: `/laybys` `status` →
> add `returned`; `/laybyPulls` `status` → add `returnedToStock`. (Optional
> hardening: an explicit `disposition` enum validate.) These are published with
> the live rules, separate from this code PR.

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
`collected`, `expired`, and **`returned`** (set when the store **cancels** a
stored layby — the POS also creates a `return_to_stock` pull, below). The
warehouse's return-to-stock action resolves that pull but **does NOT** change
this `status` — it stays `returned`.

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
| `disposition`      | `"collect" \| "return_to_stock"`  | Why the parcel is being pulled. `collect` (or **absent** ⇒ collect, backward-compat) = customer collecting → the Sent/Reject path. `return_to_stock` = layby cancelled → the warehouse returns the units to stock (path below). |

**Warehouse-written** (this app):

| Field             | Type                                                            | Notes |
|-------------------|----------------------------------------------------------------|-------|
| `status`          | `"pending" \| "sentToStore" \| "rejected" \| "returnedToStock"` | POS writes `"pending"`. Warehouse → `"sentToStore"` (Sent), `"rejected"` (Reject), or `"returnedToStock"` (Return to stock). |
| `sentAt`          | ISO string                                                     | On Sent. |
| `sentBy`          | string                                                         | Acting hub id, on Sent. |
| `rejectedAt`      | ISO string                                                     | On Reject. |
| `rejectedBy`      | string                                                         | Acting hub id, on Reject. |
| `rejectionReason` | string                                                         | **Required** on reject; flows back to the POS so the store sees why (expired laybys past `dueDate`). |
| `returnedAt`      | ISO string                                                     | On Return to stock. |
| `returnedBy`      | string                                                         | Acting hub id, on Return to stock. |

On **Sent** the warehouse atomically also patches `/laybys/{laybyId}` →
`status: "sentToStore"` + `sentToStoreAt`. On **Reject** it atomically patches
`/laybys/{laybyId}` → `status: "rejected"` + `rejectedAt` + `rejectionReason`.
Pull and parcel state never diverge.

**Return to stock** (`disposition: "return_to_stock"`): the store cancelled the
layby. The warehouse pulls the parcel, removes the label, and returns the units to
stock, then resolves the **pull only** → `status: "returnedToStock"` +
`returnedAt`/`returnedBy`. **Unlike Sent/Reject, this does NOT touch
`/laybys`** — the POS already set `/laybys/{laybyId}.status = "returned"` on
cancellation, and it stays there. (The pull carries no per-size lines, so the
units are returned to sellable stock as a manual shelf step — nothing is posted to
the `/stock` ledger.) `disposition` absent or `"collect"` ⇒ the existing Sent/Reject
collect path, unchanged (backward-compatible).

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

## `/attention_lists/{listId}/items/{productId}`

> **Owned by this app** — written by the Attention workspace
> (`src/components/stock/AttentionView.jsx`). This is the ONLY path Attention
> writes; everything else that screen shows (`/products`, `/stock`,
> `/stock_movements`) it reads.

Two FIXED lists of products picked off the Attention grid:

| `listId`    | Meaning |
|-------------|---------|
| `marketing` | The week's advertising shortlist. |
| `display`   | What should go out on the shop floor. |

Fixed, not free-form — there is no create-a-folder step, so the same two lists
mean the same thing to everyone. Adding a third is a code change, which is the
right amount of friction for something people have to agree on.

Each item is keyed **by product id**, so adding the same product twice is
idempotent and a list can never hold duplicates:

| Field     | Type            | Notes |
|-----------|-----------------|-------|
| `addedAt` | number          | ms since epoch, client clock. Also the display order (oldest pick first). |
| `addedBy` | string \| null  | uid of whoever picked it. |

A list with nothing in it has **no node at all** (RTDB drops empty objects); the
reader treats absent as an empty list, so both tabs always render. A product id
that later leaves `/products` is surfaced as "Removed from catalogue" rather
than dropped, so a list never silently shrinks.

Picking a product moves no stock, reserves nothing and changes no price.

**Deliberately NOT `/marketing`.** That tree belongs to marathon-ai (see below)
and this app never writes it. The `marketing` list here is a shortlist a human
is still assembling; if it ever feeds a real campaign that should be an explicit
hand-off, not this screen writing into another app's data.

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
