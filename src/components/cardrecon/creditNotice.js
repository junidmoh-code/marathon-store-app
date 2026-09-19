// ─── WHEN A FEATURE IS DARK, SAY WHY ─────────────────────────────────────────
// Pure: no React, no Firebase. The screen reads the node; this decides whether
// there is anything to say and what the sentence is.
//
// ── WHAT THIS EXISTS TO STOP ─────────────────────────────────────────────────
// One prepaid Gemini wallet pays for the social image engine, product photo
// generation, the AI assistant and card-recon slip OCR. It emptied on
// 2026-09-13. The social feed went dark and nobody connected the two; six days
// later a manager stood at a till photographing a slip that would never record,
// and the screen told him to check the signal.
//
// A feature that is off because the money ran out must SAY SO. Not because the
// manager can fix it — he cannot — but because "the AI credits are empty" ends
// the investigation, and "that did not go through" starts a wrong one. It also
// tells him the thing he actually needs: the emailed reports are still landing,
// so the batch is not lost and there is nothing to chase.
//
// ── IT STAYS QUIET UNLESS IT IS CERTAIN ──────────────────────────────────────
// This banner appears on a screen a manager uses for ten seconds. A warning
// shown on a healthy day is a warning that gets ignored on a bad one, so:
//
//   • "empty" is the ONLY level that speaks here. "low" is the owner's
//     business and reaches him by email; a manager can do nothing with it and
//     photo capture still works.
//   • a status that cannot be read, or has never been written, says NOTHING.
//     An unreadable node is not evidence of an empty wallet.
//   • a STALE status says nothing either. The scan runs hourly; a verdict from
//     last week describes a wallet that may have been topped up since, and
//     announcing an outage that is over is how a screen loses its credibility.

/** How old a verdict may be before it stops being evidence about right now. */
export const MAX_STATUS_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * The sentence for a card-capture screen, or null when there is nothing to say.
 *
 * @param {object|null} status  /ai_credit_status, as read (null = denied/absent)
 * @param {number} nowMs        the server clock, never the handset's
 * @returns {{title:string, detail:string}|null}
 */
export function captureCreditNotice(status, nowMs) {
  if (!status || typeof status !== "object") return null;
  if (status.level !== "empty") return null;

  const checkedAt = Number(status.checkedAt);
  if (!Number.isFinite(checkedAt)) return null;
  // A verdict from the future is a clock problem, not a wallet problem, and is
  // no more trustworthy than a stale one.
  if (checkedAt > nowMs + 60000) return null;
  if (nowMs - checkedAt > MAX_STATUS_AGE_MS) return null;

  return {
    title: "Photo capture is down — the AI credits have run out.",
    // WHAT THE MANAGER SHOULD DO, which is nothing, said plainly. The second
    // sentence is the one that matters on a shop floor: the machines that
    // email are still reporting, so no batch is being lost while this lasts.
    detail: "Photographing a slip cannot work until the owner tops up, so there is no point retaking it. "
      + "The machines that email their report are still recording normally. Junid has been told.",
  };
}
