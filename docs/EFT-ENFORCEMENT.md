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

## 19 Oct 2026 — the consume flow at the till: instant, forgiving on spelling, one tap on cover

Junid: "used hundreds of times a day — instant, obvious, effortless". Five
changes across this repo (the callables) and marathon-pos-app (the till). The
safety model is unchanged: an enforced store consumes a confirmed pool payment
through `eftPoolSettle`, consume-once in one transaction, and forgiving
matching never resolves to the WRONG payment.

**1. Why confirming was slow, and the fix.** The 14-day Cloud Run logs put the
settle's own work at 0.1–0.3 s warm (search 18 ms p50, warm because typing
keeps it busy). What the cashier waited on was the `eftpoolsettle` instance
**starting**: a settle happens a few times a day, the service scales to zero in
between, and 5 of 6 confirms paid a 2.4–3.7 s cold start (p50 2.46 s) in front
of the settle's POST. Behind that, the settle made seven *sequential* database
round trips (identity → name → customer → record → tail → claim → settle) and
the attach six. Now: `eftPoolSettle { action: "warm" }` (identity check only;
the till calls it when a pool-capable payment screen opens, throttled to once
per 4 minutes per tab) keeps the instance and the browser's preflight cache
ready; the settle fetches its four independent lookups in one round and the
attach reads the record once beside the sale, skipping the remainder follow-up
when nothing is left over. `test/eft-pool-latency.test.cjs` pins the round
trips: settle 4 (was 7), attach 4 / 3 (was 6), warm 1. Nothing in the order
claim-then-settle moved.

**2. Forgiving reference search (`lib/eft-pool.cjs`).** The reference is
matched as it is typed: the typed text as the *start* of a reference from three
letters/digits, one typo (substitution, swap, dropped or extra character — on
the whole reference or the typed head) from four, two from ten. "HAFF" finds
HAFG. The bank's transaction id is matched whole or by a six-plus-character
start, never with a typo. The reference is shown on a near match (it was
blanked) so the cashier checks it against the proof of payment. **Never on
which payment:** only the best rank of match present counts (exact > prefix >
typo), and two candidates at that rank answer `ambiguous` — with
`partial: true` when more typing would settle it (till: "keep typing"), without
it when the references are identical (till: ask for the bank id). Names and
amounts are still never keys; initials only. Trade-off accepted by Junid: a
unique three-character prefix surfaces that one payment (amount, initials,
reference) to the cashier; the one-result rule is what keeps the pool
unbrowsable.

**3 + 5. A customer only when money is left over (`eftPoolSettle` settle,
`settleDecision`).** A settle with **no customer** is accepted only when
`appliedCents` equals the payment (nothing left over) **and** the query the
cashier typed (`matchQuery`) re-resolves, through the same `searchEftPool` over
the same tail, to this payment as the single unmatched answer. Otherwise
`no-customer` (leftover; the rand amount is in the message) or `not-matched`
(a query resolving to nothing, to another payment, or to two) — refused before
any claim. The amount is never what authorises the consume. Such a settlement is
stamped `customerConfirmed: false, wholePaymentMatched: true`; it has no
remainder to mint. With a customer on the sale nothing changed (resolved
against `/customers`, confirmed by id, remainder credit at attach).

**4. Rules.** Nothing. All nodes touched are the ones already Admin-SDK-only.

**Deploy by name:**
```
firebase deploy --only functions:eftPoolSearch,functions:eftPoolSettle --project=marathon-club
```
The till half (marathon-pos-app) ships after it: an older till keeps working
against the new functions (the old flow always sends a customer); the new till
needs the new `warm` action and the customer-less settle.

**Spec review (19 Oct 2026):** an all-digit query — a phone number used as
the reference, the PII case — is matched forgivingly only from five digits;
three or four digits return nothing. A whole-payment one-tap on exact cover
with a customer already on the sale stamps `customerConfirmed: true` without a
separate "yes, this is X's" step (nothing is left over; no credit is minted).
Residual risk accepted with the spec: "never the WRONG payment" is enforced
as uniqueness within the pool plus the cashier's check against the proof of
payment, not as proof of ownership — as it always was.

**Decided against the architect review (19 Oct 2026), on record.** (a) A
customer-less whole-payment settle accepts a *forgiving* match (prefix or typo)
as long as it resolves to one payment: Junid's spec is that "HAFF" surfaces
HAFG and that payment is then usable; the till asks for a second tap naming the
reference on any non-exact match, and the old customer-attached path never
verified ownership server-side either — the proof of payment at the counter
was always the check. (b) A unique three-character prefix surfaces one payment
(reference, amount, initials) to any active POS identity; the one-result rule
stops listing, not enumeration. Accepted for "results as they type"; a per-uid
rate limit on non-exact searches is the next step if the owner panel ever shows
probing (`EFT_POOL_SEARCH` log lines carry the uid).
