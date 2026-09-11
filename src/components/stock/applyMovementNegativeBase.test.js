// ─── applyMovement — an arrival never pays a phantom debt ─────────────────────
// The Diesel Slide Full Black incident (FULFIL-CREDIT-GAP.md, 2026-09-11): a
// Hub 1 cell at −1 received a real unit and read 0. These tests pin the rule
// on the REAL single writer: an arrival at a shelf credits from max(cell, 0)
// and records the cleared debt; an adjustment and a transit landing do not.
//
// Mutation-proved in scripts/mutation-proof-fulfil-credit-gap.mjs.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

let store = {};
let pushN = 0;
function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  let node = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  if (value === null) delete node[parts[parts.length - 1]];   // real RTDB deletes nulls
  else node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => { for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v); },
  push: () => ({ key: `mv${++pushN}` }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));

const { applyMovement } = await import("./applyMovement.js");

const PID = "diesel";
const cell = (loc, size = "6") => getPath(stockCellPath(loc, PID, size));
const seed = (loc, qty, size = "6") => setPath(stockCellPath(loc, PID, size), { qty, v: 2, mv: "m0", lastType: "sold" });
const ledger = () => getPath("stock_movements") || {};
const only = () => { const ids = Object.keys(ledger()); expect(ids).toHaveLength(1); return ledger()[ids[0]]; };

beforeEach(() => { store = {}; pushN = 0; });

describe("negative base — the Diesel Slide case", () => {
  it("a refill transfer onto a −1 shelf lands the unit: hub1 reads 1, not 0", async () => {
    seed("central", 1); seed("hub1", -1);
    const res = await applyMovement({ type: "transfer_out", productId: PID, size: "6", qty: 1, from: "central", to: "hub1", reason: "hub1_auto_refill" }, { maxRetries: 1 });
    expect(res.ok).toBe(true);
    expect(cell("central").qty).toBe(0);
    expect(cell("hub1").qty).toBe(1);
    const mv = only();
    expect(mv.before).toEqual({ central: 1, hub1: -1 });
    expect(mv.after).toEqual({ central: 0, hub1: 1 });
    expect(mv.negativeCleared).toEqual({ hub1: -1 });     // the ledger says what happened
  });

  it("a hold release (transfer_in from in_transit) onto a −2 shelf lands the full quantity", async () => {
    seed("in_transit", 3); seed("hub2", -2);
    const res = await applyMovement({ type: "transfer_in", productId: PID, size: "6", qty: 3, from: "in_transit", to: "hub2", reason: "stock_hold_release" }, { maxRetries: 1 });
    expect(res.ok).toBe(true);
    expect(cell("in_transit").qty).toBe(0);
    expect(cell("hub2").qty).toBe(3);
    expect(only().negativeCleared).toEqual({ hub2: -2 });
  });

  it("a supplier receive and a return onto a negative shelf both credit from zero", async () => {
    seed("central", -1);
    await applyMovement({ type: "received", productId: PID, size: "6", qty: 8, to: "central" }, { maxRetries: 1 });
    expect(cell("central").qty).toBe(8);
    seed("trophy", -1, "7");
    await applyMovement({ type: "return", productId: PID, size: "7", qty: 1, to: "trophy" }, { maxRetries: 1 });
    expect(cell("trophy", "7").qty).toBe(1);
  });

  it("a positive shelf is untouched by the rule: 2 + 1 = 3 and no negativeCleared key", async () => {
    seed("central", 5); seed("hub1", 2);
    await applyMovement({ type: "transfer_out", productId: PID, size: "6", qty: 1, from: "central", to: "hub1" }, { maxRetries: 1 });
    expect(cell("hub1").qty).toBe(3);
    expect(only().negativeCleared).toBeUndefined();
  });

  it("an ADJUSTMENT still nets against the negative — a count's delta is the counter's number", async () => {
    seed("hub1", -1);
    // the counter saw 1 on the shelf, the store computed +2 from the live −1
    await applyMovement({ type: "adjustment", productId: PID, size: "6", qty: 2, to: "hub1", from: null, reason: "hub_sneaker_count" }, { maxRetries: 1 });
    expect(cell("hub1").qty).toBe(1);
    expect(only().negativeCleared).toBeUndefined();
  });

  it("a +leg landing at in_transit is NOT clamped — a negative transit cell is a reconciliation signal", async () => {
    seed("central", 2); seed("in_transit", -1);
    await applyMovement({ type: "transfer_out", productId: PID, size: "6", qty: 1, from: "central", to: "in_transit" }, { maxRetries: 1 });
    expect(cell("in_transit").qty).toBe(0);
    expect(only().negativeCleared).toBeUndefined();
  });

  it("the negative floor on the SOURCE leg is unchanged — a transfer out of an empty cell still refuses", async () => {
    seed("central", 0); seed("hub1", -1);
    const res = await applyMovement({ type: "transfer_out", productId: PID, size: "6", qty: 1, from: "central", to: "hub1" }, { maxRetries: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("insufficient_stock");
    expect(cell("hub1").qty).toBe(-1);                    // nothing written
    expect(Object.keys(ledger())).toEqual([]);
  });
});
