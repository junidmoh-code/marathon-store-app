# Trophy Till 1 "no card recon for 24 and 25 Oct" — 25 Oct 2026

Junid's report: Trophy Till 1 (TID 67377843) has no card recon for 24 and 25
Oct, it has failed repeatedly over the past month, and it is the only terminal
with no MID recorded. Everything below was checked against live data on
25 Oct 2026 between 14:45 and 15:30 SAST, before any code changed.

## Root cause, in one line

**Nothing failed to arrive:** TID 67377843 has stood on **Marathon Till 1**
since the 5 Oct speedpoint swap and emailed both days; the machine on Trophy
Till 1 is **67325636**, and the app still shows 67377843 as a Trophy terminal
in three places and stamped "recorded as R0.00 for this day" on 32 of the 35
emailed reports since 16 Oct (a code bug) — so a recorded day read as an empty
one.

## The five checks

| Check | What live data says |
|---|---|
| Gemini key funded, HTTP 200? | **Yes.** `gemini-3.6-flash:generateContent` with the live `GEMINI_API_KEY` secret → HTTP 200 at 14:55. Not the cause — and the Trophy machines are on the email path, which never calls Gemini. |
| Mailbox poller alive, ticked both days? | **Yes.** `~/marathon-store-app/logs/card-recon-poll.log` on the mini: 868 tick lines on 24 Oct, 499 on 25 Oct by 14:49, every ~2 min. `/card_batch_poll_health` ok, heartbeat 1 min old. |
| Did 67377843 email a report? | **Yes, both days.** 24 Oct 16:30 "Banking Report for Batch 51 of Terminal 67377843" → recorded `51-r2` (the batch opened 23 Oct 09:47 and was left open; 43 lines, R30,030). 25 Oct 14:56 "Banking Report for Batch 52 of Terminal 67377843" → recorded `52` (R7,495, clean). It sends from `NoReplyTransReport@FNB.co.za` to the recon Gmail inbox the poller reads — the terminal is configured correctly. |
| Refused or stranger-domain intake row? | **None for 67377843 either day.** The only refusals on 24–25 Oct are customers' proofs of payment from gmail.com ("That PDF is neither a terminal batch slip nor an emailed banking report…"), PE Till 3's re-sends of batch 92, and at 14:56 today a second copy of batch 52: *"Batch #52 for this terminal is already captured. If the earlier capture was wrong, resubmit as a correction — both records are kept."* — a duplicate email, correctly refused. |
| Registry entry different from the others? | **No missing MID** — 67377843 carries MID `100000002816030`; all six terminals have one (Trophy Till 2's *records* have none because it is typed, never read). **What does differ:** 67377843 and 67325636 are the only two rows whose placement is in a *different store* from their filing key. 67377843 is filed `trophy/till-1` but stands at `pe/till-1` ("Marathon Till 1") since 5 Oct 12:46; 67325636 is filed `pe/till-1` but stands at `trophy/till-1` ("Trophy Till 1"). |

## What the owner's Card Recon screen shows

The POS screen (`marathon-pos-app src/reports/cardrecon/dayRows.js`, live)
was replayed over 25 Sep → 25 Oct with `scripts/verify/card-recon-audit.mjs
--compare` from live records. The till physically at Trophy has a row on
every trading day of the month:

- 24 Oct — trophy till-1, **#70 (67325636) clean, R27,858.00 / R27,858.00**.
- 23 Oct — trophy till-1, #69 (16/16) short R7,189.50 / R7,739.50.
- 25 Oct — trophy till-1 **awaiting** (POS R6,870.00 card) — see below.

TID 67377843's rows are on **Marathon Till 1** (pe till-1): 24 Oct #51 (2/2)
R10,095 vs R34,255 — the R24,160 gap is exactly PE Till 3's R24,160 over on
the same day (PE Till 1's customers paid on the Till 3 machine), not a Trophy
problem; 25 Oct #52 clean R7,495.

## Why it looked missing

1. **The false "R0.00" sentence (code bug, since #730 on 16 Oct).**
   `resolveWriteFor` returns `reprintOpensAt` only on its re-print branch; the
   normal return leaves it `undefined`, and the PDF path tests
   `reprintOpensAt !== null` — true for `undefined`. Every emailed report has
   since opened with *"The terminal re-printed batch #N on a later day with no
   card taken since its last report — recorded as R0.00 for this day"* —
   including Trophy's real R27,858 day. 32 of 35 emailed records since 16 Oct
   carry it; 13 of those are first reports with money on them. The figures
   were never affected — only the sentence.
2. **67377843 is shown as Trophy's.** Its filing key is `trophy/till-1`, and
   that key is what the Terminals sheet prints as its store and till, what the
   capture screen groups it under, and what the capture-side matcher
   reconciles against — so each of its reports says ~26 transactions were
   "rung up on another till — pe/till-1", and its intake row says
   `storeId: trophy`. The owner's POS screen is placement-aware and correct.
3. **Today's Trophy report is not in, and the capture screen says it is.** At
   14:01 the Trophy machine (67325636) emailed a report for **batch 57** — its
   17 Sep installation batch (one R10 transaction) — instead of today's batch.
   It was recorded (it is a genuine report), and because the "is today's
   report in?" tick counts any report *recorded* today, Trophy Till 1 shows
   ticked while R6,870 of today's card money is still awaiting its slip. That
   re-print is a terminal-side action (someone reprinted batch 57), not code.

## What is fixed, and what is not code

- Fixed in code: the false sentence; the capture side reconciling a moved
  machine on its filing till (it now uses the placement, and the record
  carries `placeStoreId`/`placeTillId`); the Terminals sheet printing the
  filing till as where the machine stands (it now shows where it stands and
  names the filing key beside it); a stale batch ticking today.
- Deliberately unchanged: the FILING key. 67377843's batches stay under
  `card_batches/trophy/…` and its intake rows keep `storeId: trophy` — moving
  a filing key would strand every batch already filed. The intake row now
  also carries `placeStoreId`/`placeTillId`; no screen reads them yet, and the
  capture cards are labelled by the registry label (already "Marathon Till 1").
- Added: a morning email when a till took card money on a day no batch
  covers (`cardTillSilenceScan`, 07:30 SAST, `CARD_TILL_SILENT_ALARM`). It
  fires from the FIRST uncovered trading day, so a till that settles its batch
  the next morning instead of the evening before will be named too — by
  design ("no batch recorded by the next morning"). A crash in the check, or a
  scheduler that stops firing (watched every 10 min by cardReconHealthScan),
  sends the same email.
- Not code: whoever is on Trophy Till 1 today should settle and send today's
  batch from 67325636 — it reprinted batch 57 instead.
