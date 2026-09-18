// ─── THE TERMINAL REGISTRY, AS A VOCABULARY ──────────────────────────────────
// /config/cardTerminals/{TID} → { mid, storeId, tillId, label, activeFrom,
// retiredAt?, retiredReason? }. One row per PHYSICAL machine, keyed by the TID
// printed on its slips, and that key is the only thing that identifies it —
// see functions/test/card-terminal-identity.test.cjs for why the MID and the
// trading name cannot be.
//
// THE ROW IS MUTABLE; THE HISTORY IS NOT. A machine gets renamed, moves to the
// till next to it, changes hands. Every one of those edits rewrites the
// registry row and NONE of them may rewrite a batch already filed: a batch
// record carries its own storeId, tillId and terminalLabel, stamped at capture
// (lib/card-recon.cjs, buildBatchRecord), and a reader showing a historical
// batch reads THOSE. The registry answers "where is this machine now", never
// "where was it in August".
//
// A TID MAPPING IS NEVER DELETED. Records are filed under
// /card_batches/{storeId}/{tid}: delete the mapping and the reader stops
// subscribing to that node, and years of batches — the masked PANs, the
// variances, the settled windows — become unreachable without anybody being
// told. So a machine that leaves the estate is RETIRED: `retiredAt` is stamped,
// the row stays, its history keeps resolving, and nothing new can be captured
// against it by hand. Nothing is retired today (the 2026-09-18 change added two
// terminals and removed none) — this exists because the next swap will need it,
// and a mechanism built on the day of a swap is a mechanism built in a hurry.
//
// A LATE SLIP FROM A RETIRED MACHINE IS STILL RECORDED. The manual path refuses
// it — a retired machine has no till to be photographed at — but a batch report
// that arrives by email after the machine went is exactly the settlement money
// nobody can afford to drop, so the email path records it and says on the
// record that the terminal was retired. A refusal there would lose the money,
// which is a worse answer than a warning.
//
// PURE by the house rule: no firebase-admin, no fetch, no clock. Mirrored for
// the client in src/components/cardrecon/terminalRegistry.js — the two are
// fuzzed against each other in src/components/cardrecon/terminalRegistry.test.js,
// because two copies of a predicate eventually disagree and the disagreement
// shows up as a retired machine still being offered on a handset.
//
// Tested in functions/test/card-terminal-identity.test.cjs.

"use strict";

/**
 * Is this machine out of the estate?
 *
 * `retiredAt` — the stamp — IS the flag. A separate boolean beside it is a
 * second source that can disagree with the first, and "retired: false with a
 * retiredAt" is a state nobody can read.
 */
function isRetiredTerminal(row) {
  return Number.isFinite(row && row.retiredAt);
}

/**
 * Was this machine in the estate at `atMs`?
 *
 * `activeFrom` is when the terminal entered THIS estate, which is not when it
 * was manufactured and not batch 1 — two of the six live machines arrived
 * second-hand, mid-life, on batches 57 and 480. It bounds the "no slip
 * submitted" row so a terminal registered today is not reported as having
 * missed every evening since the range began.
 *
 * A row with no `activeFrom` has always been active: the four terminals seeded
 * on 2026-08-29 predate the field, and treating them as inactive would blank
 * the outstanding report for the estate's whole history.
 */
function wasActiveAt(row, atMs) {
  if (!row) return false;
  if (!Number.isFinite(atMs)) return false;
  const from = Number(row.activeFrom);
  if (Number.isFinite(from) && atMs < from) return false;
  if (isRetiredTerminal(row) && atMs > row.retiredAt) return false;
  return true;
}

/**
 * The warning a slip carries when its window STRADDLES a till reassignment.
 *
 * This is the one edit to a registry row that silently corrupts a figure. The
 * expected-card calculator joins the terminal's CURRENT storeId + tillId
 * against /pos/paymentEvents over the slip's own Opened -> Closed window — and a
 * batch settles at ~18:50, so the first window after a till move BEGAN BEFORE
 * THE MOVE and closed after it. Across the pre-move part of that window the
 * machine's real card legs are tagged with the OLD till (excluded — a false
 * shortfall) while the till it has now was being worked by something else
 * (included — a contaminated total). The variance that comes out is confident
 * and wrong, on exactly the slip somebody will look at hardest, and it will be
 * chased as an ordinary discrepancy because nothing says otherwise.
 *
 * There is no fix that computes the RIGHT figure: the registry holds a
 * terminal's CURRENT mapping and no history of it, deliberately — POS #357
 * reverted a reader that followed a terminal's mapping history, on the owner's
 * instruction. So this refuses to be confident instead. `tillChangedAt` is
 * stamped whenever a row's tillId changes, and any slip whose window opened
 * before that stamp says so on its own record, where the owner reads the
 * variance.
 *
 * It stops mattering by itself: the next batch opens after the stamp.
 */
function tillMoveWarning(tid, row, openedAt) {
  const movedAt = Number(row && row.tillChangedAt);
  if (!Number.isFinite(movedAt) || !Number.isFinite(openedAt)) return null;
  if (openedAt >= movedAt) return null;
  const when = new Date(movedAt).toISOString().slice(0, 16).replace("T", " ");
  return `This batch opened before terminal ${tid} was reassigned to ${row.storeId}/${row.tillId} (${when} UTC), so its window spans the move. The expected figure is the NEW till's takings across the WHOLE window and the old till's are not in it, which makes the variance on this one batch unreliable. Reconcile it by hand; the next batch is clean.`;
}

/** The warning a retired terminal's emailed slip carries onto its record. */
function retiredSlipWarning(tid, row) {
  const when = Number.isFinite(row && row.retiredAt)
    ? new Date(row.retiredAt).toISOString().slice(0, 10)
    : "an unrecorded date";
  return `Terminal ${tid} was retired on ${when}, and this report arrived after that. It is recorded against the till it was mapped to — check that this is a late final batch and not a machine still trading that nobody re-registered.`;
}

/** The refusal a retired terminal gets on the manual path. */
function retiredCaptureRefusal(tid, row) {
  const label = (row && row.label) || tid;
  return `${label} (${tid}) is retired — it is no longer mapped to a till that can take a capture. If this machine is trading again, an admin reinstates it (scripts/seed-card-terminals.mjs --reinstate) before its slips can be recorded.`;
}

module.exports = { isRetiredTerminal, wasActiveAt, tillMoveWarning, retiredSlipWarning, retiredCaptureRefusal };
