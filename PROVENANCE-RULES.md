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
4. **Deploy hosting** — `firebase deploy --only hosting:marathon-club`.

**The order is binding in both directions.**

Doing **1 late** fails loudly: the backfill uses the Admin SDK and bypasses rules, but the
app's forward maintenance (`applyMovement`) is a client write inside the atomic stock
update, so an unruled path rejects the whole movement — the cell and the ledger record
along with it. Every stock write in the app would fail.

Doing **2 late** used to be described here as "safe but pointless". **That was wrong**, and
CodeRabbit caught it on PR #376. An unready index makes `resolveTarget` return null for
every rule-managed cell, and the engine's `needGone` branch would have read that as
"nobody needs this any more" — cancelling the entire live rule-managed queue at every
destination in one scan, orders deleted. The engine is now guarded (the `!t` withdrawal
branch requires a ready index, `refill-engine.cjs`), so a missing or unreadable index
pauses new demand and withdraws nothing *on account of being missing*.

To be precise, because the imprecise version of this sentence was itself a review finding:
an unready index suppresses only the **provenance-dependent** withdrawal — the one where no
target resolved at all. Withdrawals that rest on their own evidence carry on as they should:
an explicit `target: 0` row (a human's "excluded") and a request whose target is already met
by stock on hand. Neither consults provenance, so neither should pause. Step 2 still belongs
before step 3, but getting it wrong no longer destroys the queue.

**4 goes last, and this is now a correctness requirement rather than tidiness.** The
backfill SETs counters from a ledger read. If the app's forward maintenance is live at the
same time, some of those increments are overwritten — and that is not a harmless staleness.
The predicate is `k − u > 0`, so overwriting a concurrent **`u`** increment makes net
stocking LARGER and can arm a shop that holds nothing: the exact bug this index exists to
prevent, reintroduced by its own repair path. (Found by CodeRabbit on PR #376, after two
earlier reconciliation designs had already been rejected for double-counting.)

No write protocol fixes this from the ledger alone, because "was this already counted" is
not a question the ledger answers. So the backfill **detects** whether it ran alone and
either claims authority or removes the readiness sentinels, leaving every location unarmed
for a later quiet run — never a half-trusted index. With hosting deployed last, the app
carrying the provenance leg is not live during the backfill and the run is quiescent by
construction. The POS app never writes this node.

If the backfill reports **CONTENDED** and removes the sentinels, nothing is broken: at an
unready location the engine arms nothing new and withdraws nothing because of the missing
index (explicit-0 and target-met withdrawals continue, as above). Re-run it in a quiet
window.

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
          "s": {
            ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').exists() && newData.exists()",
            ".validate": "newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0 && newData.val() >= (data.exists() ? data.val() : 0)"
          },
          "k": {
            ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').exists() && newData.exists()",
            ".validate": "newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0 && newData.val() >= (data.exists() ? data.val() : 0)"
          },
          "u": {
            ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && root.child('users').child(auth.uid).child('stockRole').exists() && newData.exists()",
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

**`.write` sits on each COUNTER, not on `$pid`, and requires `newData.exists()`.** Both
halves matter, and the first version of these rules got it wrong (CodeRabbit, PR #376).

`.validate` rules are **skipped entirely when a write is a deletion** — otherwise
required data could never be removed. So validation cannot stop a delete; only `.write`
can. And a `.write` grant at `$pid` cascades to every descendant, which would let any
`stockRole` client issue `set(null)` on `stock_provenance/{loc}/{pid}/k` and erase a
shop's stocking history. `carriesByIndex()` would then read false and the engine would
stop replenishing a line the shop genuinely sells — a silent starvation with no error
anywhere and nothing in the ledger to explain it.

Granting write only on `s`, `k` and `u`, each conditioned on `newData.exists()`, closes
both: a client may raise a counter and may create the pair by writing one, but cannot
null a counter and cannot touch the `$pid` node itself (no rule grants it). The Admin
SDK bypasses all of this, which is what still lets the backfill rewrite or clear a
record.

The `stockRole` condition is byte-identical to `/stock`'s, so there is no second answer
to "who may move stock" to keep in sync — the index is maintained inside the same atomic
`update()` that writes the cell and the ledger record (Commit 5), so exactly the people
who may move stock must be able to write it.

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
