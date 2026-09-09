// ─── DISPLAY REGISTRATION — THROUGH THE REAL COMPONENT ───────────────────────
//
// The smoke test that was missing when a dangling `searchRef` shipped a
// ReferenceError to production (CodeRabbit, PR #460): the whole route died on
// first render and no unit test noticed, because nothing MOUNTED the view.
//
// The screen is now one lane, not four tabs (owner, 2026-09-08), so this drives
// what it actually is: pick a wall, type a name, act on what comes back.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let ROWS = {};
let CELLS1 = {};
let CELLS2 = {};
let PERMS = { permRecord: { stockRole: "admin" }, isSuperAdmin: false, hasPermission: () => true };
const registerDisplayRow = vi.fn(async () => ({ ok: true }));
const closeDisplayRow = vi.fn(async () => ({ ok: true, stockMoved: false }));
const raiseDisplayRequest = vi.fn(async () => ({ ok: true, orderId: "042", createdAt: "2026-09-09T10:00:00.000Z" }));
const cancelDisplayRequest = vi.fn(async () => ({ ok: true }));

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
vi.mock("./displayRequestStore", () => ({
  raiseDisplayRequest: (...a) => raiseDisplayRequest(...a),
  cancelDisplayRequest: (...a) => cancelDisplayRequest(...a),
}));
vi.mock("./useStock", () => ({
  useDisplayRowsState: () => ({ value: ROWS, settled: true, error: false }),
  useStockCellsState: (hub) => ({ cells: hub === "hub1" ? CELLS1 : CELLS2, settled: true, error: false }),
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
  ROWS = {}; CELLS1 = { p1: { 6: { qty: 2 } } }; CELLS2 = {};
  PERMS = { permRecord: { stockRole: "admin" }, isSuperAdmin: false, hasPermission: () => true };
  registerDisplayRow.mockClear(); closeDisplayRow.mockClear(); raiseDisplayRequest.mockClear();
  cancelDisplayRequest.mockClear();
  raiseDisplayRequest.mockResolvedValue({ ok: true, orderId: "042", createdAt: "2026-09-09T10:00:00.000Z" });
  cancelDisplayRequest.mockResolvedValue({ ok: true });
});

describe("the screen is one lane, and it mounts", () => {
  it("renders the two walls and a single search box — no hubs, no brands, no scan", () => {
    const t = render();
    const s = text(t);
    expect(s).toMatch(/Marathon PE/);
    expect(s).toMatch(/Trophy/);
    // the four tabs are gone
    expect(s).not.toMatch(/Hub 1/);
    expect(s).not.toMatch(/Hub 2/);
    expect(s).not.toMatch(/Duplicate Displays/);
    expect(t.root.findAll((n) => n.type === "input")).toHaveLength(1);
  });

  it("lists a shoe the warehouse holds with no display record here", () => {
    expect(text(render())).toMatch(/Nike Dunk Low Panda/);
  });

  it("a DEACTIVATED line is never offered a display, even holding stock", () => {
    CELLS1 = { p3: { 8: { qty: 5 } } };
    expect(text(render())).not.toMatch(/Retired Line/);
  });

  it("stock at EITHER hub counts — there is no hub to pick any more", () => {
    CELLS1 = {}; CELLS2 = { p2: { 7: { qty: 3 } } };
    expect(text(render())).toMatch(/Air Max 95/);
  });
});

describe("the two answers the walk needs", () => {
  it("ON THE WALL opens a picker with NOTHING chosen, then registers", () => {
    const t = render();
    act(() => { btn(t, "On the wall").props.onClick(); });
    expect(text(t)).toMatch(/Which size is on the wall\?/);
    expect(text(t)).toMatch(/Nothing is chosen for you/);
    // The confirm reads "Pick a size" and is DEAD until a size is tapped — the
    // absolute rule, visible in the button itself.
    expect(btn(t, "Pick a size").props.disabled).toBe(true);
    act(() => { btn(t, "6").props.onClick(); });
    act(() => { btn(t, "Register — size").props.onClick(); });
    expect(registerDisplayRow).toHaveBeenCalledTimes(1);
    expect(registerDisplayRow.mock.calls[0][0].size).toBe("6");
  });

  it("...and books the row at the hub that actually HOLDS that size", () => {
    CELLS1 = {}; CELLS2 = { p1: { 7: { qty: 1 } } };      // only hub2 has it
    const t = render();
    act(() => { btn(t, "On the wall").props.onClick(); });
    act(() => { btn(t, "7").props.onClick(); });
    act(() => { btn(t, "Register — size").props.onClick(); });
    expect(registerDisplayRow.mock.calls[0][0].bookedHub).toBe("hub2");
  });

  // ── THE CONSEQUENTIAL TAP ASKS FIRST ──────────────────────────────────────
  // This tap draws a real order number and puts a real job in the warehouse
  // queue. "On the wall", which moves nothing and changes only a record, has
  // always made the operator pick a size first — this had the two backwards.
  it("ONE TAP NO LONGER RAISES ANYTHING — it asks", async () => {
    const t = render();
    await act(async () => { btn(t, "Not on the wall").props.onClick(); });
    expect(raiseDisplayRequest).not.toHaveBeenCalled();
    const s = text(t);
    expect(s).toMatch(/Ask the warehouse to send a display pair\?/);
    // It names the shoe and the wall — a confirm that does not is one nobody reads.
    expect(s).toMatch(/Nike Dunk Low Panda/);
    expect(s).toMatch(/Marathon PE/);
  });

  it("Cancel backs out and raises nothing", async () => {
    const t = render();
    await act(async () => { btn(t, "Not on the wall").props.onClick(); });
    await act(async () => { btn(t, "Cancel").props.onClick(); });
    expect(raiseDisplayRequest).not.toHaveBeenCalled();
    expect(text(t)).not.toMatch(/Ask the warehouse to send a display pair\?/);
  });

  it("confirming raises the request, and never a size", async () => {
    const t = render();
    await act(async () => { btn(t, "Not on the wall").props.onClick(); });
    await act(async () => { btn(t, "Yes — request it").props.onClick(); });
    expect(raiseDisplayRequest).toHaveBeenCalledTimes(1);
    expect(raiseDisplayRequest.mock.calls[0][0].store).toBe("marathon-pe");
    expect(raiseDisplayRequest.mock.calls[0][0]).not.toHaveProperty("size");
  });

  // ── THE WORDING SAYS WHAT WAS ASKED FOR ───────────────────────────────────
  // It read "Display partner requested" — the name of the PIPELINE, not of the
  // thing asked for. Standing at an empty spot nobody asks for a partner to
  // something that is not there.
  it("says a display pair was asked for, not that a partner was requested", async () => {
    const t = render();
    await act(async () => { btn(t, "Not on the wall").props.onClick(); });
    await act(async () => { btn(t, "Yes — request it").props.onClick(); });
    const s = text(t);
    expect(s).toMatch(/Asked the warehouse for a display pair of Nike Dunk Low Panda/);
    expect(s).toMatch(/#042/);
    expect(s).not.toMatch(/Display partner requested/);
  });

  it("OFFERS AN UNDO, and the undo carries the stamp that proves which order it is", async () => {
    const t = render();
    await act(async () => { btn(t, "Not on the wall").props.onClick(); });
    await act(async () => { btn(t, "Yes — request it").props.onClick(); });
    expect(btn(t, "Undo")).toBeTruthy();
    await act(async () => { btn(t, "Undo").props.onClick(); });
    expect(cancelDisplayRequest).toHaveBeenCalledTimes(1);
    // /orders ids are recycled daily, so the id alone does not name an order.
    expect(cancelDisplayRequest.mock.calls[0][0]).toMatchObject({
      orderId: "042", createdAt: "2026-09-09T10:00:00.000Z", store: "marathon-pe",
    });
    expect(text(t)).toMatch(/Undone/);
  });

  it("a refused undo says why and leaves the request standing", async () => {
    cancelDisplayRequest.mockResolvedValue({ ok: false, reason: "started", message: "The warehouse has already started on this one." });
    const t = render();
    await act(async () => { btn(t, "Not on the wall").props.onClick(); });
    await act(async () => { btn(t, "Yes — request it").props.onClick(); });
    await act(async () => { btn(t, "Undo").props.onClick(); });
    expect(text(t)).toMatch(/already started/);
    expect(text(t)).not.toMatch(/Undone/);
  });

  it("a FAILED raise offers no undo — there is nothing to take back", async () => {
    raiseDisplayRequest.mockResolvedValue({ ok: false, message: "A display partner is already on its way." });
    const t = render();
    await act(async () => { btn(t, "Not on the wall").props.onClick(); });
    await act(async () => { btn(t, "Yes — request it").props.onClick(); });
    expect(text(t)).toMatch(/already on its way/);
    expect(btn(t, "Undo")).toBeFalsy();
  });

  it("a store-scoped device cannot request for the OTHER wall", () => {
    const t = render({ ordersScope: "trophy" });
    act(() => { btn(t, "Marathon PE").props.onClick(); });
    expect(btn(t, "Not on the wall").props.disabled).toBe(true);
  });
});

describe("a shoe already on the record", () => {
  it("shows its size and offers a correction and a close", () => {
    ROWS = { "marathon-pe": { p1: { r1: row() } } };
    const t = render({});
    act(() => { t.root.findAll((n) => n.type === "input")[0].props.onChange({ target: { value: "Dunk" } }); });
    const s = text(t);
    expect(s).toMatch(/Size\s+6/);
    expect(btn(t, "Different size")).toBeTruthy();
    expect(btn(t, "Not on the wall any more")).toBeTruthy();
  });

  it("MORE THAN ONE record lists each size with its own close — the duplicate tab's job, here", () => {
    ROWS = { "marathon-pe": { p1: { r1: row(), r2: row({ rowId: "r2", size: "7", sizeKey: "7" }) } } };
    const t = render({});
    act(() => { t.root.findAll((n) => n.type === "input")[0].props.onChange({ target: { value: "Dunk" } }); });
    expect(text(t)).toMatch(/more than one record/);
    expect(btn(t, "Not there")).toBeTruthy();
    const closers = t.root.findAll((n) => n.type === "button").filter((b) => instText(b).includes("Not there"));
    expect(closers).toHaveLength(2);
    act(() => { closers[1].props.onClick(); });
    expect(closeDisplayRow).toHaveBeenCalledTimes(1);
    expect(closeDisplayRow.mock.calls[0][0].row.rowId).toBe("r2");
    expect(closeDisplayRow.mock.calls[0][0].reason).toBe("returned");
  });
});

describe("the design constraints the owner set", () => {
  const src = () => {
    // eslint-disable-next-line
    const { readFileSync } = require("fs");
    return readFileSync(new URL("./DisplayRegistrationView.jsx", import.meta.url), "utf8");
  };

  it("uses NO orange anywhere", () => {
    const s = src().replace(/\/\/.*$/gm, "");
    expect(s).not.toMatch(/#FBBF24/i);
    expect(s).not.toMatch(/\bAMBER\b/);
    expect(s).not.toMatch(/orange/i);
  });

  it("imports no scanner and no brand filter", () => {
    const s = src();
    expect(s).not.toMatch(/AssistantLabelFinder|TongueLabelReader|barcodeListener/);
    expect(s).not.toMatch(/brandsOf/);
  });
});
