// ─── MISSING SNEAKERS — no silently dead button, including mid-write ─────────
// The clothing list has its own render test; this pins the SAME contract on the
// sneaker list, and specifically the hole an independent review found in it:
//
//   the buttons were disabled by a GLOBAL in-flight flag (`!!solveBusy`,
//   `!!busyPid`) while their reason was computed from a PER-ROW one
//   (`solveBusy === card.pid`). So while one card's write was in flight, every
//   OTHER row's button was grey with its reason returning null — nothing
//   rendered, nothing explained. (Sonnet review, PR #342.)
//
// The invariant under test is structural and absolute: on this screen, a
// disabled button always carries its reason. Driving it requires a write that
// never settles, which is what the hanging `get` below is for.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-08-10T10:00:00.000Z");
const paths = {};
const gets = {};
let hangGets = false;   // when true, get() never settles → solveBusy stays set

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: vi.fn(() => Promise.resolve()),
  push: () => ({ key: "req1" }),
  get: (r) => (hangGets ? new Promise(() => {}) : Promise.resolve({ val: () => gets[r.path] ?? null })),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: { ok: true } }) }));
const perm = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: MissingFootwear } = await import("./MissingFootwear.jsx");

// Two stranded shoes: Central holds stock, neither hub carries a cell.
const PRODUCTS = [
  { id: "shoeA", name: "Air Zoom Alpha", category: "Footwear", sizes: ["8", "9"] },
  { id: "shoeB", name: "Air Zoom Beta", category: "Footwear", sizes: ["8", "9"] },
];
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });

const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const buttonSaying = (tree, needle) =>
  buttonsOf(tree).filter((b) => (b.children || []).some((c) => typeof c === "string" && c.includes(needle)));

const mount = () => {
  let tree;
  act(() => { tree = TestRenderer.create(<MissingFootwear products={PRODUCTS} />); });
  return tree;
};

beforeEach(() => {
  hangGets = false;
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  paths["stock"] = { central: { shoeA: { 8: cell(5), 9: cell(5) }, shoeB: { 8: cell(5), 9: cell(5) } } };
  paths["refill_requests"] = null;
  gets["config/refillEngine/footwearRunByLocation"] = { hub1: { 8: 2, 9: 2 }, hub2: { 8: 2, 9: 2 } };
  gets["config/refillEngine/policyGroups/footwear-all/policy/hub3"] = { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true };
  perm.permRecord = { stockRole: "warehouse" };
});

describe("every disabled button on the sneaker list carries its reason", () => {
  it("holds while a DIFFERENT row's write is still in flight", async () => {
    const tree = mount();
    // Open row A's Solve panel and fire its Confirm. The get() inside solve()
    // never settles, so solveBusy stays set on shoeA for the rest of the test.
    const solveButtons = buttonSaying(tree, "Solve");
    expect(solveButtons.length).toBe(2);
    await act(async () => { solveButtons[0].props.onClick(); });
    hangGets = true;
    const confirm = buttonSaying(tree, "Confirm")[0];
    expect(confirm).toBeDefined();
    await act(async () => { confirm.props.onClick(); });

    // Now open row B's panel — a different card, mid-write on the first.
    await act(async () => { buttonSaying(tree, "Solve")[0].props.onClick(); });

    const disabled = buttonsOf(tree).filter((b) => b.props.disabled);
    expect(disabled.length).toBeGreaterThan(0);
    for (const b of disabled) {
      expect(typeof b.props.title, `disabled with no reason: ${JSON.stringify(b.children)}`).toBe("string");
      expect(b.props.title.length).toBeGreaterThan(10);
    }
  });

  it("a viewer with no stock role is told, on the row", () => {
    perm.permRecord = { stockRole: null };
    const tree = mount();
    const disabled = buttonsOf(tree).filter((b) => b.props.disabled);
    expect(disabled.length).toBeGreaterThan(0);
    for (const b of disabled) expect(b.props.title).toMatch(/stock role/i);
    expect(JSON.stringify(tree.toJSON())).toMatch(/stock role/i);
  });

  it("with the footwear run unset, Solve is disabled and points at Request", () => {
    gets["config/refillEngine/footwearRunByLocation"] = null;
    const tree = mount();
    const solve = buttonSaying(tree, "Solve")[0];
    expect(solve.props.disabled).toBe(true);
    expect(solve.props.title).toMatch(/Request/);
  });
});

describe("SNEAKERS: on the Concrete list, Hub 3 is the default of the three hubs", () => {
  it("\"Missing from Concrete · Hub 3\": Solve raises refill_requests for hub3 only, never Hub 1 or Hub 2 unless ticked", async () => {
    const { update } = await import("firebase/database");
    update.mockClear();
    const tree = mount();
    const chip = (label) => buttonsOf(tree).find((b) => (b.children || []).join("") === label);
    expect(chip("Missing from Marathon · Hub 1 + Hub 2")).toBeDefined();
    const concrete = chip("Missing from Concrete · Hub 3");
    expect(concrete).toBeDefined();
    await act(async () => { concrete.props.onClick(); });
    await act(async () => { buttonSaying(tree, "Solve")[0].props.onClick(); });
    // all three hubs are offered, Hub 3 ticked
    const hubChips = buttonsOf(tree).filter((b) => b.props.role === "checkbox").map((b) => [(b.children || []).join(""), b.props["aria-checked"]]);
    expect(hubChips.map(([t]) => t.replace(/ · .*/, ""))).toEqual(["Hub 1", "Hub 2", "Hub 3"]);
    expect(hubChips.filter(([, on]) => on).map(([t]) => t.replace(/ · .*/, ""))).toEqual(["Hub 3"]);
    await act(async () => { await buttonSaying(tree, "Confirm")[0].props.onClick(); });
    expect(update).toHaveBeenCalledTimes(1);
    const reqs = Object.entries(update.mock.calls[0][1]).filter(([k]) => k.startsWith("refill_requests/")).map(([, v]) => v);
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) expect(r).toMatchObject({ requestingLocation: "hub3", status: "open", createdFrom: { source: "central" } });
  });
});

describe("Hub 1 and Hub 2 never share a sneaker, across separate Solves", () => {
  const openConfirm = async (tree) => {
    await act(async () => { buttonSaying(tree, "Solve")[0].props.onClick(); });
    return buttonSaying(tree, "Confirm")[0];
  };
  const confirmAndText = async (tree) => {
    const confirm = await openConfirm(tree);
    await act(async () => { await confirm.props.onClick(); });
    return JSON.stringify(tree.toJSON());
  };
  it("Hub 1's Solve raises nothing while Hub 2 holds a cell of it, sold out included", async () => {
    const { update } = await import("firebase/database");
    update.mockClear();
    gets["stock/hub2/shoeA"] = { 8: cell(0) };
    const tree = mount();
    expect(await confirmAndText(tree)).toMatch(/seated at Hub 2, so it cannot be solved to Hub 1/);
    expect(update).not.toHaveBeenCalled();
  });
  it("a Solve still open at Hub 2 refuses the next Solve to Hub 1", async () => {
    const { update } = await import("firebase/database");
    update.mockClear();
    gets["refill_requests"] = { r9: { status: "open", requestingLocation: "hub2", productId: "shoeA", size: "8", qty: 1 } };
    const tree = mount();
    expect(await confirmAndText(tree)).toMatch(/seated at Hub 2/);
    expect(update).not.toHaveBeenCalled();
  });
  it("a switched-off row at Hub 2 is no seat: Hub 1's Solve goes through", async () => {
    const { update } = await import("firebase/database");
    update.mockClear();
    gets["stock/hub2/shoeA"] = { 8: cell(0) };
    gets["stock_targets/hub2/shoeA"] = { 8: { target: 0 } };
    const tree = mount();
    await confirmAndText(tree);
    expect(update).toHaveBeenCalledTimes(1);
  });
  it("ticking the other hub on a card is refused while that hub has it seated", async () => {
    paths["stock"].hub1 = { shoeA: { 8: cell(2) } };
    const tree = mount();
    const concrete = buttonsOf(tree).find((b) => (b.children || []).join("") === "Missing from Concrete · Hub 3");
    await act(async () => { concrete.props.onClick(); });
    await act(async () => { buttonSaying(tree, "Solve")[0].props.onClick(); });
    const chip = buttonsOf(tree).find((b) => b.props.role === "checkbox" && (b.children || []).join("").startsWith("Hub 2"));
    await act(async () => { chip.props.onClick(); });
    expect(JSON.stringify(tree.toJSON())).toMatch(/seated at Hub 1, so it cannot be solved to Hub 2/);
  });
  it("a zero cell at the other hub does not refuse the chip: it may be switched off, and Confirm reads the rows", async () => {
    paths["stock"].hub1 = { shoeA: { 8: cell(0) } };
    const tree = mount();
    const concrete = buttonsOf(tree).find((b) => (b.children || []).join("") === "Missing from Concrete · Hub 3");
    await act(async () => { concrete.props.onClick(); });
    await act(async () => { buttonSaying(tree, "Solve")[0].props.onClick(); });
    const chip = buttonsOf(tree).find((b) => b.props.role === "checkbox" && (b.children || []).join("").startsWith("Hub 2"));
    await act(async () => { chip.props.onClick(); });
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/seated at Hub 1/);
  });
});
