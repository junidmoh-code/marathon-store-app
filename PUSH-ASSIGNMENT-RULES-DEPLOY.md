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
