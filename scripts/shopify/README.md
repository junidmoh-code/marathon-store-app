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
| `ai-rename.mjs [--dry-run] [--limit N]` — AI names for the lexicon residue only; every output re-checked by the trigger engine, cached once, never regenerated. Hard-stops without `ANTHROPIC_API_KEY` | **`/shopify_publish/{pid}` (cleanName cache)** | `node scripts/shopify/ai-rename.mjs --dry-run` |
| `migrate-live-state.mjs [--commit]` — one-time rewrite of `/shopify_publish` into the 2026-08-14 state model (`awaiting\|live\|blocked` + on/off); idempotent, prints before/after counts per state | **`/shopify_publish` states** | `node scripts/shopify/migrate-live-state.mjs` (dry run) |
| `reconcile.mjs [--commit] [--pids a,b]` — **owner-run only**: applies the page's `desiredState` intents. Turning ON creates/reconciles the product, JOINS THE STOREFRONT COLLECTION its category maps to, runs the FULL compliance validator against the CANONICAL Shopify object at that moment, re-syncs inventory, publishes to the Online Store channel (refusals mark the node blocked). Turning OFF unpublishes from that channel and LEAVES every managed collection — never archives, never deletes, never touches the ID map. Hard cap `RECONCILE_MAX_APPLY` actions/run | **Shopify products/channel + `/shopify_sync` + `/shopify_publish`** | `node scripts/shopify/reconcile.mjs` (dry run — a table of what it would do) |
| `ensure-collections.mjs [--commit]` — create/reconcile the 15 storefront collections from `collectionMap.mjs` and publish each to the Online Store channel. Idempotent: recognises by recorded id, then by handle, then creates. Refuses the WHOLE run if any collection's copy trips the brand-trigger validator | **Shopify collections + `/shopify_sync/_collections`** | `node scripts/shopify/ensure-collections.mjs` (dry run) |
| `sync-collections.mjs [--commit] [--pids a,b]` — collection membership for every product this program has touched (the union of `/shopify_publish` and `/shopify_sync`), because the reconciler only acts when an intent CHANGES. A product confirmed ON joins its mapped collection; one that is **NOT** confirmed ON **LEAVES every managed collection** — that is the destructive half, so read the dry run before `--commit`. A product with an unapplied intent, or one whose record and the shop disagree, is reported and never touched. Re-plans from Shopify every run, so it doubles as the audit-and-repair pass | **Shopify collection membership only — no RTDB writes at all** | `node scripts/shopify/sync-collections.mjs` (dry run) |
| `backfill-inventory-tracking.mjs [--commit] [--live-only] [--pids a,b]` — turns Shopify inventory TRACKING on for every variant this program has already pushed, and re-pushes the current `/stock` network quantity for each. The reconciler only revisits a product when its intent CHANGES, so a settled live product is never repaired by it — this is that pass. Only variants in the ID map are touched; an admin-added variant is left alone. Idempotent: an already-correct product costs one read and no mutation | **Shopify variants + inventory levels only — no RTDB writes** | `node scripts/shopify/backfill-inventory-tracking.mjs` (dry run) |
| `print-menu-plan.mjs` — prints the main-menu tree, every link target, the admin link and the exact steps. The Admin API **cannot** build menus for this app: `menuCreate` needs `write_online_store_navigation`, which is not granted (probed 2026-08-15) | nothing | `node scripts/shopify/print-menu-plan.mjs` |

`publish-run.mjs` (the nominated-worklist DRAFT pusher and its `--publish`
path) is RETIRED — the nominate step no longer exists; `reconcile.mjs` covers
both creation and publication, driven by the page's Publish action.

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
- `collectionMap.mjs` — THE storefront taxonomy and the category join, as
  DATA: `COLLECTIONS` (15 entries: titles, handles, customer-facing copy, SEO,
  sort order, and the Shopify-evaluated conditions for the three smart ones)
  and `CATEGORY_MAP` (internal `category|subcategory` → exactly ONE manual
  collection). `resolveCollection()` answers mapped / unmapped / unknown, and
  `validateCollectionPayload()` is the brand-trigger gate every collection
  string passes before creation. Storefront collections are deliberately
  SEPARATE from the app's stock categories — this file is the only join, and
  changing the storefront's shape is an edit here, not a code change.
- `collections.mjs` — the Shopify half: idempotent create/reconcile, the
  API-2026-07 conditions-source shape, drift fingerprints, and the membership
  planner (which never touches a smart collection, and never empties a
  collection built by hand in the admin).
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
