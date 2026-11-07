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
| manual entry **used**, bank twin arrives | since 7 Nov 2026 (Junid) a bank record carrying its **own transaction number** is judged on that number alone: no `sameUsed` warning, no refusal — the settle logs `EFT_TXN_OVER_MANUAL_TWIN` for Junid's review. When Junid hand-settles a REFUSED notice, `claim-settled-bank-fingerprint.mjs` / `claim-settled-reread-fingerprint.mjs` marks its number spent, so a resend is held. (A bank record with NO number still gets the warning and the refusal.) |
| manual entry **waiting**, bank twin arrives | the search answers with the **bank** record (not "ambiguous"); no warning — the manual one stays unused and is refused once the bank's is spent. Junid reverses it or marks it used. |
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
public holiday, and then only up to the next business day. The eve rule is
what makes Junid's example work: Thu 24 Dec 2026 dated Mon 28 Dec is
accepted. It is deliberately asymmetric: an ordinary Friday is a business day
whose next day is not a holiday, so a Friday payment dated Monday refuses; a
Friday before a Saturday holiday (24 Dec 2027) opens the window. A newly
declared one-off holiday must be added to `SA_DECLARED_HOLIDAYS` by hand.
