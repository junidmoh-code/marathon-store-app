// ─── THE PER-PRODUCT TARGET EDITOR, ON SCREEN ────────────────────────────────
// The rules live in targetOverride.test.js. This pins what the owner actually
// sees and touches: one field per real size, the inherited number as a ghost,
// the "why" beside it, a preview Save waits for, and a clear that names a row
// it did not write before removing it.
//
// Run: npx vitest run src/components/stock/productTargetEditor.render.test.jsx

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  requestAnimationFrame(fn) { fn(); },
};

const saved = [];
let RESULT = { ok: true, rowCount: 1, changes: [{ sizeKey: "M" }] };
vi.mock("./seatingStore", async (orig) => ({
  ...(await orig()),
  saveProductTargets: async (args) => { saved.push(args); return typeof RESULT === "function" ? RESULT(args) : RESULT; },
}));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u" } } }));
vi.mock("firebase/database", () => ({ ref: () => ({}), get: async () => ({ exists: () => false, val: () => null }) }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));

const ProductTargetEditor = (await import("./ProductTargetEditor.jsx")).default;
const { seatingAt } = await import("./seatingCore.js");

const P = { j1: { id: "j1", name: "Jersey", productType: "clothing", categoryKey: "soccer-jerseys",
  sizes: ["S", "M", "L"] } };
const CONFIG = { mode: { trophy: "live" }, categoryPolicy: { "soccer-jerseys": { perSize: true, trophy: { sizes: {
  S: { target: 1, minQty: 1 }, M: { target: 2, minQty: 1 }, L: { target: 2, minQty: 1 },
} } } } };
// M is deliberately stocked SOMEWHERE — the engine's dead-size rule resolves a
// size with zero units anywhere in the network to 0, and a fixture that tripped
// it would test that rule rather than this screen. Its own test is below.
const STOCK = { trophy: { j1: { S: { qty: 1 }, M: { qty: 0 }, L: { qty: 4 } } }, hub2: { j1: { M: { qty: 5 } } } };
const ctxOf = (targets = {}, products = P, stock = STOCK) => ({ products, stock, targets, config: CONFIG });

const render = (ctx, canWrite = true, onFail = () => {}) => {
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <ProductTargetEditor
        seat={seatingAt(ctx, "trophy", "j1")} ctx={ctx} label="Trophy"
        locations={["trophy", "hub2"]} canWrite={canWrite}
        onDone={() => {}} onFail={onFail}
      />,
    );
  });
  return tree;
};
const text = (t) => JSON.stringify(t.toJSON());
const inputs = (t) => t.root.findAllByType("input");
const byLabel = (t, l) => inputs(t).find((n) => n.props["aria-label"] === l);
const button = (t, label) => t.root.findAll((n) => n.type === "button"
  && JSON.stringify(n.props.children).includes(label))[0];

beforeEach(() => { saved.length = 0; RESULT = { ok: true, rowCount: 1, changes: [{ sizeKey: "M" }] }; });

// ── ONE FIELD PER REAL SIZE ──────────────────────────────────────────────────
describe("the grid is the product's own sizes", () => {
  it("renders one Keep field per declared size, in size order", () => {
    const t = render(ctxOf());
    const labels = inputs(t).map((n) => n.props["aria-label"]);
    expect(labels).toEqual(["Trophy — set every size", "Trophy S keep", "Trophy M keep", "Trophy L keep", "Trophy ask at"]);
  });

  it("shows what is on hand, per size", () => {
    expect(text(render(ctxOf()))).toContain('"4"');   // L holds 4
  });

  it("the INHERITED number is the placeholder — a blank field means that number", () => {
    const t = render(ctxOf());
    expect(byLabel(t, "Trophy S keep").props.placeholder).toBe("1");
    expect(byLabel(t, "Trophy M keep").props.placeholder).toBe("2");
    expect(byLabel(t, "Trophy M keep").props.value).toBe("");
  });

  it("names WHY each size resolves what it does, and says when it is the product's own row", () => {
    const t = render(ctxOf({ trophy: { j1: { M: { target: 9, minQty: 5 } } } }));
    expect(text(t)).toContain("Category policy");
    expect(text(t)).toContain("own row");
    expect(byLabel(t, "Trophy M keep").props.value).toBe("9");
  });

  it("a size with no units ANYWHERE shows the engine's honest 0, not the map's number", () => {
    // The dead-size rule: a paper-only size resolves an explicit stop and arms
    // itself the moment real units arrive. The ghost says 0 because that is
    // what the next scan would do.
    const t = render(ctxOf({}, P, { trophy: { j1: { S: { qty: 1 } } } }));
    expect(byLabel(t, "Trophy M keep").props.placeholder).toBe("0");
  });

  it("a ONE-SIZE product gets one field and no every-size control", () => {
    const products = { j1: { id: "j1", name: "Scent", categoryKey: "perfumes", sizes: [] } };
    const config = { mode: { trophy: "live" }, categoryPolicy: { perfumes: { trophy: { target: 8, minQty: 4 } } } };
    const ctx = { products, stock: { trophy: { j1: { _: { qty: 2 } } } }, targets: {}, config };
    const t = render(ctx);
    expect(inputs(t).map((n) => n.props["aria-label"]))
      .toEqual(["Trophy One size keep", "Trophy ask at"]);
    expect(text(t)).not.toContain("set every size");
  });
});

// ── SAVE WAITS FOR A PREVIEW ─────────────────────────────────────────────────
describe("save waits for a preview of the numbers on screen", () => {
  const type = (t, label, v) => act(() => { byLabel(t, label).props.onChange({ target: { value: v } }); });

  it("is disabled until a preview has run, and again the moment a number changes", async () => {
    const t = render(ctxOf());
    expect(button(t, "Save targets").props.disabled).toBe(true);
    await type(t, "Trophy M keep", "9");
    expect(button(t, "Save targets").props.disabled).toBe(true);
    RESULT = { ok: true, preview: { sizes: [{ sizeKey: "M", before: 2, after: 9, changed: true }], changedSizes: 1, retracts: 0, unitsWanted: 9 } };
    await act(async () => { button(t, "Preview").props.onClick(); });
    expect(button(t, "Save targets").props.disabled).toBe(false);
    // one more keystroke and the preview is about numbers no longer on screen
    await type(t, "Trophy M keep", "8");
    expect(button(t, "Save targets").props.disabled).toBe(true);
    // The edit clears the preview outright; the KEY is the second guard, for a
    // response that lands after an edit rather than before it.
    expect(text(t)).toContain("Preview before saving");
  });

  it("the preview is a DRY RUN — it writes nothing", async () => {
    const t = render(ctxOf());
    await type(t, "Trophy M keep", "9");
    RESULT = { ok: true, preview: { sizes: [], changedSizes: 0, retracts: 0, unitsWanted: 0 } };
    await act(async () => { button(t, "Preview").props.onClick(); });
    expect(saved).toHaveLength(1);
    expect(saved[0].dryRun).toBe(true);
  });

  it("says how many open refills a 0 would retract", async () => {
    const t = render(ctxOf());
    await type(t, "Trophy S keep", "0");
    RESULT = { ok: true, preview: { sizes: [{ sizeKey: "S", before: 1, after: 0, changed: true }], changedSizes: 1, retracts: 1, unitsWanted: 0 } };
    await act(async () => { button(t, "Preview").props.onClick(); });
    expect(text(t)).toContain("1 open refill retracts");
  });

  it("and the save that follows is NOT a dry run", async () => {
    const t = render(ctxOf());
    await type(t, "Trophy M keep", "9");
    RESULT = { ok: true, preview: { sizes: [], changedSizes: 1, retracts: 0, unitsWanted: 0 } };
    await act(async () => { button(t, "Preview").props.onClick(); });
    RESULT = { ok: true, rowCount: 1, changes: [{ sizeKey: "M" }] };
    await act(async () => { button(t, "Save targets").props.onClick(); });
    expect(saved[1].dryRun).toBeFalsy();
    expect(saved[1].draft.sizes.M.target).toBe("9");
  });
});

// ── CLEARING NAMES A ROW IT DID NOT WRITE ────────────────────────────────────
describe("clear override", () => {
  const withConfirm = async (answer, fn) => {
    const had = "confirm" in globalThis.window;
    const prev = globalThis.window.confirm;
    const asked = [];
    globalThis.window.confirm = (m) => { asked.push(m); return answer; };
    try { await fn(); } finally { if (had) globalThis.window.confirm = prev; else delete globalThis.window.confirm; }
    return asked;
  };

  it("asks first, and a refused confirm writes nothing", async () => {
    const t = render(ctxOf({ trophy: { j1: { M: { target: 9, minQty: 5, source: "policy_target", prevAbsent: true } } } }));
    const asked = await withConfirm(false, async () => {
      await act(async () => { button(t, "Clear override").props.onClick(); });
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("following the category policy");
    expect(saved).toHaveLength(0);
  });

  it("names a row this screen did not write before removing it", async () => {
    const t = render(ctxOf({ trophy: { j1: { M: { target: 6, minQty: 3, source: "hand" } } } }));
    const asked = await withConfirm(true, async () => {
      await act(async () => { button(t, "Clear override").props.onClick(); });
    });
    expect(asked[0]).toContain("were not written from this screen");
    expect(saved[0].allowRemoveForeign).toBe(true);
  });

  it("refuses politely when there is nothing overridden", async () => {
    const fails = [];
    const t = render(ctxOf(), true, (m) => fails.push(m));
    await act(async () => { button(t, "Clear override").props.onClick(); });
    expect(fails[0]).toContain("Nothing here is overridden");
    expect(saved).toHaveLength(0);
  });
});

// ── THE PERMISSION ───────────────────────────────────────────────────────────
describe("a viewer who may not write a row", () => {
  it("gets every field disabled", () => {
    const t = render(ctxOf(), false);
    expect(inputs(t).every((n) => n.props.disabled)).toBe(true);
    expect(button(t, "Save targets").props.disabled).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// REVIEW FINDINGS — PR #497
// ═════════════════════════════════════════════════════════════════════════════
describe("the preview belongs to the world it was computed against", () => {
  it("goes stale when the seating context is refreshed underneath it", async () => {
    const before = ctxOf();
    let tree;
    act(() => {
      tree = TestRenderer.create(
        <ProductTargetEditor seat={seatingAt(before, "trophy", "j1")} ctx={before} label="Trophy"
          canWrite onDone={() => {}} onFail={() => {}} />,
      );
    });
    await act(async () => { byLabel(tree, "Trophy M keep").props.onChange({ target: { value: "9" } }); });
    RESULT = { ok: true, preview: { sizes: [], changedSizes: 1, retracts: 0, unitsWanted: 0 } };
    await act(async () => { button(tree, "Preview").props.onClick(); });
    expect(button(tree, "Save targets").props.disabled).toBe(false);

    // Somebody sells the last one, the screen refreshes, and the ctx is
    // replaced. The typed 9 is unchanged — the WORLD it was previewed against
    // is not.
    const after = ctxOf({}, P, { trophy: { j1: { S: { qty: 1 }, M: { qty: 0 }, L: { qty: 0 } } }, hub2: { j1: { M: { qty: 5 } } } });
    act(() => {
      tree.update(
        <ProductTargetEditor seat={seatingAt(after, "trophy", "j1")} ctx={after} label="Trophy"
          canWrite onDone={() => {}} onFail={() => {}} />,
      );
    });
    expect(button(tree, "Save targets").props.disabled).toBe(true);
    expect(text(tree)).toContain("Numbers changed");
  });
});

describe("a clear that cannot act says so", () => {
  it("names the rows it cannot restore instead of claiming nothing is overridden", async () => {
    const fails = [];
    // Every overridden size carries a captured row the live rule would refuse.
    const stuckRow = { target: 0, minQty: 0, source: "policy_target", prevRow: { target: "4", minQty: 2 } };
    const t = render(ctxOf({ trophy: { j1: { S: stuckRow, M: stuckRow, L: stuckRow } } }), true, (m) => fails.push(m));
    await act(async () => { button(t, "Clear override").props.onClick(); });
    expect(fails[0]).toContain("3 sizes have a record this screen cannot restore");
    expect(fails[0]).not.toContain("Nothing here is overridden");
    expect(saved).toHaveLength(0);
  });
});
