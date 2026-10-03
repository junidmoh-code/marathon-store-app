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
  // |age|: a marker stamped by a device whose clock ran ahead (before its
  // server offset loaded) must not block for hours (Fable review, PR #677).
  return Math.abs(nowMs - at) < PICK_MARKER_TTL_MS;
}

// The claim's transaction body. Returns the new row, or undefined to abort:
// a request that is no longer open is not ours to pick, and ANY fresh claim
// is another attempt mid-pick — two devices on the same tranche compute the
// same movement id, so ownership is a per-attempt TOKEN, never the movement
// id (CodeRabbit, PR #677). A null first callback is a cold cache, never "the
// row is gone": return null so the server value re-runs it.
// `replayOf`: set ONLY when the movement under this tranche id already exists
// (a retry finishing its bookkeeping) — then a claim on that same tranche may
// be taken over: the stock has moved, and the retry is what completes it.
// `nowMs` judges an existing claim; `stamp` is what the new claim records —
// the caller passes the SERVER's timestamp sentinel, so a device whose clock
// offset has not loaded can never stamp a claim the scan reads as expired
// (CodeRabbit, PR #677). `picking.atMs` is not a rules-validated field.
export function claimPickTxn(cur, { movementId, nowMs, stamp = nowMs, by, token, replayOf = null }) {
  if (cur === null || cur === undefined) return null;
  if (cur.status !== "open") return undefined;
  if (pickInProgress(cur, nowMs) && !(replayOf && cur.picking.movementId === replayOf)) return undefined;
  return { ...cur, picking: { atMs: stamp, movementId, by: by || null, token } };
}

// Releases a claim only while it is still THIS attempt's (its token).
export function releasePickTxn(cur, token) {
  if (cur === null || cur === undefined) return null;
  return cur && cur.token === token ? null : undefined;
}

// A per-attempt token (not a secret — an identity for one tap).
export const newPickToken = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
