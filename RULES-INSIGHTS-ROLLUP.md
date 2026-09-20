# `/insights_rollup` — the read rule for the day rollups

**Junid pastes this into the Firebase console himself.** Nothing in this repo
deploys database rules, and `database.rules.json` is stale and is not touched.

This is the second of two pastes. The first is `RULES-INSIGHTS-LOG-QUERY.md`
(the query-restricted read on `/insights_log`). They are independent — neither
depends on the other having landed.

---

## What the node is

One child per finished South African day, at `/insights_rollup/days/{YYYY-MM-DD}`,
holding that day's `/insights_log` rows dictionary-encoded.

Measured on the live node after the backfill: **139 days, 112,968 rows,
7.43 MB of rollup, 54.7 KB a day**, against 35.99 MB for the log itself. One
busy day (2026-09-18, 1,030 rows) is 335,409 bytes of log and 72,085 bytes of
rollup.

Alongside it:

| Path | What it holds | Who reads it |
|---|---|---|
| `/insights_rollup/days/{date}` | the day's rows, encoded | Insights, Customers, the Admin product line |
| `/insights_rollup/meta/built/{date}` | `{n, pe, trophy, pine, other}` — how many rows that day holds, per store | the sweep: which days are missing |
| `/insights_rollup/meta/logTotals` | the whole log's running per-store counts, stamped with the cursor they are exact as far as | the Insights sidebar's "N events in view" |
| `/insights_rollup/meta/cursor` | the sweep's high-water push key | the sweep |
| `/insights_rollup/meta/lastBuild` | what the last run did | people |
| `/insights_rollup/late/{date}/{pushKey}` | a row written far later than its own day, or with no usable timestamp | the readers, merged in |

It is **derived and disposable**. Every byte of it can be rebuilt from
`/insights_log` by `scripts/backfill-insights-rollup.mjs`, which is why the
write side is closed to clients entirely.

---

## The change, side by side

**Current — there is no block. `/insights_rollup` is absent from the live rules
read from `/.settings/rules.json` on 2026-09-20**, so it inherits the database
root's default and is unreadable by clients:

```json
// (nothing — the node has no entry)
```

**Add:**

```json
"insights_rollup": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".write": false
},
```

Two things worth saying about it:

1. **`.write` is `false`, flatly.** The writer is a Cloud Function
   (`insightsRollupSweep`) and a one-off script, both on the Admin SDK, which
   bypasses rules. No client has any business writing here, and a rollup a
   client can write is a set of numbers a client can make up.
2. **The read matches `/insights_log`'s own** — any signed-in, non-anonymous
   user. This node is strictly less than the log it is derived from, so a rule
   that let somebody read the log and not the rollup would protect nothing.

No query constraint, deliberately: unlike `/insights_log`, the expensive shape
here does not exist. The whole node is a few megabytes, the readers ask for a
key range of days anyway, and a constraint would refuse the sweep's own index
read for no benefit.

---

## Sequencing: this one is NOT a gate

The app does not break if the rule is late. A read of `/insights_rollup` that
comes back `PERMISSION_DENIED` is treated as "no rollup exists yet": the window
is read from `/insights_log` by bounded key range instead, which is what those
screens did before any of this, and the result carries `degraded` so nobody
mistakes a missing rule for a working rollup
(`src/insights/rollupStore.test.js`).

So the order is whatever is convenient:

1. paste this block;
2. `firebase deploy --only functions:insightsRollupSweep`;
3. `node scripts/backfill-insights-rollup.mjs --dry-run`, then without it
   (one pass, about 160 MB of server-side reads, roughly $0.15);
4. deploy hosting.

Until step 3 finishes there is no rollup to read and every window is served
live — correct, and costing what it costs today.

## Verifying it landed

The running counter and the day index are built by two different passes over
the same log, so they cross-check each other. Run 2026-09-20, after the
backfill:

```
day index (139 finished days)   112,968   pe 88,121  trophy 10,362  pine 14,485
running counter (whole log)     113,608   pe 88,653  trophy 10,425  pine 14,530
difference                          640   pe    532  trophy     63  pine     45
```

The difference is today, which is never rolled up. Every column agrees.

## Rollback

Delete the block. The screens fall back to the log on their next read, which is
the behaviour this PR replaced. Nothing is lost: `/insights_rollup` holds no
data that is not derived from `/insights_log`, and `/insights_log` is never
written to, moved or deleted by any of this.
