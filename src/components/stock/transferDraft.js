// ─── TRANSFER DRAFT + IDEMPOTENT MOVEMENT IDS ─────────────────────────────────
// Two failure-protection primitives for the Stock Transfer screen:
//
//   1. A device-local draft of the scan cart in localStorage. A network drop,
//      page reload, or crash mid-transfer must never silently lose scanned lines
//      — the Transfer screen restores the unsent cart on reopen. localStorage
//      (not an RTDB drafts node) is deliberate: it's per-device, works offline,
//      needs no rules, and mirrors the POS `stockQueue.js` durable-queue pattern.
//
//   2. A DETERMINISTIC per-line movement id. The confirm loop moves one
//      `transfer_out` per cart line (each write is already atomic in
//      applyMovement); a partial failure or a lost ack must be retryable WITHOUT
//      re-moving lines that already landed. `transferMovementId` derives the same
//      id for the same (transferId, product, size), so a resend is a no-op in
//      applyMovement's existence check (`stock_movements/{mvId}` already exists) —
//      the transfer can never double-move a line.

import { stockSizeKey } from "../../utils/sizeKey";

const KEY = "transfer_draft_v1";
const SCHEMA = 1;

// Deterministic movement id for one transfer line. Stable across retries and
// across a reload (transferId is persisted in the draft), so applyMovement's
// idempotency guard recognises an already-applied line. The size is run through
// the same `stockSizeKey` encoder used for /stock cell paths so a half-size
// ("5.5") can't produce an RTDB-illegal key. ":" is a legal RTDB key char and
// matches the existing `sold:…` movement-key convention.
export function transferMovementId(transferId, productId, size) {
  return `${transferId}:${productId}:${stockSizeKey(size)}`;
}

// Load the persisted draft, or null when there's nothing usable to restore.
// Guards against a corrupt / stale-schema / empty-cart payload and never throws
// (private-mode reads, malformed JSON) — a broken draft simply reads as "none".
export function loadDraft() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || d.schema !== SCHEMA) return null;
    if (!d.basket || typeof d.basket !== "object" || !Object.keys(d.basket).length) return null;
    return d;
  } catch {
    return null;
  }
}

// Persist the current cart. An empty cart removes the key (a fully-successful
// transfer or a manual Clear leaves nothing to restore). Best-effort: a quota /
// private-mode error is swallowed so persistence can never crash the cart.
export function saveDraft({ from, to, refillId, transferId, basket, lineResults }) {
  try {
    if (!basket || !Object.keys(basket).length) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(
      KEY,
      JSON.stringify({
        schema: SCHEMA,
        savedAt: new Date().toISOString(),
        from: from || "",
        to: to || "",
        refillId: refillId || null,
        transferId: transferId || null,
        basket,
        lineResults: lineResults || {},
      }),
    );
  } catch {
    /* quota / private mode — persistence is best-effort */
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
