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
"shopify_sync_concrete": { ".read": false, ".write": false },
"shopify_inventory_dirty_concrete": { ".read": false, ".write": false },
"online_orders_meta_concrete": { ".read": false, ".write": false },
```
