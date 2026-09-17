// ─── The Hub 2-presence guard, rendered (incident 2026-09-17 → Phase 3) ──────
// The same real NetworkTransfer and in-scope cards as
// firstBatchSolve.render.test.jsx, nothing mocked. THE INCIDENT'S RULE: a
// product that exists at Hub 2 by any means never produces a shop-from-Central
// request — the Solve is the old one (Hub 2 AND the shop seeded, NO
// /refill_requests row). And a card the path cannot take reads nothing from
// the engine's lock table.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const paths = {};
const gets = {};
const updateMock = vi.fn(() => Promise.resolve());
let pushN = 0;
vi.mock("firebase/database", () => ({
  query: (r, ...parts) => ({ path: `${r.path}?${parts.map((p) => p.q).join("&")}` }), orderByChild: (f) => ({ q: `orderBy=${f}` }), equalTo: (v) => ({ q: `equalTo=${v}` }),
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => { readPaths.push(r.path); if (getThrows.has(r.path)) { getThrows.delete(r.path); return Promise.reject(new Error("permission_denied")); } return Promise.resolve({ val: () => gets[r.path] ?? null }); },
  push: () => ({ key: `req${++pushN}` }),
  runTransaction: () => Promise.resolve({ committed: true }),
}));
const readPaths = [];   // every scoped get() the screen issues
const getThrows = new Set();   // paths whose NEXT get() rejects (once)
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "warehouse" }, isSuperAdmin: false }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: NetworkTransfer } = await import("./NetworkTransfer.jsx");
const { computeMissingProducts } = await import("./missingProductsCore.js");
const { FIRST_BATCH_ENABLED } = await import("./firstBatchCore.js");

const CONFIG = {
  ruleBasedTargets: true,
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  maxUnitsPerIntent: 20,
  defaultRunByStore: {
    hub2: { L: 3, M: 3, S: 2, XL: 2, XXL: 2, XXXL: 1 },
    "marathon-pe": { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
    trophy: { L: 2, M: 2, S: 2, XL: 1, XXL: 1, XXXL: 1 },
  },
  categoryPolicy: { bags: { hub2: { target: 4, minQty: 2 }, trophy: { target: 2, minQty: 1 } } },
};
const TEE = "tee1";
const BAG = "bag1";
const PRODUCTS = [
  { id: TEE, name: "Essentials Tee Olive", productType: "clothing", subcategory: "T-Shirts", sizes: ["S", "M", "L"] },
  { id: BAG, name: "Gym Bag", productType: "clothing", categoryKey: "bags", subcategory: "Bags", sizes: ["_"] },
];
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const STOCK = { central: { [TEE]: { S: cell(4), M: cell(4), L: cell(0) }, [BAG]: { _: cell(10) } } };

const flat = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(flat).join("");
  return flat(n.children);
};
const textOf = (tree) => flat(tree.toJSON());
const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const buttonSaying = (tree, needle) => buttonsOf(tree).find((b) => (b.children || []).some((c) => typeof c === "string" && c.includes(needle)));
const buttonExactly = (tree, label) => buttonsOf(tree).find((b) => (b.children || []).join("") === label);

function render({ products = PRODUCTS, stock = STOCK } = {}) {
  const cards = computeMissingProducts({ allStock: stock, products });
  let tree;
  act(() => {
    tree = TestRenderer.create(<NetworkTransfer products={products} category="clothing" allStock={stock} cards={cards}
      targets={{}} targetsSettled={true} targetsError={false} />);
  });
  return tree;
}
async function solve(tree, store) {
  await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
  if (store) await act(async () => { buttonExactly(tree, store).props.onClick(); });
  const confirm = buttonSaying(tree, "Solve — ");
  await act(async () => { await confirm.props.onClick(); });
}
const only = (id) => PRODUCTS.filter((p) => p.id === id);

beforeEach(() => {
  updateMock.mockClear(); pushN = 0; readPaths.length = 0; getThrows.clear();
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  paths["config/refillEngine"] = CONFIG;
});

const ENGINE_LOCK = { M: { qty: 2, createdAt: "t", runId: "scan-1", refillId: "eng1", source: "central" } };

describe("Hub 2 presence → the old Solve, never a shop-from-Central request (the incident reproduced at the screen)", () => {
  it("the flag under test is the live one: the path is ON, so the guard is what stops it", () => { expect(FIRST_BATCH_ENABLED).toBe(true); });

  it("an engine lock at Hub 2 (a pending inbound): Hub 2 AND Marathon PE seeded for S, M, L in ONE update — no request row, no request key minted", async () => {
    gets[`refill_engine/open/hub2/${TEE}`] = ENGINE_LOCK;
    gets["refill_requests/eng1"] = { status: "open" };
    const tree = render({ products: only(TEE) });
    await solve(tree);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).sort()).toEqual([
      "stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S",
      "stock/marathon-pe/tee1/L", "stock/marathon-pe/tee1/M", "stock/marathon-pe/tee1/S",
    ]);
    for (const k of Object.keys(upd)) expect(upd[k]).toEqual({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: new Date(NOW).toISOString(), updatedBy: "u1" });
    expect(Object.keys(upd).some((k) => k.startsWith("refill_requests/"))).toBe(false);
    expect(pushN).toBe(0);
    expect(textOf(tree)).toMatch(/Carrying 3 sizes at Marathon PE \(via Hub 2\) — the engine will refill on its next scan/);
  });

  it("with the lock present the panel never promises a shop-first batch and the button is the old one", async () => {
    gets[`refill_engine/open/hub2/${TEE}`] = ENGINE_LOCK;
    gets["refill_requests/eng1"] = { status: "open" };
    const tree = render({ products: only(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    const text = textOf(tree);
    expect(text).not.toMatch(/go to .* first — requested from Central now/);
    expect(text).not.toMatch(/Hub 2 is seeded now; its own/);
    expect(buttonSaying(tree, "Solve — send")).toBeUndefined();
    expect(buttonSaying(tree, "Solve — ")).toBeTruthy();
  });

  it("a mapped category (bag, one-size) whose Hub 2 lock the engine already holds: same old path — Hub 2 + Trophy seeded at '_', no request", async () => {
    gets[`refill_engine/open/hub2/${BAG}`] = { _: { qty: 4, createdAt: "t", runId: "scan-2", refillId: "eng2", source: "central" } };
    gets["refill_requests/eng2"] = { status: "open" };
    const tree = render({ products: only(BAG) });
    await solve(tree, "Trophy");
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).sort()).toEqual(["stock/hub2/bag1/_", "stock/trophy/bag1/_"]);
  });

  it("a held line in the hold lane for the product (units on the way to Hub 2): the old Solve — no request", async () => {
    gets["settings/stockHold/held/hub2"] = { rrf_old: { productId: TEE, dest: "hub2", size: "M", sizeKey: "M", qty: 3 } };
    const tree = render({ products: only(TEE) });
    await solve(tree);
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).some((k) => k.startsWith("refill_requests/"))).toBe(false);
    expect(Object.keys(upd)).toHaveLength(6);
  });

  it("a Hub 2 lock whose request has CLOSED still bookkeeps Hub 2 (the raw node, as the server judges it): the old Solve", async () => {
    gets[`refill_engine/open/hub2/${TEE}`] = ENGINE_LOCK;
    gets["refill_requests/eng1"] = { status: "fulfilled" };
    const tree = render({ products: only(TEE) });
    await solve(tree);
    expect(Object.keys(updateMock.mock.calls[0][1]).some((k) => k.startsWith("refill_requests/"))).toBe(false);
  });

  it("an open Hub 2 request with no lock (on-hold row) is presence at the screen once the index flag is on; off, the query is never issued", async () => {
    paths["config/refillEngine"] = { ...CONFIG, refillRequestsProductIdIndex: true };
    gets[`refill_requests?orderBy=productId&equalTo=${TEE}`] = { oh1: { productId: TEE, size: "M", qty: 1, requestingLocation: "hub2", status: "open", createdFrom: { via: "on_hold" } } };
    const tree = render({ products: only(TEE) });
    await solve(tree);
    expect(Object.keys(updateMock.mock.calls[0][1]).some((k) => k.startsWith("refill_requests/"))).toBe(false);
    paths["config/refillEngine"] = CONFIG;
    readPaths.length = 0;
    const tree2 = render({ products: only(TEE) });
    await act(async () => { buttonExactly(tree2, "Solve").props.onClick(); });
    await act(async () => {});
    expect(readPaths.some((p) => p.startsWith("refill_requests?"))).toBe(false);
  });

  it("an unreadable lock table is UNKNOWN presence: the guard fails closed and the write is the old Solve", async () => {
    const tree = render({ products: only(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    getThrows.add(`refill_engine/open/hub2/${TEE}`);
    await act(async () => { await buttonSaying(tree, "Solve — ").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).some((k) => k.startsWith("refill_requests/"))).toBe(false);
    expect(Object.keys(upd)).toHaveLength(6);
  });

  it("a card the path cannot take (a sneaker) reads NOTHING from the engine's lock table when its panel opens", async () => {
    const SNK = { id: "snk1", name: "Air Max", productType: "clothing", categoryKey: "sneakers", sizes: ["8"] };
    const stock = { central: { snk1: { 8: cell(3) } } };
    const tree = render({ products: [SNK], stock });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    await act(async () => {});
    expect(readPaths.filter((p) => p.startsWith("refill_engine/open/"))).toEqual([]);
  });

  it("a card the path CAN take reads the lock table once its panel opens — the guard's live input", async () => {
    const tree = render({ products: only(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    await act(async () => {});
    expect(readPaths.filter((p) => p.startsWith("refill_engine/open/")).sort()).toEqual([
      "refill_engine/open/hub1/tee1", "refill_engine/open/hub2/tee1", "refill_engine/open/marathon-pe/tee1", "refill_engine/open/trophy/tee1",
    ]);
    expect(readPaths.filter((p) => p === "settings/stockHold/held/hub2")).toHaveLength(1);   // the hold lane, once
  });
});
