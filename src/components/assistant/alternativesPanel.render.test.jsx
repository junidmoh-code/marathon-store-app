// ─── ALTERNATIVES PANEL — rendered: the wall's language, Junid's item 7 ──────
// Proves:
//   1. the grid wraps and never scrolls sideways — 6 columns, 5 under 1400px,
//      minmax(0,1fr) tracks, overflow-x hidden — and draws at most 18 tiles in
//      the ranking's order (nothing re-sorted here)
//   2. every tile carries the requested-size pill and nothing else at rest
//   3. a tile tap opens the SAME overlay as the wall; an available size adds
//      through quickAdd and closes the panel (onAdded); Back returns
//   4. an empty answer says so; a null answer draws nothing
//   5. the quiet line is one grey sentence naming what was checked
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("../../offline/MirroredImg.jsx", () => ({
  MirroredImg: ({ productId, src, ...rest }) => <img src={src} data-pid={productId} {...rest} />,
}));
vi.mock("../stock/locations", () => ({ labelFor: (id) => id }));

const { default: AlternativesPanel, quietBlockLine, ALT_PANEL_MAX } = await import("./AlternativesPanel.jsx");

const shoe = (i) => ({ id: `p${i}`, name: `Shoe ${i}`, retailPrice: 900 + i, sizes: ["6", "7", "8"], photoUrl: `https://x/${i}.jpg` });
const rows = (n) => Array.from({ length: n }, (_, i) => ({ product: shoe(i), matchedSize: "7", hasRequestedSize: true, sizes: ["6", "7", "8"], why: "Same model", tier: "a" }));
const gate = { clothingOrder: false, hubQty: () => 0, sneakerOut: (p, sz) => sz === "8", sneakerOutWhy: () => null,
  sneakerDisplayInfo: () => null, deadForOrder: () => false, hubLabelFor: () => "Hub 1" };
const textIn = (n) => (typeof n === "string" ? n : (n.children || []).map(textIn).join(""));

function mount(props) {
  let tr;
  act(() => { tr = TestRenderer.create(<AlternativesPanel requestedSize="7" sizeGate={gate} onQuickAdd={() => 1} {...props} />); });
  return tr;
}
const tiles = (tr) => tr.root.findAll(n => n.type === "button" && n.props.className === "alt-tile");

describe("the grid", () => {
  it("wraps in fixed columns and never scrolls sideways", () => {
    const src = readFileSync(new URL("./AlternativesPanel.jsx", import.meta.url), "utf8");
    expect(src).toMatch(/\.alt-scroll\{[^}]*overflow-y:auto;overflow-x:hidden/);
    expect(src).toMatch(/\.alt-grid\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\);gap:10px\}/);
    expect(src).toMatch(/@media\(max-width:1399px\)\{\.alt-grid\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)\}\}/);
    expect(src).toMatch(/\.alt-tile\{[^}]*aspect-ratio:5\/4;border-radius:14px/);
    // No flex row, no fixed card width — the two things that made the old
    // strip scroll sideways and clip its last card.
    expect(src).not.toMatch(/flex: `0 0|overflowX: "auto"/);
  });
  it("draws at most 18, in the ranking's order", () => {
    const tr = mount({ rows: rows(25) });
    expect(ALT_PANEL_MAX).toBe(18);
    expect(tiles(tr).map(t => t.props["aria-label"].split(",")[0])).toEqual(rows(18).map(r => r.product.name));
  });
  it("each tile carries the requested-size pill and no name or price", () => {
    const tr = mount({ rows: rows(3) });
    for (const t of tiles(tr)) {
      const pill = t.find(n => n.props.className === "alt-sz");
      expect(textIn(pill)).toBe("7");
      expect(textIn(t)).toBe("7");          // nothing else drawn as text
    }
  });
  it("null draws nothing; [] says nothing in that size is available", () => {
    expect(tiles(mount({ rows: null }))).toHaveLength(0);
    const tr = mount({ rows: [] });
    expect(textIn(tr.root.find(n => n.props.className === "alt-none"))).toContain("Nothing in size 7 is available");
  });
});

describe("tap → the wall's overlay → add closes", () => {
  it("opens the details in place of the grid; an available size adds and closes; Back returns", () => {
    const onQuickAdd = vi.fn(() => 1);
    const onAdded = vi.fn();
    const onPicked = vi.fn();
    const tr = mount({ rows: rows(4), onQuickAdd, onAdded, onPicked });
    act(() => { tiles(tr)[2].props.onClick(); });
    expect(onPicked).toHaveBeenCalledTimes(1);
    expect(tiles(tr)).toHaveLength(0);                       // the grid is replaced
    const detail = tr.root.find(n => n.props["data-testid"] === "alt-detail");
    expect(textIn(detail)).toContain("Shoe 2");
    const pills = detail.findAll(n => n.type === "button" && /sw-sz/.test(n.props.className || ""));
    expect(pills.map(textIn)).toEqual(["6", "7", "8"]);
    const eight = pills[2];
    expect(eight.props.disabled).toBe(true);                 // out, and no panel-in-panel
    act(() => { pills[1].props.onClick({ currentTarget: { classList: { add() {}, remove() {} } } }); });
    expect(onQuickAdd).toHaveBeenCalledWith(rows(4)[2].product, "7", 1);
    expect(onAdded).toHaveBeenCalledTimes(1);
    act(() => { tr.root.find(n => n.type === "button" && n.props.className === "sw-back").props.onClick(); });
    expect(tiles(tr)).toHaveLength(4);
  });
  it("a refused add does not close the panel", () => {
    const onAdded = vi.fn();
    const tr = mount({ rows: rows(2), onQuickAdd: () => 0, onAdded });
    act(() => { tiles(tr)[0].props.onClick(); });
    const p6 = tr.root.findAll(n => n.type === "button" && n.props.className === "sw-sz")[0];
    act(() => { p6.props.onClick({ currentTarget: { classList: { add() {}, remove() {} } } }); });
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe("the quiet line", () => {
  it("is the short form of the refusal", () => {
    expect(quietBlockLine("7", { booked: 0, checkedBoth: true })).toBe("Size 7 not at Hub 1 or Hub 2 — these have it:");
    expect(quietBlockLine("7", { booked: 0, hubLabel: "Hub 2" })).toBe("Size 7 not at Hub 2 — these have it:");
    expect(quietBlockLine("7", { booked: 1, available: 0, hubLabel: "Hub 1" })).toContain("held for another customer's order");
    expect(quietBlockLine("7", null, false)).toContain("can be ordered again");
  });
});
