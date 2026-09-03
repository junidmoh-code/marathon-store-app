// ─── THE HUB → CENTRAL EXCESS SCREEN, RENDERED FOR REAL ──────────────────────
// Commit 5 of the excess-sneakers-hub-to-central build (docs/EXCESS-SNEAKERS.md).
//
// excessComputation.test.js pins the pure formula; this renders the ACTUAL
// component, because the remaining directives are WIRING claims that a core
// test cannot reach:
//
//   1. A move goes through the SAME action the existing excess button calls —
//      applyMovement transfer_out, hub → central — and leaves the cell at
//      EXACTLY Keep. Proved against a simulated ledger, not against the args
//      alone.
//   2. Undo restores the EXACT prior cell state, through that same path.
//   3. applyMovement RESOLVES {ok:false} rather than throwing, so a failed
//      move must put the card BACK, not silently retire it.
//   4. The screen is numbers and movement only — no sentences.
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
// This is what makes "leaves the cell at exactly Keep" and "Undo restores the
// exact prior cell state" real claims rather than argument-shape assertions.
let ledger = {};
let failMoves = false;
const cellOf = (loc, pid, size) => ledger[`${loc}|${pid}|${size}`] ?? 0;
const applyMovementMock = vi.fn(async (m) => {
  if (failMoves) return { ok: false, reason: "PERMISSION_DENIED" };
  if (m.type !== "transfer_out") return { ok: false, reason: `unexpected type ${m.type}` };
  const from = `${m.from}|${m.productId}|${m.size}`;
  const to = `${m.to}|${m.productId}|${m.size}`;
  ledger[from] = (ledger[from] ?? 0) - m.qty;
  ledger[to] = (ledger[to] ?? 0) + m.qty;
  return { ok: true, movementId: m.movementId };
});
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));

const { default: ExcessHubToCentral } = await import("./ExcessHubToCentral.jsx");

const PRODUCTS = [
  { id: "af1",  name: "Nike Air Force 1 White",    categoryKey: "sneakers", sizes: ["7", "8", "9", "10"], photoUrl: null },
  { id: "boot", name: "Timberland 6-Inch Wheat",   categoryKey: "boots",    sizes: ["7", "8", "9"],       photoUrl: null },
  { id: "tee",  name: "Essentials Tee Olive",      categoryKey: "tees",     productType: "clothing", sizes: ["S", "M", "L"], photoUrl: null },
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

// hub1: af1 has 3 over on size 9 and 2 over on size 10 (5 units); boot has 1
// over on size 9. hub2 holds a different shape so the segmented control has
// something to prove.
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
const buttonsOf = (tree) => tree.root.findAll((n) => n.type === "button");
const buttonNamed = (tree, label) =>
  buttonsOf(tree).find((n) => textOf(n.props.children).trim() === label);
// The circular move button is the one whose label is the card's unit total.
const moveButtonFor = (tree, total) => buttonNamed(tree, String(total));

function render() {
  let tree;
  act(() => { tree = TestRenderer.create(<ExcessHubToCentral products={PRODUCTS} actorRole="warehouse" />); });
  return tree;
}
const settle = async (ms = 400) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const click = (btn) => act(() => { btn.props.onClick(); });

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
  applyMovementMock.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe("the screen", () => {
  it("states the header once, with the count pill for the selected hub", () => {
    const tree = render();
    const text = screenText(tree);
    expect(text).toContain("Hub 1 → Central");
    // af1 (3 + 2 = 5 units) and boot (1 unit) — clothing is behind the flag.
    expect(text).toContain("2 products · 6 units");
    tree.unmount();
  });

  it("shows a card per product, sorted by units descending, with per-size chips", () => {
    const tree = render();
    const text = screenText(tree);
    expect(text).toContain("Nike Air Force 1 White");
    expect(text).toContain("9 · 3");     // 5 on hand − Keep 2
    expect(text).toContain("10 · 2");    // 4 on hand − Keep 2
    expect(text).not.toContain("8 · ");  // size 8 is BELOW Keep — never a chip
    expect(text.indexOf("Nike Air Force 1 White")).toBeLessThan(text.indexOf("Timberland 6-Inch Wheat"));
    tree.unmount();
  });

  it("is numbers and movement only — no sentences, no helper text", () => {
    const tree = render();
    const text = screenText(tree);
    expect(text).not.toMatch(/above target|surplus|rebalance|recommend|tap to|will be|please/i);
    tree.unmount();
  });

  it("switches hub — the header and the cards follow the segmented control", async () => {
    const tree = render();
    click(buttonNamed(tree, "Hub 2"));
    await settle(0);
    const text = screenText(tree);
    expect(text).toContain("Hub 2 → Central");
    expect(text).toContain("1 product · 2 units");    // hub2 af1 size 9: 4 − 2
    expect(text).not.toContain("Timberland 6-Inch Wheat");
    tree.unmount();
  });
});

describe("a tap moves the card", () => {
  // MUTATION-PROVED: sending `onHand` instead of the movable quantity, or
  // to: the hub instead of "central", fails this.
  it("moves every size on the card, hub → central, leaving each cell at EXACTLY Keep", async () => {
    const tree = render();
    click(moveButtonFor(tree, 5));       // the af1 card: 3 + 2
    await settle();

    const calls = applyMovementMock.mock.calls.map(([m]) => m);
    expect(calls).toHaveLength(2);
    for (const m of calls) {
      expect(m.type).toBe("transfer_out");
      expect(m.from).toBe("hub1");
      expect(m.to).toBe("central");
      expect(m.productId).toBe("af1");
      expect(m.reason).toBe("excess_rebalance");
    }
    expect(calls.map((m) => [m.size, m.qty]).sort()).toEqual([["10", 2], ["9", 3]]);

    // The claim that matters: what is LEFT on the shelf is exactly Keep.
    expect(cellOf("hub1", "af1", "9")).toBe(2);
    expect(cellOf("hub1", "af1", "10")).toBe(2);
    expect(cellOf("central", "af1", "9")).toBe(3);
    expect(cellOf("central", "af1", "10")).toBe(2);
    // A size below Keep was never touched.
    expect(cellOf("hub1", "af1", "8")).toBe(1);
    tree.unmount();
  });

  it("retires the card and decrements the pill", async () => {
    const tree = render();
    click(moveButtonFor(tree, 5));
    await settle();
    const text = screenText(tree);
    expect(text).not.toContain("Nike Air Force 1 White");
    expect(text).toContain("1 product · 1 unit");
    tree.unmount();
  });

  it("never asks for confirmation — the movement happens on the tap itself", async () => {
    const tree = render();
    click(moveButtonFor(tree, 5));
    await settle(0);
    expect(applyMovementMock).toHaveBeenCalled();
    tree.unmount();
  });

  it("gives each line a distinct idempotency key", async () => {
    const tree = render();
    click(moveButtonFor(tree, 5));
    await settle();
    const ids = applyMovementMock.mock.calls.map(([m]) => m.movementId);
    expect(new Set(ids).size).toBe(ids.length);
    tree.unmount();
  });
});

describe("Undo", () => {
  // MUTATION-PROVED: reversing with the CARD's sizes instead of the lines that
  // actually moved, or omitting the from/to swap, fails these.
  it("restores the EXACT prior cell state, through the same movement path", async () => {
    const before = { ...ledger };
    const tree = render();
    click(moveButtonFor(tree, 5));
    await settle();
    expect(ledger).not.toEqual(before);          // the move really happened

    click(buttonNamed(tree, "Undo"));
    await settle();

    // Every hub cell is back to precisely where it started, and central is
    // left holding nothing.
    expect(cellOf("hub1", "af1", "9")).toBe(5);
    expect(cellOf("hub1", "af1", "10")).toBe(4);
    expect(cellOf("central", "af1", "9")).toBe(0);
    expect(cellOf("central", "af1", "10")).toBe(0);

    // And it went back the SAME way it came — transfer_out, central → hub1.
    const back = applyMovementMock.mock.calls.map(([m]) => m).filter((m) => m.from === "central");
    expect(back).toHaveLength(2);
    for (const m of back) {
      expect(m.type).toBe("transfer_out");
      expect(m.to).toBe("hub1");
    }
    tree.unmount();
  });

  it("brings the card back with its original quantities", async () => {
    const tree = render();
    click(moveButtonFor(tree, 5));
    await settle();
    click(buttonNamed(tree, "Undo"));
    await settle();
    const text = screenText(tree);
    expect(text).toContain("Nike Air Force 1 White");
    expect(text).toContain("2 products · 6 units");
    tree.unmount();
  });

  it("is offered for five seconds, then the move is final", async () => {
    const tree = render();
    click(moveButtonFor(tree, 5));
    await settle(400);
    expect(buttonNamed(tree, "Undo")).toBeTruthy();
    await settle(5000);
    expect(buttonNamed(tree, "Undo")).toBeFalsy();
    tree.unmount();
  });
});

describe("a failed move is never presented as a success", () => {
  // applyMovement RESOLVES {ok:false} on a rejected write — it does not throw.
  // MUTATION-PROVED: ignoring the result (the original draft's `try/catch` with
  // no `ok` check) retires the card anyway and fails both of these.
  it("puts the card back when nothing moved", async () => {
    failMoves = true;
    const tree = render();
    click(moveButtonFor(tree, 5));
    await settle();
    const text = screenText(tree);
    expect(text).toContain("Nike Air Force 1 White");
    expect(text).toContain("2 products · 6 units");
    tree.unmount();
  });

  it("offers no Undo for a move that never happened", async () => {
    failMoves = true;
    const tree = render();
    click(moveButtonFor(tree, 5));
    await settle();
    expect(buttonNamed(tree, "Undo")).toBeFalsy();
    tree.unmount();
  });
});

describe("clothing stays behind the flag on this screen", () => {
  // MUTATION-PROVED: calling computeHubExcess without the clothing gate (or
  // defaulting the flag on) renders the tee card and fails the first test.
  it("renders zero clothing cards while the key is absent", () => {
    const tree = render();
    expect(screenText(tree)).not.toContain("Essentials Tee Olive");
    tree.unmount();
  });

  it("renders them again when the key is flipped on — no code change", () => {
    paths["config/refillEngine"] = { ...CONFIG, excessClothingEnabled: true };
    const tree = render();
    const text = screenText(tree);
    expect(text).toContain("Essentials Tee Olive");
    expect(text).toContain("3 products · 13 units");   // + tee M: 9 − Keep 2
    tree.unmount();
  });
});

describe("an explicit per-product row is excluded from the screen", () => {
  it("drops the covered cell, keeping the product's other sizes", () => {
    paths["stock_targets"] = { hub1: { af1: { 9: { target: 0 } } } };
    const tree = render();
    const text = screenText(tree);
    expect(text).not.toContain("9 · 3");
    expect(text).toContain("10 · 2");
    expect(text).toContain("2 products · 3 units");
    tree.unmount();
  });
});
