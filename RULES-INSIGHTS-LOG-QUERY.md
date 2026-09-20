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

It cannot arithmetic-bound a key range: `startAt("-")` with no `endAt` is a
legal query and is the whole node. Rules cannot compare key distances, so there
is no expression that would catch it. What the rule does is refuse the
**query-less** read, which is the shape that is actually billing $3.19 a day and
the shape a stale bundle issues. Stating the limit here rather than implying
airtightness is the point.

---

## Every client read path, checked against the rule before printing it

| # | Where | Query | Passes |
|---|---|---|---|
| 1 | `InsightsLogProvider` history walk (`readByKeyPages`, page 1) | `orderByKey` + `limitToFirst(5000)` | ✓ limit |
| 2 | …pages 2+ | `orderByKey` + `startAfter` + `limitToFirst(5000)` | ✓ limit |
| 3 | `InsightsLogProvider` tail (`insightsLogQueries.tail`) | `orderByKey` + `startAt(lastKey)` | ✓ range |
| 4 | `useInsightsLogRecentDays` — Source view, 5 days (`App.jsx`) | `orderByKey` + `startAt(dayKey)` | ✓ range |
| 5 | `duplicateSales.js` — Duplicates tab page | `orderByKey` + `startAt(cursor)` + `limitToFirst` | ✓ both |
| 6 | offline mirror `readChildPage` (`rtdbAdapter.js`) | `orderByKey` + `startAfter` + `limitToFirst` | ✓ limit |
| 7 | offline mirror `readKeyRange` | `orderByKey` + `startAt`/`endAt` + `limitToFirst` | ✓ both |
| 8 | offline mirror first/last key probes | `orderByKey` + `limitToFirst(1)` / `limitToLast(1)` | ✓ limit |
| 9 | marathon-pos-app | **writes only** — `logOrderCollection.js` pushes, never reads | n/a |
| 10 | `analyzeReorderNeeds`, `chatStream` (Cloud Functions) | Admin SDK — bypasses rules entirely | n/a |

Paths 1–3 are new in this PR and exist *because* of this rule: the provider used
to issue `onValue(ref(db, "insights_log"))`, which is row #0 of this table and
the one the rule refuses. `src/insights/insightsLogWholeReadShape.test.js`
asserts the shape of each of them against the real modules, so a revert to the
bare read fails a build rather than a bill.

**Path 3 uses `startAt`, not `startAfter`, deliberately.** The rule variable is
`query.startAt`; there is no documented variable that names `startAfter`. The
inclusive bound re-offers one row, which the reader drops by key.

---

## Order of operations

1. **Deploy the hosting bundle from this PR first.** It contains paths 1–3. If
   the rule goes first, current clients break on Insights, Customers and the
   Admin product line until the bundle lands.
2. Paste the block above into **Firebase console → Realtime Database → Rules →
   Publish**.
3. Run the control (below). The negative case must flip from 200 to 401.

## What will break, on purpose

Any client still running a bundle older than this deploy will get
`PERMISSION_DENIED` on **Insights**, **Customers** and the Admin product
"N orders all-time" line. That is the intended effect and the reason the rule
exists: those are the screens issuing the 35.99 MB read. Those devices keep
working everywhere else, including the Source view (path 4, unaffected), and
the auto-update checker reloads them onto the new bundle.

---

## The control

```bash
bash scripts/insights-log-rule-probe.sh
```

It signs in as a throwaway email/password client — **not** an admin credential,
which would bypass rules and prove nothing — issues both requests, and deletes
the account.

**Before the paste, run 2026-09-20 17:52 SAST:**

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

The negative call is capped with `--max-filesize` so the control does not
itself download 36 MB to prove that it can.

## Rollback

Paste the "Current" block back. It is a two-line `.read`/`.write` pair and
restores the exact behaviour in production today, including the whole-node read.
