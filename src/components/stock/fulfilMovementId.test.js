// ─── A legitimate fulfil can never be swallowed as a duplicate ───────────────
// FULFIL-CREDIT-GAP.md, Phase F: "a swallowed-id transfer is impossible". The
// forensics found no collision on the Diesel request, but the spec asks for
// the property to be pinned. Two halves:
//   • the writer resolves a movement as a duplicate ONLY when a ledger row
//     already exists under that exact id — a fresh id always moves stock;
//   • the id schemes in play cannot produce one id for two different legs:
//     a fulfil (`rrf_{requestId}`, tranches `rrf_{requestId}_{sent}`), its
//     release (`rel_{lineId}`), the repair (`fcr_{creditId}`) and the manual
//     transfer lane (`{transferId}:{pid}:{sizeKey}` / `rcv:` twin) live in
//     disjoint prefix spaces, and request ids are RTDB push keys (unique).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";
import { transferMovementId, receiveMovementId } from "./transferDraft";

let store = {};
function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) { if (node == null || typeof node !== "object") return null; node = node[part]; }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  const walk = (node, depth) => {
    const key = parts[depth];
    if (depth === parts.length - 1) { if (value === null) delete node[key]; else node[key] = value; }
    else { if (typeof node[key] !== "object" || node[key] === null) node[key] = {}; walk(node[key], depth + 1); if (Object.keys(node[key]).length === 0) delete node[key]; }
  };
  walk(store, 0);
}
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => { for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v); },
  push: () => ({ key: "pushed" }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));
const { applyMovement } = await import("./applyMovement.js");

const PID = "p1778157967464";
const fulfil = (requestId, sent = 0) => (sent ? `rrf_${requestId}_${sent}` : `rrf_${requestId}`);

beforeEach(() => { store = {}; setPath(stockCellPath("central", PID, "6"), { qty: 5, v: 0, mv: "seed", lastType: "received" }); });

describe("a swallowed-id transfer is impossible", () => {
  it("two requests for the same product and size never share a movement id, and both move stock", async () => {
    const a = fulfil("-P151_2zzLyo57i8j7Ll"), b = fulfil("-P1EXFW5GrUOQsOmpy-e");
    expect(a).not.toBe(b);
    const r1 = await applyMovement({ type: "transfer_out", productId: PID, size: "6", qty: 1, from: "central", to: "hub1", movementId: a }, { maxRetries: 1 });
    const r2 = await applyMovement({ type: "transfer_out", productId: PID, size: "6", qty: 1, from: "central", to: "hub1", movementId: b }, { maxRetries: 1 });
    expect(r1).toEqual({ ok: true, movementId: a });
    expect(r2).toEqual({ ok: true, movementId: b });           // NOT idempotent — a fresh id moves
    expect(getPath(stockCellPath("hub1", PID, "6")).qty).toBe(2);
    expect(getPath(stockCellPath("central", PID, "6")).qty).toBe(3);
  });

  it("only the SAME id replays as a no-op — and it moves nothing the second time", async () => {
    const id = fulfil("-P151_2zzLyo57i8j7Ll");
    await applyMovement({ type: "transfer_out", productId: PID, size: "6", qty: 1, from: "central", to: "hub1", movementId: id }, { maxRetries: 1 });
    const again = await applyMovement({ type: "transfer_out", productId: PID, size: "6", qty: 1, from: "central", to: "hub1", movementId: id }, { maxRetries: 1 });
    expect(again.idempotent).toBe(true);
    expect(getPath(stockCellPath("hub1", PID, "6")).qty).toBe(1);
  });

  it("a tranche id, the release id, the repair id and the transfer-lane ids are pairwise distinct for one request", () => {
    const req = "-P151_2zzLyo57i8j7Ll";
    const ids = [fulfil(req), fulfil(req, 1), `rel_${fulfil(req)}`, `fcr_${fulfil(req)}`,
      transferMovementId(req, PID, "6"), receiveMovementId(req, PID, "6")];
    expect(new Set(ids).size).toBe(ids.length);
    // A tranche id `rrf_{push}_{n}` cannot be the fulfil id of another
    // engine request: push keys are exactly 20 characters, so `{push}_{n}`
    // is never itself a push key.
    expect(req).toHaveLength(20);
    expect(`${req}_1`).not.toHaveLength(20);
  });
});
