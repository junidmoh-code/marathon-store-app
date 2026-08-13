# Shopify sync scripts

Slice 1 tooling for the one-way push to concret.co.za. Background, data-shape
contract and the ID-map proposal live in `docs/SHOPIFY-SYNC.md`.

## Credentials

Three env vars, either exported or in a git-ignored `.env` at the repo root
(real env wins over the file; `.env` is already in `.gitignore`):

```
SHOPIFY_SHOP=nu3ei8-0p.myshopify.com
SHOPIFY_CLIENT_ID=…
SHOPIFY_CLIENT_SECRET=…
```

There is **no static access token**. `token.mjs` mints one on demand via the
client credentials grant (`POST /admin/oauth/access_token`), caches it in
process memory only, and re-mints 5 minutes before the 24 h expiry. Tokens are
never written to disk and never printed. If the grant returns
`shop_not_permitted`, the app and store are not in the same Shopify
organisation — that is a Dev Dashboard problem, not a code problem.

The round-trip script also reads RTDB (read-only) via Application Default
Credentials, same as every other script in `scripts/`:
`gcloud auth application-default login` once, and `firebase-admin` is resolved
from `functions/node_modules`.

## Scripts

| Script | Writes? | Run |
|---|---|---|
| `smoke.mjs` — mint token, print shop info + locations, `expires_in` (never the token) | nothing | `node scripts/shopify/smoke.mjs` |
| `round-trip.mjs <productId>` — map one RTDB product to a `productSet` payload and print it | nothing | `node scripts/shopify/round-trip.mjs p1234567890123` |
| `round-trip.mjs <productId> --commit` — create that product ONCE (as DRAFT), read it back, print IDs, persist the ID map | **one Shopify product + `/shopify_sync/<productId>`** (no other RTDB path, ever) | `node scripts/shopify/round-trip.mjs p1234567890123 --commit` |
| `clean-report.mjs [--residue] [--json <f>]` — trigger-engine census: how many names clean automatically, 40 deterministic before/after pairs, and the residue worklist for the AI pass | nothing | `node scripts/shopify/clean-report.mjs` |

Pure modules, tested via the normal `npm test`:

- `src/utils/shopifyTriggers.js` (NOT in this directory — shared with the
  home-page card's live input check) — brand-trigger engine v2: the
  three-category lexicon (parent brands / sub-labels / model + silhouette
  names, the line-mark keep is REVERSED), squash + word matching that catches
  concatenated and misspelt forms, and `cleanTitleFor()` which rebuilds a
  generic descriptive title and REFUSES (needsAI) instead of ever shipping a
  triggered original name.
- `sizeOrder.mjs` — storefront size ordering: numeric ascending (halves
  included), letter sizes in garment order, `"_"` sentinel last.
- `idMap.mjs` — the `/shopify_sync/{productId}` mapping: `buildMapping`
  (variants keyed by the app's `encodeSizeKey` encoding, full `gid://` strings)
  and the idempotent `planIdMapWrite`/`writeIdMap` (create / noop / merge new
  sizes; REFUSES to re-point a product or a size at different IDs).

`/shopify_sync` is Admin-SDK-only: the console rules (managed there, not in
`database.rules.json`) deny all client reads and writes of the node.

## Fixed decisions in this slice

- GraphQL Admin API only; version pinned in ONE place: `API_VERSION` in
  `client.mjs` (`2026-07`).
- Throttling: cost-based leaky bucket; the client waits per
  `extensions.cost.throttleStatus` and retries (max 5 attempts), handles 429
  and re-mints once on 401.
- Round-trip products are created `status: DRAFT` and the script refuses to
  create if the exact title already exists on the shop.
- One variant per entry of the record's `sizes`, sorted for the storefront
  (`sizeOrder.mjs`); the `"_"` one-size sentinel maps to option value
  `"One Size"`; `"5.5"` keeps its dot. Variant price = `retailPrice`. Media,
  inventory levels and publication are later slices.
- Listing titles come from the trigger engine (`cleanTitleFor()`), or a
  trigger-free `cleanName` on `/shopify_publish/{productId}` when one exists.
  NOTHING pushed to Shopify may contain a brand trigger in ANY field — a name
  neither path can clean refuses the push (`clean-report.mjs --residue` is the
  worklist; the original name NEVER ships for a triggered product).
- Returned Shopify IDs are persisted to `/shopify_sync/{productId}` — a
  dedicated Admin-SDK-only node, deliberately NOT on the client-writable
  product record (a lost mapping would mean duplicate Shopify products).
- Shopify has exactly ONE location, deliberately: inventory is one sellable
  pool. Never create locations mirroring PE / Pine / Trophy / the hubs;
  per-location breakdown becomes a metafield in a later slice.
