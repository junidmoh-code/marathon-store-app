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
else server-side — so a store is added or removed **without a deploy**.

## Breach detection (the server's teeth)

The plain-EFT path never reaches a callable, so the till is the wall for the
sale itself. Every 5 minutes `eftRemainderScan` walks new regular sales
(`orderByChild("createdAt")`, a sliding two-hour window, one bounded page —
never the node) and writes any sale at an enforced store carrying an EFT leg
with **no pool key** to `/eft_enforcement_breaches/{saleId}` and logs
`EFT_ENFORCEMENT_BREACH`. Detection, not prevention: the sale stands; Junid
sees which till let it through (an old build, or a fallback that went wrong).

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

The hard wall a later session could add on `/pos/sales` (console, not here):
`payments/$paymentId` `.validate`: `newData.child('method').val() !== 'eft' ||
newData.hasChild('eftPoolKey') || !(root.child('eft_enforcement/stores')
.child(newData.parent().parent().child('storeId').val()).val() === true)`.
Not applied: it would also block Pine/Concrete the day they are switched on
with an old till build, and offline-queued sales.

## Deploy

```
firebase deploy --only functions:eftEnforcementStatus,functions:eftRemainderScan --project=marathon-club
```
