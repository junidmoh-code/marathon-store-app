// ─── A later sale is never blocked by a written-off cell ─────────────────────
// The refusal write-off (functions/lib/refusal-writeoff.cjs) is written by the
// SERVER writer. A device then sells from the same cell with the CLIENT writer.
// This drives both on the same cell: the server erases the phantom 3, and the
// client's `sold` of 1 must still go through — the sale is booked, the cell
// floors at 0 and the gap is recorded as `shortfall`, exactly as on any other
// empty cell. It also pins that the cell the server leaves behind satisfies the
// live /stock rule every device write is validated against (lastType enum, v+1,
// mv changes), because a device write that leaves lastType untouched is checked
// against the stored value.

import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { stockCellPath } from "../../utils/sizeKey";

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
    if (depth === parts.length - 1) {
      if (value === null) delete node[key]; else node[key] = value;
    } else {
      if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
      walk(node[key], depth + 1);
      if (Object.keys(node[key]).length === 0) delete node[key];
    }
  };
  walk(store, 0);
}
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => { for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v); },
  push: () => ({ key: "sale-mv-1" }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "pos-device" } } }));
const { applyMovement } = await import("./applyMovement.js");

const require = createRequire(import.meta.url);
const { applyMovementAdmin } = require("../../../functions/lib/admin-movement.cjs");
const { makeFakeDb } = require("../../../functions/test/helpers/fake-rtdb.cjs");

// The live /stock/$loc/$pid/$size .validate, first branch (fetched 2026-09-23).
const LAST_TYPE_ENUM = /^(received|opening|sold|transfer_in|transfer_out|adjustment|return)$/;
function liveRuleAccepts(before, after) {
  return typeof after.qty === "number" && after.qty % 1 === 0
    && after.v === (before ? before.v + 1 : 0)
    && after.mv !== (before ? before.mv : undefined)
    && LAST_TYPE_ENUM.test(after.lastType)
    && (after.qty >= 0 || /^(sold|return|transfer_out|transfer_in)$/.test(after.lastType));
}

describe("refusal write-off, then a sale at the same cell", () => {
  it("the sale is booked (floor 0 + shortfall), and every write passes the live /stock rule", async () => {
    const PID = "p1780382141061", SIZE = "M";
    const path = stockCellPath("hub2", PID, SIZE);
    const seed = { qty: 3, v: 4, mv: "cr_R033-1", lastType: "transfer_out", state: "live" };
    const db = makeFakeDb({ stock: { hub2: { [PID]: { [SIZE]: { ...seed } } } } });
    const w = await applyMovementAdmin(db, {
      type: "refusal_writeoff", productId: PID, size: SIZE, qty: 3, from: "hub2",
      movementId: "rwo_1789654522516_hub2_p1780382141061_M", actor: "system:refusal-writeoff",
      actorRole: "system", reason: "refused on 4 different days", expectQty: 3,
    }, { nowIso: "2026-09-23T13:00:00.000Z" });
    expect(w.ok).toBe(true);
    const afterWriteoff = (await db.ref(path).once("value")).val();
    expect(afterWriteoff.qty).toBe(0);
    expect(liveRuleAccepts(seed, afterWriteoff)).toBe(true);

    // Hand the cell to the client writer and sell one.
    store = {};
    setPath(path, structuredClone(afterWriteoff));
    const sale = await applyMovement({ type: "sold", productId: PID, size: SIZE, qty: 1, from: "hub2", to: null, actorRole: "pos" }, { maxRetries: 1 });
    expect(sale.ok).toBe(true);
    const afterSale = getPath(path);
    expect(afterSale.qty).toBe(0);
    expect(afterSale.lastType).toBe("sold");
    expect(liveRuleAccepts(afterWriteoff, afterSale)).toBe(true);
    expect(getPath("stock_movements/sale-mv-1").shortfall).toBe(1);
  });
});
