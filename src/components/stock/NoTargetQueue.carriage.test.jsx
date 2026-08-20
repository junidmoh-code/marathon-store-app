// ─── THE DECISION QUEUE MUST NOT OFFER TO EXCLUDE A CARRIED LINE ─────────────
//
// THE DEFECT, precisely. Since PR #376 the engine arms a location from
// /stock_provenance. The Decision Queue was built before that and asks only "does a
// /stock_targets row exist HERE?" — so a shop the engine is actively managing renders
// as UNCONFIGURED, with an **Exclude** button that writes an explicit `target: 0`.
//
// A `target: 0` row OUTRANKS the index permanently. One tap on a shop with real
// recorded sales silently stops replenishing a line it demonstrably trades, and
// nothing anywhere says so. The queue's own precedent already covers this shape —
// a category-mapped product is skipped as "already decided" — and carriage is the
// same statement one source along.
//
// Reached via PR #380: writing introduce rows at hub2 flips `introducedElsewhere`
// for that product, which is exactly what routes it into this queue at the OTHER
// shops.
//
// This file renders the real component. An earlier version of the fix passed the
// whole suite and the production build while the hooks it used were never imported —
// an undefined identifier is a runtime error, not a build one, and there was no
// render test to catch it. That is why this exists.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const paths = {};
const updateMock = vi.fn(() => Promise.resolve());
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  update: (...a) => updateMock(...a),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  get: (r) => Promise.resolve({ val: () => paths[r.path] ?? null }),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
const perm = { permRecord: { stockRole: "admin" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => Date.parse("2026-08-18T09:00:00.000Z"), serverNowIso: () => "2026-08-18T09:00:00.000Z" }));
// The auth-ready gate the useStock hooks sit behind.
vi.mock("./useAuthReady", () => ({ default: () => true, useAuthReady: () => true }), { virtual: true });

const { default: NoTargetQueue } = await import("./NoTargetQueue.jsx");

const PID = "p_tee";
const PRODUCTS = [{ id: PID, name: "A tee", productType: "clothing", subcategory: "T-Shirts", categoryKey: "t-shirts", sizes: ["S", "M"] }];
const cell = (qty) => ({ qty, v: 1, mv: "m", state: "live" });
const ready = (...locs) => Object.fromEntries(locs.map((l) => [l, { at: "2026-08-18T06:00:00.000Z", pairs: 3, version: 1 }]));

const render = () => {
  let tree;
  act(() => { tree = TestRenderer.create(<NoTargetQueue products={PRODUCTS} />); });
  return tree;
};
const textOf = (tree) => JSON.stringify(tree.toJSON());

beforeEach(() => {
  updateMock.mockClear();
  for (const k of Object.keys(paths)) delete paths[k];
  paths["config/refillEngine"] = {
    routes: { hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    ruleBasedTargets: true,
    defaultRunByStore: { hub2: { S: 2, M: 3 }, "marathon-pe": { S: 2, M: 2 }, trophy: { S: 2, M: 2 } },
  };
  // Stock at marathon-pe with no row THERE, and a row elsewhere — the exact shape
  // that produces an UNCONFIGURED card.
  paths["stock"] = { "marathon-pe": { [PID]: { S: cell(2), M: cell(1) } } };
  paths["stock_targets"] = { hub2: { [PID]: { S: { introduce: true } } } };
  paths["stock_targets_decisions"] = {};
  paths["stock_provenance/_meta"] = ready("hub2", "marathon-pe", "trophy", "hub1");
  paths["stock_provenance/marathon-pe"] = null;
  paths["stock_provenance/trophy"] = null;
  paths["stock_provenance/hub2"] = null;
  paths["stock_provenance/hub1"] = null;
});

describe("a pair the engine CARRIES is already decided", () => {
  it("does NOT appear in the queue when provenance says the shop sells it", () => {
    // The defect. marathon-pe has 9 recorded sales — the engine resolves its size
    // run every scan — so this is not an open decision, and must not be offered
    // with an Exclude button that would overrule the index forever.
    paths["stock_provenance/marathon-pe"] = { [PID]: { s: 9 } };
    expect(textOf(render())).not.toMatch(/A tee/);
  });

  it("DOES appear when provenance genuinely has nothing — the control", () => {
    expect(textOf(render())).toMatch(/A tee/);
  });

  it("net-zero carriage (stocked then all undone) still appears — it is a real decision", () => {
    // k − u == 0 is NOT carriage. The engine refuses this pair, so a human really
    // does have to decide, and hiding it would be the silent direction.
    paths["stock_provenance/marathon-pe"] = { [PID]: { k: 4, u: 4 } };
    expect(textOf(render())).toMatch(/A tee/);
  });

  it("an UNREADY index shows the card rather than hiding it — fail safe TOWARD the human", () => {
    // Opposite direction from the engine, deliberately. The engine treats unready as
    // "arm nothing" because the question is whether to MOVE STOCK. Here the question
    // is whether to show someone a decision, and unready means we do not know — so a
    // person looks. Hiding on a failed read is the silent failure this whole cutover
    // is fighting.
    paths["stock_provenance/marathon-pe"] = { [PID]: { s: 9 } };
    paths["stock_provenance/_meta"] = ready("hub2");        // marathon-pe unready
    expect(textOf(render())).toMatch(/A tee/);
  });

  it("carriage at ANOTHER shop does not hide this shop's card", () => {
    paths["stock_provenance/trophy"] = { [PID]: { s: 9 } };
    expect(textOf(render())).toMatch(/A tee/);
  });
});

describe("the hooks are actually wired", () => {
  it("renders without throwing — an undefined hook identifier is a runtime error the build cannot see", () => {
    // This is the test that would have caught the first version of the fix, which
    // used useProvenanceMeta/useProvenanceAt without importing them: vitest and
    // `npm run build` both passed, and the screen would have thrown on open.
    expect(() => render()).not.toThrow();
  });
});

// ─── AN ALL-ZERO SAVE IS A DELISTING, NOT A SIZE EDIT ────────────────────────
//
// A size is not a product: zeroing SOME sizes of a line is legitimate tuning —
// provenance is pid-level, so a size at 0 contradicts nothing, and it is allowed.
// The ONE guarded case is a save where EVERY size computes to 0 at a destination:
// that writes the same permanent `target: 0` rows as Exclude, but labelled
// `source: "manual"` — a delisting disguised as a size edit, indistinguishable
// from ordinary tuning forever after. Such a save is refused with nothing written
// and the user pointed at Exclude, whose rows say what they are.
describe("the size-loop guard on saveTargets", () => {
  const clickByText = (tree, text) => {
    const btn = tree.root.findAll(
      (n) => n.type === "button" && JSON.stringify(n.children ?? []).includes(text),
    )[0];
    expect(btn, `button "${text}" must exist`).toBeTruthy();
    act(() => { btn.props.onClick(); });
  };
  const openTargets = (tree) => {
    clickByText(tree, "Decide");
    clickByText(tree, "Set targets");
  };
  const steppers = (tree) => tree.root.findAll((n) => typeof n.type === "function" && n.type.name === "SizeStepperChip");

  it("refuses when every size is 0, writes nothing, and names Exclude", async () => {
    const tree = render();
    openTargets(tree);
    for (const chip of steppers(tree)) act(() => { chip.props.onChange(0); });
    clickByText(tree, "Targets only");
    await act(async () => {});
    expect(updateMock).not.toHaveBeenCalled();
    expect(textOf(tree)).toMatch(/exclusion, not a size edit/);
  });

  it("allows zeroing SOME sizes — the control that keeps this a guard, not a redesign", async () => {
    const tree = render();
    openTargets(tree);
    act(() => { steppers(tree)[0].props.onChange(0); });   // S → 0, M keeps its prefill
    clickByText(tree, "Targets only");
    await act(async () => {});
    expect(updateMock).toHaveBeenCalledTimes(1);
    const written = updateMock.mock.calls[0][1];
    const targets = Object.values(written).map((row) => row.target).sort();
    expect(targets).toContain(0);                          // the zeroed size went through
    expect(targets.some((t) => t > 0)).toBe(true);         // and the line is still listed
  });
});
