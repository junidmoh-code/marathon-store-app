# Shopify sync — recon and data-shape contract

Slice 1 of the Shopify push program (app → concret.co.za, one-way). This document
records the **live** shape of the catalogue as read from the code and a read-only
census of RTDB on 2026-08-13, and proposes the ID-map fields the sync will need.
No sync ships and nothing deploys in this slice — but `round-trip.mjs --commit`
DOES create one Shopify DRAFT product and write its ID map to
`/shopify_sync/{productId}` (the only RTDB path this slice may touch).

Program contract (fixed): the app is the source of truth for product data and
stock; Shopify is the source of truth for orders only. Nothing flows back into
`/products`.

---

## 1. `/products/{productId}` — exact record shape

Node key: `"p" + serverNowMs()` (`src/App.jsx:5316`). The single canonical
builder is `buildNewProduct()` in `src/utils/newProductRecord.js:54`, written via
`set()` in `addProductToFirebase` (`src/App.jsx:610-626`). `SCHEMA.md:12-56` is
the authoritative prose table; the numbers below are from the live census
(4,166 records).

### Always present

| Field | Type | Live count | Written at | Notes |
|---|---|---|---|---|
| `id` | string | 4,166 | `newProductRecord.js:101` | **Must equal the node key.** The app's only list builder filters on `v.id && v.name` (`src/App.jsx:515`) — a record without inner `id` is invisible in every list and picker. Write guard at `src/App.jsx:611-613`. |
| `name` | string | 4,166 | `newProductRecord.js:91` | Same visibility filter. |
| `category` | string | 4,166 | `newProductRecord.js:95` | Legacy tree, load-bearing. |

### Near-universal (required on new records, absent on some old ones)

| Field | Type | Live count | Written at | Notes |
|---|---|---|---|---|
| `sizes` | string[] | 4,131 | `newProductRecord.js:100` | See §2. The 35 records without it predate the builder. |
| `subcategory` | string | 4,162 | `newProductRecord.js:108` | Omitted when the category has no legacy leaf. |
| `barcode` | string (8-digit) | 4,138 | reserved via `/products_meta`, `src/App.jsx:5446-5447` | Internal, not a retail EAN. |
| `barcodes` | `{ [sizeKey]: code }` | 4,124 | `src/components/stock/barcodeStore.js:69` | Per-size internal codes, keyed with the encoded size key (§2). |
| `sku` | string (4-digit) | 4,048 | `src/App.jsx:5446-5447` | Internal. |
| `photoUrl` | string (HTTPS) | 4,098 | `newProductRecord.js:98`, replace at `src/App.jsx:6313` | See §4. |
| `photo` | string | 4,075 | `newProductRecord.js:97` | Legacy data-URL slot, superseded by `photoUrl`. |
| `hubs` | string[] | 3,929 | `newProductRecord.js:99` | Fulfilment routing; irrelevant to Shopify. |
| `brand` | string | 3,921 | `newProductRecord.js:96` via `brandOf(name)` (`src/utils/productCategory.js:124-134`) | Derived from the name; 411 distinct values, noisy (misspellings, colours, clubs). Null when unbranded. |
| `categoryKey` | string | 3,904 | `newProductRecord.js:93` | New taxonomy key. |
| `retailPrice` | number | 3,894 | `newProductRecord.js:116` | See §3. **Omitted, never 0/null**, when unpriced. |
| `stockPrice` | number | 3,888 | `newProductRecord.js:115` | Wholesale selling price, NOT supplier cost. Same omit rule. |
| `hasShoeBoxOption` | boolean | 3,669 | `newProductRecord.js:120` | POS-only. |

### Optional / conditional (omitted, never null — an `undefined` in a `set()` aborts the whole write, the 2026-08-06 outage; `newProductRecord.js:258-262`)

`productType` (`"sneaker"|"clothing"`, 3,271 — **deliberately absent on perfume**,
`newProductRecord.js:104-107`; do not touch), `photoUpdatedAt` (1,753),
`photoUrlOriginal` (804), `styleCode` + `styleCodeNormalised` (717; the identity
key, immutable once set), `styleCodeLabelPhoto` (530), `createdBy {uid,deviceId,at}`
(446), `gallery` string[] (151), `dominantColours` (150), `priceProduct` (35),
`depletedAt/By` (34, retired), `printedBarcode` (6, perfume EAN),
`labelUpc`/`labelColorway`/`labelModelName`, style-code exemption and provenance
stamps, `mergedInto/mergedAt/mergedBy` (server-only; merged records are hidden
from lists via `src/utils/mergedProducts.js:21-23`).

**Sync implication:** a curated-subset sync must select records that pass the
same `id && name` filter the app uses, skip `mergedInto` records, and treat every
field outside "always present" as optional.

---

## 2. Sizes and per-size stock

### On the product

`sizes` is a plain `string[]` (`newProductRecord.js:100`). Runs are defined in
`src/utils/productTaxonomy.js`:

- Apparel `["S","M","L","XL","XXL","XXXL"]` (line 47); bottoms use waist numbers
  `28–40` (`src/App.jsx:648`); kids `26–33` (line 56); fitted caps `55–63`
  (line 57).
- Footwear `["3","4","5","5.5","6","7","8","9","10","11","12","13"]` (line 54) —
  **`"5.5"` is stored with the dot in the array** (485 products carry it).
- **One-size sentinel `"_"`** — `ONE_SIZE_SENTINEL` at `productTaxonomy.js:62-63`.
  224 live products have `sizes: ["_"]` (perfumes, watches, bags, one-size caps).
  The UI renders it as "One size" / "Free Size" (`src/App.jsx:7539`, `7804`).

### Size keys (RTDB paths)

`.` is illegal in an RTDB key, so **keys** use `encodeSizeKey`
(`src/utils/sizeKey.js:20-28`): `"5.5" → "5_5"`, `"_"` stays `"_"`. Decode is
deliberately narrow (`sizeKey.js:30-35`). This contract is byte-identical with
marathon-pos-app (`sizeKey.js:6-11`).

### Per-size stock

`/stock/{locationId}/{productId}/{encodedSizeKey}` — path built only by
`stockCellPath` (`src/utils/sizeKey.js:101-103`). Cell shape (`SCHEMA.md:817-824`):
`{ qty, v, mv, lastType, state, updatedAt, updatedBy }`. Read via `useStockCells`
(`src/components/stock/useStock.js:92-102`), which decodes keys back to raw sizes.
Written by exactly one module, `src/components/stock/applyMovement.js` (qty write
at line 178); a missing cell reads as 0 (`applyMovement.js:124`). Locations:
`studio, central, base, hub1..3, marathon-pe, trophy, marathon-pine, in_transit`
(`SCHEMA.md:799-803`).

**Sync implication:** a Shopify variant maps 1:1 to a raw size string; the
size-level ID map must be keyed by the **encoded** size key to be a legal RTDB
path, matching how `barcodes` and `/stock` already key sizes.

---

## 3. Price

Two price fields, both on the record, both omitted when not `> 0`
(`newProductRecord.js:111-116`):

- **`retailPrice` — the consumer price. This is what Shopify gets.** Displayed
  and charged throughout the app (`src/App.jsx:7778`, `7849`, `9333-9335`);
  ZAR, no currency code stored (`SCHEMA.md:78`).
- `stockPrice` — B2B wholesale **selling** price, not supplier cost
  (`SCHEMA.md:31-32`). Admin/margin contexts only. Never push to Shopify.

Caveat: while a special runs, `retailPrice` **is** the special price and the
pre-special price is parked at `/specials/{productId}/wasPrice`
(`src/utils/specials.js:1-35`, PR #355). A later sync slice must decide whether
specials propagate; this slice only records the fact.

---

## 4. Photos

- Storage path `products/{id}/photo.jpg`, bucket `marathon-club.firebasestorage.app`
  (`src/firebase.js:14-15`); uploaded then resolved with `getDownloadURL`
  (`src/App.jsx:5321-5325`).
- **The public HTTPS download URL (with `?alt=media&token=…`) is stored on the
  record as `photoUrl`** — nothing reconstructs URLs from paths. Extra angles in
  `gallery: string[]` (`src/App.jsx:3183`); `photoBoxUrl` for the box shot.
- `products/**` is public-read in storage rules (`storage.rules:12-16`), so
  `photoUrl` is directly fetchable by Shopify's file ingestion — no signing
  needed. Note `photo.jpg` is overwritten in place on re-shoot (cacheControl
  7 days, `src/App.jsx:5322-5323`), so a photo *update* needs `photoUpdatedAt`
  as the change signal.

---

## 5. Proposed ID-map fields (naming = the open human decision)

Proposal: a **dedicated top-level node, off the product record**:

```
/shopify_sync/{productId}: {
  shopifyProductId:  "gid://shopify/Product/1234567890",
  variants: {
    {encodedSizeKey}: {                     // "M", "5_5", "_" — encodeSizeKey contract
      shopifyVariantId:       "gid://shopify/ProductVariant/…",
      shopifyInventoryItemId: "gid://shopify/InventoryItem/…"
    }
  },
  syncedAt: <epoch ms>          // NOT yet written by idMap.mjs — deferred to
}                               // the slice that needs staleness (deliberate)
```

Why off-record rather than fields on `/products/{id}`:

1. **Write-safety.** The app writes whole product records with `set()` at
   creation (`src/App.jsx:619`) and the codebase has a proven failure class
   around unexpected fields in that payload (the 2026-08-06 omit-don't-copy
   outage, `newProductRecord.js:229-243`). Sync bookkeeping on the record would
   have to survive every current and future record-level writer.
2. **Rules isolation.** Live rules give any non-anonymous authed user write on
   `/products/**`; a new top-level node can be locked to Admin-SDK-only, the
   same posture as the label nodes from #334. The Shopify ID map should never be
   client-writable.
3. **Nothing in the app reads Shopify IDs.** One-way sync means only the sync
   scripts consume the map; colocating it with the record buys no reader
   anything.
4. **Key legality.** Size-level entries must be keyed `"5_5"` not `"5.5"`
   (§2) — reusing `encodeSizeKey` keeps the one existing size-key contract.

Alternative considered (rejected, but this is the naming decision to confirm
before merge): `products/{id}/shopify/{…}` on-record — trivial joins when
eyeballing a record in the console, at the cost of points 1–2 above. Also open:
node name `/shopify_sync` vs `/shopify/products`, and whether `syncedAt` /
per-variant timestamps are wanted at all in slice 2.

Resolution: the dedicated `/shopify_sync/{productId}` node shipped (owner
decision) — `idMap.mjs` writes `shopifyProductId` + per-encoded-size variant
IDs on `round-trip.mjs --commit`; `syncedAt` stays deferred (note in §5 shape).

---

## 6. Census — price and photo coverage (read-only, 2026-08-13)

4,166 product records. "Has price" = `retailPrice` present and `> 0` (no
zero-price records exist); "has photo" = non-empty `photoUrl`.

| Bucket | Count |
|---|---|
| Price **and** at least one photo (sync-eligible) | **3,828** |
| Photo but no price | 270 |
| Price but no photo | 66 |
| Neither | 2 |
| Total | 4,166 |

Also counted: 224 one-size (`sizes: ["_"]`) products, 35 records with no `sizes`
field at all, 0 records missing the inner `id`.

---

## 7. Shopify side (established in this slice)

- App "Marathon Catalogue Sync", Dev Dashboard, installed on
  `nu3ei8-0p.myshopify.com` (concret.co.za). Scopes: read/write products,
  read/write inventory, read locations, write files, read/write publications.
- Auth: **client credentials grant** — `POST /admin/oauth/access_token` with
  form-encoded `grant_type=client_credentials`, `client_id`, `client_secret`;
  response `{ access_token, expires_in: 86399, scope }`; tokens live 24 h and
  are re-minted with the identical request. Only works when the app and store
  belong to the same organisation (`shop_not_permitted` otherwise).
- API: **GraphQL Admin API only**, version pinned to `2026-07` in
  `scripts/shopify/client.mjs`. Endpoint
  `https://{shop}/admin/api/2026-07/graphql.json`, header
  `X-Shopify-Access-Token`. Cost-based throttling; `extensions.cost.throttleStatus`
  drives the retry backoff.
- Product mapping (slice 1 round-trip): one product per record, one option
  "Size", one variant per entry of `sizes`; `"_"` maps to the single option
  value `"One Size"`; `"5.5"` keeps its dot (Shopify option values are plain
  strings). `retailPrice` → variant price. Created as **DRAFT** so nothing
  reaches the storefront. Media, inventory and publication are later slices.

---

## 8. Storefront collections and navigation (2026-08-15)

Four sections above describe how a product gets ONTO Shopify. This one is about
where it then sits, because until now the answer was "nowhere": the reconciler
created products, set inventory and stopped, and the theme's menus and home
page are collection-driven — so a shopper had no path to any listing.

### 8.1 Two taxonomies, one map

Storefront collections are deliberately **separate** from the app's internal
stock categories. The app's tree runs a warehouse (refill targets, Display
Checks, POS browse, size runs) and renaming it to suit a storefront would
change live automation behaviour. `scripts/shopify/collectionMap.mjs` is the
only join, and it is data: change the storefront's shape by editing it, with no
Shopify call and no touch to `/products`, `/stock` or
`/settings/productTaxonomy`.

**The internal categories, from the read-only census of 2026-08-15** (4,167
records passing the app's own `id && name` filter, `mergedInto` excluded):

| category | count | | subcategory | count |
|---|---|---|---|---|
| Clothing | 2,240 | | Sneakers | 1,224 |
| Footwear | 1,402 | | Clothing — Uncategorized | 472 |
| Accessories | 427 | | T-Shirts | 451 |
| Perfume | 63 | | Caps & Hats | 339 |
| Price Products | 35 | | Bags | 336 |

The map keys on the `category|subcategory` PAIR (subcategory is present on
4,163 of 4,167, and is already what the reconciler pushes as `productType` and
as a tag), with a `category|*` row per category as the fallback. Resolving
every visible record through it: **4,132 mapped · 35 excluded · 0 unknown.**

### 8.2 One category, one collection

An internal category lands in exactly one collection. "Clothing" is therefore a
sibling bucket — jerseys, polos, underwear, uncategorised — not a superset of
its six children; the menu nests them, the collections do not. Jerseys and
polos are deliberately NOT filed under "T-shirts": they are not t-shirts.

**Footwear has four lanes (2026-08-16).** The original single "Sneakers" lane
held 7 products, every one of them a boot. Boots (45), Soccer Boots (81) and
Sandals & Slides (49) now have their own top-level collections. The split was
the data edit this section always promised: three `COLLECTIONS` entries plus
three repointed `CATEGORY_MAP` rows, no handle change and no reconciler change.
Full census, the `categoryKey`-vs-legacy analysis and the apply runbook are in
`docs/STOREFRONT-FOOTWEAR-SPLIT.md`.

### 8.3 Excluded vs unmapped vs unknown

Three different things, kept apart on purpose:

- **excluded** — not merchandise. `isPriceRecord()` (`src/utils/productCategory.js`)
  answers this before any category lookup, for the 35 internal price-carrier
  records. This is the ONLY status that blocks publication: the publishing page
  does not list them and the reconciler refuses them at apply time. See
  `docs/STOREFRONT-FOOTWEAR-SPLIT.md` §2 for the rule and its fail-safe.
- **unmapped** — a `null` in `CATEGORY_MAP`; a recorded decision. No live
  category resolves here today.
- **unknown** — the category is absent from the table entirely: somebody added
  a category and did not update this file. A doubled warning in the reconciler
  run log, never a silent skip and never a refusal.

`unmapped` and `unknown` share ONE defined destination: no manual collection, so
no menu heading — but still ACTIVE and published, so the "New In" smart
collection picks it up. Reachable from the home page and by direct URL. Nothing
is stranded. `excluded` never reaches Shopify at all.

### 8.4 Compliance

Collection titles, handles, descriptions, SEO fields and menu labels are
catalogue fields and go through the SAME brand-trigger engine
(`triggersInText` in `src/utils/shopifyTriggers.js`) the product push uses,
before anything is created — wrapped as `validateCollectionPayload` in
`scripts/shopify/collectionMap.mjs`, plus a whole-run refusal in `ensureAllCollections`
(a half-built navigation is worse than none). All 15 pass; nothing was refused.
No brand is expressed as a tag, metafield, vendor or product type: the brand
association stays in the app.

### 8.5 API 2026-07 gotchas (the old recipes do not work)

- `ruleSet` is **deprecated** on `Collection` and absent from
  `CollectionCreateInput`. Smart membership is a **conditions source**:
  `sources[].source.inclusion { matchType, conditions }`.
- `CollectionCreateInput` has **no `products` field**. Manual membership is
  written from the product side — `productSet(collections:)` on create,
  `productUpdate(collectionsToJoin/collectionsToLeave)` after.
- A **manual collection's membership is itself a conditions source with an
  EMPTY conditions list** — the products live in `inclusion.selections`, and
  Shopify creates that source the first time a product joins. Deleting it
  because it "looks like a stray rule" is refused with *"A condition based
  source must have at least one product selection or condition"*: you are
  asking Shopify to throw the membership away. Only RULE-bearing sources may be
  compared or deleted.
- A collection is **Publishable**. Creating it is not enough — unpublished, its
  URL 404s and any menu link goes nowhere. `publishablePublish` runs on every
  pass, including a noop.
- Smart-collection conditions have **no created-at column** (the set is product
  tag / title / category / type / vendor / status, variant title / price /
  compare-at price / inventory / weight, and metafields). "Listed in the last N
  days" is therefore not something Shopify can evaluate for itself.

### 8.6 The three cross-cutting collections

| Collection | Condition (all Shopify-evaluated) | Note |
|---|---|---|
| New In | status is ACTIVE, sorted `CREATED_DESC` | No date condition exists, so this is every listed product newest-first — self-maintaining, and the safety net that keeps an unmapped product reachable. |
| Sale | status is ACTIVE **and** compare-at price IS_SET | The only cross-price test Shopify offers. EMPTY until specials propagate — nothing sets a compare-at price today. |
| Under R500 | status is ACTIVE **and** variant price < 500.00 ZAR | |

The ACTIVE gate is not decoration: the shop still holds 2,452 ARCHIVED products
from the old catalogue, and a price-only condition swept 841 of them in.

### 8.7 Navigation — Junid's to build

The Admin API **cannot** build menus for this app. Probed against the live shop
on 2026-08-15: `menus` → `ACCESS_DENIED, read_online_store_navigation`;
`menuCreate` → `ACCESS_DENIED, write_online_store_navigation`. The mutations
exist on 2026-07; the app simply is not granted those scopes.
`scripts/shopify/print-menu-plan.mjs` prints the tree, every link target, the
admin link and the exact steps — and what to change in the Dev Dashboard if the
menu should be API-built later.

Click paths verified in a browser on 2026-08-15, both already working from the
theme's existing hero buttons:

- Home → "Shop now" → Sneakers (7) → Boots Shell Green
- Home → "View collection" → Collections → Caps & Hats (4) → Red Sox fitted cap
