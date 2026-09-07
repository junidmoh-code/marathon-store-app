// Behavioural coverage for the Display Records tab. The classification is
// proven in displayRecordCleanup.test.js; these pin what only the SCREEN can
// get wrong — what it offers a button for, what it writes, and that it can
// never clear a display slot.
//
// The asymmetry the whole screen is shaped around: retiring a GHOST fixes a
// false discrepancy, retiring a REAL display makes the next count expect a pair
// that is genuinely out at a shop and adjust a real unit away. So "has no
// button" is as much a behaviour worth pinning as "writes the right thing".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { create, act } from "react-test-renderer";
import { readFileSync } from "fs";

const removeDisplayFact = vi.fn(async () => ({ ok: true }));
let SLOTS = {};
let REGISTER = {};

vi.mock("./displayRegistrationStore", () => ({ removeDisplayFact: (...a) => removeDisplayFact(...a) }));
vi.mock("./useStock", () => ({
  useDisplaySlots: () => SLOTS,
  useDisplayRegister: () => REGISTER,
}));

const DisplayRecordsTab = (await import("./DisplayRecordsTab")).default;

const PRODUCTS = [
  { id: "p1", name: "Air Force 1 White", category: "Footwear", productType: "sneaker" },
  { id: "p2", name: "Lacoste Gripshot", category: "Footwear", productType: "sneaker" },
];
const liveSlot = (over = {}) => ({ size: "6", sizeKey: "6", bookedHub: "hub1", source: "registration", at: "2026-09-01T08:00:00.000Z", ...over });

beforeEach(() => {
  removeDisplayFact.mockClear();
  removeDisplayFact.mockImplementation(async () => ({ ok: true }));
  SLOTS = {}; REGISTER = {};
});

const paint = (props = {}) => {
  let tree;
  act(() => { tree = create(<DisplayRecordsTab products={PRODUCTS} isAdmin {...props} />); });
  return tree;
};
const textOf = (tree) => JSON.stringify(tree.toJSON());
const buttons = (tree) => tree.root.findAll((n) => n.type === "button", { deep: true });
// react-test-renderer test instances: .children is a mix of strings and more
// instances, so the label of a button with nested spans needs a real walk.
const textIn = (node) => {
  if (typeof node === "string") return node;
  if (!node || !node.children) return "";
  return node.children.map(textIn).join("");
};
const byLabel = (tree, re) => buttons(tree).filter((b) => re.test(textIn(b)));
const click = async (b) => { await act(async () => { await b.props.onClick(); }); };
// The unknown-shop and confirmed sections are collapsed by default — 582 rows
// live, and the point of the screen is what it will ACT on.
const expand = async (tree, title) => { await click(byLabel(tree, new RegExp(title))[0]); };

describe("what the screen offers", () => {
  it("a REPLACED row gets a Retire button and names the size now on the floor", () => {
    REGISTER = { p1__6: { qty: 1, at: "2026-08-07T10:00:00.000Z" } };
    SLOTS = { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8", source: "display_refill" }) } };
    const t = paint();
    expect(textOf(t)).toContain("Air Force 1 White");
    expect(textOf(t)).toContain("now size 8");
    expect(byLabel(t, /^Retire$/)).toHaveLength(1);
  });

  it("A ROW WITH NO SHOP ON RECORD IS SHOWN AND HAS NO BUTTON", async () => {
    // No evidence is not evidence of absence. A button here counts a real
    // display away at the next stock-take.
    REGISTER = { p1__6: { qty: 1, at: "2026-08-07T10:00:00.000Z" } };
    SLOTS = {};
    const t = paint();
    expect(textOf(t)).toContain("No shop on record");
    expect(byLabel(t, /^Retire$/)).toHaveLength(0);
    expect(byLabel(t, /Retire all/)).toHaveLength(0);
    await expand(t, "No shop on record");           // collapsed by default — 582 rows live
    expect(textOf(t)).toContain("Air Force 1 White");
    expect(byLabel(t, /^Retire$/)).toHaveLength(0); // still no button once you can see them
  });

  it("a CONFIRMED row has no button either", async () => {
    REGISTER = { p1__6: { qty: 1 } };
    SLOTS = { "marathon-pe": { p1: liveSlot() } };
    const t = paint();
    expect(textOf(t)).toContain("Confirmed");
    await expand(t, "Confirmed");
    expect(textOf(t)).toContain("Air Force 1 White");
    expect(byLabel(t, /^Retire$/)).toHaveLength(0);
  });

  it("NOTHING IS ACTIONABLE WHILE THE CATALOGUE IS EMPTY — every pid would look deleted", () => {
    REGISTER = { p1__6: { qty: 1 }, p2__7: { qty: 1 } };
    SLOTS = {};
    const t = paint({ products: [] });
    expect(byLabel(t, /^Retire$/)).toHaveLength(0);
    expect(byLabel(t, /Retire all/)).toHaveLength(0);
  });

  it("a non-admin is refused outright", () => {
    REGISTER = { p1__6: { qty: 1 } };
    const t = paint({ isAdmin: false });
    expect(textOf(t)).toContain("admin-only");
    expect(byLabel(t, /Retire/)).toHaveLength(0);
  });
});

describe("what the screen writes", () => {
  it("retires through removeDisplayFact after a confirm, and NEVER passes a slot store", async () => {
    REGISTER = { p1__6: { qty: 1 } };
    SLOTS = { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }) } };
    const t = paint();
    await click(byLabel(t, /^Retire$/)[0]);
    // one tap only ARMS it — the effect is spelled out before anything is written
    expect(removeDisplayFact).not.toHaveBeenCalled();
    expect(textOf(t)).toContain("No stock moves");
    await click(byLabel(t, /^Confirm$/)[0]);
    expect(removeDisplayFact).toHaveBeenCalledTimes(1);
    expect(removeDisplayFact).toHaveBeenCalledWith({
      hub: "hub1", product: { id: "p1", name: "Air Force 1 White" }, sizeKey: "6", slotStores: [],
    });
  });

  it("an OVER-registered row retires ONLY its surplus — one call per unit", async () => {
    REGISTER = { p1__6: { qty: 3 } };
    SLOTS = { "marathon-pe": { p1: liveSlot() } };
    const t = paint();
    await click(byLabel(t, /^Retire$/)[0]);
    await click(byLabel(t, /^Confirm$/)[0]);
    expect(removeDisplayFact).toHaveBeenCalledTimes(2);   // 3 claimed − 1 floor
  });

  it("a failed write says so and leaves the row still offered", async () => {
    REGISTER = { p1__6: { qty: 1 } };
    SLOTS = { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }) } };
    removeDisplayFact.mockImplementation(async () => ({ ok: false, message: "permission denied" }));
    const t = paint();
    await click(byLabel(t, /^Retire$/)[0]);
    await click(byLabel(t, /^Confirm$/)[0]);
    expect(textOf(t)).toContain("permission denied");
    // still armed, so a retry is one tap — the row is NOT marked done
    expect(byLabel(t, /^Confirm$/)).toHaveLength(1);
  });

  it("BULK STOPS AT THE FIRST FAILURE instead of hammering a broken write", async () => {
    REGISTER = { p1__6: { qty: 1 }, p2__7: { qty: 1 } };
    SLOTS = { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }), p2: liveSlot({ size: "9", sizeKey: "9" }) } };
    let n = 0;
    removeDisplayFact.mockImplementation(async () => (++n === 1 ? { ok: true } : { ok: false, message: "boom" }));
    const t = paint();
    await click(byLabel(t, /Retire all 2/)[0]);
    await click(byLabel(t, /Yes, retire them/)[0]);
    expect(textOf(t)).toContain("Retired 1, then stopped at a failure");
    expect(removeDisplayFact).toHaveBeenCalledTimes(2);
  });

  it("the bulk button counts ONLY contradicted rows, never the unknown-shop ones", () => {
    REGISTER = { p1__6: { qty: 1 }, p2__7: { qty: 1 } };
    SLOTS = { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }) } };   // p2 has no slot at all
    const t = paint();
    expect(byLabel(t, /Retire all 1 contradicted record/)).toHaveLength(1);
  });

  it("bulk needs its own confirm, and that confirm says no stock moves", async () => {
    REGISTER = { p1__6: { qty: 1 } };
    SLOTS = { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }) } };
    const t = paint();
    await click(byLabel(t, /Retire all 1/)[0]);
    expect(removeDisplayFact).not.toHaveBeenCalled();
    expect(textOf(t)).toContain("No stock moves.");
    expect(textOf(t)).toContain("Nothing with an unknown shop");
  });

  it("a retired row leaves the list and the bulk count drops with it", async () => {
    REGISTER = { p1__6: { qty: 1 }, p2__7: { qty: 1 } };
    SLOTS = { "marathon-pe": { p1: liveSlot({ size: "8", sizeKey: "8" }), p2: liveSlot({ size: "9", sizeKey: "9" }) } };
    const t = paint();
    expect(byLabel(t, /Retire all 2/)).toHaveLength(1);
    await click(byLabel(t, /^Retire$/)[0]);
    await click(byLabel(t, /^Confirm$/)[0]);
    expect(byLabel(t, /^Retire$/)).toHaveLength(1);
    expect(byLabel(t, /Retire all 1/)).toHaveLength(1);
  });
});

describe("the screen never writes a slot", () => {
  it("names no slot writer and no movement writer at all", () => {
    const src = readFileSync(new URL("./DisplayRecordsTab.jsx", import.meta.url), "utf8");
    // Clearing a REPLACED row's live slot would erase the CURRENT display and
    // re-create the duplicate-marker bug PR #574 closed.
    expect(src).not.toMatch(/setDisplaySlot|clearDisplaySlot/);
    expect(src).not.toMatch(/applyMovement|runTransaction/);
    expect((src.match(/removeDisplayFact/g) || []).length).toBeGreaterThan(0);
  });
});
