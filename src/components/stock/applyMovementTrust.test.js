// ─── applyMovement — TRUST rides with the stock that earns it ────────────────
// A refill/order leg landing at a cell marks THAT cell trusted, in the same
// write; a count confirming a cell marks it trusted; a manual edit alone —
// Adjust, Set Quantity, a hand transfer — never does, and never clears it.

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
  // Real RTDB deletes a null leaf AND every parent left empty — the fake must too.
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
  push: () => ({ key: `mv${++pushN}` }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));

const { applyMovement } = await import("./applyMovement.js");

const { setCellState } = await import("./applyMovement.js");

const PID = "tee";
const cell = (loc, size = "M") => getPath(stockCellPath(loc, PID, size));
const seed = (loc, qty, extra = {}, size = "M") => setPath(stockCellPath(loc, PID, size), { qty, v: 2, mv: "m0", lastType: "sold", ...extra });

beforeEach(() => { store = {}; pushN = 0; });

describe("trust on arrival", () => {
  it("a refill fulfilment (link.refillId) trusts the DESTINATION cell only", async () => {
    seed("hub3", 5); seed("marathon-pine", 0);
    const res = await applyMovement({ type: "transfer_out", productId: PID, size: "M", qty: 2, from: "hub3", to: "marathon-pine", reason: "marathon-pine_auto_refill", link: { refillId: "r1" } }, { maxRetries: 1 });
    expect(res.ok).toBe(true);
    expect(cell("marathon-pine")).toMatchObject({ qty: 2, trusted: true, trustedVia: "refill" });
    expect(cell("hub3").trusted).toBeUndefined();
  });

  it("an order dispatch (link.orderId) trusts the shop cell", async () => {
    seed("hub3", 5);
    await applyMovement({ type: "transfer_out", productId: PID, size: "M", qty: 1, from: "hub3", to: "concrete", reason: "clothing_order", link: { orderId: "C001" } }, { maxRetries: 1 });
    expect(cell("concrete")).toMatchObject({ qty: 1, trusted: true, trustedVia: "refill" });
  });

  it("a MANUAL edit alone never trusts: a hand transfer, an adjustment, a typed receipt", async () => {
    seed("central", 9);
    await applyMovement({ type: "transfer_out", productId: PID, size: "M", qty: 1, from: "central", to: "marathon-pine", reason: "manual", link: { transferId: "t1" } }, { maxRetries: 1 });
    await applyMovement({ type: "adjustment", productId: PID, size: "M", qty: 2, to: "marathon-pine", reason: "found two" }, { maxRetries: 1 });
    await applyMovement({ type: "received", productId: PID, size: "M", qty: 1, to: "marathon-pine", reason: "received" }, { maxRetries: 1 });
    expect(cell("marathon-pine").qty).toBe(4);
    expect(cell("marathon-pine").trusted).toBeUndefined();
  });

  it("a manual edit on a TRUSTED cell leaves it trusted (it never clears the marker)", async () => {
    seed("marathon-pine", 3, { trusted: true, trustedVia: "solve", trustedAt: "T0" });
    await applyMovement({ type: "adjustment", productId: PID, size: "M", qty: 1, from: "marathon-pine", reason: "damaged" }, { maxRetries: 1 });
    expect(cell("marathon-pine")).toMatchObject({ qty: 2, trusted: true, trustedVia: "solve", trustedAt: "T0" });
  });

  it("a COUNT trusts the cell it counts (trust: 'count'), with or without a quantity change", async () => {
    seed("marathon-pine", 2);
    await applyMovement({ type: "adjustment", productId: PID, size: "M", qty: 1, to: "marathon-pine", reason: "recount", cellState: "live", trust: "count" }, { maxRetries: 1 });
    expect(cell("marathon-pine")).toMatchObject({ qty: 3, state: "live", trusted: true, trustedVia: "count" });
    seed("marathon-pine", 4, {}, "L");
    expect((await setCellState("marathon-pine", PID, "L", "live", { trust: "count" })).ok).toBe(true);
    expect(cell("marathon-pine", "L")).toMatchObject({ qty: 4, v: 2, mv: "m0", state: "live", trusted: true, trustedVia: "count" });
    // a counted-zero size that had no cell: seeded trusted
    await setCellState("marathon-pine", PID, "S", "live", { trust: "count" });
    expect(cell("marathon-pine", "S")).toMatchObject({ qty: 0, mv: "seed", trusted: true, trustedVia: "count" });
  });

  it("a state flip WITHOUT trust: 'count' never trusts", async () => {
    seed("marathon-pine", 4);
    await setCellState("marathon-pine", PID, "M", "live");
    expect(cell("marathon-pine").trusted).toBeUndefined();
    await setCellState("marathon-pine", PID, "M", "untracked", { trust: "count" });
    expect(cell("marathon-pine").trusted).toBeUndefined();
  });
});
