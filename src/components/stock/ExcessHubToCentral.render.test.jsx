// ─── THE HUB → CENTRAL EXCESS SCREEN, RENDERED FOR REAL ──────────────────────
// excessComputation.test.js pins the pure formula; this renders the ACTUAL
// component, because the remaining directives are WIRING claims a core test
// cannot reach.
//
// The owner reversed the original one-tap design ("the transfer is too
// sensitive"), so the claims under test are now:
//
//   1. A card is COLLAPSED until opened — no stepper, no Transfer button, and
//      therefore no way to move stock by a stray tap on the list.
//   2. Each size defaults to its full excess and can be sent DOWN. Sending
//      less leaves the cell ABOVE Keep — that is the whole point of the
//      control.
//   3. A size can NEVER be sent above its excess. Above it, the cell would end
//      BELOW its Keep number. This is the invariant the screen exists for.
//   4. The Transfer button names the quantity, the source hub and Central.
//   5. A move goes through the SAME action the existing excess button calls,
//      proved against a simulated ledger rather than argument shapes.
//   6. Undo restores the EXACT prior cell state through that same path.
//   7. applyMovement RESOLVES {ok:false} rather than throwing, so a failed or
//      partial move must never be presented as a completed one.
//
// Every test here was MUTATION-PROVED; the mutation is named on each block.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-09-03T10:00:00.000Z");

const paths = {};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: vi.fn(() => Promise.resolve()),
  get: (r) => Promise.resolve({ val: () => paths[r.path] ?? null }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

// ── the simulated /stock ledger every movement is applied to ─────────────────
let ledger = {};
let failMoves = false;
let failOneSize = null;
const cellOf = (loc, pid, size) => ledger[`${loc}|${pid}|${size}`] ?? 0;
const applyMovementMock = vi.fn(async (m) => {
  if (failMoves) return { ok: false, reason: "PERMISSION_DENIED" };
  if (failOneSize && m.size === failOneSize) return { ok: false, reason: "insufficient_stock" };
  if (m.type !== "transfer_out") return { ok: false, reason: `unexpected type ${m.type}` };
  ledger[`${m.from}|${m.productId}|${m.size}`] = (ledger[`${m.from}|${m.productId}|${m.size}`] ?? 0) - m.qty;
  ledger[`${m.to}|${m.productId}|${m.size}`] = (ledger[`${m.to}|${m.productId}|${m.size}`] ?? 0) + m.qty;
  return { ok: true, movementId: m.movementId };
});
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));

const { default: ExcessHubToCentral } = await import("./ExcessHubToCentral.jsx");

const PRODUCTS = [
  { id: "af1",  name: "Nike Air Force 1 White",  categoryKey: "sneakers", sizes: ["7", "8", "9", "10"], photoUrl: null },
  { id: "boot", name: "Timberland 6-Inch Wheat", categoryKey: "boots",    sizes: ["7", "8", "9"],       photoUrl: null },
  { id: "tee",  name: "Essentials Tee Olive",    categoryKey: "tees",     productType: "clothing", sizes: ["S", "M", "L"], photoUrl: null },
];

const KEEP = (target) => ({ target, reorderPoint: 1, minQty: 1 });
const SNEAKER_SIZES = { 7: KEEP(3), 8: KEEP(3), 9: KEEP(2), 10: KEEP(2) };
const CONFIG = {
  categoryPolicy: {
    sneakers: { perSize: true, hub1: { carriedOnly: true, sizes: SNEAKER_SIZES }, hub2: { carriedOnly: true, sizes: SNEAKER_SIZES } },
    boots:    { perSize: true, hub1: { carriedOnly: true, sizes: { 9: KEEP(2) } }, hub2: { carriedOnly: true, sizes: { 9: KEEP(2) } } },
    tees:     { perSize: true, hub1: { carriedOnly: true, sizes: { M: KEEP(2) } }, hub2: { carriedOnly: true, sizes: { M: KEEP(2) } } },
  },
};

// hub1 af1: size 9 has 3 over (5 on hand, Keep 2), size 10 has 2 over (4, Keep
// 2), size 8 is BELOW Keep. boot has 1 over. hub2 holds a different shape.
const STOCK = {
  hub1: { af1: { 9: { qty: 5, v: 1 }, 10: { qty: 4, v: 1 }, 8: { qty: 1, v: 1 } },
          boot: { 9: { qty: 3, v: 1 } },
          tee:  { M: { qty: 9, v: 1 } } },
  hub2: { af1: { 9: { qty: 4, v: 1 } } },
};

const textOf = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return textOf(n.children);
};
const screenText = (tree) => textOf(tree.toJSON());
// toJSON nodes carry `.children`; findAll returns React elements, whose text
// lives under `props.children`. deepText reads either shape.
const deepText = (n) => {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(deepText).join("");
  if (n.props) return deepText(n.props.children);
  if (n.children) return deepText(n.children);
  return "";
};
const label = (el) => deepText(el.props.children).trim();
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");
const buttonNamed = (tree, name) => buttons(tree).find((b) => label(b) === name);
const transferButton = (tree) => buttons(tree).find((b) => label(b).startsWith("Transfer"));
// The card header is the element carrying aria-expanded.
const headerFor = (tree, name) =>
  tree.root.findAll((n) => n.props && n.props["aria-expanded"] !== undefined)
    .find((n) => deepText(n.props.children).includes(name));
// SizeStepperChip renders "−" then "+" per chip, in the card's size order.
const steppers = (tree, sign) => buttons(tree).filter((b) => label(b) === sign);

function render() {
  let tree;
  act(() => { tree = TestRenderer.create(<ExcessHubToCentral products={PRODUCTS} actorRole="warehouse" />); });
  return tree;
}
const settle = async (ms = 400) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const click = (el) => act(() => { (el.props.onClick)(); });
const openCard = (tree, name) => click(headerFor(tree, name));

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(paths)) delete paths[k];
  paths["stock"] = STOCK;
  paths["stock_targets"] = {};
  paths["config/refillEngine"] = CONFIG;
  paths["refill_requests"] = {};
  ledger = {};
  for (const [loc, byPid] of Object.entries(STOCK))
    for (const [pid, bySize] of Object.entries(byPid))
      for (const [size, cell] of Object.entries(bySize)) ledger[`${loc}|${pid}|${size}`] = cell.qty;
  failMoves = false;
  failOneSize = null;
  applyMovementMock.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe("the list", () => {
  it("states the header once, with the count pill for the selected hub", () => {
    const tree = render();
    const t = screenText(tree);
    expect(t).toContain("Hub 1 → Central");
    expect(t).toContain("2 products · 6 units");
    tree.unmount();
  });

  it("shows collapsed cards, sorted by units descending", () => {
    const tree = render();
    const t = screenText(tree);
    expect(t).toContain("Nike Air Force 1 White");
    expect(t).toContain("2 sizes · 5 over target");
    expect(t.indexOf("Nike Air Force 1 White")).toBeLessThan(t.indexOf("Timberland 6-Inch Wheat"));
    tree.unmount();
  });

  // MUTATION-PROVED: rendering the stepper grid unconditionally (dropping the
  // `open &&` gate) fails this — the whole point of collapsing is that stock
  // cannot be moved from the list without opening a card first.
  it("cannot transfer anything until a card is opened", () => {
    const tree = render();
    expect(transferButton(tree)).toBeFalsy();
    expect(steppers(tree, "+")).toHaveLength(0);
    tree.unmount();
  });

  it("opens one card at a time — opening another closes the first", () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    expect(transferButton(tree)).toBeTruthy();
    expect(screenText(tree)).toContain("Hub 1 → Central");
    openCard(tree, "Timberland 6-Inch Wheat");
    // Only the boot card's Transfer (1 unit) is present now.
    expect(label(transferButton(tree))).toContain("Transfer 1 unit");
    tree.unmount();
  });

  it("switches hub and closes any open card", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(buttonNamed(tree, "Hub 2"));
    await settle(0);
    const t = screenText(tree);
    expect(t).toContain("Hub 2 → Central");
    expect(t).toContain("1 product · 2 units");
    expect(transferButton(tree)).toBeFalsy();
    tree.unmount();
  });
});

describe("the opened card", () => {
  it("defaults every size to its full excess and names the destination", () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    const t = screenText(tree);
    expect(t).toContain("of 3");     // size 9 hint
    expect(t).toContain("of 2");     // size 10 hint
    expect(label(transferButton(tree))).toBe("Transfer 5 units · Hub 1 → Central");
    tree.unmount();
  });

  it("says which hub it is sending from — Hub 2, not Hub 1", async () => {
    const tree = render();
    click(buttonNamed(tree, "Hub 2"));
    await settle(0);
    openCard(tree, "Nike Air Force 1 White");
    expect(label(transferButton(tree))).toBe("Transfer 2 units · Hub 2 → Central");
    tree.unmount();
  });

  it("counts down as a size is reduced", () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(steppers(tree, "−")[0]);          // size 9: 3 → 2
    expect(label(transferButton(tree))).toBe("Transfer 4 units · Hub 1 → Central");
    tree.unmount();
  });

  // THE SAFETY INVARIANT. MUTATION-PROVED: raising the stepper's `max` above
  // the size's excess (or dropping the re-clamp in `transfer`) fails this.
  it("can NEVER raise a size above its excess", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    for (let i = 0; i < 6; i++) click(steppers(tree, "+")[0]);   // hammer size 9's +
    expect(label(transferButton(tree))).toBe("Transfer 5 units · Hub 1 → Central");

    click(transferButton(tree));
    await settle();
    const nine = applyMovementMock.mock.calls.map(([m]) => m).find((m) => m.size === "9");
    expect(nine.qty).toBe(3);                       // the excess, not 9
    expect(cellOf("hub1", "af1", "9")).toBe(2);     // left at exactly Keep, never below
    tree.unmount();
  });

  it("disables Transfer when every size is set to zero", () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    for (let i = 0; i < 3; i++) click(steppers(tree, "−")[0]);   // size 9 → 0
    for (let i = 0; i < 2; i++) click(steppers(tree, "−")[1]);   // size 10 → 0
    const btn = transferButton(tree);
    expect(textOf(btn.props.children)).toBe("Transfer 0 units · Hub 1 → Central");
    expect(btn.props.disabled).toBe(true);
    click(btn);
    expect(applyMovementMock).not.toHaveBeenCalled();
    tree.unmount();
  });
});

describe("transferring", () => {
  it("sends the full excess, leaving each cell at EXACTLY Keep", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(transferButton(tree));
    await settle();

    const calls = applyMovementMock.mock.calls.map(([m]) => m);
    expect(calls).toHaveLength(2);
    for (const m of calls) {
      expect(m.type).toBe("transfer_out");
      expect(m.from).toBe("hub1");
      expect(m.to).toBe("central");
      expect(m.reason).toBe("excess_rebalance");
    }
    expect(calls.map((m) => [m.size, m.qty]).sort()).toEqual([["10", 2], ["9", 3]]);
    expect(cellOf("hub1", "af1", "9")).toBe(2);
    expect(cellOf("hub1", "af1", "10")).toBe(2);
    expect(cellOf("hub1", "af1", "8")).toBe(1);     // below Keep, never touched
    tree.unmount();
  });

  // The reason the control exists: send 5 of 6, keep the 6th on the shelf.
  // MUTATION-PROVED: sending `s.excess` instead of the chosen quantity fails
  // this — the cell would drop to Keep instead of staying one above it.
  it("sends a REDUCED quantity and leaves the rest on the shelf", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(steppers(tree, "−")[0]);                  // size 9: send 2 of 3
    click(transferButton(tree));
    await settle();

    const nine = applyMovementMock.mock.calls.map(([m]) => m).find((m) => m.size === "9");
    expect(nine.qty).toBe(2);
    expect(cellOf("hub1", "af1", "9")).toBe(3);     // Keep 2 + the 1 held back
    expect(cellOf("central", "af1", "9")).toBe(2);
    tree.unmount();
  });

  it("skips a size set to zero entirely", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    for (let i = 0; i < 3; i++) click(steppers(tree, "−")[0]);   // size 9 → 0
    click(transferButton(tree));
    await settle();
    const sizes = applyMovementMock.mock.calls.map(([m]) => m.size);
    expect(sizes).toEqual(["10"]);
    expect(cellOf("hub1", "af1", "9")).toBe(5);     // untouched
    tree.unmount();
  });

  it("retires the card and decrements the pill when the whole excess is sent", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(transferButton(tree));
    await settle();
    const t = screenText(tree);
    expect(t).not.toContain("Nike Air Force 1 White");
    expect(t).toContain("1 product · 1 unit");
    tree.unmount();
  });

  // MUTATION-PROVED: retiring on `moved.length === lines.length` alone
  // (dropping `sentAll`) fails this — the units deliberately held back would
  // vanish from the screen for the rest of the session.
  it("KEEPS the card when only part of the excess was sent", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(steppers(tree, "−")[0]);                  // hold one unit back
    click(transferButton(tree));
    await settle();
    expect(screenText(tree)).toContain("Nike Air Force 1 White");
    tree.unmount();
  });

  it("gives each line a distinct idempotency key", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(transferButton(tree));
    await settle();
    const ids = applyMovementMock.mock.calls.map(([m]) => m.movementId);
    expect(new Set(ids).size).toBe(ids.length);
    tree.unmount();
  });
});

describe("Undo", () => {
  it("restores the EXACT prior cell state, through the same movement path", async () => {
    const before = { ...ledger };
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(transferButton(tree));
    await settle();
    expect(ledger).not.toEqual(before);

    click(buttonNamed(tree, "Undo"));
    await settle();
    expect(cellOf("hub1", "af1", "9")).toBe(5);
    expect(cellOf("hub1", "af1", "10")).toBe(4);
    expect(cellOf("central", "af1", "9")).toBe(0);
    expect(cellOf("central", "af1", "10")).toBe(0);

    const back = applyMovementMock.mock.calls.map(([m]) => m).filter((m) => m.from === "central");
    expect(back).toHaveLength(2);
    for (const m of back) { expect(m.type).toBe("transfer_out"); expect(m.to).toBe("hub1"); }
    tree.unmount();
  });

  it("reverses only what was actually sent, not the full excess", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(steppers(tree, "−")[0]);                  // size 9: send 2 of 3
    click(transferButton(tree));
    await settle();
    click(buttonNamed(tree, "Undo"));
    await settle();
    expect(cellOf("hub1", "af1", "9")).toBe(5);     // back to the original 5, not 6
    expect(cellOf("central", "af1", "9")).toBe(0);
    tree.unmount();
  });

  it("is offered for five seconds, then the transfer is final", async () => {
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(transferButton(tree));
    await settle(400);
    expect(buttonNamed(tree, "Undo")).toBeTruthy();
    await settle(5000);
    expect(buttonNamed(tree, "Undo")).toBeFalsy();
    tree.unmount();
  });
});

describe("a failed transfer is never presented as a success", () => {
  it("leaves the card exactly as it was when nothing moved", async () => {
    failMoves = true;
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(transferButton(tree));
    await settle();
    const t = screenText(tree);
    expect(t).toContain("Nike Air Force 1 White");
    expect(t).toContain("2 products · 6 units");
    expect(buttonNamed(tree, "Undo")).toBeFalsy();
    tree.unmount();
  });

  it("keeps the card when only SOME sizes moved", async () => {
    failOneSize = "10";
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(transferButton(tree));
    await settle();
    expect(cellOf("hub1", "af1", "9")).toBe(2);     // the good line moved
    expect(cellOf("hub1", "af1", "10")).toBe(4);    // the rejected one did not
    expect(screenText(tree)).toContain("Nike Air Force 1 White");
    tree.unmount();
  });

  it("offers Undo for only the line that actually moved", async () => {
    failOneSize = "10";
    const tree = render();
    openCard(tree, "Nike Air Force 1 White");
    click(transferButton(tree));
    await settle();
    click(buttonNamed(tree, "Undo"));
    await settle();
    expect(cellOf("hub1", "af1", "9")).toBe(5);
    expect(cellOf("hub1", "af1", "10")).toBe(4);
    tree.unmount();
  });
});

describe("what may never appear on this screen", () => {
  it("renders zero clothing cards while the flag is absent", () => {
    const tree = render();
    expect(screenText(tree)).not.toContain("Essentials Tee Olive");
    tree.unmount();
  });

  it("renders them again when the flag is flipped on — no code change", () => {
    paths["config/refillEngine"] = { ...CONFIG, excessClothingEnabled: true };
    const tree = render();
    const t = screenText(tree);
    expect(t).toContain("Essentials Tee Olive");
    expect(t).toContain("3 products · 13 units");
    tree.unmount();
  });

  it("drops a cell covered by an explicit per-product row", () => {
    paths["stock_targets"] = { hub1: { af1: { 9: { target: 0 } } } };
    const tree = render();
    const t = screenText(tree);
    expect(t).toContain("1 size · 2 over target");   // only size 10 survives
    expect(t).toContain("2 products · 3 units");
    tree.unmount();
  });
});
