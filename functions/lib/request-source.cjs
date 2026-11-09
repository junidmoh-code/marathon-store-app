// ─── THE SCAN IS THE ONLY REQUESTER — source tag + guard (Junid, 1 Nov 2026) ──
//
// Junid's model: stock leaves a location only through a sale, and a request to
// Central or a hub is raised ONLY by the refill scan comparing on hand against
// policy. A Solve is not a request (it places a product's policy batch).
//
// Every request now carries `requestSource`:
//   "scan"   functions/refill-scan.cjs (live rows and SHDWrr- previews)
//   "solve"  the clothing Solve (firstBatchCore.js), its Hub 2 leg
//            (lib/first-batch.cjs) and the Missing Sneakers Solve
// Rows written before the tag existed are recognised by their shape, so a
// stale client or an old function revision mid-deploy is judged by what it
// wrote, never guessed:
//   createdFrom.engine === true                      → scan
//   createdFrom.firstBatch === true, or via one of
//   the Solve vias                                   → solve
// Anything else — the on-hold path, the website escalation, a typed-quantity
// request, an untagged write — is REJECTED by refillRequestSourceGuard
// (functions/index.js): cancelled while still untouched, with cancelReason
// "not_scan_source", and logged at /refill_engine/rejectedRequests/{id}.
//
// PURE.

"use strict";

const REQUEST_SOURCE = Object.freeze({ SCAN: "scan", SOLVE: "solve" });
const SOLVE_VIAS = Object.freeze(["missing_products_solve", "first_batch_hub2_leg", "missing_sneakers", "hub3_solve"]);
const REJECT_REASON = "not_scan_source";
const REJECTED_LOG = "refill_engine/rejectedRequests";

/** "scan" | "solve" | null (rejected). */
function classifyRequestSource(rr) {
  if (!rr || typeof rr !== "object") return null;
  const cf = rr.createdFrom && typeof rr.createdFrom === "object" ? rr.createdFrom : {};
  // Hub 1 + Hub 2 is never one sneaker Solve (Junid, 9 Nov 2026): the server's
  // half of the refusal, whatever a screen let through.
  if (Array.isArray(cf.solveHubs) && cf.solveHubs.includes("hub1") && cf.solveHubs.includes("hub2")) return null;
  if (rr.requestSource === REQUEST_SOURCE.SCAN) return cf.engine === true ? REQUEST_SOURCE.SCAN : null;
  if (rr.requestSource === REQUEST_SOURCE.SOLVE) return (cf.firstBatch === true || SOLVE_VIAS.includes(cf.via)) ? REQUEST_SOURCE.SOLVE : null;
  if (rr.requestSource != null) return null;   // an unknown tag is not a pass
  if (cf.engine === true) return REQUEST_SOURCE.SCAN;
  if (cf.firstBatch === true || SOLVE_VIAS.includes(cf.via)) return REQUEST_SOURCE.SOLVE;
  return null;
}

/**
 * The transaction body for a rejected request: cancel it only while nobody has
 * touched it (still open, nothing sent, no fulfil, no pick claimed). Returns
 * undefined (abort) otherwise — a person's send always wins.
 */
function rejectTxn(cur, { nowIso }) {
  if (cur == null) return null;                       // cold pass
  if (cur.status !== "open") return undefined;
  if (Number(cur.sentQty) > 0 || cur.fulfilledBy || cur.picking) return undefined;
  if (classifyRequestSource(cur) !== null) return undefined;   // a scan/Solve row — never ours to cancel
  return { ...cur, status: "cancelled", cancelReason: REJECT_REASON, resolvedAt: nowIso, rejectedBySourceGuard: true };
}

// ── HUB 1 / HUB 2 NEVER SHARE A SNEAKER, ACROSS SEPARATE SOLVES (Junid, 9 Nov 2026) ──
// The server's half of the refusal (the screen has the other). A Solve row names
// one hub, so the guard asks whether the other hub already has the product
// seated. A claim per product stops two Solves in the same moment each seeing
// nothing: the first to the claim wins. `refill_engine` is server-only.
const SOLVE_SEATS = "refill_engine/solveSeats";
const SEAT_REJECT_REASON = "seated_at_other_marathon_hub";

/** { hub, other, pid } for a sneaker Solve line at Hub 1 or Hub 2, else null. */
function marathonSolveLeg(rr) {
  const hub = rr?.requestingLocation;
  if (hub !== "hub1" && hub !== "hub2") return null;
  if (rr.requestSource !== REQUEST_SOURCE.SOLVE || rr.createdFrom?.via !== "missing_sneakers") return null;
  if (typeof rr.productId !== "string" || !rr.productId) return null;
  return { hub, other: hub === "hub1" ? "hub2" : "hub1", pid: rr.productId };
}

/**
 * Transaction body for the claim. Aborts (undefined) when the OTHER hub holds a
 * claim that is not known to be finished: `staleIds` are the claim's requests
 * this run read as no longer open; one it did not read keeps the claim alive.
 */
function claimSolveSeat(cur, { hub, id, nowIso, staleIds = [] }) {
  if (cur && cur.hub !== hub) {
    const live = Object.keys(cur.requests || {}).some((r) => !staleIds.includes(r));
    if (live) return undefined;
    cur = null;
  }
  return { hub, at: cur?.at || nowIso, requests: { ...(cur?.requests || {}), [id]: true } };
}

/** Cancels a refused Solve line while nobody has touched it; a person's send wins. */
function rejectSeatTxn(cur, { nowIso }) {
  if (cur == null) return null;
  if (cur.status !== "open") return undefined;
  if (Number(cur.sentQty) > 0 || cur.fulfilledBy || cur.picking) return undefined;
  return { ...cur, status: "cancelled", cancelReason: SEAT_REJECT_REASON, resolvedAt: nowIso, rejectedBySourceGuard: true };
}

/** The log record Junid reads: who/what wrote it, what it asked. */
function rejectionRecord(id, rr, { nowIso, cancelled, reason = null }) {
  const cf = rr?.createdFrom && typeof rr.createdFrom === "object" ? rr.createdFrom : {};
  return {
    id, at: nowIso, cancelled: !!cancelled, ...(reason ? { reason } : {}),
    productId: rr?.productId ?? null, size: rr?.size ?? null, qty: Number(rr?.qty) || 0,
    requestingLocation: rr?.requestingLocation ?? null, source: cf.source ?? rr?.source ?? null,
    via: cf.via ?? null, requestSource: rr?.requestSource ?? null,
    createdAt: rr?.createdAt ?? null, createdBy: rr?.stamps ? Object.values(rr.stamps)[0]?.personName ?? null : null,
  };
}

module.exports = {
  REQUEST_SOURCE, SOLVE_VIAS, REJECT_REASON, REJECTED_LOG, SOLVE_SEATS, SEAT_REJECT_REASON,
  classifyRequestSource, rejectTxn, rejectionRecord, marathonSolveLeg, claimSolveSeat, rejectSeatTxn,
};
