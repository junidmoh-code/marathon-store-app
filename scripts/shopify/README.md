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
| `round-trip.mjs <productId> --commit` — create that product ONCE (as DRAFT), read it back, print productId / variantIds / inventoryItemIds | **one Shopify product** (never RTDB) | `node scripts/shopify/round-trip.mjs p1234567890123 --commit` |

`nameRewrite.mjs` (brand stripping, pure functions — no I/O, no credentials) is
tested by `nameRewrite.test.mjs` via the normal `npm test`.

## Fixed decisions in this slice

- GraphQL Admin API only; version pinned in ONE place: `API_VERSION` in
  `client.mjs` (`2026-07`).
- Throttling: cost-based leaky bucket; the client waits per
  `extensions.cost.throttleStatus` and retries (max 5 attempts), handles 429
  and re-mints once on 401.
- Round-trip products are created `status: DRAFT` and the script refuses to
  create if the exact title already exists on the shop.
- One variant per entry of the record's `sizes`; the `"_"` one-size sentinel
  maps to option value `"One Size"`; `"5.5"` keeps its dot. Variant price =
  `retailPrice`. Media, inventory levels and publication are later slices.
- Returned Shopify IDs are printed, **not** written back to RTDB — the ID-map
  field naming (docs §5) needs a human decision first.
