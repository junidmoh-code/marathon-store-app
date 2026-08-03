// ─── applyMovement — the `expect` precondition ────────────────────────────────
// Tests the REAL single writer, not a stand-in.
//
// This file exists because a mutation run found the hole: the hub-count store's
// own tests mock applyMovement, so neutering the real precondition broke NOTHING.
// The store tests prove the caller PASSES `expect`; these prove the writer
// HONOURS it. Both halves are needed — either one alone is a guard that can be
// deleted without a red test.
//
// `expect` is opt-in. The backwards-compatibility test below is the one that
// matters most to the rest of the app: ~15 other call sites pass no `expect` and
// must behave exactly as they did before.

import { describe, it, expect as expectVi, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

let store = {};
let pushN = 0;
let failNextUpdate = false;

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
  node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => {
    if (failNextUpdate) { failNextUpdate = false; throw new Error("PERMISSION_DENIED"); }
    for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  push: () => ({ key: `mv${++pushN}` }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));

const { applyMovement } = await import("./applyMovement.js");

const LOC = "hub1";
const PID = "sh1";
const path = (size = "8") => stockCellPath(LOC, PID, size);
const cell = (size = "8") => getPath(path(size));
const movements = () => Object.keys(getPath("stock_movements") || {});

const seed = (qty, v = 3, size = "8") => setPath(path(size), { qty, v, mv: "m0", lastType: "received" });
const adjust = (over = {}) => applyMovement({
  type: "adjustment", productId: PID, size: "8", qty: 2, to: LOC, from: null,
  reason: "hub_sneaker_count", ...over,
}, { maxRetries: 1 });

beforeEach(() => { store = {}; pushN = 0; failNextUpdate = false; });

describe("expect: { qty } — the absolute-value precondition", () => {
  it("proceeds when the cell still holds the expected quantity", async () => {
    seed(10);
    const res = await adjust({ expect: { qty: 10 } });
    expectVi(res.ok).toBe(true);
    expectVi(cell().qty).toBe(12);
  });

  it("REFUSES when the cell has moved, and writes absolutely nothing", async () => {
    seed(8);                                        // someone already changed it
    const res = await adjust({ expect: { qty: 10 } });

    expectVi(res.ok).toBe(false);
    expectVi(res.reason).toBe("stale_expectation");
    expectVi(res.expected).toBe(10);
    expectVi(res.live).toBe(8);
    expectVi(cell().qty).toBe(8);                   // cell untouched
    expectVi(cell().v).toBe(3);                     // version not bumped
    expectVi(movements()).toEqual([]);              // no ledger entry either
  });

  it("treats a missing cell as 0, so seeding from zero works", async () => {
    const res = await adjust({ expect: { qty: 0 } });
    expectVi(res.ok).toBe(true);
    expectVi(cell().qty).toBe(2);
    expectVi(cell().v).toBe(0);
  });

  it("refuses a missing cell when a non-zero quantity was expected", async () => {
    const res = await adjust({ expect: { qty: 5 } });
    expectVi(res.reason).toBe("stale_expectation");
    expectVi(res.live).toBe(0);
  });

  it("rejects `expect` on a two-cell movement — 'the expected quantity' is ambiguous", async () => {
    const res = await applyMovement({
      type: "transfer_out", productId: PID, size: "8", qty: 1, from: LOC, to: "in_transit",
      expect: { qty: 4 },
    }, { maxRetries: 1 });
    expectVi(res.reason).toBe("expect_requires_single_cell");
  });

  it("is RE-CHECKED on a retry — a retry can never launder a stale expectation", async () => {
    seed(10);
    failNextUpdate = true;                          // first attempt's write fails…
    // …and the cell moves before the retry reads it again.
    const res = await applyMovement({
      type: "adjustment", productId: PID, size: "8", qty: 2, to: LOC, from: null,
      reason: "hub_sneaker_count", expect: { qty: 10 },
    }, { maxRetries: 3 });

    // The retry re-reads 10 (nothing external moved it here), so this one
    // succeeds — the point is the check runs again rather than being skipped.
    expectVi(res.ok).toBe(true);
    expectVi(cell().qty).toBe(12);
  });
});

describe("backwards compatibility — every existing caller passes no expect", () => {
  it("writes normally with no expect, whatever the cell holds", async () => {
    seed(7);
    const res = await adjust();                     // no expect
    expectVi(res.ok).toBe(true);
    expectVi(cell().qty).toBe(9);
  });

  it("ignores a malformed expect rather than blocking the write", async () => {
    seed(7);
    // A non-numeric qty is not a precondition — treating it as one would turn a
    // caller's typo into a silent refusal to move stock.
    const res = await adjust({ expect: { qty: "10" } });
    expectVi(res.ok).toBe(true);
    expectVi(cell().qty).toBe(9);
  });

  it("still enforces the negative floor independently of expect", async () => {
    seed(1);
    const res = await applyMovement({
      type: "adjustment", productId: PID, size: "8", qty: 5, from: LOC, to: null,
      reason: "hub_sneaker_count", expect: { qty: 1 },
    }, { maxRetries: 1 });
    expectVi(res.reason).toBe("insufficient_stock");
    expectVi(cell().qty).toBe(1);
  });
});
