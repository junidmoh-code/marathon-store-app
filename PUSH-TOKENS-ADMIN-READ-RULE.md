# The one-line rule change the Order alerts card needs

**Path:** `push_tokens` → `$uid` → `.read`

## What is broken without it

`/#admin/notifications` shows a device state next to every name — "2 devices"
or "no device" — because an assignment to somebody whose browser has never been
granted notification permission is a decision that will silently never produce
a notification, and this screen is the only place that can be seen.

To do that it has to read `push_tokens/{uid}` for the people on the list. The
live rule allows a read there **only when you are that person**:

```json
"push_tokens": {
  "$uid": {
    ".read": "auth != null && auth.uid === $uid",
    ".write": "auth != null && auth.uid === $uid"
  }
}
```

So the account owner, looking at somebody else's row, is refused — exactly like
everybody else.

## What this is NOT

It is **not** a `.read` on the `push_tokens` node. The card previously issued
`get(ref(db, "push_tokens"))`, a whole-node fetch, and a node-level `.read`
would have made that legal. That would have been the wrong fix twice over: it
would hand a browser every device token in the business in order to count the
ones belonging to 35 names, and live bandwidth is the largest line on this
project's bill.

The card now issues **one bounded read per row**, at the same per-uid path the
rule already governs. Nothing above `$uid` becomes readable.

## The rule

Replace the `.read` line inside `push_tokens/$uid`. **`.write` does not
change** — a device token is still written only by its own owner.

```json
"push_tokens": {
  "$uid": {
    ".read": "auth != null && (auth.uid === $uid || auth.token.email === 'gunidmoh@gmail.com')",
    ".write": "auth != null && auth.uid === $uid"
  }
}
```

Same super-admin identity as `/push_assignments` and `/push_hub_audience`
(`PUSH-ASSIGNMENT-RULES-DEPLOY.md`), so there is no new privileged identity
here — the account that decides who is assigned can now see whether the
assignment can be delivered.

`database.rules.json` in this repo is STALE and console-managed. It is not
edited for this and deploying it would regress the live document
(`project_live_rules_drift`). Paste in **Firebase Console → Realtime Database
→ Rules**, then **Publish**.

## Until it is pasted

Nothing is broken and nothing waits. The staff list loads, the assignments load
and every switch works — the device column alone says **"device unknown"**, and
an amber banner says why. "Device unknown" is deliberately a different sentence
from "no device": the second is a fact about a person, the first is a fact about
this screen.

## Verifying it took

Open `/#admin/notifications` as `gunidmoh@gmail.com`. The banner about devices
is gone and rows read "no device" or "N devices". If the banner is still up,
the rule did not publish — a green Publish on a document that failed to parse
is not evidence.
