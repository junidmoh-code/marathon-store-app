// ─── A PICK IN PROGRESS — the client half (2026-10-03) ──────────────────────
// Central's fulfil moves stock with applyMovement (its own transactional
// writer) and records sentQty / fulfilled in a second write. The refill scan
// could land between the two and close, resize or withdraw a request whose
// units had already left. So the picker CLAIMS the request first, by
// transaction, with `picking: { atMs, movementId, by }` — atMs from
// serverNowMs, never the device clock — then moves stock, then clears the
// marker in the SAME write as sentQty / fulfilled. Every server close,
// resize and withdrawal refuses a request carrying a fresh marker.
// Server twin: functions/lib/shop-source-rule.cjs pickInProgress (pinned
// equal by test).
export const PICK_MARKER_TTL_MS = 30 * 60e3;

export function pickInProgress(rr, nowMs = Date.now()) {
  const p = rr && rr.picking;
  if (!p || typeof p !== "object") return false;
  const at = Number(p.atMs);
  if (!Number.isFinite(at)) return true;
  return nowMs - at < PICK_MARKER_TTL_MS;
}

// The claim's transaction body. Returns the new row, or undefined to abort:
// a request that is no longer open is not ours to pick, and a FRESH marker
// for a DIFFERENT tranche is another device mid-pick. Our own marker (same
// movement id — a retry) is re-stamped. A null first callback is a cold
// cache, never "the row is gone": return null so the server value re-runs it.
export function claimPickTxn(cur, { movementId, atMs, by }) {
  if (cur === null || cur === undefined) return null;
  if (cur.status !== "open") return undefined;
  if (pickInProgress(cur, atMs) && cur.picking.movementId !== movementId) return undefined;
  return { ...cur, picking: { atMs, movementId, by: by || null } };
}
