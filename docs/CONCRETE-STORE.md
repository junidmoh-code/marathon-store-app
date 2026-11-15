# Concrete store — second Shopify store, one stock pool

Concrete World (`g2m9cm-9q.myshopify.com`, concreteworld.co.za) lists every
product Junid marks **in addition to** Marathon's store. Both sell from the one
stock engine. Marathon's publishing ignores the Concrete fields entirely.

## Data

| path | what |
|---|---|
| `/products/{pid}.listOnConcrete` | `true` = also on Concrete. Absent/false = Marathon only |
| `/products/{pid}.listOnConcreteSetBy` / `listOnConcreteSetAt` | who/when (serverNowMs) |
| `/products/{pid}.brandVerifiedAt` / `brandVerifiedBy` | the Brand Check stamp |
| `/shopify_publish_concrete/{pid}` | same shape as `/shopify_publish/{pid}` |
| `/shopify_sync_concrete/{pid}` | same shape as `/shopify_sync/{pid}` (Admin SDK only) |

Helper: `src/utils/concreteListing.js` (`isOnConcrete`, `buildConcreteUpdate`,
`setOnConcrete`, `buildBrandConfirmUpdate`, `needsBrandCheck`).

## Rules to paste (Firebase console → Realtime Database → Rules)

`database.rules.json` in the repo is stale; never deploy it. Paste these by hand.

### 1. Inside `"products" → "$pid"` — add these siblings next to `styleCode…`

```json
"listOnConcrete":      { ".validate": "newData.isBoolean()" },
"listOnConcreteSetBy": { ".validate": "newData.isString() && newData.val() === auth.uid" },
"listOnConcreteSetAt": { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= now + 86400000" },
"brandVerifiedAt":     { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= now + 86400000" },
"brandVerifiedBy":     { ".validate": "newData.isString() && newData.val() === auth.uid" }
```

### 2. New top-level siblings of `"shopify_publish"`

```json
"shopify_publish_concrete": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".indexOn": ["state", "updatedAt"],
  "$pid": {
    ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && ((auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com') || root.child('users').child(auth.uid).child('stockRole').val() === 'admin' || root.child('users').child(auth.uid).child('permFlags').child('shopify_publish').val() === true)",
    ".validate": "!newData.exists() || (newData.hasChildren(['state']) && root.child('products').child($pid).exists())",
    "state":           { ".validate": "newData.isString() && newData.val().matches(/^(awaiting|live|blocked)$/)" },
    "liveState":       { ".validate": "newData.isString() && newData.val().matches(/^(on|off)$/)" },
    "desiredState":    { ".validate": "newData.isString() && newData.val().matches(/^(on|off)$/)" },
    "blockedReason":   { ".validate": "newData.isString() && newData.val().length <= 1000" },
    "cleanName":       { ".validate": "newData.isString() && newData.val().length >= 3 && newData.val().length <= 255" },
    "cleanNameSource": { ".validate": "newData.isString() && newData.val().matches(/^(lexicon|ai|manual)$/)" },
    "updatedAt":       { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= now + 86400000" },
    "updatedBy":       { ".validate": "newData.isString() && newData.val() === auth.uid" },
    "$other":          { ".validate": true }
  }
},
"concrete_house_style": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".indexOn": ["status"],
  "$pid": {
    ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && ((auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com') || root.child('users').child(auth.uid).child('stockRole').val() === 'admin' || root.child('users').child(auth.uid).child('permFlags').child('shopify_publish').val() === true)",
    "status": { ".validate": "newData.isString() && newData.val().matches(/^(queued|running|awaiting_approval|approved|rejected|failed)$/)" }
  }
},
```

`shopify_sync_concrete`, `shopify_inventory_dirty_concrete`,
`online_orders_meta_concrete`, `shopify_pending_sales` and
`shopify_fanout_stats` are Admin-SDK-only: no rule is needed (no rule = denied
to every browser), the same as `shopify_sync` effectively is.

### 3. Inside `"config"` — a sibling of `"shopify"`

```json
"concrete_house_style": {
  ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && ((auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com') || root.child('users').child(auth.uid).child('stockRole').val() === 'admin')"
}
```

### 4. Storage rules (Firebase console → Storage → Rules) — inside `match /b/{bucket}/o`

The repo's `storage.rules` has drifted from the live rules too (live has a
`tv_ads` block and Jafer on `aiStudio`), so it is NOT deployed. Paste:

```
    // Concrete house-style reference photos. Public read (the Mac mini worker
    // fetches them by URL); write = the owners (Storage rules cannot read
    // stockRole from the database).
    match /concrete_style_refs/{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null
                   && (request.auth.token.email == "gunidmoh@gmail.com" || request.auth.token.email == "jafermohammed340@gmail.com");
    }
```

## Concrete store credentials (until these exist the Concrete leg is OFF)

The runner logs `concrete: credentials missing` and does nothing for Concrete.

1. Go to https://dev.shopify.com/dashboard → the same organisation as
   "Marathon Catalogue Sync" → **Create app** → name it "Concrete Catalogue Sync".
2. **Versions → Create version**. Access scopes — exactly Marathon Catalogue
   Sync's (read from its live token, 15 Nov 2026), which already include
   order read for the ingest:
   `read_all_orders, read_customers, write_discounts, write_files,
   write_inventory, read_locations, write_merchant_managed_fulfillment_orders,
   write_online_store_navigation, write_orders, write_products,
   write_publications, write_store_credit_account_transactions, write_themes,
   customer_write_orders`. API version 2026-07. Release the version.
3. **Home → Install app** → choose the store **Concrete World
   (g2m9cm-9q.myshopify.com)** → Install.
4. **Settings** → copy **Client ID** and **Client secret**.
5. On the Mac mini, add two lines to `~/marathon-store-app/.env`:
   ```
   CONCRETE_SHOPIFY_CLIENT_ID=<client id>
   CONCRETE_SHOPIFY_CLIENT_SECRET=<client secret>
   ```
6. Nothing to restart: the next reconcile tick (≤ 2 min, trading hours)
   recreates the collections on Concrete, then publishes, and the
   `com.marathon.stockfanout.concrete` agent picks the credentials up within
   an hour (or `launchctl kickstart -k gui/501/com.marathon.stockfanout.concrete`).
   In Concrete's admin, make sure the store has ONE location (339C Monty
   Naicker Road) — the stock push refuses a store with two.

## Moving parts

| piece | where | cadence |
|---|---|---|
| Concrete publish/stock/price/media | `concrete-leg.mjs` from `reconcile-runner.mjs` | every reconcile tick, own processes, own log `logs/concrete-reconcile.log` |
| Concrete website orders → POS | `orders-poll.mjs` with `SHOPIFY_STORE=concrete` | same tick; `sourceStore: "concrete"`; escalation OFF |
| cross-store stock push | `stock-fanout.mjs` × 2 (`com.marathon.stockfanout.{marathon,concrete}`) | event-driven (seconds), all hours |
| house-style generation | `scripts/concrete/house-style-worker.mjs` (`com.marathon.concretestyle`) | every 30 s, only queued rows |

