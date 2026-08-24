// ─── THE COUNTED TAB'S CARRIAGE VIEW, RENDERED FOR REAL ──────────────────────
// The pure tests pin the guards; these pin the WIRING, which is where the
// original bug actually lived. A product seeded at the wrong shop was
// unfixable not because any rule forbade it but because one filter line
// (`if (!countedSizes.length) continue`) meant the only screen that could show
// the claim never did. So the claims here are all "the screen shows it, and the
// button reaches the right writer":
//
//   1. THE COUNTING VIEW IS UNCHANGED. A seated-but-empty product does NOT
//      appear among the counted rows — that regression would flood the count.
//   2. THE SEATED VIEW SHOWS IT, with the location that holds the empty claim.
//   3. UNSEAT PREVIEWS BEFORE IT DELETES — the confirm reads the engine's open
//      locks and prints the sizes it would remove.
//   4. UNSEAT REACHES THE WRITER with the exact location and product of the row.
//   5. A ROW HOLDING STOCK IS NEVER OFFERED UNSEAT — the honest action there is
//      Move or Clear.
//   6. MOVE CARRIES THE SEATING BY DEFAULT — the checkbox is ticked, so the
//      default gesture is a relocation and not the copy the old Move performed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// ── The write boundary, captured ────────────────────────────────────────────
const unseatCarriage = vi.fn(async () => ({ ok: true, gone: ["M", "L"], kept: [] }));
const moveCarriage = vi.fn(async () => ({ ok: true, moved: 3, seeded: [], gone: ["M"], kept: [] }));
const openLocksFor = vi.fn(async () => ({}));

vi.mock("./carriageStore", () => ({
  unseatCarriage: (...a) => unseatCarriage(...a),
  moveCarriage: (...a) => moveCarriage(...a),
  openLocksFor: (...a) => openLocksFor(...a),
}));
vi.mock("./applyMovement", () => ({ applyMovement: async () => ({ ok: true }) }));

// /stock as the component reads it: { loc: { pid: { size: cell } } }.
//   pSeated — carried at Marathon PE with nothing behind it, stock is at Trophy.
//   pStocked — a plain counted row, the view this tab has always shown.
let STOCK = {};
vi.mock("./useStock", () => ({ useStockCells: () => STOCK }));

import CountedStockReview from "./CountedStockReview";

const PRODUCTS = [
  { id: "pSeated", name: "Essentials Tracksuit Black", sizes: ["M", "L"], productType: "clothing" },
  { id: "pStocked", name: "Lacoste Tracksuit Light Grey", sizes: ["M"], productType: "clothing" },
];
const REGISTRY = {
  "marathon-pe": { id: "marathon-pe", label: "Marathon PE", kind: "store", sellable: true, active: true },
  trophy: { id: "trophy", label: "Trophy", kind: "store", sellable: true, active: true },
};

const render = () => {
  let tree;
  act(() => { tree = TestRenderer.create(<CountedStockReview products={PRODUCTS} registry={REGISTRY} actorRole="admin" />); });
  return tree;
};

// Every string the tree renders, flattened — enough to ask "does the screen say this".
const text = (tree) => JSON.stringify(tree.toJSON());
const buttonsSaying = (tree, label) =>
  tree.root.findAll((n) => n.type === "button" && JSON.stringify(n.props.children || "").includes(label));

// Map-backed localStorage stub — the runner is the node environment (no jsdom),
// so the component's persisted-filter reads hit this. Fresh per test, so no
// test inherits another's remembered view.
function installStorage() {
  const m = new Map();
  // "All locations" as the remembered filter — the component otherwise opens on
  // Marathon PE (its counting default) and these tests are about the carriage
  // split, not about which location a returning user last looked at.
  m.set("countedLoc", "all");
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installStorage();
  STOCK = {
    "marathon-pe": { pSeated: { M: { qty: 0, v: 0, mv: "seed" }, L: { qty: 0, v: 0, mv: "seed" } } },
    trophy: { pStocked: { M: { qty: 3, v: 2, mv: "mv_7" } } },
  };
});

describe("the counting view is unchanged", () => {
  it("a seated-but-empty product is not listed among the counted rows", () => {
    const t = render();
    expect(text(t)).toContain("Lacoste Tracksuit Light Grey");
    expect(text(t)).not.toContain("Essentials Tracksuit Black");
  });

  it("and it is not offered an Unseat button there either", () => {
    expect(buttonsSaying(render(), "Unseat")).toHaveLength(0);
  });
});

describe("the seated view", () => {
  const openSeated = () => {
    const t = render();
    act(() => { buttonsSaying(t, "Seated, no stock")[0].props.onClick(); });
    return t;
  };

  it("shows the claim, its location, and an Unseat button", () => {
    const t = openSeated();
    const s = text(t);
    expect(s).toContain("Essentials Tracksuit Black");
    expect(s).toContain("Marathon PE");
    expect(s).toContain("seated, no stock");
    expect(buttonsSaying(t, "Unseat").length).toBeGreaterThan(0);
  });

  it("and hides the rows that do hold stock — they are the other view", () => {
    expect(text(openSeated())).not.toContain("Lacoste Tracksuit Light Grey");
  });

  it("counts the claims in the toggle so the size of the mess is visible up front", () => {
    expect(text(render())).toContain("Seated, no stock (1)");
  });

  it("previews the sizes it would remove before deleting anything", async () => {
    const t = openSeated();
    await act(async () => { buttonsSaying(t, "Unseat")[0].props.onClick(); });
    expect(openLocksFor).toHaveBeenCalledWith("marathon-pe", "pSeated");
    expect(text(t)).toContain("empty size cell(s) removed");
    expect(unseatCarriage).not.toHaveBeenCalled();          // preview only — nothing written yet
  });

  it("refuses in the panel when the engine holds an open refill", async () => {
    openLocksFor.mockResolvedValueOnce({ M: { orderId: "ORD-7" } });
    const t = openSeated();
    await act(async () => { buttonsSaying(t, "Unseat")[0].props.onClick(); });
    expect(text(t)).toContain("ORD-7");
    // The confirm button is present but disabled — the refusal is readable, not
    // a button that fails when tapped.
    const confirm = buttonsSaying(t, "Unseat").at(-1);
    expect(confirm.props.disabled).toBe(true);
  });

  it("unseats the exact location and product of the row", async () => {
    const t = openSeated();
    await act(async () => { buttonsSaying(t, "Unseat")[0].props.onClick(); });
    await act(async () => { buttonsSaying(t, "Unseat").at(-1).props.onClick(); });
    expect(unseatCarriage).toHaveBeenCalledWith(expect.objectContaining({ loc: "marathon-pe", pid: "pSeated" }));
  });
});

describe("move carries the seating by default", () => {
  it("the checkbox is ticked when the panel opens", () => {
    const t = render();
    act(() => { buttonsSaying(t, "Move")[0].props.onClick(); });
    const boxes = t.root.findAll((n) => n.type === "input" && n.props.type === "checkbox");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].props.checked).toBe(true);
  });

  it("and the move reaches the writer with moveSeating on", async () => {
    const t = render();
    act(() => { buttonsSaying(t, "Move")[0].props.onClick(); });
    const picker = t.root.findAll((n) => n.type === "select")[0];
    act(() => { picker.props.onChange({ target: { value: "marathon-pe" } }); });
    await act(async () => { buttonsSaying(t, "Move").at(-1).props.onClick(); });
    expect(moveCarriage).toHaveBeenCalledWith(expect.objectContaining({
      loc: "trophy", pid: "pStocked", to: "marathon-pe", moveSeating: true,
    }));
  });

  // A carried-only product used to dead-end here: the old Move only sent
  // positive quantities, found none, and reported "nothing to move".
  it("a seated-but-empty product can still be moved — there is a claim to carry", () => {
    const t = render();
    act(() => { buttonsSaying(t, "Seated, no stock")[0].props.onClick(); });
    act(() => { buttonsSaying(t, "Move")[0].props.onClick(); });
    expect(text(t)).toContain("Move the seating");
  });
});
