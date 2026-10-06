// ─── applyMovement — THE SECTION WALL ────────────────────────────────────────
// Tests the REAL single writer. Every stock move in the store app goes through
// it, so a crossing refused here is refused for Transfer, Network Transfer,
// the Source queue, Move Excess, Clothing Sold refill, order dispatch, CR
// fulfil — every screen, without each needing its own check.
//
// The other half is the byte-for-byte promise: every move inside a section,
// and every move to or from Central, writes exactly what it wrote before.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

let store = {};
let pushN = 0;
const updates = [];
const reads = [];

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
  get: async (node) => { reads.push(node.path); return { val: () => getPath(node.path), exists: () => getPath(node.path) != null }; },
  update: async (node, u) => {
    updates.push(u);
    for (const [k, v] of Object.entries(u)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  push: () => ({ key: `mv${++pushN}` }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));

const { applyMovement, movementWallCheck } = await import("./applyMovement.js");
const { setCurrentNetworkFromRaw, __resetNetworkForTests } = await import("../../utils/networkStore.js");
const { SEED_REGISTRY } = await import("../../utils/networkRegistry.js");

const S1 = ["marathon-pine", "concrete", "hub3", "concrete-stockroom"];
const S2 = ["marathon-pe", "trophy", "hub1", "hub2"];
const PID = "p1";
const seed = (loc, qty = 5) => setPath(stockCellPath(loc, PID, "M"), { qty, v: 1 });
const qtyAt = (loc) => getPath(stockCellPath(loc, PID, "M"))?.qty ?? 0;
const move = (from, to, over = {}) => applyMovement({ type: "transfer_out", productId: PID, size: "M", qty: 1, from, to, ...over });

beforeEach(() => {
  store = {}; pushN = 0; updates.length = 0; reads.length = 0;
  __resetNetworkForTests();
  for (const loc of [...S1, ...S2, "central", "in_transit"]) seed(loc);
});

describe("a crossing is refused before anything is read or written", () => {
  it("every Section 1 ↔ Section 2 pair, both directions", async () => {
    for (const a of S1) for (const b of S2) for (const [from, to] of [[a, b], [b, a]]) {
      const res = await move(from, to);
      expect(res, `${from}→${to}`).toMatchObject({ ok: false, reason: "section_wall", wall: "cross_section" });
      expect(res.message).toMatch(/different sections\. Send the stock back to Central first\./);
    }
    expect(updates).toEqual([]);
    expect(reads).toEqual([]);
    for (const loc of [...S1, ...S2]) expect(qtyAt(loc)).toBe(5);
  });

  it("refuses it for transfer_in as well as transfer_out, and with allowNegative", async () => {
    expect((await move("hub2", "hub3", { type: "transfer_in" })).reason).toBe("section_wall");
    expect((await move("hub2", "hub3", { allowNegative: true })).reason).toBe("section_wall");
  });

  it("refuses a location the registry does not know", async () => {
    expect(await move("hub2", "hubC")).toMatchObject({ ok: false, reason: "section_wall", wall: "unknown_location" });
  });

  it("a transit send is judged on its REAL destination", async () => {
    expect((await move("hub2", "in_transit", { transitTo: "hub3" })).reason).toBe("section_wall");
    expect((await move("hub2", "in_transit", { transitTo: "trophy" })).ok).toBe(true);
    // a sectioned origin that does not say where the stock is going is refused
    expect(await move("hub2", "in_transit")).toMatchObject({ ok: false, reason: "section_wall", wall: "transit_needs_real_endpoints" });
  });

  it("a transit receive is judged on its real origin when it is known", async () => {
    expect((await move("in_transit", "hub3", { type: "transfer_in", transitFrom: "hub2" })).reason).toBe("section_wall");
    expect((await move("in_transit", "hub3", { type: "transfer_in", transitFrom: "central" })).ok).toBe(true);
  });
});

describe("everything else writes exactly as before", () => {
  it("every pair inside a section moves one unit", async () => {
    for (const set of [S1, S2]) for (const a of set) for (const b of set) {
      if (a === b) continue;
      const before = [qtyAt(a), qtyAt(b)];
      const res = await move(a, b);
      expect(res.ok, `${a}→${b}`).toBe(true);
      expect([qtyAt(a), qtyAt(b)]).toEqual([before[0] - 1, before[1] + 1]);
    }
  });

  it("Central sends to, and takes back from, every location in both sections", async () => {
    for (const x of [...S1, ...S2]) {
      expect((await move("central", x)).ok, `central→${x}`).toBe(true);
      expect((await move(x, "central")).ok, `${x}→central`).toBe(true);
    }
  });

  it("Central parks stock in transit, and a receive lands, with no extra fields — as the hold lane does today", async () => {
    expect((await move("central", "in_transit")).ok).toBe(true);
    expect((await move("in_transit", "hub2", { type: "transfer_in" })).ok).toBe(true);
    expect((await move("in_transit", "hub3", { type: "transfer_in" })).ok).toBe(true);
  });

  it("the retired Central-building locations still move to Central", async () => {
    for (const loc of ["studio", "base"]) { seed(loc); expect((await move(loc, "central")).ok).toBe(true); }
  });

  it("single-location writes never meet the wall", async () => {
    const one = (m) => applyMovement({ productId: PID, size: "M", qty: 1, ...m });
    expect((await one({ type: "received", to: "hub3" })).ok).toBe(true);
    expect((await one({ type: "sold", from: "marathon-pine" })).ok).toBe(true);
    expect((await one({ type: "return", to: "concrete" })).ok).toBe(true);
    expect((await one({ type: "adjustment", to: "hub2", reason: "count" })).ok).toBe(true);
    expect((await one({ type: "adjustment", from: "hub3", reason: "count" })).ok).toBe(true);
  });

  it("a Section 2 move writes the same paths and the same movement fields with or without the wall's extra inputs", async () => {
    await move("hub2", "trophy", { movementId: "plain" });
    const plain = updates.at(-1);
    store = {}; for (const loc of S2) seed(loc);
    await move("hub2", "trophy", { movementId: "plain", transitTo: undefined });
    expect(Object.keys(updates.at(-1)).sort()).toEqual(Object.keys(plain).sort());
    const mv = plain["stock_movements/plain"];
    expect(mv).toMatchObject({ type: "transfer_out", from: "hub2", to: "trophy", qty: 1 });
    expect("transitTo" in mv || "wall" in mv).toBe(false);
  });
});

describe("the wall follows the registry", () => {
  it("uses the live registry: a location moved across is walled from its old section", async () => {
    setCurrentNetworkFromRaw({ locations: { hub3: { section: 2 } } });
    expect((await move("hub3", "hub2")).ok).toBe(true);
    expect((await move("hub3", "marathon-pine")).reason).toBe("section_wall");
  });

  it("is not affected by a location being live or not — the wall is not the live flag", async () => {
    setCurrentNetworkFromRaw({ locations: { hub3: { live: true }, "marathon-pine": { live: true } } });
    expect((await move("hub3", "hub2")).reason).toBe("section_wall");
    expect((await move("hub3", "marathon-pine")).ok).toBe(true);
  });

  it("the pure check agrees with the writer", () => {
    expect(movementWallCheck(SEED_REGISTRY, { from: "hub1", to: "hub3" }).ok).toBe(false);
    expect(movementWallCheck(SEED_REGISTRY, { from: "hub1", to: "hub2" }).ok).toBe(true);
    expect(movementWallCheck(SEED_REGISTRY, { to: "hub3" }).ok).toBe(true);
    expect(movementWallCheck(SEED_REGISTRY, null).ok).toBe(true);
  });
});
