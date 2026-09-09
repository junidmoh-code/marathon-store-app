# The mute — one new node, one rule to paste

**Path:** a new top-level `push_mutes`.

`database.rules.json` in this repo is STALE and console-managed — it is not
edited here and deploying it would regress the live document
(`project_live_rules_drift`). Paste this into **Firebase Console → Realtime
Database → Rules**, as a sibling of the existing top-level entries, then
**Publish**.

## The rule

```json
"push_mutes": {
  "$uid": {
    ".read":  "auth != null && (auth.uid === $uid || auth.token.email === 'gunidmoh@gmail.com')",
    ".write": "auth != null && auth.uid === $uid",
    ".validate": "newData.hasChildren(['muted','updatedAt'])",
    "muted":     { ".validate": "newData.isBoolean()" },
    "updatedAt": { ".validate": "newData.isNumber()" },
    "$other":    { ".validate": false }
  }
}
```

## What the node holds

| Path | Written by | Read by |
|---|---|---|
| `/push_mutes/{uid}` | that signed-in user, own uid only | that user, the account owner, and the Cloud Function (Admin SDK, bypasses rules) |

A record exists **only while that person is muted**: `{muted: true, updatedAt}`.
Unmuting **deletes** it. Absence is audible, and that is the default for
everybody — see `src/push/pushMute.js`.

## Why each clause is load-bearing

**`.write` is `auth.uid === $uid` and nothing else.** A blanket `auth != null`
would let any signed-in staff member mute a colleague — a targeted denial of
service against somebody else's working day, invisible from both ends, and
indistinguishable from the feature being broken. It is the same attack the
`/notification_prefs` rule was shaped against in `PUSH-RULES-DEPLOY.md` and the
same answer.

**`.read` adds the account owner, and only the account owner.** The Order alerts
card shows, per row, whether that person has silenced themselves — an assignment
that is being ignored at the other end has to be visible to the one person who
can do something about it. Same super-admin identity as `/push_assignments`,
`/push_hub_audience` and the per-uid `/push_tokens` read, so this introduces no
new privileged identity. It is deliberately **not** a `.read` on the
`push_mutes` node: the card reads one bounded leaf per row, and nothing above
`$uid` becomes readable.

**A mute can only ever REMOVE somebody from a send, and no rule here grants
anything.** This is the correction to #569. That release made the personal
switch an opt-in, which made it load-bearing for delivery — a person had to find
it before an assignment could reach them. Here, recipients are the AND of
"Junid assigned this hub" (super-admin-write-only nodes) and "not muted". There
is no state in which writing this node makes somebody a recipient who was not
already chosen, so a client-writable node is safe in a way `/push_audience`
never was.

**`hasChildren(['muted','updatedAt'])` with `$other: false`.** The record is a
closed shape: one boolean and one stamp. Without it a future bug or a console
paste could park a field on the record and have it stored and served forever.

**`muted` is a boolean, not a string.** `isMuted()` counts only a real boolean
`true`, so corruption degrades towards DELIVERY — the opposite direction from
`assignedHubs()`, and deliberately: there the harm is notifying somebody nobody
chose, here it is silencing somebody who was. The rule makes the same statement
at the other end, so a `"true"` string is never stored in the first place.

**`updatedAt` is a number from `serverNowMs()`**, never `Date.now()` — a
rules-validated timestamp written from a phone's clock is not evidence of
anything (`src/utils/serverTime.js`).

## Order of operations

**Paste this BEFORE the hosting deploy.** Pasting first cannot break anything —
nothing reads or writes `push_mutes` until the new bundle ships. Deploying
first is not damaging but is visibly broken: the switch on the home screen sits
disabled with an amber line reading "Couldn't save this setting on your
account… PERMISSION_DENIED", because its listener is refused. No assignment,
token or notification is affected either way, and no data can be damaged —
every refused write is refused whole.

The fan-out is unaffected by the paste entirely: it uses the Admin SDK, which
bypasses rules, and reads an absent node as audible.

## Verifying it took

1. Open the app as any staff member and scroll to the bottom of the home screen.
   The **New order alerts** switch is there, above Sign out, and is **not**
   disabled.
2. Switch it OFF. The console shows `/push_mutes/{that uid}` =
   `{muted: true, updatedAt: …}` and the sub-line reads "Muted — your phone
   stays quiet…".
3. Switch it back ON. The record is **gone** (not `muted: false`).
4. Open `/#admin/notifications` as `gunidmoh@gmail.com`. A muted person's row
   reads **muted** in amber, and the summary line counts them if they are also
   assigned.

If step 4 shows "mute unknown" on every row while step 2 worked, the `.read`
half of the paste did not land — the `.write` half evidently did.
