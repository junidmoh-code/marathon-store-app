// ─── EVERY FAILED MANUAL TRANSFER LEAVES A NOTE (Junid, 26 Nov 2026) ─────────
// Two days of "it still fails" went by with nothing on record, because a
// refused write leaves no trace in the database. Now each failure writes one
// tiny append-only row:
//
//   /logs/transferFailures/{pushId}
//     { code, message, uid, role, from, to, productId, lines, stage, build, atMs }
//
// Write-only from the app: nothing here ever reads the node (never a
// whole-node read). Best-effort and fire-and-forget — logging must never
// stand between a person and their retry. atMs is serverNowMs() (the console
// rule validates it against `now`). The console rule for this path is in
// scripts/emulator/proposedTransferRules.mjs.

import { ref, push, set } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { CURRENT_VERSION } from "../../update/updateChecker";

export const TRANSFER_FAILURES_PATH = "logs/transferFailures";

const str = (v, n) => (v == null ? null : String(v).slice(0, n));

export function transferFailureRecord({ error, reason, role, from, to, productId, lines, stage }) {
  const code = error?.code ? String(error.code).replace(/^database\//, "") : (reason || null);
  return {
    code: str(code || "unknown", 60),
    message: str(error?.message || error || reason || "", 300),
    uid: auth.currentUser?.uid || null,
    role: str(role, 30),
    from: str(from, 40),
    to: str(to, 40),
    productId: str(productId, 80),
    lines: Number.isFinite(lines) ? lines : null,
    stage: str(stage, 30),
    build: str(CURRENT_VERSION, 60),
    atMs: serverNowMs(),
  };
}

export function logTransferFailure(facts) {
  try {
    const rec = transferFailureRecord(facts);
    const r = push(ref(database, TRANSFER_FAILURES_PATH));
    return set(r, rec).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}
