// ─── Missing Products × Concrete-only (Junid, 20 Nov 2026), rendered ─────────
//   • a Marathon row carries a third action, "Concrete": one tap marks the
//     product Concrete-only through the ONE helper, the row leaves at once, and
//     the action lands in the Solved history with an Undo;
//   • a refused mark brings the row back and says why (never silent);
//   • only Junid / a stockRole admin sees the button;
//   • on the Concrete division's list a Concrete-only row — and only such a
//     row — offers BOTH divisions' stores, each routed through its own hub;
//   • the Solved tab lists the visit's actions with Undo; undoing a Concrete
//     mark returns the product to Marathon.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const paths = {};
const gets = {};
const updateMock = vi.fn(() => Promise.resolve());
let pushN = 0;
vi.mock("firebase/database", () => ({
  query: (r, ...parts) => ({ path: `${r.path}?${parts.map((p) => p.q).join("&")}` }), orderByChild: (f) => ({ q: `orderBy=${f}` }), equalTo: (v) => ({ q: `equalTo=${v}` }),
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
  push: () => ({ key: `req${++pushN}` }),
  runTransaction: () => Promise.resolve({ committed: true, snapshot: { val: () => null } }),
}));
const saveRows = vi.fn(async () => {});
vi.mock("./solvedLogStore", () => ({
  useSolvedLog: () => ({ entries: [], settled: true, error: null, hasMore: false, loadMore: () => {} }),
  saveSolvedRows: (...a) => saveRows(...a),
  markSolvedUndone: vi.fn(async () => {}),
}));
const markMock = vi.fn();
vi.mock("../concrete/concreteStore", () => ({ markConcreteProduct: (...a) => markMock(...a) }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const perm = { permRecord: { stockRole: "admin", displayName: "Junid" }, isSuperAdmin: true };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: NetworkTransfer } = await import("./NetworkTransfer.jsx");
const { computeMissingProducts } = await import("./missingProductsCore.js");
const { __resetNetworkForTests } = await import("../../utils/networkStore.js");

const S1_LIVE = { locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true } } };
const CONFIG = {
  ruleBasedTargets: true,
  routes: { hub1: "central", hub2: "central", hub3: "central", "marathon-pe": "hub2", trophy: "hub2", "marathon-pine": "hub3", concrete: "hub3" },
  maxUnitsPerIntent: 20,
  defaultRunByStore: { hub2: { L: 3, M: 3, S: 2 }, "marathon-pe": { L: 2, M: 2, S: 2 }, trophy: { L: 2, M: 2, S: 2 } },
};
const TEE = { id: "tee1", name: "Essentials Tee Olive", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "L"] };
const PANT = { id: "pant1", name: "Pant fashion 3306", productType: "clothing", categoryKey: "pants", subcategory: "Cargos & Pants", sizes: ["S", "M", "L"], concreteProduct: true };
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const PLENTY = { S: cell(9), M: cell(9), L: cell(9) };
const STOCK = { central: { tee1: PLENTY, pant1: PLENTY } };

const flat = (n) => (n == null || n === false ? "" : typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.children));
const textOf = (tree) => flat(tree.toJSON());
const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const buttonExactly = (tree, label) => buttonsOf(tree).find((b) => (b.children || []).join("") === label);
const buttonSaying = (tree, needle) => buttonsOf(tree).find((b) => (b.children || []).some((c) => typeof c === "string" && c.includes(needle)));
const boxes = (tree) => buttonsOf(tree).filter((b) => b.props.role === "checkbox");
const boxLabel = (b) => (b.children || []).join("").replace(/^✓ /, "");

function render({ products = [TEE, PANT], division = 2, view = "list", session = [] } = {}) {
  const list = computeMissingProducts({ allStock: STOCK, products, ...(division === 1 ? { section: 1 } : {}) });
  let tree;
  let state = { session, resolving: {} };
  const Host = () => {
    const [solved, setSolved] = React.useState(session);
    const [resolving, setResolving] = React.useState({});
    state = { session: solved, resolving };
    return <NetworkTransfer products={products} category="clothing" view={view} allStock={STOCK} cards={list}
      targets={{}} targetsSettled targetsError={false}
      solvedSession={solved} setSolvedSession={setSolved} resolving={resolving} setResolving={setResolving} />;
  };
  act(() => { tree = TestRenderer.create(<Host />); });
  return { tree, state: () => state };
}

beforeEach(() => {
  updateMock.mockClear(); markMock.mockReset(); saveRows.mockClear(); pushN = 0;
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  __resetNetworkForTests();
  paths["config/refillEngine"] = CONFIG;
  paths.network = S1_LIVE;
  perm.permRecord = { stockRole: "admin", displayName: "Junid" }; perm.isSuperAdmin = true;
});

describe("the Concrete button on a Marathon row", () => {
  it("Marathon's list never carries the Concrete-only product; the ordinary one has a Concrete button", () => {
    const { tree } = render();
    expect(textOf(tree)).toContain("Essentials Tee Olive");
    expect(textOf(tree)).not.toContain("Pant fashion 3306");
    expect(buttonExactly(tree, "Concrete")).toBeTruthy();
  });
  it("one tap: marked through the helper, the row leaves at once, the Solved row offers Undo", async () => {
    let resolve;
    markMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { tree, state } = render();
    await act(async () => { buttonExactly(tree, "Concrete").props.onClick(); });
    // Gone while the write is still in flight.
    expect(textOf(tree)).not.toMatch(/Essentials Tee Olive.*Move manually/);
    expect(buttonExactly(tree, "Solve")).toBeUndefined();
    expect(markMock).toHaveBeenCalledWith("tee1", true);
    await act(async () => { resolve({ ok: true }); });
    expect(state().session[0]).toMatchObject({ kind: "concrete", pid: "tee1", status: "done", byName: "Junid" });
    expect(saveRows).toHaveBeenCalledTimes(1);
    expect(saveRows.mock.calls[0][0][0].log).toMatchObject({ kind: "concrete", pid: "tee1", at: NOW, by: "u1" });
    expect(textOf(tree)).toMatch(/Concrete — Essentials Tee Olive/);
    expect(buttonExactly(tree, "Undo")).toBeTruthy();
    // Nothing about stock, targets or requests was written.
    expect(updateMock).not.toHaveBeenCalled();
  });
  it("a refused mark brings the row back and says why", async () => {
    markMock.mockResolvedValue({ ok: false, message: "Permission denied — the Concrete console rules have not been pasted yet. Nothing was saved." });
    const { tree } = render();
    await act(async () => { buttonExactly(tree, "Concrete").props.onClick(); });
    expect(textOf(tree)).toContain("Essentials Tee Olive");
    expect(textOf(tree)).toMatch(/Not marked Concrete — Permission denied/);
    expect(saveRows).not.toHaveBeenCalled();
  });
  it("staff without the admin role never see it", () => {
    perm.permRecord = { stockRole: "warehouse" }; perm.isSuperAdmin = false;
    const { tree } = render();
    expect(buttonExactly(tree, "Concrete")).toBeUndefined();
    expect(buttonExactly(tree, "Solve")).toBeTruthy();
  });
});

describe("Solve on the Concrete division's list", () => {
  it("a Concrete-only row offers BOTH divisions' stores; Solve to Trophy routes through Hub 2", async () => {
    const { tree } = render({ products: [PANT], division: 1 });
    expect(textOf(tree)).toContain("Pant fashion 3306");
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    expect(boxes(tree).map(boxLabel)).toEqual(expect.arrayContaining(["Marathon Pine", "Concrete", "Marathon PE", "Trophy"]));
    for (const b of boxes(tree)) if (b.props["aria-checked"]) act(() => { b.props.onClick(); });
    act(() => { boxes(tree).find((b) => boxLabel(b) === "Trophy").props.onClick(); });
    await act(async () => { await buttonSaying(tree, "Solve — ").props.onClick(); });
    const upd = updateMock.mock.calls[0][1];
    const locs = new Set(Object.keys(upd).filter((k) => k.startsWith("stock/")).map((k) => k.split("/")[1]));
    expect([...locs].sort()).toEqual(["hub2", "trophy"]);
  });
  it("an ordinary row on the same list keeps the wall: Concrete division stores only", async () => {
    const { tree } = render({ products: [TEE], division: 1 });
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    expect(boxes(tree).map(boxLabel)).toEqual(["Marathon Pine", "Concrete"]);
  });
});

describe("the Solved tab", () => {
  const row = { key: "k0179520000000aaaaaa", kind: "concrete", pid: "tee1", name: "Essentials Tee Olive", at: NOW, by: "u1", byName: "Junid", status: "done", locs: [], paths: [], priorOpen: {}, batch: "k0179520000000aaaaaa" };
  it("lists the visit's actions with who and where; Undo of a Concrete mark returns it to Marathon", async () => {
    markMock.mockResolvedValue({ ok: true });
    const { tree, state } = render({ view: "solved", session: [row] });
    expect(textOf(tree)).toMatch(/Concrete — Essentials Tee Olive: made Concrete-only/);
    expect(textOf(tree)).toMatch(/Junid/);
    await act(async () => { await buttonExactly(tree, "Undo").props.onClick(); });
    expect(markMock).toHaveBeenCalledWith("tee1", false);
    expect(state().session[0].status).toBe("undone");
    expect(buttonExactly(tree, "Undo")).toBeUndefined();
    expect(textOf(tree)).toMatch(/Undone/);
  });
});

describe("fast Solve — the row resolves on the tap, the write follows", () => {
  const solveTee = async (tree) => {
    await act(async () => { buttonExactly(tree, "Solve").props.onClick(); });
    await act(async () => { buttonSaying(tree, "Solve — ").props.onClick(); });
  };
  it("the card leaves before the write is acknowledged; the Solved row appears once it is", async () => {
    let ack;
    updateMock.mockImplementationOnce(() => new Promise((r) => { ack = r; }));
    const { tree, state } = render({ products: [TEE] });
    await solveTee(tree);
    expect(buttonExactly(tree, "Solve")).toBeUndefined();          // gone on the tap
    expect(state().resolving.tee1).toBe("pending");
    expect(updateMock).toHaveBeenCalledTimes(1);                    // ONE multi-path update
    await act(async () => { ack(); });
    expect(state().resolving.tee1).toBe("done");
    expect(state().session[0]).toMatchObject({ kind: "solve", pid: "tee1" });
    expect(textOf(tree)).toMatch(/Solved — Essentials Tee Olive/);
  });
  it("a refused write brings the card back with the reason in red", async () => {
    updateMock.mockImplementationOnce(() => Promise.reject(new Error("PERMISSION_DENIED")));
    const { tree, state } = render({ products: [TEE] });
    await solveTee(tree);
    expect(state().resolving.tee1).toBeUndefined();
    expect(buttonExactly(tree, "Solve")).toBeTruthy();
    expect(textOf(tree)).toMatch(/Couldn't solve Essentials Tee Olive — nothing changed, retry\. \(PERMISSION_DENIED\)/);
    expect(saveRows).not.toHaveBeenCalled();
  });
});
