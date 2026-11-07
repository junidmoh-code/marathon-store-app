// ─── PINE AND CONCRETE ON THE WALL SCREEN (Junid, 7 Nov 2026) ────────────────
// The per-store wall screen offers every shop in the registry. Pine and
// Concrete are walked against Hub 3, the hub that feeds them, and their walls
// RECORD what is standing there — but "Not on the wall" (which raises a display
// request) stays off: no request path is opened for a shop that had none
// (CLAUDE.md, Junid's rules). Marathon PE and Trophy are unchanged.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let ROWS = {};
let CELLS = {};
let PERMS = { permRecord: { stockRole: "admin" }, isSuperAdmin: false, hasPermission: () => true };
const registerDisplayRow = vi.fn(async () => ({ ok: true }));
const closeDisplayRow = vi.fn(async () => ({ ok: true, stockMoved: false }));
const raiseDisplayRequest = vi.fn(async () => ({ ok: true, orderId: "042" }));

vi.mock("../PermissionsContext", () => ({ usePermissions: () => PERMS }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } }, functions: {} }));
vi.mock("firebase/database", () => ({
  ref: () => ({}), get: async () => ({ val: () => null }), update: async () => {},
  runTransaction: async () => ({ committed: true, snapshot: { val: () => null } }),
  onValue: () => () => {}, child: () => ({}),
}));
vi.mock("./displayRowStore", () => ({
  registerDisplayRow: (...a) => registerDisplayRow(...a),
  closeDisplayRow: (...a) => closeDisplayRow(...a),
}));
vi.mock("./displayRequestStore", () => ({ raiseDisplayRequest: (...a) => raiseDisplayRequest(...a) }));
vi.mock("./useStock", () => ({
  useDisplayRowsState: () => ({ value: ROWS, settled: true, error: false }),
  useStockCellsState: (hub) => ({ cells: hub ? (CELLS[hub] || {}) : {}, settled: true, error: false }),
  // /network: no node, so the registry is its seed — the two live walls
  // (Marathon PE, Trophy) and their two gated hubs (Hub 1, Hub 2).
  usePathState: () => ({ value: null, settled: true, error: false }),
}));

const { default: View } = await import("./DisplayRegistrationView.jsx");

const PRODUCTS = [
  { id: "p1", name: "Nike Dunk Low Panda", brand: "Nike", category: "Footwear", productType: "sneaker", sizes: ["6", "7", "8"] },
  { id: "p2", name: "Air Max 95", brand: "Nike", category: "Footwear", productType: "sneaker", sizes: ["7", "8"] },
  { id: "p3", name: "Retired Line", brand: "Nike", category: "Footwear", productType: "sneaker", sizes: ["8"], deactivated: true },
];
const row = (o = {}) => ({
  rowId: "r1", store: "marathon-pe", productId: "p1", productName: "Nike Dunk Low Panda",
  size: "6", sizeKey: "6", bookedHub: "hub1", status: "open",
  openedAt: "2026-09-01T00:00:00.000Z", openedVia: "send", events: {}, ...o,
});

const render = (props = {}) => {
  let t;
  act(() => { t = TestRenderer.create(<View products={PRODUCTS} onExit={() => {}} {...props} />); });
  return t;
};
const text = (t) => {
  const out = [];
  const walk = (n) => {
    if (n == null || n === false) return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.children) n.children.forEach(walk);
  };
  walk(t.toJSON());
  return out.join(" ");
};
const instText = (i) => {
  const out = [];
  const walk = (n) => {
    if (n == null || n === false) return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.children) n.children.forEach(walk);
    else if (n.props && n.props.children) walk(n.props.children);
  };
  walk(i.props ? i.props.children : i);
  return out.join(" ");
};
const btn = (t, label) => t.root.findAll((n) => n.type === "button").find((b) => instText(b).includes(label));

beforeEach(() => {
  ROWS = {};
  CELLS = { hub1: { p1: { 6: { qty: 2 } } }, hub3: { p2: { 7: { qty: 1 } } } };
  PERMS = { permRecord: { stockRole: "admin" }, isSuperAdmin: false, hasPermission: () => true };
  registerDisplayRow.mockClear(); closeDisplayRow.mockClear(); raiseDisplayRequest.mockClear();
});

const wallTabs = (t) => t.root.findAll((n) => n.type === "button").map((b) => instText(b).trim()).slice(1, 5);

describe("every shop has a wall", () => {
  it("Marathon PE, Trophy, Pine, Concrete — Marathon first", () => {
    const tabs = wallTabs(render());
    expect(tabs[0]).toMatch(/Marathon PE/);
    expect(tabs[1]).toMatch(/Trophy/);
    expect(tabs[2]).toMatch(/Pine/);
    expect(tabs[3]).toMatch(/Concrete/);
  });
});

describe("the Pine wall is walked against Hub 3", () => {
  const openPine = () => {
    const t = render();
    act(() => { btn(t, "Pine").props.onClick(); });
    return t;
  };
  it("lists what Hub 3 holds, not what Hub 1 holds", () => {
    const s = text(openPine());
    expect(s).toMatch(/Air Max 95/);
    expect(s).not.toMatch(/Nike Dunk Low Panda/);
  });
  it("On the wall records a Pine row booked at hub3 — no stock moves", async () => {
    const t = openPine();
    act(() => { btn(t, "On the wall").props.onClick(); });
    act(() => { btn(t, "7").props.onClick(); });
    await act(async () => { await btn(t, "Register").props.onClick(); });
    expect(registerDisplayRow).toHaveBeenCalledTimes(1);
    expect(registerDisplayRow.mock.calls[0][0]).toMatchObject({ store: "marathon-pine", productId: "p2", size: "7", bookedHub: "hub3" });
  });
  it("Not on the wall is OFF — a Pine wall raises no display request", async () => {
    const t = openPine();
    const b = btn(t, "Not on the wall");
    expect(b.props.disabled).toBe(true);
    await act(async () => { await b.props.onClick(); });   // even a forced tap
    expect(raiseDisplayRequest).not.toHaveBeenCalled();
  });
  it("Concrete is the same", () => {
    const t = render();
    act(() => { btn(t, "Concrete").props.onClick(); });
    expect(text(t)).toMatch(/Air Max 95/);
    expect(btn(t, "Not on the wall").props.disabled).toBe(true);
  });
});

describe("Marathon PE is unchanged", () => {
  it("walks Hub 1/Hub 2 and Not on the wall still raises its request", async () => {
    const t = render();
    expect(text(t)).toMatch(/Nike Dunk Low Panda/);
    expect(text(t)).not.toMatch(/Air Max 95/);
    const b = btn(t, "Not on the wall");
    expect(b.props.disabled).toBe(false);
    await act(async () => { await b.props.onClick(); });
    expect(raiseDisplayRequest).toHaveBeenCalledTimes(1);
    expect(raiseDisplayRequest.mock.calls[0][0].store).toBe("marathon-pe");
  });
});
