// ─── CENTRAL → CONCRETE SEND ─────────────────────────────────────────────────
// The send sheet's destination list is transferTargets(registry) through the
// section wall. Concrete was missing because /locations had no record for it.
// This proves the canonical record makes it a destination from Central, and
// that the REAL writer moves Central → concrete exactly like any other store.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

let store = {};
let pushN = 0;
const getPath = (path) => {
  let n = store;
  for (const p of String(path).split("/")) { if (n == null || typeof n !== "object") return null; n = n[p]; }
  return n === undefined ? null : n;
};
const setPath = (path, v) => {
  const parts = String(path).split("/"); let n = store;
  for (let i = 0; i < parts.length - 1; i++) { if (typeof n[parts[i]] !== "object" || n[parts[i]] === null) n[parts[i]] = {}; n = n[parts[i]]; }
  n[parts[parts.length - 1]] = v;
};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, u) => { for (const [k, v] of Object.entries(u)) setPath(node.path ? `${node.path}/${k}` : k, v); },
  push: () => ({ key: `mv${++pushN}` }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));

const { applyMovement } = await import("./applyMovement.js");
const { DEFAULT_LOCATIONS, transferTargets, wallAllowedLocations, labelFor } = await import("./locations.js");
const { seedUpdate } = await import("../admin/networkSettingsCore.js");
const { __resetNetworkForTests } = await import("../../utils/networkStore.js");
const { isTransitLane } = await import("./transitLanes.js");

const PID = "p1";
const regOf = (list) => Object.fromEntries(list.map((l) => [l.id, l]));
// The live /locations before the fix: every active location except Concrete.
const LIVE_BEFORE = regOf(DEFAULT_LOCATIONS.filter((l) => l.id !== "concrete"));
const sheetDests = (registry) => wallAllowedLocations(transferTargets(registry), "central").filter((l) => l.id !== "central").map((l) => l.id);

beforeEach(() => {
  store = { products: { [PID]: { name: "Tee" } } };
  pushN = 0;
  __resetNetworkForTests();
  for (const loc of ["central", "concrete", "trophy", "marathon-pine"]) setPath(stockCellPath(loc, PID, "M"), { qty: loc === "central" ? 10 : 2, v: 1 });
});

describe("the send sheet offers Concrete from Central", () => {
  it("without a /locations record Concrete is not offered (the bug)", () => {
    expect(sheetDests(LIVE_BEFORE)).not.toContain("concrete");
  });
  it("with the canonical record it is, labelled Concrete, beside every other destination", () => {
    const reg = { ...LIVE_BEFORE, concrete: DEFAULT_LOCATIONS.find((l) => l.id === "concrete") };
    expect(sheetDests(reg)).toEqual(expect.arrayContaining(["hub1", "hub2", "hub3", "marathon-pe", "marathon-pine", "trophy", "concrete"]));
    expect(labelFor("concrete", reg)).toBe("Concrete");
    expect(sheetDests({})).toContain("concrete"); // unseeded registry falls back to the seed
  });
  it("the record is the one 'Set up the network' writes — one definition", () => {
    const r = seedUpdate(null, LIVE_BEFORE, 1, "u1");
    expect(r.updates["locations/concrete"]).toEqual(DEFAULT_LOCATIONS.find((l) => l.id === "concrete"));
    expect(r.updates["locations/concrete"]).toEqual({ id: "concrete", label: "Concrete", kind: "store", sellable: true, active: true });
  });
  it("Central → Concrete is a one-step move (no in-transit leg)", () => {
    expect(isTransitLane("central", "concrete")).toBe(false);
  });
});

describe("the write", () => {
  const send = (to, id) => applyMovement({ type: "transfer_out", productId: PID, size: "M", qty: 3, from: "central", to, movementId: id });

  it("decrements Central and increments /stock/concrete at the concrete key", async () => {
    const res = await send("concrete", "c1");
    expect(res.ok).toBe(true);
    expect(getPath(stockCellPath("central", PID, "M")).qty).toBe(7);
    expect(getPath(stockCellPath("concrete", PID, "M")).qty).toBe(5);
    expect(getPath("stock/concrete")).toBeTruthy();
    expect(getPath("stock/concrete-stockroom")).toBeNull();
  });

  it("writes the same movement record shape as a send to another store", async () => {
    await send("trophy", "t1");
    await send("concrete", "c1");
    const t = getPath("stock_movements/t1"), c = getPath("stock_movements/c1");
    expect(Object.keys(c).sort()).toEqual(Object.keys(t).sort());
    expect(c).toMatchObject({ type: "transfer_out", from: "central", to: "concrete", productId: PID, size: "M", qty: 3 });
  });
});
