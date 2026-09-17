// ─── The Solve with the first-batch path OFF (incident 2026-09-17) ───────────
// The same real NetworkTransfer, the same in-scope card as
// firstBatchSolve.render.test.jsx — but the REAL flag (FIRST_BATCH_ENABLED
// false, nothing mocked). The claim: the Solve is the pre-#607 Solve again —
// Hub 2 AND the shop seeded for every qualifying size, NO /refill_requests
// row, no shop-from-Central request possible from this screen.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const paths = {};
const gets = {};
const updateMock = vi.fn(() => Promise.resolve());
let pushN = 0;
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => { readPaths.push(r.path); return Promise.resolve({ val: () => gets[r.path] ?? null }); },
  push: () => ({ key: `req${++pushN}` }),
  runTransaction: () => Promise.resolve({ committed: true }),
}));
const readPaths = [];   // every scoped get() the screen issues
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
  updateMock.mockClear(); pushN = 0; readPaths.length = 0;
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  paths["config/refillEngine"] = CONFIG;
});

describe("with the real flag (OFF) the Solve is the pre-#607 Solve", () => {
  it("the flag under test is the live one", () => { expect(FIRST_BATCH_ENABLED).toBe(false); });

  it("a Central-stranded tee at Marathon PE: Hub 2 AND the shop seeded for S, M, L in ONE update — no request row anywhere", async () => {
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
    expect(pushN).toBe(0);   // no request key was ever minted
    expect(textOf(tree)).toMatch(/Carrying 3 sizes at Marathon PE \(via Hub 2\) — the engine will refill on its next scan/);
  });

  it("opening the panel reads NOTHING from the engine's lock table — off the path there is no reservation to check", async () => {
    const tree = render({ products: only(TEE) });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    await act(async () => {});
    expect(readPaths.filter((p) => p.startsWith("refill_engine/open/"))).toEqual([]);
    await act(async () => { await buttonSaying(tree, "Solve — ").props.onClick(); });
    // the old Solve's own two reads per seeded location, nothing more
    expect(readPaths.filter((p) => p.startsWith("refill_engine/open/")).sort()).toEqual(["refill_engine/open/hub2/tee1", "refill_engine/open/marathon-pe/tee1"]);
  });

  it("the panel never promises a shop-first batch and the button is the old one", () => {
    const tree = render({ products: only(TEE) });
    act(() => { buttonExactly(tree, "Solve").props.onClick(); });
    const text = textOf(tree);
    expect(text).not.toMatch(/go to .* first — requested from Central now/);
    expect(text).not.toMatch(/Hub 2's own .* follow automatically/);
    expect(buttonSaying(tree, "Solve — send")).toBeUndefined();
    expect(buttonSaying(tree, "Solve — ")).toBeTruthy();
  });

  it("a mapped category (bag, one-size) at Trophy: same old path — Hub 2 + Trophy seeded at '_', no request", async () => {
    const tree = render({ products: only(BAG) });
    await solve(tree, "Trophy");
    const upd = updateMock.mock.calls[0][1];
    expect(Object.keys(upd).sort()).toEqual(["stock/hub2/bag1/_", "stock/trophy/bag1/_"]);
  });
});
