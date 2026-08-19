# The gap — holds fulfilled while the customer notification was off

Census run 2026-08-19 against live RTDB. Read-only: nothing was sent, nothing
was written, nothing was rewritten.

Reproduce: `node scripts/hold-notify-gap-census.mjs`

**No customer names or phone numbers are recorded in this file.** The census
writes them to `~/hold-notify-gap-<date>.json`, mode 600, outside the repo.

## The window

The hold WhatsApp was deleted in **e115cde** (2026-08-08 21:31 SA, "Refill
unification", PR #337) and restored at fulfil on 2026-08-19. The `/refill_requests`
row a hold raises (`onhold_{saDate}_{orderNumber}`) was introduced by the *same*
work — 07a9bfc raised the row, e115cde removed the send — so the set of
`onhold_*` rows that have ever existed is, near enough, the notification-off era.

## The count

| | |
|---|---|
| `onhold_*` rows ever raised | **437** |
| … cancelled (hold released, human ✕, or engine withdrawal) | 382 |
| … **fulfilled — the stock arrived** | **29** |
| … still open | 26 |

**29 customers had their held item physically arrive and were told nothing.**

All 29 were raised after the removal commit, and all 29 still have a phone
number recoverable from `/insights_log` — nobody in the gap is uncontactable.

Spread, by the day the refill was fulfilled:

| fulfilled on | customers |
|---|---|
| 2026-08-10 | 2 |
| 2026-08-11 | 3 |
| 2026-08-13 | 5 |
| 2026-08-14 | 2 |
| 2026-08-15 | 6 |
| 2026-08-16 | 6 |
| 2026-08-18 | 2 |
| 2026-08-19 | 3 |

Two phone numbers appear twice, so the 29 lines are 27 distinct customers —
two of them had two separate held orders each.

Nothing was sent to any of them and no record was altered. Whether to message
them now, and with what, is the owner's call — the restored notifier fires only
on a live fulfil transition, so it will never pick these up by itself.

## The carry-over tail

**26 holds are still OPEN and were raised before the re-link shipped.** They
carry no `holdLink`, so when a picker fulfils them the restored notifier will
read them as not-hold-origin and send nothing. Their order numbers are listed by
the census run.

This is deliberate and was NOT backfilled — commit 4's brief is to count, not to
rewrite. Two ways to close it, both the owner's call:

1. **Do nothing.** The tail drains as those 26 resolve; every hold raised from
   the deploy forward carries its link and notifies normally.
2. **Backfill** `holdLink` onto the 26 open rows from their `/insights_log`
   "tomorrow" events, Admin-SDK-only. That would make them notify on fulfil like
   any new hold. It is a write against live data, so it needs its own
   nominated-scope go-ahead.

## Where the contact details come from

Not `/orders`: order numbers reset daily and that node is ephemeral, so most of
these rows point at a recycled or deleted order. The durable source is
`/insights_log` — the `tomorrow` event logged at hold time carries
`refillRequestId` alongside `customerName`, `customerPhone` and `orderNumber`.

This join existing at all is the reason the restored feature stores `holdLink`
**on the request**: rows raised from 2026-08-19 onward need no join, and the
notifier never has to go looking for a customer whose order may be gone.
