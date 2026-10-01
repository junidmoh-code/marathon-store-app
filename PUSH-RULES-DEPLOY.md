# Web push — the RTDB rules to paste, and why each one is shaped that way

The push feature introduces four top-level paths. The live rules have **no root
`.read`/`.write`**, so until these are pasted every client write in the feature
is `PERMISSION_DENIED`: no token registers, no preference saves, the audience
index stays empty and the fan-out finds nobody. The switch will look broken for
everyone. **This is the one step that has to happen by hand.**

`database.rules.json` in this repo is STALE and console-managed — it is not
edited here and deploying it would regress the live document
(`project_live_rules_drift`). Paste these into
**Firebase Console → Realtime Database → Rules**, as siblings of the existing
top-level entries, then Publish.

> **2026-09-06 — the trigger moved to /orders and these rules did NOT change.**
> The four paths, their shapes and their validations are byte-for-byte what was
> pasted for the refill release. `/push_bursts` is now keyed by `destShop`
> rather than by a hub, which is a different key under the same server-only
> node — no rule mentions the key. `/notification_prefs/{uid}/refillRequests`
> keeps its field name deliberately: it holds a person's explicit answer to
> "do you want to be told", and renaming it would read every one of those
> answers as never-given and silently re-subscribe everyone who switched the
> alerts off. **Nothing to paste for this release.**

## The paths

| Path | Written by | Read by |
|---|---|---|
| `/push_tokens/{uid}/{tokenId}` | the signed-in user, own uid only | the Cloud Function (Admin SDK, bypasses rules) |
| `/notification_prefs/{uid}` | the signed-in user, own uid only | that user |
| `/push_audience/{bucket}/{uid}` | the signed-in user, own uid only | the Cloud Function |
| `/push_bursts/{destShop}` | nobody — server only | nobody |

## The rules

```json
"push_tokens": {
  "$uid": {
    ".read":  "auth != null && auth.uid === $uid",
    ".write": "auth != null && auth.uid === $uid",
    "$tokenId": {
      ".validate": "newData.hasChildren(['token','createdAt','lastSeenAt'])",
      "token":      { ".validate": "newData.isString() && newData.val().length > 20 && newData.val().length <= 1024" },
      "device":     { ".validate": "newData.isString() && newData.val().length <= 200" },
      "createdAt":  { ".validate": "newData.isNumber()" },
      "lastSeenAt": { ".validate": "newData.isNumber()" },
      "$other":     { ".validate": false }
    }
  }
},

"notification_prefs": {
  "$uid": {
    ".read":  "auth != null && auth.uid === $uid",
    ".write": "auth != null && auth.uid === $uid",
    ".validate": "newData.hasChild('refillRequests')",
    "refillRequests": { ".validate": "newData.isBoolean()" },
    "updatedAt":      { ".validate": "newData.isNumber()" },
    "$other":         { ".validate": false }
  }
},

"push_audience": {
  "$bucket": {
    "$uid": {
      ".read":  "auth != null && auth.uid === $uid",
      ".write": "auth != null && auth.uid === $uid",
      ".validate": "newData.hasChild('at')",
      "at":     { ".validate": "newData.isNumber()" },
      "$other": { ".validate": false }
    }
  }
},

"push_bursts": {
  ".read":  false,
  ".write": false
}
```

## Why each clause is load-bearing

**`auth.uid === $uid` on all three client paths, not a blanket `auth != null`.**
This is the whole security model of the feature, and a blanket rule on any one
of them is a real attack, not a theoretical one:

- on `push_tokens`, a staff member could write their own FCM token into a
  colleague's node and silently receive that colleague's alerts;
- on `notification_prefs`, they could switch a colleague off — a targeted denial
  of service against someone else's working day, with no trace;
- on `push_audience`, they could stuff the index with arbitrary uids and make
  every burst pay a per-uid read for each one. `MAX_RECIPIENTS` (60) bounds one
  burst; nothing bounds how many bursts.

**`push_bursts` closed to clients entirely.** It holds the burst window and the
replay memory. A client that could write it could pre-seed a window that never
closes, or a `seen` map naming requests that have not happened, and suppress a
hub's notifications indefinitely — a failure that looks exactly like the feature
not working. Nothing in the client code touches it; this rule is what makes that
a guarantee rather than a convention. The Cloud Function uses the Admin SDK and
bypasses rules, so closing it costs nothing.

**`$other: false` on each record.** These nodes are written by a browser on
every app load. Without it, anything a future bug (or a console paste) puts on
one of these records is stored and served forever.

**The `token` length bounds.** An FCM registration token is ~150–350 characters.
The bounds reject an empty string and refuse to let a per-load write become a
place to park kilobytes.

## Verifying it took

After publishing, open the app as any warehouse or admin user and check that
`/push_tokens/{their uid}` gains a row with `token`, `device`, `createdAt` and
`lastSeenAt`, and that `/push_audience/all/{their uid}` exists. If the console
shows nothing, the rules did not publish or the paste landed inside another
node — the browser console will be logging `[push] registration failed`.
