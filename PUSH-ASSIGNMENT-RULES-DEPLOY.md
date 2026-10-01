# Admin-assigned, hub-scoped notifications — the RTDB rules to paste

**This paste is the gate.** The live rules have no root `.read`/`.write`, so
until these two nodes exist in the published document every save on the
Notifications admin card is `PERMISSION_DENIED` and the fan-out finds nobody.
The screen will look broken and no order will notify anyone.

`database.rules.json` in this repo is STALE and console-managed — it is not
edited here and deploying it would regress the live document
(`project_live_rules_drift`). Paste these into
**Firebase Console → Realtime Database → Rules**, as siblings of the existing
top-level entries, then **Publish**.

Nothing in the previously pasted push rules changes. `push_tokens`,
`notification_prefs`, `push_audience` and `push_bursts` stay exactly as they
are — see `PUSH-RULES-DEPLOY.md`. (`/notification_prefs` is now unread and
unwritten by the app; its rule is harmless and is left alone rather than
removed, so nothing has to be un-pasted.)

## The paths

| Path | Written by | Read by |
|---|---|---|
| `/push_assignments/{uid}` | the super-admin, and nobody else | the admin card |
| `/push_hub_audience/hub3/{uid}` | the super-admin, and nobody else | the Cloud Function — **new 2026-09-08** |
| `/push_hub_audience/{hub}/{uid}` | the super-admin, and nobody else | the Cloud Function (Admin SDK, bypasses rules) |

## The rules

```json
"push_assignments": {
  ".read":  "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  ".write": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  "$uid": {
    ".validate": "newData.hasChildren(['hub1','hub2','updatedAt'])",
    "hub1":      { ".validate": "newData.isBoolean()" },
    "hub2":      { ".validate": "newData.isBoolean()" },
    "hub3":      { ".validate": "newData.isBoolean()" },
    "updatedAt": { ".validate": "newData.isNumber()" },
    "$other":    { ".validate": false }
  }
},

"push_hub_audience": {
  ".read":  "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  ".write": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  "$hub": {
    "$uid": {
      ".validate": "newData.hasChild('at')",
      "at":     { ".validate": "newData.isNumber()" },
      "$other": { ".validate": false }
    }
  }
}
```

## Why each clause is load-bearing

**The super-admin email on `.write`, not `auth != null`, and not a stockRole.**
This is the entire access model of the feature. `push_hub_audience` IS the
recipient list the Cloud Function reads — a staff member who could write it
could add their own uid to Hub 1 and receive every Hub 1 order (surveillance of
a colleague's workload, and a phone buzzing all night), or delete a colleague's
entry and silently stop their alerts, which looks exactly like the feature not
working and would be found by nobody. Gating on `stockRole` would reintroduce
the very coupling this release removes: a stock grant would once again change
who gets woken up.

The same email is what already gates `/users` in the live document, so this is
the established idiom rather than a new one, and it is the one clause a UI-only
gate cannot substitute for. The admin card is gated twice in the client as well
(route and component), but neither of those is enforcement — this is.

**`.read` is admin-only too.** The index answers "whose phone can I reach, and
for which hub" for every member of staff. It is roster data about other people;
there is no screen that needs a non-admin to read it.

**`hasChildren(['hub1','hub2','updatedAt'])` with `$other: false`.** The record
is a closed shape: two booleans and a stamp. Without the closed shape a future
bug — or a console paste — could park a third field on a record and have it
stored and served forever, and `assignedHubs()` would keep ignoring it while a
reader assumed it meant something.

**Booleans, not strings.** `assignedHubs()` counts only a real boolean `true`,
deliberately, so that corruption degrades to silence. The rule makes the same
statement at the other end: a `"true"` string never gets stored in the first
place.

**`updatedAt` is a number, and it comes from `serverNowMs()`.** A rules-validated
timestamp written from a till's clock is not evidence of when anything happened
(`src/utils/serverTime.js`). The card passes the server clock; the rule refuses
anything that is not a number.

**An empty assignment is a DELETE, never `{hub1:false, hub2:false}`.** Absence
is the off state. `assignmentUpdates()` writes `null` for both the record and
both index entries, so there is exactly one representation of "off" and no rule
has to be written to distinguish two.

## Verifying it took

Open **Admin → Notifications** (`/#admin/notifications`) as the super-admin,
assign yourself to Hub 1, and check the console shows
`/push_assignments/{your uid}` = `{hub1: true, hub2: false, updatedAt: …}` and
`/push_hub_audience/hub1/{your uid}` = `{at: …}`. Clearing the assignment must
remove BOTH. If the console shows nothing, the paste did not publish or landed
inside another node — the browser console will be logging
`[push] assignment save failed`.


## 2026-09-08 — Hub 3 (Pine) became assignable

Pine was left out on the reasoning that it picks on its own floor. That is
reversed. It was never a quiet exclusion: in the fourteen days to 2026-09-08 the
live log holds **714 orders placed at hub3**, every one with a real `hub` of
`"hub3"` and a `destShop` of `"marathon-pine"` — none refused as `no_hub` or
`bad_hub`, none a refill. They passed every guard in the fan-out and arrived at
an audience node that could never have had anybody in it.

### What changed in the rule — one line

A `hub3` child, validated as a boolean, inside `push_assignments/$uid`. Nothing
else moves: both `.read` and `.write` still name only the super-admin, `$other`
is still `false`, and `push_hub_audience` is untouched (its `$hub` wildcard
already accepted `hub3`; only the code that writes there had to learn to).

### Why `hub3` is NOT added to `hasChildren`

**This is the compatibility hinge, and getting it wrong refuses every existing
assignment.** `hasChildren(['hub1','hub2','updatedAt'])` stays exactly as it is.

Every record written before today has three children and no `hub3`. Requiring
`hub3` would make each of them invalid the moment anything touched it — and it
would also refuse a write from any browser still running a cached two-hub
bundle, which is a real state for as long as a service worker holds one.
Listing `hub3` as an optional, type-checked child accepts **both** shapes:

| record | `hasChildren` | `hub3` rule | `$other` | verdict |
|---|---|---|---|---|
| `{hub1,hub2,updatedAt}` (legacy) | ✅ | not present, nothing to check | ✅ | **accepted** |
| `{hub1,hub2,hub3,updatedAt}` (new) | ✅ | boolean ✅ | ✅ | **accepted** |
| `{hub1,hub2,hub3:"true",updatedAt}` | ✅ | **not a boolean** ❌ | — | rejected |
| `{hub1,hub2,hub4,updatedAt}` | ✅ | — | **`$other` false** ❌ | rejected |
| `{hub1,updatedAt}` | **❌** | — | — | rejected |

There is no migration and none is needed: a legacy record reads as "not
assigned to Hub 3" (`assignedHubs` counts only a real boolean `true`, so an
absent child is false), and the next save from the card rewrites it in the new
shape.

### 🚨 Order of operations — PASTE THIS BEFORE THE HOSTING DEPLOY

Not a preference. Get it wrong and **every save on the card fails, not just the
Hub 3 ones.**

The new card writes the whole record, so every save it makes now carries a
`hub3` child — including a save that only turns Hub 1 on. Under the OLD rule
`hub3` is not a declared child, so it falls through to `$other`, whose
`.validate` is `false`, and the entire write is refused. The card degrades
honestly (the row rolls back and the amber banner names this document) but
nobody can change any assignment until the rule is published.

Pasting FIRST cannot break anything. The old two-hub card never sends a `hub3`
child, and the new rule does not require one — that is the whole point of
leaving `hub3` out of `hasChildren`. So the safe order is:

1. paste this rule and **Publish**
2. deploy hosting
3. open `/#admin/notifications` and check a Hub 3 switch saves

If hosting somehow went out first, the fix is to paste the rule — nothing needs
rolling back and no data is damaged, because every refused write was refused
whole.
