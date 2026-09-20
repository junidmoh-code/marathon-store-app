# `/insights_rollup` — the read rule for the day rollups

**Junid pastes this into the Firebase console himself.** Nothing in this repo
deploys database rules, and `database.rules.json` is stale and is not touched.

This is the second of two pastes. The first is `RULES-INSIGHTS-LOG-QUERY.md`
(the query-restricted read on `/insights_log`). They are independent — neither
depends on the other having landed.

---

## What the node is

One child per finished South African day, at `/insights_rollup/days/{YYYY-MM-DD}`,
holding that day's `/insights_log` rows dictionary-encoded. Measured on a real
trading day, 2026-09-18: **338,270 bytes → 72,439**, with every row intact.

Alongside it:

| Path | What it holds | Who reads it |
|---|---|---|
| `/insights_rollup/days/{date}` | the day's rows, encoded | Insights, Customers, the Admin product line |
| `/insights_rollup/meta/built/{date}` | `{n, pe, trophy, pine, other}` — how many rows that day holds, per store | the sweep (which days are missing), and the Insights sidebar's "N events in view" |
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
3. `node scripts/backfill-insights-rollup.mjs --dry-run`, then without it;
4. deploy hosting.

Until step 3 finishes there is no rollup to read and every window is served
live — correct, and costing what it costs today.

## Rollback

Delete the block. The screens fall back to the log on their next read, which is
the behaviour this PR replaced. Nothing is lost: `/insights_rollup` holds no
data that is not derived from `/insights_log`, and `/insights_log` is never
written to, moved or deleted by any of this.
