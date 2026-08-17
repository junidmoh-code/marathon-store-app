# `/stock_provenance` — console rules to publish

**These rules must be published BEFORE the rewired functions deploy.** On 2026-08-13 a
shipped read against an unruled path blocked 272 price saves; this is the same shape of
risk in the write direction. `database.rules.json` in this repo is **stale and
console-managed** — nothing here edits it, and nobody should run
`firebase deploy --only database`.

## Order of operations

1. **Paste the rules below** in the Firebase console → Realtime Database → Rules → Publish.
2. **Run the backfill** — `node scripts/backfill-stock-provenance.mjs --execute`.
   It writes pair records first and the readiness sentinel last, per location.
3. **Deploy the functions** — `firebase deploy --only functions:refillHealthScan`.

Doing 3 before 2 is safe but pointless: the engine refuses to arm a location whose
sentinel is missing, so every location would go quiet until the backfill lands. Doing
either before 1 fails: the backfill uses the Admin SDK and bypasses rules, but the
**app's** forward maintenance (`applyMovement`) is a client write and would be denied,
taking every stock write down with it — the whole multi-path update is atomic, so a
denied provenance leg rejects the movement and the ledger record too.

## Where it goes

A new top-level sibling of `"stock"`, inside the existing `"rules"` object.

```json
    "stock_provenance": {
      ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
      "_meta": {
        ".write": false
      },
      "$loc": {
        "$pid": {
          ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').exists()",
          "s": {
            ".validate": "newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0 && newData.val() >= (data.exists() ? data.val() : 0)"
          },
          "k": {
            ".validate": "newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0 && newData.val() >= (data.exists() ? data.val() : 0)"
          },
          "u": {
            ".validate": "newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0 && newData.val() >= (data.exists() ? data.val() : 0)"
          },
          "$other": {
            ".validate": false
          }
        }
      }
    },
```

## Why each line is there

**`.read` — authenticated, non-anonymous.** Byte-identical to `/stock`'s read rule. The
engine runs on the Admin SDK and bypasses rules entirely, so this read is for the app:
the Health view has to be able to show that the index is unreadable or unready, which is
the loud failure the fail-closed design depends on. An anonymous read is denied for the
same reason it is on `/stock` — quantities and assortment are commercial data.

**`_meta` is `.write: false`.** The readiness sentinel is what licenses the engine to
arm a location. A client that could forge it could arm a location against an index that
was never built. Only the Admin SDK writes it, and only the backfill does that, last,
after the pairs are in. A named child beats the `$loc` wildcard in RTDB rule matching,
so this denial genuinely shadows the writable branch below — it is not decoration.

**`.write` — the same `stockRole` gate as `/stock`.** The index is maintained inside the
same atomic `update()` that writes the cell and the ledger record (Commit 5), so anyone
who may move stock must be able to write it, and nobody else may. Reusing `/stock`'s
exact condition means there is no second answer to "who may move stock" to keep in sync.

**Counters validate as monotonic non-negative integers.** `newData.val() >= data.val()`
is the load-bearing half. Forward maintenance uses `ServerValue.increment(qty)` with a
positive `qty`, so a legitimate write always raises the counter and always passes. A
client attempting `increment(-n)` — the only way to make a shop stop "carrying" a line
from the app — produces a result below the stored value and is refused. Un-arming is
therefore an owner action through the target/policy, never something a till can do by
accident. The Admin SDK bypasses this, which is exactly what lets the backfill re-run
and correct counters downward if forward maintenance ever drifts.

`% 1 === 0` keeps them whole: `k` counts units and `s` counts sale events, and a
fractional counter would be a symptom of a caller passing something that is not a
quantity.

**`$other` is `.validate: false`.** The three counters are the whole contract. A fourth
key would either be junk or a second, unreviewed meaning for "carries" — and this node
is read on all 49 engine runs a day, so anything stored here is paid for repeatedly.

## What is NOT here, deliberately

There is **no** validation tying a counter to `/stock` or `/stock_movements`. It would
read another subtree on every till write for no safety: the counters are derived, the
ledger is authoritative, and the backfill is the reconciliation. Rules that re-derive
data are how a hot write path acquires a hidden dependency on a cold one.

## Rollback

Deleting the `"stock_provenance"` block denies the app's forward-maintenance writes,
which — because the update is atomic — would reject every stock movement. **Do not roll
back the rules while the rewired engine is live.** Roll back in the reverse order of
publication: redeploy the previous `refillHealthScan`, then remove the rules block.
