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

### 2.1 One ordered list — `/shopify_publish/{pid}/media`

Items `{ id, type: photo|video, url, path, posterUrl?, posterPath?, sha256?,
bytes?, mime?, width?, height?, durationMs?, addedAt?, addedBy?, source?,
derivedFrom? }` (publishShared.js). Every write of `media` rewrites `photos`
as its photo projection in the SAME transaction, so every photos-only reader
keeps working. `resolveMediaList(node, product)` is the one read: the saved
list; or the old `photos`; or the record's `photoUrl` + `gallery` — a
one-photo list with **no backfill write**. A photos-only writer (the New
Arrivals chain, an old bundle) that changes `photos` afterwards is merged on
read (photos take the new order, videos keep their places).

Position 0 is always a photo: `mediaListProblem` refuses otherwise, the
append mutator refuses a video into a photo-less list, and every strip chip is
computed first and disabled when its result would break it (mediaEdits.js).
Cap = Shopify's own 250. Edits are allowed while the listing is ON.

### 2.2 Upload (mediaUpload.js)

Gallery (multi-select), Take photo, Record video. Per file: SHA-256 of the
exact bytes (streamed, sha256.js) → `mediaHashClaim` (refuses a file owned by
a DIFFERENT product, naming it) → photo: the existing 1600 px JPEG path;
video: the picked File itself via `uploadBytesResumable` (never re-encoded) to
`products/{pid}/media/{id}.{ext}`, retry window 30 min while in flight, paused
offline / resumed online; poster drawn on the phone →
`products/{pid}/media/{id}_poster.jpg`. Only then is the item appended
(computed from the server's current list) — no ghost entries.

### 2.3 Hash index — `/shopify_sync/_mediaHash/{sha256}`

`{ pid, at, uid, kind }`, written only by the `mediaHashClaim` callable
(Admin SDK; `/shopify_sync` is server-only). Ownership follows use: if the
owner's own media list no longer carries the hash, the claim moves. Reads are
per path only. No rule change needed.

### 2.4 Primary → app photo (26 Sep decision)

When an edit CHANGES position 0, `/products/{pid}` gets `photoUrl` (+
`photoUrlOriginal` for a replaced staff photo) — child keys only — and the till
thumbnail is rebuilt (appPhoto.js), exactly the AI Studio approve write.
Extras and videos never touch the app photo.

### 2.5 Reconciler (scripts/shopify/mediaSync.mjs) + the video sender

* Per item: photos by URL (Shopify fetches them), videos by staged upload.
* **Video bytes move only in `media-video-runner.mjs`** — its own launchd job
  (`com.marathon.shopifymediavideo`, KeepAlive + ThrottleInterval 120, own
  lockfile), one video per run. It streams the Storage object to Shopify,
  SHA-256-checked in flight, and records the `resourceUrl` the moment Shopify
  accepts it: **sent exactly once**. The reconcile tick never moves bytes; it
  attaches what has arrived and polls. A run killed mid-transfer recorded
  nothing and sends again (the bytes never landed); 3 real failures → failed.
* State: `/shopify_sync/{pid}/media/items/{key}` (Shopify media id, status,
  resourceUrl, attempts; written field by field so the tick and the sender
  never overwrite each other) + `/shopify_sync/{pid}/media/inflight` (a create
  whose answer was lost, adopted next tick) + `/shopify_publish/{pid}/mediaShopify`
  (what the page shows) + `mediaSyncedSig` + `/shopify_sync/_mediaPending`.
* Order: ours that are READY, in list order, first (productReorderMedia);
  anything not ours after, untouched. Alt text = the validated listing name,
  re-labelled on rename (fileUpdate).
* Removal: only items this system created that left the list, plus the
  pre-tracking photo set the old path attached — snapshotted into the record on
  first contact, IMAGE-only, count-checked against `mediaCount` (stamped beside
  `mediaFingerprint` from now on). On a live product nothing is removed until
  every listed photo is READY, so the shop never shows it without photos.
* FAILED photos are retried (3×); a FAILED video is never re-sent.
* Publish path: photos READY before going live; videos queued for the sender.
* Live path: runs after the intent batch and sweeps, rotating through the
  pending set; a settled product costs no Shopify call (sig compare) and an
  idle re-run writes nothing anywhere.
* Videos Shopify cannot take (> 1 GB, > 10 min, > 4K, other formats) are kept
  and never pushed; the strip says "kept, too large for Shopify".
* `productCreateMedia` / `productDeleteMedia` are deprecated but still served
  in API 2026-07 (introspected 6 Oct 2026); the existing photo path uses them too.

### 2.6 Storefront (theme/snippets/marathon-card.liquid + marathon-storefront.js/css)

The quick-view panel shows every `product.media` in order as a scroll-snap
gallery (arrows on desktop, "n / N"). A video is its poster + play button; the
`<video>` (preload none, controls, playsinline) is created from an inert
`<template>` only on tap, and paused when swiped away or closed. The grid tile
stays the primary photo. The product page is Dawn's gallery, which already
renders video media.
