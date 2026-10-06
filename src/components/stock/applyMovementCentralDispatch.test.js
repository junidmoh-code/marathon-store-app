// ─── applyMovement — THE CENTRAL DISPATCH RECORD ─────────────────────────────
// Tests the REAL single writer. Every unit Central sends to a section is
// recorded with its cost value and the receiving section, in the same atomic
// update as the stock move — once per movement, never for any other origin,
// and never at the price of the stock move itself.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

let store = {};
let pushN = 0;
const updates = [];
const reads = [];
// Paths the fake database refuses to write (a rule that is not there yet).
let refuse = () => false;
// Reads the fake database fails.
let failRead = () => false;

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
  // RTDB drops null-valued keys inside a written object.
  const clean = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined))
    : value;
  node[parts[parts.length - 1]] = clean;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => {
    reads.push(node.path);
    if (failRead(node.path)) throw new Error("read failed");
    return { val: () => getPath(node.path), exists: () => getPath(node.path) != null };
  },
  // All-or-nothing, like the real multi-path update.
  update: async (node, u) => {
    if (Object.keys(u).some((k) => refuse(k))) throw new Error("PERMISSION_DENIED");
    updates.push(u);
    for (const [k, v] of Object.entries(u)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  push: () => ({ key: `mv${++pushN}` }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));

const { applyMovement, centralDispatchOf, CENTRAL_DISPATCH_ROOT, DISPATCH_COST_FIELD } = await import("./applyMovement.js");
const { setCurrentNetworkFromRaw, __resetNetworkForTests } = await import("../../utils/networkStore.js");
const { SEED_REGISTRY } = await import("../../utils/networkRegistry.js");

const PID = "p1";
const S1 = ["marathon-pine", "concrete", "hub3", "concrete-stockroom"];
const S2 = ["marathon-pe", "trophy", "hub1", "hub2"];
const seed = (loc, qty = 50) => setPath(stockCellPath(loc, PID, "M"), { qty, v: 1 });
const qtyAt = (loc) => getPath(stockCellPath(loc, PID, "M"))?.qty ?? 0;
const move = (from, to, over = {}) => applyMovement({ type: "transfer_out", productId: PID, size: "M", qty: 3, from, to, ...over });
const rowOf = (id) => getPath(`${CENTRAL_DISPATCH_ROOT}/${id}`);

beforeEach(() => {
  store = { products: { [PID]: { name: "Tee", stockPrice: 199.99, retailPrice: 499 } } };
  pushN = 0; updates.length = 0; reads.length = 0;
  refuse = () => false; failRead = () => false;
  __resetNetworkForTests();
  for (const loc of [...S1, ...S2, "central", "in_transit", "studio"]) seed(loc);
});

describe("a Central dispatch is recorded with the move", () => {
  it("writes units, cost value and the receiving section in the SAME update as the stock and the movement", async () => {
    const res = await move("central", "hub2", { movementId: "d1", ts: "2026-10-02T08:00:00.000Z" });
    expect(res).toEqual({ ok: true, movementId: "d1" });
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u["stock_movements/d1"]).toBeTruthy();
    expect(u[`${stockCellPath("central", PID, "M")}/qty`]).toBe(47);
    expect(u[`${CENTRAL_DISPATCH_ROOT}/d1`]).toEqual({
      productId: PID, size: "M", qty: 3, unitCost: 199.99, costValue: 599.97,
      from: "central", to: "hub2", section: 2, ts: "2026-10-02T08:00:00.000Z", actor: "u1", movementId: "d1",
    });
  });

  it("names the section of every destination: Section 2 as 2, Section 1 as 1", async () => {
    for (const loc of S2) { const r = await move("central", loc); expect(rowOf(r.movementId)).toMatchObject({ to: loc, section: 2 }); }
    for (const loc of S1) { const r = await move("central", loc); expect(rowOf(r.movementId)).toMatchObject({ to: loc, section: 1 }); }
  });

  it("a send into transit is recorded against its REAL destination", async () => {
    await move("central", "in_transit", { transitTo: "hub2", movementId: "t1" });
    expect(rowOf("t1")).toMatchObject({ from: "central", to: "hub2", section: 2, qty: 3 });
    await move("central", "in_transit", { transitTo: "hub3", movementId: "t2" });
    expect(rowOf("t2")).toMatchObject({ to: "hub3", section: 1 });
  });

  it("a transit send that does not say where it is going is still recorded, with no section", async () => {
    await move("central", "in_transit", { movementId: "t3" });
    const row = rowOf("t3");
    expect(row).toMatchObject({ from: "central", to: "in_transit", qty: 3, costValue: 599.97 });
    expect("section" in row).toBe(false);
  });

  it("follows the registry: a location moved to the other section is recorded there", async () => {
    setCurrentNetworkFromRaw({ locations: { hub3: { section: 2 } } });
    await move("central", "hub3", { movementId: "r1" });
    expect(rowOf("r1").section).toBe(2);
  });

  it("reads the cost as ONE key, never the product record", async () => {
    await move("central", "hub2");
    expect(reads).toContain(`products/${PID}/${DISPATCH_COST_FIELD}`);
    expect(reads).not.toContain(`products/${PID}`);
    expect(reads).not.toContain("products");
    expect(DISPATCH_COST_FIELD).toBe("stockPrice");
  });
});

describe("it never blocks or changes the stock move", () => {
  it("a product with no cost moves, and its row carries no cost", async () => {
    for (const bad of [undefined, 0, "199", null, Number.NaN]) {
      store.products[PID].stockPrice = bad;
      const res = await move("central", "hub2");
      expect(res.ok).toBe(true);
      const row = rowOf(res.movementId);
      expect(row).toMatchObject({ qty: 3, to: "hub2", section: 2 });
      expect(row.unitCost ?? null).toBeNull();
      expect(row.costValue ?? null).toBeNull();
    }
    expect(qtyAt("hub2")).toBe(50 + 15);
  });

  it("a failed cost read moves the stock with no cost", async () => {
    failRead = (p) => p === `products/${PID}/stockPrice`;
    const res = await move("central", "trophy", { movementId: "f1" });
    expect(res.ok).toBe(true);
    expect(qtyAt("trophy")).toBe(53);
    expect(rowOf("f1").unitCost ?? null).toBeNull();
  });

  it("a database that refuses /central_dispatch still moves the stock — once — and writes the movement", async () => {
    refuse = (k) => k.startsWith(`${CENTRAL_DISPATCH_ROOT}/`);
    const res = await applyMovement({ type: "transfer_out", productId: PID, size: "M", qty: 3, from: "central", to: "hub2", movementId: "x1" }, { maxRetries: 1 });
    expect(res).toEqual({ ok: true, movementId: "x1" });
    expect(qtyAt("central")).toBe(47);
    expect(qtyAt("hub2")).toBe(53);
    expect(getPath("stock_movements/x1")).toMatchObject({ from: "central", to: "hub2", qty: 3 });
    expect(rowOf("x1")).toBeNull();
    // (maxRetries: 1 — the refused attempt did not use up the caller's budget)
    expect(updates).toHaveLength(1);
  });

  it("when the atomic update is refused once for another reason, the row is written straight after the move", async () => {
    let first = true;
    refuse = () => { if (first) { first = false; return true; } return false; };
    const res = await move("central", "hub2", { movementId: "c1" });
    expect(res.ok).toBe(true);
    expect(qtyAt("hub2")).toBe(53);
    expect(rowOf("c1")).toMatchObject({ qty: 3, section: 2, movementId: "c1" });
  });

  it("the movement record is exactly what it was — no dispatch field leaks into the ledger", async () => {
    await move("central", "hub2", { movementId: "m1" });
    const withRow = getPath("stock_movements/m1");
    await move("hub2", "trophy", { movementId: "m2" });
    const plain = getPath("stock_movements/m2");
    expect(Object.keys(withRow).sort()).toEqual(Object.keys(plain).sort());
    for (const k of ["unitCost", "costValue", "section", "transitTo"]) expect(k in withRow).toBe(false);
  });
});

describe("written once, and only for Central", () => {
  it("the same movementId is written once — a replay changes nothing", async () => {
    await move("central", "hub2", { movementId: "same" });
    const before = JSON.stringify(rowOf("same"));
    store.products[PID].stockPrice = 1;                 // the cost changed since
    const again = await move("central", "hub2", { movementId: "same" });
    expect(again).toEqual({ ok: true, movementId: "same", idempotent: true });
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(rowOf("same"))).toBe(before);
    expect(qtyAt("hub2")).toBe(53);
  });

  it("no other origin writes a row: hub → store, store → hub, back to Central, and a transit receive", async () => {
    await move("hub2", "trophy", { movementId: "n1" });
    await move("trophy", "hub2", { movementId: "n2" });
    await move("hub2", "central", { movementId: "n3" });
    await move("hub3", "marathon-pine", { movementId: "n4" });
    await move("in_transit", "hub2", { type: "transfer_in", movementId: "n5" });
    await move("in_transit", "hub2", { type: "transfer_in", transitFrom: "central", movementId: "n6" });
    expect(getPath(CENTRAL_DISPATCH_ROOT)).toBeNull();
    expect(reads.some((p) => p.endsWith("/stockPrice"))).toBe(false);
  });

  it("single-location writes at or into Central write no row", async () => {
    const one = (m) => applyMovement({ productId: PID, size: "M", qty: 1, ...m });
    await one({ type: "received", to: "central" });
    await one({ type: "received", to: "hub2" });
    await one({ type: "adjustment", from: "central", reason: "count" });
    await one({ type: "sold", from: "marathon-pe" });
    expect(getPath(CENTRAL_DISPATCH_ROOT)).toBeNull();
  });

  it("a move between Central's own buildings is not a dispatch; the retired buildings are still Central when they send to a section", async () => {
    await move("studio", "central", { movementId: "b1" });
    expect(rowOf("b1")).toBeNull();
    await move("studio", "hub2", { movementId: "b2" });
    expect(rowOf("b2")).toMatchObject({ from: "studio", to: "hub2", section: 2 });
  });

  it("a refused crossing writes nothing at all", async () => {
    const res = await move("hub2", "hub3");
    expect(res.reason).toBe("section_wall");
    expect(updates).toEqual([]);
  });

  it("the pure rule agrees with the writer", () => {
    const d = (m) => centralDispatchOf(SEED_REGISTRY, { type: "transfer_out", ...m });
    expect(d({ from: "central", to: "trophy" })).toEqual({ from: "central", to: "trophy", section: 2 });
    expect(d({ from: "central", to: "concrete" })).toEqual({ from: "central", to: "concrete", section: 1 });
    expect(d({ from: "central", to: "in_transit", transitTo: "hub1" })).toEqual({ from: "central", to: "hub1", section: 2 });
    expect(d({ from: "Central", to: "pe" })).toEqual({ from: "central", to: "marathon-pe", section: 2 });
    expect(d({ from: "hub2", to: "central" })).toBeNull();
    expect(d({ from: "central", to: "base" })).toBeNull();
    expect(d({ from: "central", to: "nowhere" })).toBeNull();
    expect(centralDispatchOf(SEED_REGISTRY, { type: "received", to: "hub2" })).toBeNull();
    expect(centralDispatchOf(SEED_REGISTRY, { type: "sold", from: "central" })).toBeNull();
    expect(centralDispatchOf(SEED_REGISTRY, null)).toBeNull();
  });
});
