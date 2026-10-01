// The store-app writer against the SHARED drift table (__fixtures__/negativeBase.json —
// byte-identical copy in marathon-pos-app src/stock/__fixtures__). Two copies of one
// rule drift; the table is what stops them drifting apart unnoticed.
import { describe, it, expect, vi } from "vitest";
import table from "./__fixtures__/negativeBase.json";
import { stockCellPath } from "../../utils/sizeKey";
let store = {};
const getPath = (p) => { let n = store; for (const k of String(p).split("/")) { if (n == null || typeof n !== "object") return null; n = n[k]; } return n === undefined ? null : n; };
const setPath = (p, v) => { const ks = String(p).split("/"); let n = store; for (let i = 0; i < ks.length - 1; i++) { if (typeof n[ks[i]] !== "object" || n[ks[i]] === null) n[ks[i]] = {}; n = n[ks[i]]; } if (v === null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = v; };
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }), child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => { for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v); },
  push: () => ({ key: "mvX" }),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const { applyMovement } = await import("./applyMovement.js");

describe("negative-base drift table — store-app writer", () => {
  for (const row of table.rows) {
    it(row.case, async () => {
      store = {};
      if (row.curQty !== null) setPath(stockCellPath("marathon-pe", "p1", "10"), { qty: row.curQty, v: 1, mv: "m0", lastType: "received" });
      const res = await applyMovement({ type: row.type, productId: "p1", size: "10", qty: row.qty, ...(row.type === "sold" ? { from: "marathon-pe" } : { to: "marathon-pe" }), movementId: "mvX" }, { maxRetries: 1 });
      expect(res.ok).toBe(true);
      expect(getPath(stockCellPath("marathon-pe", "p1", "10")).qty).toBe(row.newQty);
      const mv = getPath("stock_movements/mvX");
      expect(mv.shortfall ?? null).toBe(row.shortfall);
      expect(mv.negativeCleared ? mv.negativeCleared["marathon-pe"] : null).toBe(row.negativeCleared);
    });
  }
});
