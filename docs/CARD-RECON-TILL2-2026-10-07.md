# Marathon PE Till 2 "not reading" — diagnosis, 7 Oct 2026

**Terminal:** `0000HP1X`, filed `pe`, on `pe/till-2` ("Marathon Till 2") since
18 Sep 2026 14:07 SAST (it was PE Till 1 before that). It is the one machine in
the estate that **cannot email** its batch report, so every batch it has ever
filed came from a **photo read by Gemini** at the moment a manager submitted it.

## Verdict

**The OCR call failed. The read never failed to attach to the till.**

Every Till 2 photo that the reader answered was recorded under
`card_batches/pe/0000HP1X` on `pe/till-2`, and 10 of the 11 recorded since 25 Sep
were within R0–R300 of the POS. The batch numbers that are missing (#510–#524,
#527, #537) are exactly the evenings when no read succeeded. On each of those,
the reason was outside the slip and outside the mapping:

| SAST day | what reached the server | outcome |
|---|---|---|
| 11–17 Sep | **nothing** (no photo-sized request in the function log) | no batch |
| 18 Sep | 4 photo uploads, 17:32 and 20:12 | Gemini **HTTP 429** ×4 |
| 19 Sep | 2 uploads | Gemini **HTTP 402** (prepaid credit empty) |
| 20 Sep | 4 uploads | **503** ×3, 1 read and refused |
| 21 Sep | 5 uploads | **503** ×3, 2 read and refused |
| 22 Sep | 2 uploads | 1 read and refused at 150 s, 1 **503** |
| 23 Sep | 1 upload | **503** |
| 24 Sep | nothing | no batch |
| 27 Sep | nothing | no batch (#527) |
| 4 Oct | 3 uploads | **402** ×2, then read OK (#534) |
| **7 Oct** | 2 uploads, 17:03 and 17:40 | Gemini **timed out** after 120 s, both times (504 to the phone) |

Source: Cloud Logging `resource.labels.service_name="cardbatchcapture"` —
`httpRequest.requestSize > 200000` (photos; emailed PDFs are ~70 KB) and the
callable's own `OCR failed:` / `photo read picked=0000HP1X` lines.

## Ruled out

- **Unmapped / mis-mapped TID.** The live registry row and its placement put
  `0000HP1X` on `pe/till-2` from 18 Sep 12:07Z through today. The 5 Oct
  12:46 SAST swap moved `67325636` and `67377843` only. Every successful read
  returned `tid: "0000HP1X"` at 0.99–1.0 confidence. Pinned by
  `functions/test/card-till2-mapping.test.cjs` with the live rows.
- **A slip layout the parser rejects.** The photo reads that came back parsed
  the header and totals at ≥0.99; the one low-confidence read (2 Oct, batch
  number at 0.5) was re-taken and recorded the same minute.

## Why a failed read cost the whole day

1. **The read was synchronous.** The manager stood at the till while Gemini
   worked; a 429/402/503/timeout was the end of it, and the phone said "try
   again".
2. **The photo was discarded with the failure.** `handleExtract` stored the
   photos in Storage only *after* a successful read, so nothing was left to
   retry later — and so none of the missing days can be re-read now.
3. **A timeout was not retried at all.** Only a 503 was; a hang ended the read
   without ever trying the fallback model.

## What changed

- **Commit 1:** a hung read (timeout) or a 500/502/504 now goes straight to the
  fallback model instead of ending the read; the 16 missing days are marked
  **"Unread – needs manual entry"** in the POS report
  (`scripts/cardrecon/mark-till2-unread-20261007.mjs`, one summary email).
- **Commit 2:** the photo is stored the moment it arrives, the manager gets
  "Received", and the read runs server-side with retries over ~8 hours. A read
  that still fails marks that till/day Unread and emails Junid.
- **Commit 3:** Junid types the figures for any till/day in the POS report.

The effective-dated mapping (placements, #695) was already right; nothing in it
changed.
