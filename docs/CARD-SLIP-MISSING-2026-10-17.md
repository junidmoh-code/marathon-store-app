# Yasmin's Marathon PE Till 2 slip, 17 Oct 2026

## What happened

Yasmin said she sent Marathon PE Till 2's card slip from the store app (Card Slip tile) before about 17:10 SAST. Junid saw nothing in Card Recon on the desk or the phone, and the till didn't show as submitted anywhere.

**Her slip never reached the server.** It was never saved, and she needs to send it again.

The evidence (all times SAST):

| When | What |
|---|---|
| 15:41 | #739 goes live: Marathon PE Till 2 sends a **photo only**, with no total box. |
| 15:43:46 | Amanda's Trophy Till 2 slip arrives: an iPhone sends a 930 KB POST, recorded as batch 501 (`slip recorded picked=0000Z4M6 key=501`). |
| 16:03 | #741 goes live: the till list comes over HTTP (`slipTills`). |
| 16:24:26 | Yasmin's account (`yasmin@marathon.internal`, uid `58ayGw…`) signs in. |
| 16:24:28 | Her iPhone (Safari 26.5, a different phone from Amanda's) calls `cardBatchCapture` once: 1.6 KB, 8 ms, HTTP 200. That is the till list (`slipTills`), not a slip. |
| after 16:24 | **No other request from her phone** reached `cardBatchCapture`, or any other function, all day. |

Nothing exists anywhere for Marathon PE Till 2 today:

- no `/card_batch_jobs` entry and no `/card_batch_jobs_count/0000HP1X/2026-10-17`;
- no `/card_batches/pe/0000HP1X/545`;
- no photo under `cardRecon/**` in Storage (the only slip photo of the day is Amanda's);
- no log line (`received`, `slip recorded`, `slip attached` or a refusal).

The scope and section gates were checked for her account live: neither would have refused her.

## Could the app have said "Sent" anyway?

Not from the code that was live. "Sent — thank you" was drawn only when the callable answered `ok`, and no callable answered her. So one of two things happened:

- she never got as far as Submit; or
- the upload never completed (a weak mobile link, or the phone locked or switched apps while it showed "Sending…"). In that case the old screen waited up to **five minutes** before saying anything.

Either way, the screen told her nothing about whether **today's** slip was in. A phone that had been closed, reloaded or reopened looked exactly the same as one that had sent the slip.

She also remembers typing a total. That box has not existed for Marathon PE Till 2 since 15:41 (#739), and her phone ran the 16:03 build.

## What changed

### Store app: function `cardBatchCapture` (+ the read job and manual entry, which share the code)

- **Every staff slip the server keeps is logged** at `/card_batch_overrides/staff_slips/{filed store}/{tid}/{trading day}/{entry}` (`functions/lib/card-staff-slip-log.cjs`):
  - one entry per slip, whatever became of it: the day's record, a supporting slip beside a better figure, or a photo still waiting to be read;
  - a photo-only slip is logged **in the same write as its job**;
  - each entry names who sent it, when, the till, and the photo path;
  - the node is owner-only, already live, and needs no rules paste.
- **The reply carries a receipt** (`receipt: { at, dayYmd }`): when the server kept the slip, and for which day. It never carries a figure, a batch or a verdict.
- **`slipTills` says whether today's slip is in** (`sent: { at } | null`) for the caller's own tills only.
- **One trading day for every screen**: before 06:00 SAST counts as the evening before. This was already the rule for received photos; it now applies to supporting slips and typed staff slips too.
- **A typed staff slip is filed against its batch**: it closes at the FNB cut-off, 18:50 on its trading day, not at the minute it was sent.
  - A slip sent at 15:43 still covers that batch's card sales until 18:50, and the next batch opens at 18:50 too.
  - Junid's correction never closes before the record it corrects.
  - His manual entry may keep a cut-off close that is still ahead.

### Store app: the Card Slip screen

- **"Sent — thank you" only with the server's receipt.** Anything else shows **"Not sent — try again"** with the reason: a refusal, a dropped connection, a reply without a receipt.
- **The send gives up after 2 minutes, not 5**, so the person hears "Not sent" while still standing there.
- **The till says whether today's slip is in**: "✓ Today's slip is in — sent at 16:24", or "No slip sent yet today". This comes from the server's live answer, never from the phone's copy, which may be yesterday's. The server is asked again after every send.
- The page shows the trading day: after midnight, it still shows the evening's date.

### POS (marathon-pos-app): Card Recon, desk and phone

The POS reads the log by day key per terminal, never the whole node:

- A day with a staff slip and no batch yet is **one quiet row, "SLIP SENT BY STAFF – BEING READ"** (or "SLIP SENT BY STAFF"):
  - it shows on that day, with who sent it and when;
  - the desk shows the photo; the phone never draws slip photos (they carry masked card numbers);
  - it replaces "Awaiting tonight's report";
  - it is counted as "sent by staff", never as missing, and never turns the day red.
- When the batch lands, its card takes over and carries the log. A staff photo that went to the reader after the machine's report was already in still opens there.
- Card money on a day whose staff slip is in reads **"SLIP SENT BY STAFF – NOT RECORDED YET"**, never "No slip for 2+ days".
- A supporting slip is compared on its trading day (`dayYmd`).

## Today's records

- **Yasmin, Marathon PE Till 2:** nothing to recover — the server never got it. **She needs to send it again.** When she does, her till shows "✓ Today's slip is in" and Junid's report shows the row (or the batch) on 17 Oct with the photo.
- **Amanda, Trophy Till 2, batch 501:** recorded at 15:43, before this change, so its window closed at 15:43. Its close was moved to the 18:50 cut-off, so tonight's remaining card sales are counted against it and tomorrow's batch starts at 18:50. The original close is kept on the record (`windowAdjusted`). Her slip was also added to the staff-slip log.
