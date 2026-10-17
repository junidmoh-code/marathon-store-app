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
the same key (create-if-absent → `already: true`). A second entry with the
same normalised reference **and** amount while one is in the pool tail is
refused (`already-entered`). The fingerprint is claimed create-only at entry,
in the poller's order.

## Consuming it

The ordinary path: `eftPoolSearch` by the reference → the till's confirm step
(customer attached and confirmed) → `eftPoolSettle` settle (consume-once
transaction, fingerprint re-derived inside it) → attach → remainder → the
owner's reversal. Single-use by the same transaction as a bank payment.

`publicEftView` carries `manualEntry: { by, at }` so the till prints
**MANUALLY ENTERED BY JUNID** on the row and on the staged tender; the
owner's tab and the review screen print it too. A bank-confirmed payment
answering a search when a manual entry for the same reference and amount was
already spent carries `manualTwin` — the till warns before a second spend.

## Log

Every entry and every consumption is logged at `/eft_manual_entries`
(see the log section, commit 3) so Junid can see how often the hatch is used.

## Deploy

```
firebase deploy --only functions:eftPoolManualEntry,functions:eftPoolSearch,functions:eftPoolSettle,functions:eftPoolReverse --project=marathon-club
```
