# EFT enforcement — Trophy and Marathon PE match every EFT sale

Junid, 17 Oct 2026. At an **enforced** store a cashier can no longer complete an
EFT sale by looking at the customer's phone. The till's "EFT without matching"
button is gone there; an EFT sale must consume a **confirmed pool payment**
through the existing `eftPoolSettle` flow (reference or bank transaction id
typed in full, customer attached and confirmed, consume-once). Pine and
Concrete keep the looser path for now.

## The set is config, not code

| node | who writes | shape |
|---|---|---|
| `/eft_enforcement` | Admin SDK only (owner via the POS, or `firebase database:set`) | `{ stores: { trophy: true, pe: true, pine: false, concrete: false }, updatedAt, updatedBy }` |

* **Missing node → the default**: `trophy` + `pe` (Marathon PE's POS id) enforced.
* A present `stores` map is honoured exactly, an empty one included.
* Store ids are the POS short ids — what `/pos/sales/{id}.storeId` carries.

The till asks `eftEnforcementStatus` (any active POS identity) on the payment
screen and caches the answer per store; with no answer it uses the built-in
default, never "not enforced". The owner changes the set with
`eftEnforcementStatus { action: "set", stores: {…} }` — refused for anyone
else server-side, **merged** into the current map (a missing node starts from
the default, so `{ pine: true }` never switches Trophy off) — from the
phone's EFT enforcement sheet, so a store is added or removed **without a
deploy**.

## What is enforced, exactly

A **regular sale** (`type: "sale"`) at an enforced store. Not enforced, by
Junid's "do not break layby" and the current screens: **layby deposits and
instalments** and **on-account payments** render the payment screen without
the pool, so their EFT is still the plain tender at every store. Switching
those on is a later, explicit decision (pass `eftPool` to those screens and
judge `type: "layby"` in the scan).

## Breach detection (the server's teeth)

The plain-EFT path never reaches a callable, so the till is the wall for the
sale itself. Every 5 minutes `eftRemainderScan` walks new regular sales
(`orderByChild("createdAt")`, a sliding two-hour window, one bounded page —
never the node) and writes any sale at an enforced store carrying an EFT leg
with **no pool key** to `/eft_enforcement_breaches/{saleId}` (create-only:
one record, one log line per sale) and logs `EFT_ENFORCEMENT_BREACH`.
Detection, not prevention: the sale stands; Junid sees which till let it
through (an old build, or a fallback that went wrong) on the phone's EFT
enforcement sheet, which reads `eftEnforcementStatus { action: "listBreaches" }`
(owner only, the newest 50 by key order).

Cursor at `/eft_enforcement_scan { sinceMs, at, drained }`.

## Rules

Nothing in `database.rules.json` is touched (console-managed, repo copy stale).
All three nodes are top-level with no rule, so only the Admin SDK reaches
them, which is what the design needs. **Optional**, if Junid wants the breach
list readable on his phone without a callable:

```json
"eft_enforcement_breaches": {
  ".read": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  ".write": "false"
}
```

The hard wall on `/pos/sales` — **apply in the console once every till runs
this build** (not from the repo): `payments/$paymentId` `.validate`:
`newData.child('method').val() !== 'eft' || newData.hasChild('eftPoolKey') ||
!(root.child('eft_enforcement/stores').child(newData.parent().parent()
.child('storeId').val()).val() === true)`. It keys on the config node ONLY —
the functions' built-in default is not visible to a rule — so **write
`/eft_enforcement/stores` explicitly first** (a toggle on the phone sheet does
it, writing the full map). Not applied today because a till
with an **offline-queued** plain EFT sale from before the cut-over would have
its sale refused on sync; wait for the breach list to stay empty for a day.

## Deploy

```
firebase deploy --only functions:eftEnforcementStatus,functions:eftRemainderScan --project=marathon-club
```
