# Concrete store — second Shopify store, one stock pool

Concrete World (`g2m9cm-9q.myshopify.com`, concreteworld.co.za) lists every
product Junid marks **Concrete**. Since 20 Nov 2026 a Concrete product is
**CONCRETE-ONLY**: it sells on the Concrete website only (Marathon's
publishing tab and reconciler skip it, and the Marathon reconciler switches
off any that are live on marathonclub.co.za), and Missing Products lists it
under the Concrete division, not Marathon. Both stores sell from the one stock
engine.

## Data

| path | what |
|---|---|
| `/products/{pid}.concreteProduct` | `true` = Concrete-only. Absent/false = Marathon |
| `/products/{pid}.concreteProductSetBy` / `concreteProductSetAt` | who/when (serverNowMs) |
| `/settings/concreteOnlyIndex/{pid}` | `true` while Concrete-only — the small index the Marathon reconciler reads (no /products scan) |
| `/settings/missingProductsSolved/{pushKey}` | Missing Products → Solved tab: every Solve and every Concrete mark, with what Undo needs |
| `/products/{pid}.listOnConcrete` (+SetBy/SetAt) | LEGACY (#911). Still read when `concreteProduct` is absent; mirrored on every write for one release, then dropped |
| `/products/{pid}.brandVerifiedAt` / `brandVerifiedBy` | the Brand Check stamp |
| `/shopify_publish_concrete/{pid}` | same shape as `/shopify_publish/{pid}` |
| `/shopify_sync_concrete/{pid}` | same shape as `/shopify_sync/{pid}` (Admin SDK only) |

Helper: `src/utils/concreteListing.js` (`isConcreteProduct`, `buildConcreteUpdate`,
`setConcreteProduct`, `buildBrandConfirmUpdate`, `needsBrandCheck`). Migration:
`scripts/concrete/migrate-concrete-only.mjs` (dry run by default; `--commit`;
`--rollback FILE`). Marathon-side enforcement: `scripts/shopify/concreteOnly.mjs`.

## Concrete-only rules (20 Nov 2026) — PASTE THESE

`/products` and `/settings` are writable by every signed-in staff account on
the live rules, so the app works without these. But marking a product
Concrete-only now takes it OFF marathonclub.co.za, so these `.validate` rules
let only Junid, Jafer or a stockRole admin CHANGE the mark (a `.write` granted
at `/products` cannot be narrowed below it; `.validate` can refuse the change).
Admin SDK scripts bypass rules.

Inside `"products" → "$pid"`, next to `styleCode…`:

```json
"concreteProduct":      { ".validate": "newData.isBoolean() && (newData.val() === data.val() || auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com' || root.child('users').child(auth.uid).child('stockRole').val() === 'admin')" },
"concreteProductSetBy": { ".validate": "newData.isString() && newData.val() === auth.uid" },
"concreteProductSetAt": { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= now + 86400000" },
"listOnConcrete":       { ".validate": "newData.isBoolean() && (newData.val() === data.val() || auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com' || root.child('users').child(auth.uid).child('stockRole').val() === 'admin')" }
```

(If you already pasted #911's `listOnConcrete` line from block 1 below, replace
it with this one.)

Inside `"settings"`:

```json
"concreteOnlyIndex": {
  "$pid": { ".validate": "newData.val() === true && (auth.token.email === 'gunidmoh@gmail.com' || auth.token.email === 'jafermohammed340@gmail.com' || root.child('users').child(auth.uid).child('stockRole').val() === 'admin')" }
},
"missingProductsSolved": {
  "$id": { ".validate": "(newData.hasChildren(['kind', 'pid', 'at', 'by']) || (data.exists() && newData.hasChildren(['status']))) && (!newData.child('at').exists() || (newData.child('at').isNumber() && newData.child('at').val() <= now + 86400000))" }
}
```

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

