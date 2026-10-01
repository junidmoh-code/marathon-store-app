// Behavioural coverage for the strip itself, rather than a source pin on the
// line that renders it. Extracting the component out of App.jsx was worth doing
// for exactly this: the reviewers were right that a pin proves a line has not
// moved and nothing about what a shop assistant sees.
//
// What is actually at stake on this surface: that an empty result renders
// NOTHING (no section header, no "no matches" row — the sheet has to fall back
// to the bare refusal), that every fact the assistant reads out is on the card,
// and that tapping one hands back the row it was given.
import { test, expect, vi } from "vitest";
import { create, act } from "react-test-renderer";
import AlternativesStrip from "./AlternativesStrip.jsx";

const ROW = (over = {}) => ({
  product: { id: "p1", name: "Nubuck low-top in navy", retailPrice: 1200, photoUrl: "https://x/p1.jpg" },
  sizes: ["7", "8", "9.5"],
  why: "Same shape and colour",
  code: "s",
  hasRequestedSize: true,
  hubLabel: "Hub 2",
  ...over,
});
const render = (props) => {
  let tree;
  act(() => { tree = create(<AlternativesStrip requestedSize="8" onPick={() => {}} {...props} />); });
  return tree;
};
// The rendered text with React's per-child splits flattened. react-test-renderer
// keeps `{"Size "}{"8"}` as two children, so a naive JSON.stringify cannot find
// "Size 8" — and en-ZA formats R1200 with a NARROW NO-BREAK SPACE, not a comma
// (which is correct for this shop and wrong in my first draft of this test).
const textOf = (tree) => {
  const out = [];
  const walk = (n) => {
    if (n === null || n === undefined) return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.props) for (const [k, v] of Object.entries(n.props)) if (typeof v === "string") out.push(v);
    walk(n.children);
  };
  walk(tree.toJSON());
  // Joined with NOTHING: React keeps `{"Size "}{"8"}` as two children, so any
  // separator here would break the very string this file needs to find.
  return out.join("");
};
// R1 200 in en-ZA — the space is U+00A0/U+202F, not an ASCII one.
const money = (n) => "R" + Number(n).toLocaleString("en-ZA", { maximumFractionDigits: 0 });

// THE RULE THAT MATTERS MOST ON THIS SURFACE.
test("renders NOTHING at all when there is nothing sellable", () => {
  for (const rows of [[], null, undefined]) {
    expect(render({ rows }).toJSON(), String(rows)).toBe(null);
  }
});

test("every fact the assistant reads out is on the card", () => {
  const text = textOf(render({ rows: [ROW()] }));
  expect(text).toContain("Nubuck low-top in navy");     // the product
  expect(text).toContain(money(1200));                  // the price, in en-ZA
  expect(text).toContain("https://x/p1.jpg");           // the photo
  expect(text).toContain("Same shape and colour");      // why it matched
  expect(text).toContain("Hub 2");                      // which shelf it comes off
});

// Printed in full, not counted: "3 sizes" makes the assistant tap to find out
// whether any of them is the one in front of them.
test("the available sizes are printed, every one of them", () => {
  const text = textOf(render({ rows: [ROW()] }));
  for (const s of ["7", "8", "9.5"]) expect(text).toContain(s);
  expect(text).not.toContain("3 sizes");
});

test("one size is rendered as a word, not as the raw sentinel", () => {
  const text = textOf(render({ rows: [ROW({ sizes: ["Free Size"] })] }));
  expect(text).toContain("OS");
  expect(text).not.toContain("Free Size");
});

// The one fact that decides whether the row is the answer or a near miss.
test("the customer's own size is called out — and only when the shoe has it", () => {
  expect(textOf(render({ rows: [ROW({ hasRequestedSize: true })] }))).toContain("Size 8");
  expect(textOf(render({ rows: [ROW({ hasRequestedSize: false })] }))).not.toContain("Size 8");
});

test("shows every row it is given, in the order it is given them", () => {
  const rows = [ROW({ product: { id: "a", name: "AAA", retailPrice: 700, photoUrl: "u" } }),
                ROW({ product: { id: "b", name: "BBB", retailPrice: 800, photoUrl: "u" } })];
  const tree = render({ rows });
  const buttons = tree.root.findAllByType("button");
  expect(buttons).toHaveLength(2);
  const text = textOf(tree);
  expect(text.indexOf("AAA")).toBeLessThan(text.indexOf("BBB"));
});

test("tapping a card hands back the row it was given, untouched", () => {
  const onPick = vi.fn();
  const row = ROW();
  const tree = render({ rows: [row], onPick });
  act(() => { tree.root.findAllByType("button")[0].props.onClick(); });
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick.mock.calls[0][0]).toBe(row);
});

// A wrapped grid would push the size picker and the Add button off a phone
// screen, and the picker is what the assistant came here for.
test("it is one horizontally scrolled row, never a wrapping grid", () => {
  const tree = render({ rows: [ROW(), ROW({ product: { id: "p2", name: "B", retailPrice: 700, photoUrl: "u" } })] });
  const scroller = tree.root.findAll((n) => n.props?.style?.overflowX === "auto");
  expect(scroller.length).toBe(1);
  expect(scroller[0].props.style.display).toBe("flex");
  expect(scroller[0].props.style.flexWrap).toBeUndefined();
});

test("a missing hub label leaves no dangling separator", () => {
  const text = textOf(render({ rows: [ROW({ hubLabel: "" })] }));
  expect(text).toContain("Same shape and colour");
  expect(text).not.toContain("colour ·");
});

test("the compact variant still renders every fact", () => {
  const text = textOf(render({ rows: [ROW()], compact: true }));
  expect(text).toContain("Nubuck low-top in navy");
  expect(text).toContain(money(1200));
});
