# Shopify media gallery — photos and videos per product

Junid's brief (6 Oct 2026): each product in Shopify Publishing carries a full
media set — several photos and videos — added from camera or gallery,
reordered, with a chosen primary photo, and Shopify follows automatically.
Videos are kept at original quality, forever.

This file starts as the investigation (what exists today) and then records the
design that was built on top of it.

## 1. Investigation — the photo model today

### 1.1 Where a product's photo lives

| Field / object | What it is | Written by |
|---|---|---|
| `/products/{pid}/photoUrl` | THE app photo (every till, list, label, TV board) | Add Product, edit-page re-shoot, AI Photo Studio approve, New Arrivals chain |
| `/products/{pid}/photoUrlOriginal` | the staff photo an approved AI photo replaced | AI Studio approve, New Arrivals chain |
| `/products/{pid}/gallery[]` | extra angles kept from the AI photo studio | App.jsx gallery keep/remove |
| `/products/{pid}/photoUpdatedAt` | stamped by HUMAN uploads only | Add Product, re-shoot |
| `/products/{pid}/photoSourceUrl` | hi-res copy for New Arrivals | Add Product |
| Storage `products/{pid}/photo.jpg` | staff original, 800 px / 200 KB | Add Product, re-shoot |
| Storage `products/{pid}/thumb_300.webp` | till thumbnail (POS shares the path convention) | `writeProductThumb` / `writeApprovedThumbFromUrl` |
| `/shopify_publish/{pid}/photos[]` | the PUBLISHING set: ordered URL list, first = primary | `setPublishPhotos` (page), `photosMutator` (New Arrivals chain) |
| Storage `products/{pid}/shopify/{upload,gen}_{ts}_{rand}.{ext}` | publishing uploads, 1600 px / 800 KB JPEG, immutable cache headers | `photoTools.uploadPublishPhoto` |

Storage rule `products/**`: public read, any signed-in non-anonymous write; no
size or content-type condition — a video under `products/{pid}/` needs no
Storage rule change.

### 1.2 Every reader

* **Store app (`src/`)** — ~80 files read `photoUrl` (`ProductThumb`,
  `productPhotos()` = photoUrl + gallery, Health, Refill, labels, TV board,
  pick lists). The offline cache serves `thumb_300.webp` and invalidates on
  `photoUpdatedAt|photoUrl`.
* **Shopify Publishing** — `effectivePhotoList(product, node)`: the custom
  `photos` list when present, else `photoUrl` + `gallery`. `PhotoStrip` on
  `ShopifyProductPage.jsx` reorders / makes primary / removes / uploads / opens
  AI Studio, writing ONLY `/shopify_publish/{pid}/photos`. Locked while the
  listing is ON. Cap `MAX_PUBLISH_PHOTOS = 20`.
* **AI Studio (Publishing card)** — `AiStudioCard.jsx` generates from the
  selected slot, copies the result to `products/{pid}/shopify/gen_*`, then
  `onReplace` (swap that slot) or `onAdd` (append). Never touched `/products`.
* **Reconciler** (`scripts/shopify/reconcile.mjs`, Mac mini, every 2 min,
  07:00–19:00 SAST, cap 25) — only on an INTENT change (off→on / on→off).
  `buildMediaPlan` = publishing list or photoUrl+gallery, IMAGE only, alt =
  the validated clean title. `mediaFingerprint` (sha1 of the URL list) stored
  on `/shopify_sync/{pid}`; any mismatch → unpublish → `productDeleteMedia`
  ALL → wait for zero → `productCreateMedia` the plan → poll READY. A product
  already live never has its media touched again — which is why the page
  locked the strip while ON.
* **Search index** — does not read the app photo; it stores Shopify's
  `featuredMedia` (so it follows the primary automatically).
* **Social engine** (`functions/lib/social-select.cjs`) — `node.photos[0] ||
  product.photoUrl`.
* **WhatsApp group poster** — lives outside this repo (`~/marathon-group-poster`
  on the mini); its compose code was copied into `functions/newArrivals/studio`.
  It reads the product's `photoUrl`.
* **New Arrivals** — `sourcePhoto.cjs currentSourceUrl` (photo.jpg →
  photoUrlOriginal → photoUrl). The approval chain writes the publishing list
  (`photosMutator`, `[generatedUrl]`) AND `products/{pid}/photoUrl` +
  thumbnail — the only code path where a publishing photo became the app
  photo before this change.
* **POS** — reads `thumb_300.webp`.

### 1.3 The 26 Sep decision

"A photo changed in Shopify Publishing must also become the product's photo in
the normal app" was NOT implemented on the Publishing page — the code said the
opposite ("NEVER to /products"). Only the New Arrivals chain did it.

### 1.4 Duplicate / wrong-photo detection

None. The only checks compare URL strings within one product's list.

### 1.5 Shopify video API (verified against shopify.dev / help.shopify.com, API 2026-07)

* Upload: `stagedUploadsCreate(input:[{resource: VIDEO, filename, mimeType,
  fileSize (required for VIDEO), httpMethod: POST}])` → `{url, resourceUrl,
  parameters[]}`; multipart POST with every parameter as a form field and the
  file LAST.
* Attach: `productUpdate(product:{id}, media:[{originalSource: resourceUrl,
  mediaContentType: VIDEO, alt}])` (`productCreateMedia` is deprecated but
  still served; this shop's existing photo push uses it).
* Processing is asynchronous: `Media.status` UPLOADED → PROCESSING → READY |
  FAILED, `mediaErrors` on failure. Shopify transcodes for playback.
* Reorder: `productReorderMedia(id, moves)` (async job, not deprecated).
* Remove: `productDeleteMedia` (deprecated, still served) /
  `fileUpdate(referencesToRemove)` (needs the file READY).
* **Limits (help center "Product media types"): video up to 1 GB, up to 10
  minutes, up to 4K (4096×2160; the dev guide says 3840×2160), .mp4/.mov/.webm;
  at most 250 media per product; 1,000 videos per store per week.**
* Scopes: `write_products` + `write_files` — both already granted to
  "Marathon Catalogue Sync".

## 2. Design (what was built)

See the sections below, filled in by the commits that follow.
