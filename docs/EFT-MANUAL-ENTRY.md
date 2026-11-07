# Manual EFT entry — Junid's escape hatch

With EFT matching enforced at Trophy and Marathon PE
(docs/EFT-ENFORCEMENT.md), a payment whose bank notification never reaches
the pool would have no way through. **Junid, and Junid alone**, can type a
customer reference and an amount and that becomes a spendable record in
`/eft_pool`, which a cashier finds and consumes exactly like a bank-confirmed
payment.

## The lock

`eftPoolManualEntry` checks `isOwner(request)` — the admin email **and** a
verified Google sign-in — before reading anything. No POS access flag
(`role`, `eftReview`, `individual`) grants it: managers, EFT-review holders
and shared till logins get `permission-denied` (`owner-only`). The UI hiding
the button is not the control.

## The record

Shape is the poller's recorded payment, so nothing downstream has a special
case:

| field | value |
|---|---|
| `reader` | `"manual"` |
| `outcome` / `status` | `"recorded"` / `"unmatched"` |
| `reference`, `amountCents` | as typed (3–60 chars; R1–R50,000) |
| `bankRef` | `MANUAL-<first 12 of key>` — synthetic, unique, so the fingerprint claim and every settle-time check apply unchanged |
| `payer`, `rawText`, `destination` | null — nothing was read from a bank |
| `auth.verdict` | `"manual"` |
| `manualEntry` | `{ by: "Junid", uid, email, at: server time, note, entryId }` |

The key is `sha256("eftmanual1|" + entryId)[0:40]`: a retried submit lands on
the same key (create-if-absent → `already: true`). Refused at entry:

* the **bank's own unmatched notification** for that reference and amount
  already in the tail (`bank-twin-waiting`) — the cashier uses that one.

**Same reference, warned not blocked (Junid, 7 Nov 2026).** A second hand
entry with the same normalised reference and amount typed the same SAST day
(or within 12 hours) is ACCEPTED as its own record, and the answer carries
`warning: { code: "similar-entry", key, status, message }` — no renaming to
"… 2". Only the EXACT same entry (reference, amount and note) under another
entryId within 10 seconds is an accidental double tap: it is answered with the
first record (`already: true, doubleSubmit: true`) and nothing new is written.

The fingerprint is claimed create-only at entry, in the poller's order.

## One payment, two records — never paid out twice

A manual entry and the bank's later notification of the same payment carry
different fingerprints, so the fingerprint check cannot see they are one
payment. Three rules do:

| situation | what happens |
|---|---|
| manual entry **floated** (used or waiting), bank twin arrives | the poller **holds** the notice automatically (`held-possible-duplicate`, `linkedHold: "manual-twin"`) — see *Linked copies* below. A pair recorded before that: the search warns (`sameUsed`) and the settle refuses the notice once the entry is used (`twin-used`). The owner releases a hold only for a genuine second payment. |
| manual entry **waiting**, bank twin arrives | the notice is **held** at ingest (manual-twin), so the hand entry stays the one spendable record and the cashier finds it as usual. (Recorded before this shipped: the search answers with the bank record and the hand entry is refused once the bank's is spent.) |
| bank record already waiting when Junid types | refused at entry (`bank-twin-waiting`). |
| bank twin arrives and is **used** while the manual entry still waits | the search warns on the manual row (`sameUsed`); the **settle refuses** the manual entry (`twin-used`; the log line says `bank-twin-used`). Junid marks it used or reverses the bank settlement. |

A "twin" is the same normalised reference and amount AND a bank payment the
bank dates **no later than the entry was typed** (an hour's clock tolerance)
and **at most 7 days before it**, whose notice landed after the typing or the
same SAST day (7 Nov 2026, PR #861 — the old "arrived at or after", with no
end date, let one used entry block every later payment a repeat customer made
under the same reference and amount). A payment the bank dates after the
entry was typed is a new payment. `bank-twin-waiting` looks at unused bank
payments dated from 7 days back to tomorrow; a second manual entry is
`similar-entry` (a warning) only when typed the same SAST day or within 12
hours of the first.

Limit: all three look at the pool tail (the newest 400), as every settle-time
check does.

## Consuming it

The ordinary path: `eftPoolSearch` by the reference → the till's confirm step
(customer attached and confirmed) → `eftPoolSettle` settle (consume-once
transaction, fingerprint re-derived inside it) → attach → remainder → the
owner's reversal. Single-use by the same transaction as a bank payment.

**The till cannot tell (Junid, 20 Oct 2026).** A manual entry is
indistinguishable from a bank-confirmed payment on the cashier's side: same
card, same confirm wording, same taps, nothing on the staged tender or the
sale record. `publicEftView` carries no manual field; a twin warning
(`sameUsed { at, receiptNumber }`) and the settle's `twin-used` refusal use
one sentence whichever side was typed by hand. The provenance stays where it
belongs — the pool record (`reader: "manual"`, `manualEntry`), the
`/eft_manual_entries` log, the `EFT_MANUAL_ENTRY` / settle log lines, the
owner's pool tab, and the EFT review list **for the owner only** (POS
`eftPoolList` strips the mark for an eftReview holder).

## Log — how often the hatch is used

`/eft_manual_entries/{logKey}`, one row per entry, `logKey` = zero-padded
entry time + pool key (so `orderByKey()` lists in time order with **no
index**, and the settle can address the row from the pool record alone).

| when | row |
|---|---|
| entry | `{ key, entryId, at, by: "Junid", uid, email, reference, amountCents, note, status: "unmatched" }` |
| settle | `status: "used"`, `usedAt`, `cashierUid/Name`, `storeId`, `tillId`, `customerId/Name`, `appliedCents` |
| attach | `saleId`, `receiptNumber`, `attachedAt` |
| release | back to `"unmatched"`, `releasedAt` |
| markUsed | `"used-outside-pos"`, `reason` |
| reverse | back to `"unmatched"`, `reversedAt`, `reversals` |

Written by `eftPoolSettle` / `eftPoolReverse` after their transaction commits
(best effort, never a reason to fail the settle), with log markers
`EFT_MANUAL_ENTRY`, `EFT_MANUAL_SETTLE`, `EFT_MANUAL_ATTACH`,
`EFT_MANUAL_RELEASE`, `EFT_MANUAL_MARKUSED`, `EFT_MANUAL_REVERSE`.

Junid reads it with `eftPoolManualEntry { action: "list" }` (owner only; the
newest 60 by key order, with counts entered / used / waiting / outside-POS)
from the phone's manual-entry sheet. Optional rule if the node should also be
readable from the console-side owner tab (not needed by the build):

```json
"eft_manual_entries": {
  ".read": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  ".write": "false"
}
```

When the counts show the hatch idle for weeks, enforcement has settled and
the button can be retired.

## Deploy

```
firebase deploy --only functions:eftPoolManualEntry,functions:eftPoolSearch,functions:eftPoolSettle,functions:eftPoolReverse --project=marathon-club
```

## Later-dated payments: weekends and public holidays only (7 Nov 2026)

A payment the bank dates a LATER day than the day it is judged on (the
notice's arrival; the server's clock for a keyed proof) is accepted only when
that day is not a business day — Saturday, Sunday or a South African public
holiday (`functions/lib/eft-text.cjs`, local calendar: the Act's fixed days,
Good Friday, Family Day, the Sunday→next-free-day rule, and
`SA_DECLARED_HOLIDAYS` for declared days such as 2026-11-04) — or the EVE of a
public holiday, and then only up to the next business day. Since the evening
of 7 Nov 2026 the window also opens on the LAST business day before a
non-business day: a Friday payment dated Monday is accepted like a Saturday
one, and so is Thu 24 Dec 2026 dated Mon 28 Dec (the eve of Christmas).
Monday to Thursday, with an ordinary business day after it, a payment dated
tomorrow still refuses. A newly
declared one-off holiday must be added to `SA_DECLARED_HOLIDAYS` by hand.

## Linked copies of one payment — held automatically (7 Nov 2026 evening)

`functions/lib/eft-linked-copies.cjs`, run by the poller at ingest and by
`eftPoolSettle` at the settle. No hand-run script is needed; the
`claim-settled-*.mjs` scripts are a backstop only.

| case | what happens |
|---|---|
| a hand entry floated (used or waiting), then its bank notice arrives with the bank's own number (`isPaymentTwin`) | the notice is **held** `held-possible-duplicate`, `linkedHold: "manual-twin"`, `duplicateOf` the entry. The owner releases it from the EFT pool tab if the statement shows a second payment. |
| an Absa notice with a blank number and a numbered copy of the same payment (payer, account, day, amount, reference), in either order, including a proof Junid approved | the second is **held**, `linkedHold: "blank-numbered-twin"`. |
| a pair recorded before this shipped, or a race | the settle refuses the record whose linked copy was used (`twin-used`), unless the owner released it. |
| a proof approved from ONE bank's document and a notice from ANOTHER bank, same amount, dated −1..+3 days | **not held**. The notice is recorded, carries `reviewFlag: { code: "possible-cross-bank-duplicate", approvedKey, sameReference, samePayer }`, and the poller logs `EFT_POSSIBLE_CROSS_BANK_DUPLICATE`. |
