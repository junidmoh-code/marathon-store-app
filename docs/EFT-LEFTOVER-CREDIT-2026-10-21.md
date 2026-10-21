# EFT leftover credit that never landed — 21 Oct 2026

## What happened to Deran's R1,000

| SAST (21 Oct) | Event |
|---|---|
| 09:06:51 | Yasmin, **PE till-2**, settles pool payment `78a7321f…` (D MOODLEY, Capitec, **R1,150**) against sale **S-46291** (NY cap, **R150**) for customer **Deran** `27785056874` — customer confirmed. |
| 09:06:51 (+54 ms) | The attach reads the sale back. The till's offline outbox has **not landed it yet**, so the read finds nothing: the R1,000 remainder is stamped `disposition: "unallocated"`, `holdReason: "the sale was not on the server when the payment was attached, so it could not be checked"`, and written to `/eft_unallocated/78a7321f…`. **No credit was created.** |
| 09:11:03 | `eftRemainderScan` re-reads S-46291 — it is there and matches (R150 EFT leg, same customer). It stamps `sale.verified = true` and **stops**: the hold whose only reason was "could not be checked" stays a hold. |
| 09:11:55 | Junid issues R1,000 by hand from his phone (manual "Goodwill" credit `-P4SIKbsY4LFM8pN5TMQ`, store "remote"). |
| 09:12:19 | Ifrah, **Trophy till-1**, redeems the full R1,000 on S-45738. |

So the R1,000 was never minted, on any customer, at any store. The "not at the
other store" symptom came from it not existing at all. Cross-store visibility is
fine: `/network/creditScope` is unset, so it defaults to `shared` and every
credit can be spent at every store. PE and Trophy are in the same section anyway.

## Why Junid's R200/R100 test worked

Junid's payment `469748aa…` (Trophy till-1, 09:28) was attached after its sale
had already reached the server. The settle response came back slowly enough for
the outbox to land the sale first, so `verified: true` at attach and the R100
was minted at once. The two cases differ only in **timing**: whether the
outbox lands the sale before the attach callable reads it. The customer, the
store and credit visibility had nothing to do with it.

The same race had already held one other remainder: `0ce50318…` (R390 against
R350, Trophy till-1, 20 Oct, customer **Daud** `0655953203`). Its R40 was never
issued.

## Root cause

`attachSaleDecision` holds a remainder when the sale cannot be read back,
which is right at that moment. `laterSaleCheckDecision` verified the sale later
but never re-decided the remainder, so a hold whose only reason had gone away
stayed held for ever.

## Fix

1. **Server (this repo)**: when the later sale check verifies the sale, a
   remainder held *only* for `SALE_ABSENT_HOLD` with a confirmed customer is
   **promoted** to the credit plan a verified attach would have stamped. It is
   then minted through the same `finishRemainder` (claim, canonical credit,
   mirror, audit, ledger) and taken off `/eft_unallocated`. A hold for any
   other reason, one the owner allocated, or one marked `resolvedByHand` is
   never touched. `allocate` refuses a `resolvedByHand` remainder.
2. **Till (marathon-pos-app)**: a sale queued through the outbox is drained
   (bounded) before the attach, so the attach normally verifies the sale itself
   and the credit is minted in the same call. The scan is the backstop, at
   most one run later.
3. **Slip (marathon-pos-app)**: the sale slip prints **Store credit issued**
   and the **Store Credit Balance** including it. This covers EFT leftover and
   refund/exchange credit.

## Did the two bugs share a cause?

Partly. Bug 1 was the credit never being created (the race plus no
promotion). Bug 2 was separate: the slip never carried an issued-credit line,
and its balance was computed before the mint, so it would have been wrong even
when the credit did land: on Junid's R100 test the slip's balance was the Payment screen's pre-sale figure, without the R100. Both show
up in the same place, which is the attach response the till ignored. That
response now drives the slip.

## Data repair (`scripts/eft/repair-held-remainders-20261021.mjs`)

- `78a7321f…` (Deran): marked `resolvedByHand` with Junid's credit
  `-P4SIKbsY4LFM8pN5TMQ` and removed from `/eft_unallocated`, so it can never
  be paid a second time.
- `0ce50318…` (Daud): sale check re-queued, so the deployed scan promotes the
  R40 through the normal mint.
