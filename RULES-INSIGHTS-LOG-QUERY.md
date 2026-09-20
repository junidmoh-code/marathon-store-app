# `/insights_log` — a read rule that refuses the whole-node read

**Junid pastes this into the Firebase console himself.** Nothing in this repo
deploys database rules, and `database.rules.json` is stale and is not touched.

---

## Why a rule, and not only a client fix

`/insights_log` is **35.99 MB** and **112,968 entries**. On 2026-09-20 the cost
watcher recorded **97 whole-node reads of it in 18 hours** — 3,505,862,777 bytes,
**$3.19 for the day**, every one of them the same request:

```
GET /insights_log.json        # no orderBy, no limit, no range
```

The largest-reads table names them individually, at 35.97–35.99 MB each, almost
all from `uid:vWfHqbLE`.

A client-side fix alone cannot stop them. The device doing it is running an old
bundle in a parked tab; the account is shared, so the device cannot be chased;
and signing the account out does not replace a web app's code. **The only thing
that reaches a client running code we cannot change is a rule.**

The rule below refuses the one request shape that costs: a read with no query
on it. Everything the app actually does — the paged history walk, the tail, the
Source view's five-day window, the duplicates page, the offline mirror's
download — carries a query and is unaffected.

---

## The change, side by side

**Current — live in the console, read 2026-09-20 from `/.settings/rules.json`:**

```json
"insights_log": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'"
},
```

**Replace it with:**

```json
"insights_log": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && query.orderByKey == true && ((query.limitToFirst != null && query.limitToFirst <= 10000) || (query.limitToLast != null && query.limitToLast <= 10000) || query.startAt != null || query.endAt != null)",
  ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  "$entry": {
    ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'"
  }
},
```

Three things changed and nothing else:

1. **The read must be a query.** `query.orderByKey == true` plus at least one
   bound. A request with no query carries no bounds at all, so it fails here.
2. **A limit, if that is the bound, has a ceiling.** Without the `<= 10000`,
   `limitToLast(1000000)` is the whole node again with a query modifier stapled
   to it, and the rule would be decoration.
3. **`$entry` keeps single-record reads working.** The old rule allowed them
   implicitly; removing that would be a behaviour change nobody asked for. It is
   not a loophole: pulling the node this way is 112,968 separate requests.

`.write` is untouched. Every writer — the store app, the POS, the refill engine —
keeps writing exactly as before.

### What this rule does NOT claim

**It is not airtight.** `startAt("-")` with no `endAt` is a legal query and is
the whole node; rules cannot compare key distances, so no expression catches
it. What the rule does is refuse the **query-less** read — the shape that is
actually billing $3.19 a day and the shape a stale bundle issues.

**It also refuses `equalTo`.** `orderByKey().equalTo(k)` sets `query.equalTo`,
which no clause here names, so that read is denied. Nothing in either app uses
it today, and a single-record read has `$entry` — but a future reader reaching
for `equalTo` will get a permission error, and this is where that is written
down.

---

## Every client read path, checked against the rule before printing it

| # | Where | Query | Passes |
|---|---|---|---|
| 1 | `InsightsLogProvider` history walk (`readByKeyPages`, page 1) | `orderByKey` + `limitToFirst(10000)` | ✓ limit — the page size IS the rule's ceiling |
| 2 | …pages 2+ | `orderByKey` + `startAfter` + `limitToFirst(10000)` | ✓ limit |
| 3 | `InsightsLogProvider` tail (`insightsLogQueries.tail`) | `orderByKey` + `startAt(a key below the walk's last)` | ✓ range |
| 4 | `useInsightsLogRecentDays` — Source view, 5 days (`App.jsx`) | `orderByKey` + `startAt(dayKey)` | ✓ range |
| 5 | `duplicateSales.js` — Duplicates tab page | `orderByKey` + `startAt(cursor)` + `limitToFirst` | ✓ both |
| 6 | offline mirror `readChildPage` (`rtdbAdapter.js`) | `orderByKey` + `startAfter` + `limitToFirst` | ✓ limit |
| 7 | offline mirror `readKeyRange` | `orderByKey` + `startAt`/`endAt` + `limitToFirst` | ✓ both |
| 8 | offline mirror first/last key probes | `orderByKey` + `limitToFirst(1)` / `limitToLast(1)` | ✓ limit |
| 9 | marathon-pos-app | **writes only** — `logOrderCollection.js` pushes, never reads | n/a |
| 10 | `analyzeReorderNeeds`, `chatStream` (Cloud Functions) | Admin SDK — bypasses rules entirely | n/a |
| 11 | `scripts/backfill-depleted-from-history.mjs:84` | client SDK, **whole node**, anonymous auth | **would be refused** — and already is, by the current rule's anonymous clause. A one-off that has run and must not run again (`project_depleted_backfill_done`). |
| 12 | `scripts/targets/extract-demand.mjs:58` | `firebase database:get /insights_log` — whole node, owner OAuth | n/a — an owner credential bypasses rules. Listed so nobody later reads its success as evidence the rule is loose. |

Rows 11 and 12 were missed in the first draft of this table and found in
review. Neither is an app screen and neither changes behaviour, but "every
client read path" has to mean every one.

Paths 1–3 are new in this PR and exist *because* of this rule: the provider used
to issue `onValue(ref(db, "insights_log"))`, which is row #0 of this table and
the one the rule refuses. `src/insights/insightsLogWholeReadShape.test.js`
asserts the shape of each of them against the real modules, so a revert to the
bare read fails a build rather than a bill.

**Path 3 uses `startAt`, not `startAfter`, deliberately.** The rule variable is
`query.startAt`; there is no documented variable that names `startAfter`. The
bound is also deliberately set *below* where the walk ended — a device whose
push-key clock runs behind can write a row that sorts under the walk's cursor,
and a tail starting at that cursor would lose it silently. The overlap is
re-offered and dropped by key. See `src/insights/insightsLogWholeRead.js`.

---

## Order of operations

1. **Deploy the hosting bundle from this PR first.** It contains paths 1–3. If
   the rule goes first, current clients break on Insights, Customers and the
   Admin product line until the bundle lands.
2. Paste the block above into **Firebase console → Realtime Database → Rules →
   Publish**.
3. Run the control (below). The negative case must flip from 200 to 401.

## What will break, on purpose — and the deviation this represents

The brief said the rule "must not break any current-version screen". Read
strictly, **this rule breaks three screens on the version that is live right
now**, between the moment it is pasted and the moment a given device picks up
the new bundle. That is not an oversight and it is not a technicality: it is
the owner's instruction of 2026-09-20 — *"the rule is the only fix that works
regardless of client version"* — and refusing the old bundle's read is the
entire mechanism. It is recorded here as a deviation rather than left to be
discovered.

Concretely: any client still running an older bundle gets `PERMISSION_DENIED`
on **Insights**, **Customers** and the Admin product "N orders all-time" line.
Those devices keep working everywhere else, including the Source view (path 4,
unaffected).

**Do not expect the auto-update checker to clear this by itself.** It exists
(`src/update/updateChecker.js`) and it demonstrably did not reach the device
producing 97 whole-node reads a day — which is the premise of this whole change.
Making stale clients reload reliably is separate work (COMMIT 3 of the brief)
and is not in this PR. Until it lands, a device stuck on an old bundle shows a
permission error on those three screens until somebody reloads it.

---

## The control

```bash
bash scripts/insights-log-rule-probe.sh
```

It signs in as a throwaway email/password client — **not** an admin credential,
which would bypass rules and prove nothing — issues both requests, and deletes
the account.

**Before the paste** (`--include-before`; note this run SERVES the unbounded
read, so it pulls part of a 36 MB body — see the script header). Run
2026-09-20 17:52 SAST:

```
── POSITIVE CONTROL — a bounded read must still work ──────────────────
   GET /insights_log.json?orderBy="$key"&limitToFirst=1
   -> http=200 bytes=216

── NEGATIVE CONTROL — the unbounded whole-node read ───────────────────
   GET /insights_log.json          (no orderBy, no limit, no range)
   -> http=200

✗ RULE IS NOT LIVE — the unbounded read was served.
```

**After the paste, expected:**

```
   GET /insights_log.json?orderBy="$key"&limitToFirst=1   -> http=200 bytes=216
   GET /insights_log.json                                 -> http=401

✓ RULE IS LIVE — the unbounded read is refused.
```

The negative call is capped with `--max-filesize`, which aborts the transfer —
but only after the server has begun pushing, so a pre-paste run costs tens of
kilobytes on the wire, not zero. The script prints what it pulled. Once the
rule is live the call is a 401 with no body and the control is free.

The verdict is gated on the positive control: if the bounded read does not come
back 200, the script exits `INCONCLUSIVE` without interpreting the second call.
A rejected token 401s both requests, and reading only the second would announce
success having tested nothing.

## What this change costs to investigate

Bytes this work read from production, all bounded, none of them a whole-node
read except the one the negative control deliberately provokes:

| Read | Bytes |
|---|---|
| `/cost_watch` latest + two day summaries + one hour node | ~10,700 |
| `/.settings/rules.json` (the live block above) | 51,831 |
| one SA day of `/insights_log` by key range (2026-09-18, 1,030 rows) | 335,409 |
| `/customers?shallow=true` (9,709 keys) | 179,979 |
| `/returns_log?shallow=true` (2,803 keys) | 78,485 |
| the probe's bounded read | 216 |
| **total** | **~657 KB** |

Plus the pre-paste negative control, which was served and aborted: tens of KB,
not separately measurable from `curl`.

## Rollback

Paste the "Current" block back. It is a two-line `.read`/`.write` pair and
restores the exact behaviour in production today, including the whole-node read.
