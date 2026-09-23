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
// the request has NOT been sent; once it has, the tap is a no-op and the
// caller logs it as blocked. Staff see nothing different — the row leaves the
// list either way, because the live listener already shows it as fulfilled.
//
// "Sent" = what a full send writes: status "fulfilled", or a fulfilledBy
// record (the movement that moved the units — a counted transfer, or the
// "received" credit for an uncounted send). A PARTLY sent request is still
// open for its remainder, and "Out of Stock" on that remainder is a real
// answer the queue has always accepted: it stays allowed, and the sentQty
// already recorded survives the write (the transaction keeps every field it
// does not set). Pure — no Firebase here.

export function alreadySent(rr) {
  if (!rr || typeof rr !== "object") return false;
  return rr.status === "fulfilled" || !!(rr.fulfilledBy && typeof rr.fulfilledBy === "object");
}

/**
 * The transaction body for "Out of Stock" on a request.
 *   cur     the live node (null on a cold cache first pass)
 *   fields  the refusal fields; a null value clears that field
 * → the next node, null (probe: see below), or undefined (blocked — abort).
 */
export function refusalTxn(cur, fields) {
  // NULL-TOLERANT (the #199 lesson — refill-scan.cjs has the long form): the
  // first pass can run against a cold local cache and see null for a node
  // that exists. Returning undefined would abort for good; returning null
  // probes — a real node fails the server's compare and this re-runs with the
  // true value, a genuinely missing request stays missing.
  if (cur === null || cur === undefined) return null;
  if (alreadySent(cur)) return undefined;
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  return next;
}
