// ─── DISPLAY REGISTRATION — THROUGH THE REAL COMPONENT ───────────────────────
// The smoke test that was missing when a dangling `searchRef` shipped a
// ReferenceError to production (CodeRabbit, PR #460): the whole route died on
// first render and no unit test noticed, because nothing MOUNTED the view.
// This renders the real component end-to-end over faked data: search → pick →
// facts list → register panel. If any identifier in the render path is
// undefined, this fails.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } }, functions: { fake: true } }));
vi.mock("firebase/database", () => ({
  ref: () => ({}), get: async () => ({ val: () => null }), update: async () => {}, runTransaction: async () => ({ committed: true, snapshot: { val: () => null } }),
  onValue: () => () => {}, child: () => ({}),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));
vi.mock("./useStock", () => ({
  useDisplaySlots: () => ({ "marathon-pe": { p1: { size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration" } } }),
  useDisplayRegister: () => ({ p1__6: { productId: "p1", size: "6", sizeKey: "6", qty: 1 } }),
}));

const { default: DisplayRegistrationView } = await import("./DisplayRegistrationView.jsx");

const PRODUCTS = [
  { id: "p1", name: "Nike Dunk Low Panda", category: "Footwear", sizes: ["6", "7", "8"] },
  { id: "p2", name: "Air Max 95", category: "Footwear", sizes: ["7", "8"] },
  // NOT footwear — must never surface in this lane (owner: sneakers only).
  { id: "p3", name: "Dunk Hill Perfume", categoryKey: "perfumes", sizes: [] },
];

const text = (tree) => JSON.stringify(tree.toJSON());
const findInput = (root) => root.root.findAllByType("input")[0];
// Text of one rendered instance: walk its children collecting strings only
// (instances are circular; JSON.stringify chokes on fibers).
const instText = (inst) => {
  if (typeof inst === "string") return inst;
  const kids = inst?.children || [];
  return kids.map(instText).join("");
};
const buttonWith = (tree, needle) =>
  tree.root.findAllByType("button").find((b) => instText(b).includes(needle));

describe("DisplayRegistrationView renders and walks the lane", () => {
  it("mounts, searches, picks a product, and shows facts + register panel", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<DisplayRegistrationView products={PRODUCTS} onExit={() => {}} />); });
    expect(text(tree)).toContain("Display Registration");

    await act(async () => { findInput(tree).props.onChange({ target: { value: "dunk" } }); });
    expect(text(tree)).toContain("Nike Dunk Low Panda");
    expect(text(tree)).not.toContain("Dunk Hill Perfume");   // sneakers only — non-footwear never surfaces

    const resultBtn = buttonWith(tree, "Nike Dunk Low Panda");
    await act(async () => { resultBtn.props.onClick(); });

    const body = text(tree);
    expect(body).toContain("display records");                      // product panel
    expect(body).toContain("on Marathon PE");                        // the slot-backed fact with its store
    expect(body).toContain("WHICH SIZE WENT ON THE WALL?");          // register panel
    expect(body).toContain("Change size");
  });

  it("the register button demands a size and names the store once picked", async () => {
    let tree;
    await act(async () => { tree = TestRenderer.create(<DisplayRegistrationView products={PRODUCTS} onExit={() => {}} />); });
    await act(async () => { findInput(tree).props.onChange({ target: { value: "air max" } }); });
    const resultBtn = buttonWith(tree, "Air Max 95");
    await act(async () => { resultBtn.props.onClick(); });
    expect(text(tree)).toContain("Pick a size");
    const size7 = tree.root.findAllByType("button").find((b) => instText(b) === "7");
    await act(async () => { size7.props.onClick(); });
    expect(text(tree)).toContain("Register size 7 on Marathon PE");   // store preselected + named
  });
});
