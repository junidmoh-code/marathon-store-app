// ─── THE TWO CLEANUP TABS LIVE IN THE DISPLAY REGISTRATION CARD ─────────────
//
// (Owner correction, 2026-09-08.) They shipped inside the Stock console, which
// was a misreading of "leave the Display Registry untouched" — that was about
// not changing how Hub 1 and Hub 2 REGISTER, not about where the new screens
// go. This card is where an operator looks for anything about a display wall.
//
// What this pins is REACHABILITY, which is the thing that was wrong: the tabs
// existed and worked, and nobody would ever have found them. Plus the promise
// that came with the move — Hub 1 and Hub 2 register exactly as before.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let PERMS = { permRecord: { stockRole: "admin" }, isSuperAdmin: false, hasPermission: () => true };

vi.mock("../PermissionsContext", () => ({ usePermissions: () => PERMS }));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } }, functions: { fake: true } }));
vi.mock("firebase/database", () => ({
  ref: () => ({}), get: async () => ({ val: () => null }), update: async () => {},
  runTransaction: async () => ({ committed: true, snapshot: { val: () => null } }),
  onValue: () => () => {}, child: () => ({}),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));
vi.mock("./useStock", () => ({
  useDisplaySlots: () => ({}),
  useDisplayRegister: () => ({}),
  useDisplayRowsState: () => ({ value: ROWS, settled: true, error: false }),
  useStockCellsState: () => ({ cells: CELLS, settled: true, error: false }),
}));
// The scan surface is a full-screen camera; the tab's contract with it is only
// "hand me a product", which its own suite drives.
vi.mock("../assistant/AssistantLabelFinder", () => ({ default: () => null }));

let ROWS = {};
let CELLS = {};

const { default: DisplayRegistrationView } = await import("./DisplayRegistrationView.jsx");

const PRODUCTS = [
  { id: "p1", name: "Nike Dunk Low Panda", brand: "Nike", category: "Footwear", productType: "sneaker", sizes: ["6", "7", "8"] },
];

const row = (o = {}) => ({
  rowId: "r1", store: "marathon-pe", productId: "p1", productName: "Nike Dunk Low Panda",
  size: "6", sizeKey: "6", bookedHub: "hub1", status: "open",
  openedAt: "2026-09-01T00:00:00.000Z", openedVia: "send", events: {}, ...o,
});

const render = (props = {}) => {
  let t;
  act(() => { t = TestRenderer.create(<DisplayRegistrationView products={PRODUCTS} onExit={() => {}} {...props} />); });
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
// Test-instance children are nodes, not a rendered tree, so flatten the
// instance's own descendants rather than round-tripping through toJSON.
const instText = (inst) => {
  const out = [];
  const walk = (n) => {
    if (n == null || n === false) return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.children) n.children.forEach(walk);
    else if (n.props && n.props.children) walk(n.props.children);
  };
  walk(inst.props ? inst.props.children : inst);
  return out.join(" ");
};
const buttonSaying = (t, label) =>
  t.root.findAll((n) => n.type === "button").find((b) => instText(b).includes(label));

beforeEach(() => {
  PERMS = { permRecord: { stockRole: "admin" }, isSuperAdmin: false, hasPermission: () => true };
  ROWS = {}; CELLS = {};
});

describe("the card offers all four panes to an admin", () => {
  it("Hub 1, Hub 2, Duplicate Displays and Unregistered Displays are all reachable", () => {
    const t = render();
    const s = text(t);
    expect(s).toMatch(/Hub 1/);
    expect(s).toMatch(/Hub 2/);
    expect(s).toMatch(/Duplicate Displays/);
    expect(s).toMatch(/Unregistered Displays/);
  });

  it("tapping Unregistered Displays shows the wall walk, not the registration form", () => {
    CELLS = { p1: { 6: { qty: 2 } } };
    const t = render();
    act(() => { buttonSaying(t, "Unregistered Displays").props.onClick(); });
    const s = text(t);
    // the wall walk's own furniture, and NOT the register lane's search prompt
    expect(s).toMatch(/On the wall|Not on the wall|Scan a tongue label|wall walk|no display record/i);
    expect(s).not.toMatch(/to register or fix its display size/);
  });

  it("tapping Duplicate Displays shows that tab", () => {
    ROWS = { "marathon-pe": { p1: { r1: row(), r2: row({ rowId: "r2", size: "7", sizeKey: "7" }) } } };
    const t = render();
    act(() => { buttonSaying(t, "Duplicate Displays").props.onClick(); });
    expect(text(t)).not.toMatch(/to register or fix its display size/);
  });

  it("and Hub 1 comes back to the registration lane, unchanged", () => {
    const t = render();
    act(() => { buttonSaying(t, "Unregistered Displays").props.onClick(); });
    act(() => { buttonSaying(t, "Hub 1").props.onClick(); });
    expect(text(t)).toMatch(/to register or fix its display size/);
  });
});

describe("the wall walk inside the card serves BOTH stores", () => {
  it("offers marathon-pe and trophy, and Pine is deliberately absent", () => {
    CELLS = { p1: { 6: { qty: 2 } } };
    const t = render();
    act(() => { buttonSaying(t, "Unregistered Displays").props.onClick(); });
    const s = text(t);
    expect(s).toMatch(/Marathon PE|marathon-pe/i);
    expect(s).toMatch(/Trophy/i);
    // Pine's displays are booked at hub3, outside GATED_SNEAKER_HUBS.
    expect(s).not.toMatch(/Pine/i);
  });
});

describe("a non-admin sees the card exactly as it was", () => {
  it("no cleanup chips, and the two hub chips still register", () => {
    PERMS = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false, hasPermission: () => false };
    const t = render();
    const s = text(t);
    expect(s).toMatch(/Hub 1/);
    expect(s).toMatch(/Hub 2/);
    expect(s).not.toMatch(/Duplicate Displays/);
    expect(s).not.toMatch(/Unregistered Displays/);
    expect(s).toMatch(/to register or fix its display size/);
  });

  it("a super-admin gets them without a stockRole", () => {
    PERMS = { permRecord: null, isSuperAdmin: true, hasPermission: () => true };
    expect(text(render())).toMatch(/Unregistered Displays/);
  });
});

describe("the Stock console no longer carries them", () => {
  it("StockView names neither tab", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./StockView.jsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/dupdisplays/);
    expect(src).not.toMatch(/walldisplays/);
    // Display Records STAYS — it is about the hub register, which is stock work.
    expect(src).toMatch(/displayrecs/);
  });
});
