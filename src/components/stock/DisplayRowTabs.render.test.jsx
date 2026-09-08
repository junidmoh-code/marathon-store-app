// Behavioural coverage for the two display-row screens. The decisions are
// proven in displayRowCore.test.js and the invariant in displayRowFuzz.test.js;
// these pin what only the SCREEN can get wrong — what it offers a button for,
// what it writes when the button is pressed, and the two things the owner asked
// to be said out loud: that closing a record moves no stock, and what the wall
// walk cannot see.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { create, act } from "react-test-renderer";

const closeDisplayRow = vi.fn(async () => ({ ok: true }));
const registerDisplayRow = vi.fn(async () => ({ ok: true }));
const raiseDisplayRequest = vi.fn(async () => ({ ok: true, orderId: "042" }));

let ROWS = {};
let CELLS = {};

vi.mock("./displayRowStore", () => ({
  closeDisplayRow: (...a) => closeDisplayRow(...a),
  registerDisplayRow: (...a) => registerDisplayRow(...a),
}));
vi.mock("./displayRequestStore", () => ({
  raiseDisplayRequest: (...a) => raiseDisplayRequest(...a),
}));
vi.mock("./useStock", () => ({
  useDisplayRowsState: () => ({ value: ROWS, settled: true, error: false }),
  useStockCellsState: () => ({ cells: CELLS, settled: true, error: false }),
}));
// The shared label pipeline is a full-screen camera surface; the tab's contract
// with it is only "hand me a product", which the scan test drives directly.
vi.mock("../assistant/AssistantLabelFinder", () => ({ default: () => null }));

const DuplicateDisplaysTab = (await import("./DuplicateDisplaysTab")).default;
const UnregisteredDisplaysTab = (await import("./UnregisteredDisplaysTab")).default;

const PRODUCTS = [
  { id: "p1", name: "Air Force 1 White", brand: "Nike", category: "Footwear", productType: "sneaker", sizes: ["8", "9", "10"] },
  { id: "p2", name: "Lacoste Gripshot", brand: "Lacoste", category: "Footwear", productType: "sneaker", sizes: ["7", "8"] },
];

const row = (o = {}) => ({
  rowId: "r1", store: "trophy", productId: "p1", productName: "Air Force 1 White",
  size: "9", sizeKey: "9", bookedHub: "hub1", status: "open",
  openedAt: "2026-09-01T08:00:00.000Z", openedVia: "send", events: {}, ...o,
});
const ledger = (...rows) => {
  const out = {};
  for (const r of rows) {
    out[r.store] = out[r.store] || {};
    out[r.store][r.productId] = out[r.store][r.productId] || {};
    out[r.store][r.productId][r.rowId] = r;
  }
  return out;
};

beforeEach(() => {
  closeDisplayRow.mockClear(); registerDisplayRow.mockClear(); raiseDisplayRequest.mockClear();
  closeDisplayRow.mockImplementation(async () => ({ ok: true }));
  registerDisplayRow.mockImplementation(async () => ({ ok: true }));
  raiseDisplayRequest.mockImplementation(async () => ({ ok: true, orderId: "042" }));
  ROWS = {}; CELLS = {};
});

const textOf = (tree) => JSON.stringify(tree.toJSON());
const buttons = (tree) => tree.root.findAll((n) => n.type === "button", { deep: true });
const textIn = (node) => {
  if (typeof node === "string") return node;
  if (!node || !node.children) return "";
  return node.children.map(textIn).join("");
};
const byLabel = (tree, re) => buttons(tree).filter((b) => re.test(textIn(b)));
const click = async (b) => { await act(async () => { await b.props.onClick(); }); };

const paintDupes = (props = {}) => {
  let tree;
  act(() => { tree = create(<DuplicateDisplaysTab products={PRODUCTS} isAdmin {...props} />); });
  return tree;
};
const paintWall = (props = {}) => {
  let tree;
  act(() => { tree = create(<UnregisteredDisplaysTab products={PRODUCTS} orders={[]} isAdmin {...props} />); });
  return tree;
};

describe("Duplicate Displays", () => {
  it("shows nothing to correct when every wall holds one record", () => {
    ROWS = ledger(row());
    expect(textOf(paintDupes())).toContain("No product is registered on display more than once");
  });

  it("shows the product, the store and EVERY registered size with its date and source", () => {
    ROWS = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "10", sizeKey: "10", openedVia: "wall_walk", openedAt: "2026-09-05T08:00:00.000Z" }));
    const t = textOf(paintDupes());
    expect(t).toContain("Air Force 1 White");
    expect(t).toContain("Trophy");
    expect(t).toContain("2026-09-01");
    expect(t).toContain("2026-09-05");
    expect(t).toContain("Sent from the warehouse");
    expect(t).toContain("Registered on a wall walk");
  });

  it("says, before the confirm, that no stock moves", async () => {
    ROWS = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "10", sizeKey: "10" }));
    const tree = paintDupes();
    await click(byLabel(tree, /Not on the wall — close it/)[0]);
    expect(textOf(tree)).toContain("No stock moves");
  });

  it("takes two taps to close, and closes exactly the row that was tapped", async () => {
    ROWS = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "10", sizeKey: "10" }));
    const tree = paintDupes();
    await click(byLabel(tree, /Not on the wall/)[1]);
    expect(closeDisplayRow).not.toHaveBeenCalled();              // the first tap only asks
    await click(byLabel(tree, /^Confirm$/)[0]);
    expect(closeDisplayRow).toHaveBeenCalledTimes(1);
    expect(closeDisplayRow.mock.calls[0][0].row.rowId).toBe("b");
    expect(closeDisplayRow.mock.calls[0][0].reason).toBe("corrected");
  });

  it("a failed close is reported and the row is NOT treated as done", async () => {
    closeDisplayRow.mockImplementation(async () => ({ ok: false, message: "permission denied" }));
    ROWS = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "10", sizeKey: "10" }));
    const tree = paintDupes();
    await click(byLabel(tree, /Not on the wall/)[0]);
    await click(byLabel(tree, /^Confirm$/)[0]);
    expect(textOf(tree)).toContain("permission denied");
  });

  it("the size that is not listed can be registered, WITHOUT closing the others", async () => {
    ROWS = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "10", sizeKey: "10" }));
    const tree = paintDupes();
    await click(byLabel(tree, /size on the wall is not listed/)[0]);
    // Nothing is preselected: the confirm is dead until a size is tapped.
    expect(byLabel(tree, /Pick a size/)[0].props.disabled).toBe(true);
    await click(byLabel(tree, /^8$/)[0]);
    await click(byLabel(tree, /Register — size 8/)[0]);
    expect(registerDisplayRow).toHaveBeenCalledTimes(1);
    expect(registerDisplayRow.mock.calls[0][0].keepOpen).toBe(true);
    expect(registerDisplayRow.mock.calls[0][0].size).toBe("8");
  });

  it("is admin-only", () => {
    ROWS = ledger(row({ rowId: "a" }), row({ rowId: "b", size: "10", sizeKey: "10" }));
    let tree; act(() => { tree = create(<DuplicateDisplaysTab products={PRODUCTS} isAdmin={false} />); });
    expect(textOf(tree)).toContain("admin-only");
    expect(byLabel(tree, /close it/)).toHaveLength(0);
  });
});

describe("Unregistered Displays — the wall walk", () => {
  beforeEach(() => { CELLS = { p1: { 9: { qty: 2 } }, p2: { 8: { qty: 1 } } }; });

  it("lists hub stock with no display record for this store", () => {
    const t = textOf(paintWall());
    expect(t).toContain("Air Force 1 White");
    expect(t).toContain("Lacoste Gripshot");
  });

  it("drops a product that already has an open record at this store", () => {
    ROWS = ledger(row({ productId: "p1", store: "marathon-pe" }));   // the default store tab
    const t = textOf(paintWall());
    expect(t).not.toContain("Air Force 1 White");
    expect(t).toContain("Lacoste Gripshot");
  });

  it("ON THE WALL asks for the size, with nothing chosen, then registers it", async () => {
    const tree = paintWall();
    await click(byLabel(tree, /^On the wall$/)[0]);
    expect(byLabel(tree, /Pick a size/)[0].props.disabled).toBe(true);
    expect(registerDisplayRow).not.toHaveBeenCalled();
    await click(byLabel(tree, /^9$/)[0]);
    await click(byLabel(tree, /Register — size 9/)[0]);
    expect(registerDisplayRow).toHaveBeenCalledTimes(1);
    expect(registerDisplayRow.mock.calls[0][0]).toMatchObject({ size: "9", store: "marathon-pe", bookedHub: "hub1" });
    expect(textOf(tree)).toContain("No stock moved");
  });

  it("NOT ON THE WALL raises an ordinary display request and names the order", async () => {
    const tree = paintWall();
    await click(byLabel(tree, /Not on the wall — request a display/)[0]);
    expect(raiseDisplayRequest).toHaveBeenCalledTimes(1);
    expect(raiseDisplayRequest.mock.calls[0][0].store).toBe("marathon-pe");
    // No size is passed anywhere near the request.
    expect(raiseDisplayRequest.mock.calls[0][0]).not.toHaveProperty("size");
    expect(textOf(tree)).toContain("#042");
  });

  it("a request that is already open is refused, not doubled", async () => {
    raiseDisplayRequest.mockImplementation(async () => ({ ok: false, already: true, message: "already on its way" }));
    const tree = paintWall();
    await click(byLabel(tree, /Not on the wall/)[0]);
    expect(textOf(tree)).toContain("already on its way");
  });

  it("searches and filters by brand", () => {
    const tree = paintWall();
    const input = tree.root.findAll((n) => n.type === "input")[0];
    act(() => { input.props.onChange({ target: { value: "gripshot" } }); });
    expect(textOf(tree)).not.toContain("Air Force 1 White");
    act(() => { input.props.onChange({ target: { value: "" } }); });
    act(() => { byLabel(tree, /^Nike$/)[0].props.onClick(); });
    expect(textOf(tree)).not.toContain("Lacoste Gripshot");
  });

  it("the empty state states plainly what it cannot see", () => {
    CELLS = {};
    const t = textOf(paintWall());
    expect(t).toContain("What it cannot see");
    expect(t).toContain("stock has run out");
    expect(t).toContain("cannot tell you which of these is actually on the wall");
  });

  it("Pine is not offered — its displays are booked at a hub this screen does not serve", () => {
    const tree = paintWall();
    expect(byLabel(tree, /Pine/)).toHaveLength(0);
  });
});


// ── THE RETURNED DISPLAY — the case that had no screen at all ───────────────
describe("Unregistered Displays — a wall that already has a record", () => {
  beforeEach(() => { CELLS = { p1: { 9: { qty: 2 } }, p2: { 8: { qty: 1 } } }; });

  const search = (tree, q) => {
    const input = tree.root.findAll((n) => n.type === "input")[0];
    act(() => { input.props.onChange({ target: { value: q } }); });
  };

  it("a search reaches a product with ONE open row, which no other screen lists", () => {
    ROWS = ledger(row({ store: "marathon-pe" }));
    const tree = paintWall();
    // Not in the walk list — it HAS a record.
    expect(textOf(tree)).not.toContain("Already on");
    search(tree, "air force");
    // The heading is JSX children, so assert on the rendered TEXT, not on the
    // JSON of the tree — interpolated pieces are separate children there.
    const heading = tree.root.findAll((n) => n.type === "div")
      .map(textIn).find((t) => t.startsWith("Already on"));
    expect(heading).toContain("Marathon PE");
    expect(heading).toContain("1 match");
    expect(byLabel(tree, /Not on the wall any more/)).toHaveLength(1);
  });

  it("closing it records `returned` and moves no stock", async () => {
    ROWS = ledger(row({ store: "marathon-pe" }));
    const tree = paintWall();
    search(tree, "air force");
    await click(byLabel(tree, /Not on the wall any more/)[0]);
    expect(closeDisplayRow).toHaveBeenCalledTimes(1);
    expect(closeDisplayRow.mock.calls[0][0].reason).toBe("returned");
    expect(textOf(tree)).toContain("No stock moved");
  });

  it("a WRONG SIZE is corrected by registering the real one — the old row is replaced", async () => {
    ROWS = ledger(row({ store: "marathon-pe", size: "9", sizeKey: "9" }));
    const tree = paintWall();
    search(tree, "air force");
    await click(byLabel(tree, /A different size is on the wall/)[0]);
    expect(byLabel(tree, /Pick a size/)[0].props.disabled).toBe(true);   // still nothing preselected
    await click(byLabel(tree, /^10$/)[0]);
    await click(byLabel(tree, /Register — size 10/)[0]);
    expect(registerDisplayRow).toHaveBeenCalledTimes(1);
    // keepOpen falsy → the old row is closed as `replaced` by the same plan.
    expect(registerDisplayRow.mock.calls[0][0].keepOpen).toBeFalsy();
    expect(registerDisplayRow.mock.calls[0][0].size).toBe("10");
  });

  it("a wall with TWO records offers no close here — that is the Duplicate tab's job", () => {
    ROWS = ledger(row({ store: "marathon-pe", rowId: "a" }),
                  row({ store: "marathon-pe", rowId: "b", size: "10", sizeKey: "10" }));
    const tree = paintWall();
    search(tree, "air force");
    expect(byLabel(tree, /Not on the wall any more/)).toHaveLength(0);
    expect(textOf(tree)).toContain("sort that out on Duplicate Displays");
  });
});
