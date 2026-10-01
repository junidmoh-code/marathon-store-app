// ─── OUT OF STOCK CANNOT OVERWRITE A SENT REQUEST (2026-09-23) ───────────────
// The queue's "Out of Stock" on a /refill_requests row used to be a blind
// multi-path update: status → "cancelled", whatever the row said by then. A
// list that was stale (another device had just sent the size, or this device
// had not caught up) turned a FULFILLED request into a refusal — live case
// -P28C3fKttMx5YtJGvp2: cancelled, yet it still carried fulfilledBy and a real
// transfer out of Central (second-brain review, PR #642). The refusal
// write-off (#642) defends itself against that shape; this makes the button
// itself right.
//
// The refusal is now a transaction on the request node. It applies only while
// the request is still OPEN and nothing is on its way; otherwise the tap is a
// no-op and the caller logs it as blocked. Staff see nothing different — the
// row leaves the list either way, because the live listener already shows it
// as resolved.
//
// Blocked:
//   • SENT — what a full send writes: status "fulfilled", or a fulfilledBy
//     record (the movement that moved the units — a counted transfer, or the
//     "received" credit for an uncounted send).
//   • ALREADY CLOSED — any status but "open": an engine withdrawal
//     (no_longer_needed …) or another person's refusal. Re-refusing it would
//     strip the engine's cancelReason and turn a withdrawal into a staff "no"
//     that counts toward the four-day write-off (reproduced on the emulator,
//     second-brain review, PR #643). The Fulfil button has always refused a
//     non-open request the same way.
//   • MID-SEND — Fulfil moves the stock FIRST (movement rrf_{id}, or
//     rrf_{id}_{sentQty} for a later tranche) and writes the request after.
//     The caller looks that one movement up; if it was recorded in the last
//     MID_SEND_MS for the tranche the request is still at, units are on their
//     way and a refusal landing in the gap would leave moved stock under a
//     "cancelled" request. An OLDER movement is not a send in flight but a
//     stuck one (its bookkeeping write failed and nobody retried): blocking
//     there would silence the button on that row for good, so the refusal
//     goes through as it always has — and the #642 write-off still counts the
//     ledger transfer as a fulfilment (review of the fix delta, PR #643).
// A PARTLY sent request is still open for its remainder, and "Out of Stock" on
// that remainder is a real answer the queue has always accepted: it stays
// allowed, and the sentQty already recorded survives the write (the
// transaction keeps every field it does not set). Pure — no Firebase here.

export function alreadySent(rr) {
  if (!rr || typeof rr !== "object") return false;
  return rr.status === "fulfilled" || !!(rr.fulfilledBy && typeof rr.fulfilledBy === "object");
}

const sentOf = (rr) => Number(rr?.sentQty) || 0;

// How long after its movement a send counts as still in flight. Fulfil's
// bookkeeping follows the movement within one round trip; two minutes is a
// wide margin for a slow connection.
export const MID_SEND_MS = 2 * 60 * 1000;

// Was this tranche movement recorded recently enough to be a send in flight?
// An unreadable time is treated as NOT in flight — never wedge the button.
export function sendInFlight(movement, nowMs) {
  if (!movement || typeof movement !== "object") return false;
  const t = Date.parse(movement.ts || "");
  return Number.isFinite(t) && nowMs - t >= -MID_SEND_MS && nowMs - t <= MID_SEND_MS;
}

// The id Fulfil gives the tranche a request is at (RefillQueue fulfilRequest).
export function trancheMovementId(id, sentQty) {
  const already = Number(sentQty) || 0;
  return already === 0 ? `rrf_${id}` : `rrf_${id}_${already}`;
}

/**
 * The transaction body for "Out of Stock" on a request.
 *   cur          the live node (null on a cold cache first pass)
 *   fields       the refusal fields; a null value clears that field
 *   sendingAt    the sentQty whose tranche movement the caller found recorded
 *                AND still in flight (sendInFlight); null otherwise
 * → the next node, null (probe: see below), or undefined (blocked — abort).
 */
export function refusalTxn(cur, fields, { sendingAt = null } = {}) {
  // NULL-TOLERANT (the #199 lesson — refill-scan.cjs has the long form): the
  // first pass can run against a cold local cache and see null for a node
  // that exists. Returning undefined would abort for good; returning null
  // probes — a real node fails the server's compare and this re-runs with the
  // true value, a genuinely missing request stays missing.
  if (cur === null || cur === undefined) return null;
  if (typeof cur !== "object") return undefined;
  if (alreadySent(cur) || cur.status !== "open") return undefined;
  if (sendingAt !== null && sentOf(cur) === Number(sendingAt)) return undefined;
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  return next;
}
