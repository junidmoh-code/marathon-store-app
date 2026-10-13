// ─── BLACK FRIDAY "COMING SOON" TAPE ─────────────────────────────────────────
// Junid's teaser: two black barrier tapes crossing the floor of the queue board,
// "BLACK FRIDAY" in white and "COMING SOON" in red, scrolling. It is a countdown
// teaser, so it takes itself down: from Black Friday itself (27 Nov 2026, SAST
// midnight) "coming soon" would be a lie, and the board goes back to its footer
// with no deploy needed. Pure — the board passes server time in.

export const BLACK_FRIDAY_MS = Date.parse("2026-11-27T00:00:00+02:00");

export function showBlackFridayTape(nowMs) {
  return Number.isFinite(nowMs) && nowMs < BLACK_FRIDAY_MS;
}
