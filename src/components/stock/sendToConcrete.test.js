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
const { DEFAULT_LOCATIONS, transferTargets, wallAllowedLocations, labelFor, withSeedGaps } = await import("./locations.js");
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

// ─── 30 OCT 2026: CONCRETE MISSING FROM THE TRANSFER PICKERS ─────────────────
// A device's stored copy of /locations (the offline mirror) that predates the
// 27 Oct concrete record must still offer Concrete — and Hub 3 → Concrete /
// Pine must be offered and written exactly like Hub 2 → Marathon PE / Trophy.
describe("a stale /locations copy without Concrete", () => {
  // Exactly what Transfer.jsx builds its source and destination lists from.
  const sheet = (registry) => transferTargets(withSeedGaps(registry));
  const dests = (registry, from) => wallAllowedLocations(sheet(registry), from).filter((l) => l.id !== from).map((l) => l.id);

  it("still offers Concrete from Hub 3 and from Central, and as a source", () => {
    expect(dests(LIVE_BEFORE, "hub3")).toEqual(expect.arrayContaining(["concrete", "marathon-pine", "central"]));
    expect(dests(LIVE_BEFORE, "central")).toContain("concrete");
    expect(sheet(LIVE_BEFORE).map((l) => l.id)).toContain("concrete");
  });
  it("Hub 3 never offers the Marathon division; Hub 2 never offers Concrete's", () => {
    const fromHub3 = dests(LIVE_BEFORE, "hub3");
    for (const id of ["marathon-pe", "trophy", "hub1", "hub2"]) expect(fromHub3).not.toContain(id);
    expect(dests(LIVE_BEFORE, "hub2")).toEqual(expect.arrayContaining(["marathon-pe", "trophy"]));
    for (const id of ["concrete", "marathon-pine", "hub3"]) expect(dests(LIVE_BEFORE, "hub2")).not.toContain(id);
  });
  it("a stored record wins over the seed (a deactivated location stays out)", () => {
    const reg = { ...LIVE_BEFORE, concrete: { ...DEFAULT_LOCATIONS.find((l) => l.id === "concrete"), active: false } };
    expect(sheet(reg).map((l) => l.id)).not.toContain("concrete");
    // Every other picker keeps the stored registry as the whole list.
    expect(transferTargets(LIVE_BEFORE).map((l) => l.id)).not.toContain("concrete");
    expect(sheet(regOf(DEFAULT_LOCATIONS)).map((l) => l.id).sort()).toEqual(DEFAULT_LOCATIONS.filter((l) => l.active && l.id !== "in_transit").map((l) => l.id).sort());
  });
  it("Hub 3 → Concrete and Hub 3 → Pine move stock one-step, like Hub 2 → Trophy", async () => {
    for (const loc of ["hub2", "hub3"]) setPath(stockCellPath(loc, PID, "M"), { qty: 5, v: 1 });
    for (const [from, to] of [["hub3", "concrete"], ["hub3", "marathon-pine"], ["hub2", "trophy"]]) {
      expect(isTransitLane(from, to)).toBe(false);
      const res = await applyMovement({ type: "transfer_out", productId: PID, size: "M", qty: 1, from, to, movementId: `${from}_${to}` });
      expect(res.ok).toBe(true);
    }
    expect(getPath(stockCellPath("hub3", PID, "M")).qty).toBe(3);
    expect(getPath(stockCellPath("concrete", PID, "M")).qty).toBe(3);
    expect(getPath(stockCellPath("marathon-pine", PID, "M")).qty).toBe(3);
  });
});
