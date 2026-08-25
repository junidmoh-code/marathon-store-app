// ─── applyMovement — auto-reactivation on stock ARRIVAL ──────────────────────
// Tests the REAL single writer (the applyMovementExpect.test.js lesson: a
// mocked writer proves nothing about the writer).
//
// The trap this pins: a deactivated product that receives stock must come back
// to life IN THE SAME ATOMIC UPDATE as the stock write, announce itself
// (REACTIVATED_EVENT), and only on arrivals — a sale deducts and must never
// reactivate, and a transfer_out only parks units at in_transit.
//
// The fake reproduces the real RTDB semantic the payload depends on:
// WRITING NULL DELETES THE CHILD.

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
  // Real RTDB: writing null DELETES the child. The reactivation payload's
  // `deactivated: null` depends on exactly this.
  if (value === null) delete node[parts[parts.length - 1]];
  else node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => {
    for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  push: () => ({ key: `mv${++pushN}` }),
}));
vi.mock("../../firebase", () => ({
  database: { fake: true },
  auth: { currentUser: { uid: "u1", email: "junid@marathon.internal" } },
}));

const { applyMovement } = await import("./applyMovement.js");
const { REACTIVATED_EVENT } = await import("../../utils/deactivation.js");

const PID = "sh1";
const DEACT = { at: 1756100000000, by: "uX", byName: "someone" };
const seedCell = (loc, qty = 0) => setPath(stockCellPath(loc, PID, "8"), { qty, v: 3, mv: "m0", lastType: "received" });

let events;
beforeEach(() => {
  store = {}; pushN = 0; events = [];
  setPath(`products/${PID}`, { id: PID, name: "Finished Runner", deactivated: { ...DEACT } });
  vi.stubGlobal("window", { dispatchEvent: (e) => events.push(e) });
});

const mv = (over = {}) => applyMovement({ type: "received", productId: PID, size: "8", qty: 2, to: "hub1", ...over });

describe("arrivals reactivate", () => {
  it("received: clears deactivated, stamps reactivated stock_received, in the same update, and announces it", async () => {
    seedCell("hub1", 1);
    const res = await mv();
    expect(res.ok).toBe(true);
    expect(res.reactivated).toBe(true);
    expect(getPath(`products/${PID}/deactivated`)).toBe(null);           // DELETED, not zeroed
    const r = getPath(`products/${PID}/reactivated`);
    expect(r.reason).toBe("stock_received");
    expect(r.by).toBe("u1");
    expect(r.byName).toBe("junid");
    expect(getPath(stockCellPath("hub1", PID, "8")).qty).toBe(3);        // the stock write itself landed
    expect(events.map((e) => e.type)).toEqual([REACTIVATED_EVENT]);
    expect(events[0].detail.productId).toBe(PID);
  });
  it("transfer_in (in_transit → shelf) and positive adjustment reactivate too", async () => {
    seedCell("in_transit", 5); seedCell("hub1", 0);
    const t = await mv({ type: "transfer_in", from: "in_transit", to: "hub1" });
    expect(t.reactivated).toBe(true);
    setPath(`products/${PID}/deactivated`, { ...DEACT });
    const a = await mv({ type: "adjustment", to: "hub1", reason: "found stock" });
    expect(a.reactivated).toBe(true);
  });
});

describe("non-arrivals never reactivate", () => {
  it("sold deducts and leaves the flag alone", async () => {
    seedCell("hub1", 5);
    const res = await mv({ type: "sold", to: undefined, from: "hub1" });
    expect(res.ok).toBe(true);
    expect(res.reactivated).toBeUndefined();
    expect(getPath(`products/${PID}/deactivated`)).toEqual(DEACT);
    expect(events).toEqual([]);
  });
  it("transfer_out parks at in_transit — the flag waits for the transfer_in", async () => {
    seedCell("hub1", 5); seedCell("in_transit", 0);
    const res = await mv({ type: "transfer_out", from: "hub1", to: "in_transit" });
    expect(res.ok).toBe(true);
    expect(res.reactivated).toBeUndefined();
    expect(getPath(`products/${PID}/deactivated`)).toEqual(DEACT);
  });
  it("adjustment INTO in_transit leaves the flag alone — in_transit is not a shelf", async () => {
    seedCell("in_transit", 0);
    const res = await mv({ type: "adjustment", to: "in_transit", reason: "transit correction" });
    expect(res.ok).toBe(true);
    expect(res.reactivated).toBeUndefined();
    expect(getPath(`products/${PID}/deactivated`)).toEqual(DEACT);
    expect(events).toEqual([]);
  });
  it("negative adjustment (from, no to) leaves the flag alone", async () => {
    seedCell("hub1", 5);
    const res = await mv({ type: "adjustment", to: undefined, from: "hub1", reason: "damage" });
    expect(res.ok).toBe(true);
    expect(res.reactivated).toBeUndefined();
    expect(getPath(`products/${PID}/deactivated`)).toEqual(DEACT);
  });
});

describe("active products are byte-for-byte untouched", () => {
  it("an arrival into an ACTIVE product writes nothing under /products", async () => {
    setPath(`products/${PID}`, { id: PID, name: "Live Runner" });
    seedCell("hub1", 1);
    const res = await mv();
    expect(res).toEqual({ ok: true, movementId: "mv1" });                // no reactivated key at all
    expect(getPath(`products/${PID}`)).toEqual({ id: PID, name: "Live Runner" });
    expect(events).toEqual([]);
  });
});
