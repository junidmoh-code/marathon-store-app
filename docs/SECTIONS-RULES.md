# Sections — database rule changes to paste in the console

`database.rules.json` in this repo is stale and is not touched. Everything
the sections work needs is in the ONE block below, built against the LIVE
rules as read on 2026-10-01. Each key
REPLACES the key of the same name under `rules` (`network` and
`sections_repair` are new). Nothing else in the live rules changes.

## Order

0. Deploy both apps first. A till still running the old POS can route a Pine
   sneaker sale to Hub 1 or Hub 2; once the block is pasted and the registry
   is set up, the rule refuses that write and the till would queue it forever.
1. Paste the block.
2. Home → Network → **Set up the network** (writes the registry; adds Concrete
   and Concrete Stockroom to `/locations`, all four Section 1 locations off).

Until step 2 the wall clauses pass everything: they compare sections read from
`/network`, and a location with no section there is not judged. The apps
enforce the wall from their built-in seed regardless.

## What each key does

| key | change |
|---|---|
| `network` | New. Read: any signed-in account. Write: Junid only. A store's back stock can only be a hub in its own section. |
| `stock_movements` | Existing rule kept word for word, plus three clauses: (1) a two-location movement must not pair a Section 1 location with a Section 2 one; (2) a `return` linked to a POS record must land in the section of the store that took it; (3) a `sold` linked to a POS record must deduct in the selling store's section. Central has no section and pairs with anything. |
| `transfers` | Existing rule kept, plus: a transfer's `from` and `to` must not be on opposite sides of the wall. This is what covers a transit send, whose movements only name `in_transit`. |
| `orders` | Existing rule kept, plus, on create only: the order's hub and its `destShop` must not be on opposite sides. |
| `refill_requests` | Existing rule kept, plus, on create only: the requesting location and its source (and the shop it is for) must not be on opposite sides. |
| `sections_repair` | New. The return-repair log. Junid reads; only the admin script writes. |

## The block

```json
  "network": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    ".write": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
    "creditScope": {
      ".validate": "newData.val() === 'shared' || newData.val() === 'section'"
    },
    "updatedAt": {
      ".validate": "newData.isNumber() && newData.val() <= now + 60000"
    },
    "locations": {
      "$id": {
        "live": {
          ".validate": "newData.isBoolean()"
        },
        "type": {
          ".validate": "newData.val() === 'store' || newData.val() === 'hub' || newData.val() === 'central'"
        },
        "section": {
          ".validate": "newData.val() === 1 || newData.val() === 2"
        }
      }
    },
    "backStock": {
      "$store": {
        "$category": {
          ".validate": "newData.isString() && newData.parent().parent().parent().child('locations').child(newData.val()).child('type').val() === 'hub' && newData.parent().parent().parent().child('locations').child(newData.val()).child('section').val() === newData.parent().parent().parent().child('locations').child($store).child('section').val()"
        }
      }
    },
    "productOverrides": {
      "$store": {
        "$pid": {
          ".validate": "newData.isString() && newData.parent().parent().parent().child('locations').child(newData.val()).child('type').val() === 'hub' && newData.parent().parent().parent().child('locations').child(newData.val()).child('section').val() === newData.parent().parent().parent().child('locations').child($store).child('section').val()"
        }
      }
    },
    "posStores": {
      "$posId": {
        "section": {
          ".validate": "newData.val() === 1 || newData.val() === 2"
        }
      }
    }
  },
  "stock_movements": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    "$mvId": {
      ".write": "!data.exists() && newData.exists() && auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
      ".validate": "newData.hasChildren(['type','productId','size','qty','actor','ts']) && newData.child('qty').isNumber() && newData.child('qty').val() > 0 && newData.child('actor').val() === auth.uid && root.child('products').child(newData.child('productId').val()).exists() && (!newData.child('from').exists() || newData.child('from').val() === null || root.child('locations').child(newData.child('from').val()).exists()) && (!newData.child('to').exists() || newData.child('to').val() === null || root.child('locations').child(newData.child('to').val()).exists()) && (!newData.child('from').exists() || !newData.child('to').exists() || (!root.child('network').child('locations').child(newData.child('from').val()).child('section').exists() || !root.child('network').child('locations').child(newData.child('to').val()).child('section').exists() || root.child('network').child('locations').child(newData.child('from').val()).child('section').val() === root.child('network').child('locations').child(newData.child('to').val()).child('section').val())) && (newData.child('type').val() !== 'return' || !newData.child('link').child('saleId').exists() || !newData.child('to').exists() || !root.child('network').child('locations').child(newData.child('to').val()).child('section').exists() || !root.child('pos').child('sales').child(newData.child('link').child('saleId').val()).child('storeId').exists() || !root.child('network').child('posStores').child(root.child('pos').child('sales').child(newData.child('link').child('saleId').val()).child('storeId').val()).child('section').exists() || root.child('network').child('posStores').child(root.child('pos').child('sales').child(newData.child('link').child('saleId').val()).child('storeId').val()).child('section').val() === root.child('network').child('locations').child(newData.child('to').val()).child('section').val()) && (newData.child('type').val() !== 'sold' || !newData.child('link').child('saleId').exists() || !newData.child('from').exists() || !root.child('network').child('locations').child(newData.child('from').val()).child('section').exists() || !root.child('pos').child('sales').child(newData.child('link').child('saleId').val()).child('storeId').exists() || !root.child('network').child('posStores').child(root.child('pos').child('sales').child(newData.child('link').child('saleId').val()).child('storeId').val()).child('section').exists() || root.child('network').child('posStores').child(root.child('pos').child('sales').child(newData.child('link').child('saleId').val()).child('storeId').val()).child('section').val() === root.child('network').child('locations').child(newData.child('from').val()).child('section').val())",
      "type": {
        ".validate": "(newData.val() === 'received' && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(warehouse|admin)$/)) || (newData.val() === 'opening' && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(warehouse|admin)$/)) || (newData.val() === 'transfer_out' && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(warehouse|store|admin)$/)) || (newData.val() === 'transfer_in' && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(warehouse|store|admin)$/)) || (newData.val() === 'sold' && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(pos|store|admin)$/)) || (newData.val() === 'return' && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(pos|store|admin)$/)) || (newData.val() === 'adjustment' && root.child('users').child(auth.uid).child('stockRole').val() === 'admin')"
      },
      "reason": {
        ".validate": "newData.parent().child('type').val() !== 'adjustment' || (newData.isString() && newData.val().length > 0)"
      }
    },
    ".indexOn": [
      "ts"
    ]
  },
  "transfers": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    "$transferId": {
      ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(warehouse|store|admin)$/)",
      "status": {
        ".validate": "newData.val().matches(/^(dispatched|partially_received|received|discrepancy)$/)"
      },
      "from": {
        ".validate": "(!data.exists() || data.val() === newData.val()) && root.child('locations').child(newData.val()).exists()"
      },
      "to": {
        ".validate": "(!data.exists() || data.val() === newData.val()) && root.child('locations').child(newData.val()).exists()"
      },
      "createdAt": {
        ".validate": "!data.exists() || data.val() === newData.val()"
      },
      "lines": {
        "$pid": {
          "$sizeKey": {
            ".validate": "newData.isNumber() && newData.val() > 0"
          }
        }
      },
      "received": {
        "$pid": {
          "$sizeKey": {
            ".validate": "newData.isNumber() && newData.val() >= 0 && (!data.exists() || data.val() === newData.val())"
          }
        }
      },
      ".validate": "!newData.exists() || (!root.child('network').child('locations').child(newData.child('from').val()).child('section').exists() || !root.child('network').child('locations').child(newData.child('to').val()).child('section').exists() || root.child('network').child('locations').child(newData.child('from').val()).child('section').val() === root.child('network').child('locations').child(newData.child('to').val()).child('section').val())"
    }
  },
  "orders": {
    ".read": "auth != null && (!root.child('users').child(auth.uid).child('destShop').exists() || (query.orderByChild === 'destShop' && query.equalTo === root.child('users').child(auth.uid).child('destShop').val()))",
    ".indexOn": [
      "destShop",
      "readyNotifyPending",
      "customerId"
    ],
    "$id": {
      ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
      ".validate": "data.exists() || !newData.exists() || !newData.child('destShop').exists() || ((!newData.child('placedAtHub').exists() || (!root.child('network').child('locations').child(newData.child('placedAtHub').val()).child('section').exists() || !root.child('network').child('locations').child(newData.child('destShop').val()).child('section').exists() || root.child('network').child('locations').child(newData.child('placedAtHub').val()).child('section').val() === root.child('network').child('locations').child(newData.child('destShop').val()).child('section').val())) && (!newData.child('hub').exists() || (!root.child('network').child('locations').child(newData.child('hub').val()).child('section').exists() || !root.child('network').child('locations').child(newData.child('destShop').val()).child('section').exists() || root.child('network').child('locations').child(newData.child('hub').val()).child('section').val() === root.child('network').child('locations').child(newData.child('destShop').val()).child('section').val())))"
    }
  },
  "refill_requests": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    ".indexOn": [
      "createdAt",
      "resolvedAt"
    ],
    "$refillId": {
      ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').exists()",
      "status": {
        ".validate": "newData.val().matches(/^(open|fulfilled|cancelled)$/)"
      },
      "earlyRelease": {
        ".validate": "(root.child('users').child(auth.uid).child('stockRole').val() === 'admin' || auth.token.email === 'gunidmoh@gmail.com') && newData.hasChildren(['at','reason']) && newData.child('reason').isString() && newData.child('reason').val().length > 0"
      },
      ".validate": "data.exists() || !newData.exists() || !newData.child('requestingLocation').exists() || ((!newData.child('source').exists() || (!root.child('network').child('locations').child(newData.child('source').val()).child('section').exists() || !root.child('network').child('locations').child(newData.child('requestingLocation').val()).child('section').exists() || root.child('network').child('locations').child(newData.child('source').val()).child('section').val() === root.child('network').child('locations').child(newData.child('requestingLocation').val()).child('section').val())) && (!newData.child('createdFrom').child('source').exists() || (!root.child('network').child('locations').child(newData.child('createdFrom').child('source').val()).child('section').exists() || !root.child('network').child('locations').child(newData.child('requestingLocation').val()).child('section').exists() || root.child('network').child('locations').child(newData.child('createdFrom').child('source').val()).child('section').val() === root.child('network').child('locations').child(newData.child('requestingLocation').val()).child('section').val())) && (!newData.child('store').exists() || (!root.child('network').child('locations').child(newData.child('store').val()).child('section').exists() || !root.child('network').child('locations').child(newData.child('requestingLocation').val()).child('section').exists() || root.child('network').child('locations').child(newData.child('store').val()).child('section').val() === root.child('network').child('locations').child(newData.child('requestingLocation').val()).child('section').val())))"
    }
  },
  "sections_repair": {
    ".read": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
    ".write": false
  }
```

## Limits, stated plainly

- Every lookup is guarded by an `exists()` first: a rule that calls
  `child()` on a missing value fails closed and would refuse the write.
- A rule cannot see where a customer is standing. Clauses 2 and 3 on
  `stock_movements` rely on the POS record the movement links to; a movement
  with no link, or whose record does not exist yet, is not judged by them. The
  POS code is the first wall for those paths; the rule is the second.
- The `orders` and `refill_requests` clauses apply on create, so a record
  written before the paste can still be worked and closed.
- The admin SDK (Cloud Functions) bypasses rules. The functions carry their
  own checks: the engine acts only on live, same-side routes, and the
  first-batch trigger writes nothing for a shop outside Hub 2's section.

## Block 2 — added by the later areas

Paste with block 1. These are new keys or new children; none replaces an
existing rule wholesale. Where a parent already exists (`users/$uid`,
`pos_meta`, `push_assignments/$uid`, `network/locations/$id`), add the child
inside it.

```json
"orderCounter_byStore": {
  "$shop": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'"
  }
},
"refillCounter_byStore": {
  "$shop": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'"
  }
},
"central_dispatch": {
  ".read": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  "$mvId": {
    ".write": "!data.exists() && newData.exists() && auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').val().matches(/^(warehouse|store|admin)$/)",
    ".validate": "newData.hasChildren(['productId','size','qty','from','to','ts','actor','movementId']) && newData.child('actor').val() === auth.uid && newData.child('movementId').val() === $mvId && newData.child('qty').isNumber() && newData.child('qty').val() > 0 && newData.parent().parent().child('stock_movements').child($mvId).exists()"
  }
}
```

Children to add inside existing parents:

| parent | child | rule |
|---|---|---|
| `pos_meta` | `byStore/$storeId/$counter` | same read/write as the existing `pos_meta` counters; `.validate`: `newData.isNumber() && newData.val() >= 0 && (!data.exists() || newData.val() >= data.val()) && $counter.matches(/^last(Sale|Layby|Refund|Exchange|NoReceiptReturn)Number$/)` |
| `users/$uid` | `sections/$n` | `.validate`: `($n === '1' || $n === '2') && newData.val() === true`. Confirm no child rule under `users/$uid` lets a user write their own record. |
| `users/$uid` | `allSections` | `.validate`: `newData.val() === true` |
| `push_assignments/$uid` | `concrete-stockroom` | `.validate`: `newData.isBoolean()` |
| `network/locations/$id` | `pos` | optional; only if block 1's `/network` rule is tightened to reject unknown children |

What fails until each is pasted:

- `orderCounter_byStore`, `refillCounter_byStore`: a Pine or Concrete order is refused at the counter. Marathon PE and Trophy are unaffected.
- `pos_meta/byStore`: a Pine or Concrete sale can fail when reserving a number.
- `central_dispatch`: stock still moves; the dispatch cost row is dropped and not back-filled.
- `push_assignments/…/concrete-stockroom`: only switching the stockroom on as an alert hub is refused.

Proposed, not required for the build (enforces a device's or account's
section on stock writes; written out in the access commit's notes): AND onto
the `.write` of `/stock/$loc/$pid/$size`:

```
(auth.token.section === null || !root.child('network').child('locations').child($loc).child('section').exists() || root.child('network').child('locations').child($loc).child('section').val() === auth.token.section)
```
