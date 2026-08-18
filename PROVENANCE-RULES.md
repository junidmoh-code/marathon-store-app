# `/stock_provenance` — console rules to publish

**These rules must be published BEFORE the rewired functions deploy.** On 2026-08-13 a
shipped read against an unruled path blocked 272 price saves; this is the same shape of
risk in the write direction. `database.rules.json` in this repo is **stale and
console-managed** — nothing here edits it, and nobody should run
`firebase deploy --only database`.

## Order of operations

1. **Paste the rules below** in the Firebase console → Realtime Database → Rules → Publish.
2. **Deploy hosting** — `firebase deploy --only hosting:marathon-club`.
3. **Run the backfill IN A QUIET WINDOW** — `node scripts/backfill-stock-provenance.mjs --execute`.
   Outside trading hours. It refuses and removes the sentinels if anything writes
   provenance while it runs, which during trading it will.
4. **Deploy the functions** — `firebase deploy --only functions:refillHealthScan`.

**⚠ THIS ORDER WAS REVISED 2026-08-17. Hosting moved from LAST to SECOND.** The earlier
version put hosting last so the backfill could not race forward maintenance. That was
right about the race and wrong about the cost, because it left a window in which the
index was materialised but *not maintained* — and that window is not safe in both
directions.

Measured on the live ledger: an unrecorded `STOCKING` or `SALE` movement leaves a
counter too LOW, so the predicate under-states carriage and fails toward NOT arming —
harmless. But an unrecorded **UNSTOCK** leaves `u` too low, so `k − u` is too HIGH, so
the index **over-states** carriage and fails toward arming a shop that holds nothing.
That is the bug this whole index exists to prevent, so a window that can produce it is
not acceptable regardless of how narrow it is.

Rate at which it matters: ~880–1,000 movements/day overall (105–139/hour in trading),
of which UNSTOCK is **14 in 59 days** — 0.24/day, one every ~4 days, all
`clothing_cr_undo`. So the exposure was small. It was still the wrong direction, and
sequencing hosting second removes it entirely: forward maintenance is live before the
index is published, so there is no unmaintained window at all.

The cost of the new order is that step 3 must run quiet. The backfill detects contention
and refuses rather than publishing something it cannot vouch for, so a daytime run is
safe but will simply decline. Run it before 07:00 or after 19:00.

Doing **1 late** fails loudly: the backfill uses the Admin SDK and bypasses rules, but the
app's forward maintenance (`applyMovement`) is a client write inside the atomic stock
update, so an unruled path rejects the whole movement — the cell and the ledger record
along with it. Every stock write in the app would fail. Rules genuinely must be first.

Doing **4 early** is not destructive but silences all rule-based and category-based
auto-refill until the backfill claims authority: the engine refuses to arm a location
whose sentinel is missing. An unready index withdraws nothing *on account of being
missing* — the `needGone` guard covers that — though explicit `target: 0` and target-met
withdrawals continue, because neither consults provenance.

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
