// ─── THE REDESIGNED SCREEN — PER-SIZE, GROUPS, ROWS, AND THE LAYOUT ───────────
// Run: npx vitest run src/components/stock/enginePolicyPerSize.test.jsx
//
// enginePolicyCore.test.js pins the one-size rules that shipped and stays
// untouched. This file pins the three the redesign adds, plus the two things
// the rebuild was FOR:
//
//   • the location row is ONE LINE of label — the wrap that collided with the
//     inputs is asserted gone, at the level of what the row renders;
//   • the stat block is never more than two columns at phone width.
//
// Both are asserted against the rendered tree and the stylesheet rather than
// described in a comment, because a layout fix nobody can see break is a layout
// fix that comes back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  policyFromDraft, validateDraft, previewKey, changedFields, armedLocations,
  draftFromEntry, editorRows, fillAllSizes, seedPerSizeLocation, isPerSizeRow,
  sizeLabel, sizeRank, bySizeRank, canSave,
} from "./enginePolicyCore";

// ═══ PER-SIZE, AS RULES ══════════════════════════════════════════════════════
describe("a per-size draft", () => {
  it("writes EVERY size individually — nothing stores a collapsed number", () => {
    const draft = { hub2: { sizes: {
      S: { target: "4", minQty: "2", reorderPoint: "" },
      M: { target: "4", minQty: "2", reorderPoint: "" },
    } } };
    const out = policyFromDraft(draft, { perSize: true });
    expect(out).toEqual({ perSize: true, hub2: { sizes: {
      S: { target: 4, minQty: 2 },
      M: { target: 4, minQty: 2 },
    } } });
  });

  it("keeps a blank Ask at ABSENT on every size — never zeroed", () => {
    const out = policyFromDraft({ hub2: { sizes: { S: { target: "4", minQty: "2", reorderPoint: "" } } } }, { perSize: true });
    expect("reorderPoint" in out.hub2.sizes.S).toBe(false);
    const withRp = policyFromDraft({ hub2: { sizes: { S: { target: "4", minQty: "2", reorderPoint: "0" } } } }, { perSize: true });
    expect(withRp.hub2.sizes.S.reorderPoint).toBe(0);
  });

  it("drops a size the owner cleared, and the whole leg when every size is cleared", () => {
    const out = policyFromDraft({ hub2: { sizes: {
      S: { target: "4", minQty: "2" }, M: { target: "", minQty: "" },
    } } }, { perSize: true });
    expect(Object.keys(out.hub2.sizes)).toEqual(["S"]);
    expect(policyFromDraft({ hub2: { sizes: { S: { target: "" }, M: { target: "" } } } }, { perSize: true })).toBe(null);
  });

  it("defaults each size's Minimum from ceil(Keep / 2), the same as a whole-location row", () => {
    const out = policyFromDraft({ hub2: { sizes: { S: { target: "9", minQty: "" } } } }, { perSize: true });
    expect(out.hub2.sizes.S.minQty).toBe(5);
  });

  it("holds every size to the SAME rules a whole-location row is held to", () => {
    const errs = validateDraft({ hub2: { sizes: {
      S: { target: "4", minQty: "9" },              // minimum above keep
      M: { target: "4", minQty: "2", reorderPoint: "4" },  // ask-at at keep
      L: { target: "4", minQty: "2" },              // fine
    } } });
    expect(errs["hub2::S"]).toMatch(/no higher than Keep/);
    expect(errs["hub2::M"]).toMatch(/must be below Keep/);
    expect(errs["hub2::L"]).toBeUndefined();
  });

  it("refuses a leg where no size has a number at all", () => {
    const errs = validateDraft({ hub2: { sizes: { S: { target: "" }, M: { target: "" } } } });
    expect(errs.hub2).toMatch(/at least one size/);
  });
});

describe("the preview key", () => {
  it("changes when ANY size in a run changes — a stale preview must not enable Save", () => {
    const a = { hub2: { sizes: { S: { target: "4", minQty: "2" }, M: { target: "4", minQty: "2" } } } };
    const b = { hub2: { sizes: { S: { target: "4", minQty: "2" }, M: { target: "5", minQty: "2" } } } };
    expect(previewKey("sneakers", a, { perSize: true })).not.toBe(previewKey("sneakers", b, { perSize: true }));
  });

  it("is stable when nothing changed", () => {
    const a = { hub2: { sizes: { M: { target: "4", minQty: "2" }, S: { target: "4", minQty: "2" } } } };
    const b = { hub2: { sizes: { S: { target: "4", minQty: "2" }, M: { target: "4", minQty: "2" } } } };
    expect(previewKey("sneakers", a, { perSize: true })).toBe(previewKey("sneakers", b, { perSize: true }));
  });

  it("still gates Save through canSave", () => {
    const draft = { hub2: { sizes: { S: { target: "4", minQty: "2" } } } };
    const key = previewKey("sneakers", draft, { perSize: true });
    expect(canSave({ preview: { key }, previewKeyNow: key, errors: {}, busy: false })).toBe(true);
    expect(canSave({ preview: { key: "stale" }, previewKeyNow: key, errors: {}, busy: false })).toBe(false);
  });
});

describe("a per-size leg is recognised as armed", () => {
  it("counts as armed even though it has no target of its own", () => {
    // Reporting it as unarmed rendered no editor row for it, the draft omitted
    // it, and the save — which .set()s the whole entry — would have DELETED it.
    // The drift check cannot catch that: live still matched what was rendered.
    expect(armedLocations({ perSize: true, hub2: { sizes: { S: { target: 4, minQty: 2 } } } })).toEqual(["hub2"]);
  });

  it("arms nothing when no size in the map has a usable target", () => {
    expect(armedLocations({ perSize: true, hub2: { sizes: { S: { target: 0, minQty: 0 } } } })).toEqual([]);
    expect(armedLocations({ perSize: true, hub2: { sizes: { S: { target: "4", minQty: 2 } } } })).toEqual([]);
  });

  it("round-trips a per-size entry through the draft unchanged", () => {
    const entry = { perSize: true, hub2: { sizes: { M: { target: 5, minQty: 3 }, S: { target: 4, minQty: 2, reorderPoint: 1 } } } };
    const draft = draftFromEntry({ entry, carriage: { hub2: { carries: true } }, destinations: ["hub2"] });
    expect(isPerSizeRow(draft.hub2)).toBe(true);
    expect(policyFromDraft(draft, { perSize: true })).toEqual(entry);
  });
});

describe('"same across all sizes"', () => {
  it("fills every size with its own row, all of them still separately editable", () => {
    const out = fillAllSizes(["S", "M", "L"], { target: "4", minQty: "2", reorderPoint: "" });
    expect(Object.keys(out.sizes)).toEqual(["S", "M", "L"]);
    for (const k of ["S", "M", "L"]) expect(out.sizes[k]).toEqual({ target: "4", minQty: "2", reorderPoint: "" });
    // …and what it produces is a real per-size policy, not a shortcut.
    expect(policyFromDraft(out.sizes ? { hub2: out } : {}, { perSize: true }).hub2.sizes.L.target).toBe(4);
  });

  it("seeds an empty run when a location is armed per size", () => {
    const out = seedPerSizeLocation(["7", "5_5"]);
    expect(Object.keys(out.sizes)).toEqual(["7", "5_5"]);
    expect(out.sizes["5_5"].target).toBe("");
  });
});

describe("half sizes", () => {
  it("read as 5.5 and are stored as 5_5", () => {
    expect(sizeLabel("5_5")).toBe("5.5");
    expect(sizeLabel("XL")).toBe("XL");
    const out = policyFromDraft({ hub2: { sizes: { "5_5": { target: "2", minQty: "1" } } } }, { perSize: true });
    expect(Object.keys(out.hub2.sizes)).toEqual(["5_5"]);
  });

  it("sort where a person expects them to", () => {
    expect(["8", "5_5", "S", "7", "XL"].sort(bySizeRank)).toEqual(["S", "XL", "5_5", "7", "8"]);
    expect(sizeRank("5_5")).toBe(105.5);
  });

  it("rank identically to the server's copy", async () => {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const server = req("../../../functions/lib/policy-groups.cjs");
    for (const s of ["S", "M", "XXXL", "4XL", "7", "5_5", "12", "junk", ""]) {
      expect(sizeRank(s)).toBe(server.sizeRank(s));
    }
  });
});

describe("the changed-fields banner", () => {
  it("names the size that changed, not just the location", () => {
    const before = { perSize: true, hub2: { sizes: { S: { target: 4, minQty: 2 } } } };
    const after = { perSize: true, hub2: { sizes: { S: { target: 6, minQty: 2 } } } };
    const out = changedFields(before, after);
    expect(out.find((c) => c.size === "S")?.text).toMatch(/^S — Keep 4 -> 6$/);
  });

  it("shows the NEW number when a leg leaves per-size, and reads coherently", () => {
    // It used to `continue` past the uniform loop, so the banner listed every
    // old size going to "not set" and said "now one number for the whole shop"
    // without ever showing what that number is — and the banner is the last
    // thing read before saving. (CodeRabbit, PR #401.)
    const before = { perSize: true, hub2: { sizes: { S: { target: 5, minQty: 3 } } } };
    const after = { perSize: true, hub2: { target: 7, minQty: 4 } };
    const out = changedFields(before, after);
    const keep = out.find((c) => c.field === "target" && !c.size);
    expect(keep).toBeTruthy();
    expect(keep.to).toBe(7);
    // …and it does not read as a second, unrelated change alongside the
    // per-size lines that already said everything went to "not set".
    expect(keep.text).toBe("the whole shop — Keep 7");
    expect(keep.leftPerSize).toBe(true);
  });

  it("reports a shape change as a shape change, not as an un-arming", () => {
    const before = { perSize: true, hub2: { target: 5, minQty: 3 } };
    const after = { perSize: true, hub2: { sizes: { S: { target: 5, minQty: 3 } } } };
    const out = changedFields(before, after);
    expect(out.some((c) => /size by size/.test(c.text || ""))).toBe(true);
    // …and it does NOT claim Keep went to "not set", which is what reporting
    // the fields alone produced.
    expect(out.some((c) => c.field === "target" && c.to === null && !c.size)).toBe(false);
  });
});

describe("armedLocations agrees with the ENGINE, shape for shape", () => {
  // A DIFFERENTIAL, not a hand-written case list, because a hand-written list is
  // what let three shapes disagree in the first place — and all three in the
  // unsafe direction: the card showed a location as armed where the engine is
  // silent, which is the exact thing this function exists to prevent.
  //
  // The card's own comment claimed it was "byte-for-byte the engine's own test".
  // It was not. This asserts it instead of claiming it.
  const SHAPES = [
    {},
    { hub2: {} },
    { hub2: { target: 5, minQty: 3 } },
    { hub2: { target: 0, minQty: 0 } },
    { hub2: { target: "5", minQty: 3 } },
    { hub2: { target: -1, minQty: 0 } },
    { hub2: { target: NaN, minQty: 0 } },
    { hub2: { sizes: {} } },
    { hub2: { sizes: { S: { target: 1 } } } },                      // no perSize
    { hub2: { sizes: { S: { target: 2, minQty: 1 } } } },           // no perSize
    { hub2: { target: 5, sizes: { S: { target: 1 } } } },           // both at once
    { perSize: true, hub2: { target: 5, sizes: { S: { target: 1 } } } },
    { perSize: true, hub2: { sizes: {} } },
    { perSize: true, hub2: { sizes: { S: { target: 0, minQty: 0 } } } },
    { perSize: true, hub2: { sizes: { S: { target: "2", minQty: 1 } } } },
    { perSize: true, hub2: { sizes: { S: { target: 2, minQty: 1 } } } },
    { perSize: true, hub2: { target: 5, minQty: 3 } },
    { perSize: true, hub2: { sizes: { S: { target: 2, minQty: 1 } } }, trophy: { sizes: { S: { target: 3, minQty: 1 } } } },
  ];

  it("calls a location armed exactly when categoryPolicyEntry resolves for it", async () => {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const { categoryPolicyEntry } = req("../../../functions/lib/refill-engine.cjs");
    const products = { p1: { categoryKey: "cat", sizes: ["S"] } };
    const disagreed = [];
    for (const entry of SHAPES) {
      const mine = armedLocations(entry);
      const theirs = ["hub2", "trophy"].filter((loc) =>
        categoryPolicyEntry({ categoryPolicy: { cat: entry } }, products, "p1", loc) !== null);
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
        disagreed.push({ entry, card: mine, engine: theirs });
      }
    }
    expect(disagreed).toEqual([]);
  });
});

describe("editor rows", () => {
  it("report which shape each leg holds", () => {
    const entry = { perSize: true, hub2: { sizes: { S: { target: 4, minQty: 2 } } }, trophy: { target: 3, minQty: 2 } };
    const rows = editorRows({ entry, carriage: {}, destinations: ["hub2", "trophy", "marathon-pe"] });
    expect(rows.find((r) => r.loc === "hub2").shape).toBe("per-size");
    expect(rows.find((r) => r.loc === "trophy").shape).toBe("uniform");
    expect(rows.find((r) => r.loc === "marathon-pe").shape).toBe(null);
  });
});

// ═══ THE SCREEN ══════════════════════════════════════════════════════════════
globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  confirm: () => true, requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

const CENSUS = {
  destinations: ["hub2", "marathon-pe", "trophy"],
  cap: 75,
  history: [],
  groups: {
    "footwear-all": {
      label: "All footwear except soccer boots", armed: false,
      memberCategoryKeys: ["sneakers", "slides"],
      policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
    },
  },
  categories: [
    {
      key: "caps-beanies", label: "Caps & Beanies", products: 94, units: 512, perSize: false,
      entry: { hub2: { target: 10, minQty: 5, reorderPoint: 2 } },
      effectiveEntry: { hub2: { target: 10, minQty: 5, reorderPoint: 2 } },
      armed: ["hub2"], armedEffective: ["hub2"], policySource: "category", groupKey: null,
      carriage: { hub2: { carries: true, products: 94, units: 400 }, "marathon-pe": { carries: true, products: 40, units: 112 },
        trophy: { carries: false, products: 0, units: 0 } },
      ownRowCells: 188, ownRowProducts: 94, sizeRun: [], sizeRunExtra: ["S", "M"], sizeRunEmpty: true,
      imageUrl: null,
    },
    {
      key: "sneakers", label: "Sneakers", products: 1246, units: 16872, perSize: true,
      entry: null, effectiveEntry: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
      armed: [], armedEffective: ["hub2"], policySource: "group", groupKey: "footwear-all",
      groupLabel: "All footwear except soccer boots",
      carriage: { hub2: { carries: true, products: 900, units: 9000 } },
      ownRowCells: 0, ownRowProducts: 0, sizeRun: ["5_5", "7", "8"], sizeRunExtra: [], sizeRunEmpty: false,
      imageUrl: null,
    },
  ],
};

const callableMock = vi.fn(async (payload) => {
  if (payload?.action === "rows") {
    return { data: { ok: true, rows: [
      { loc: "hub2", pid: "c1", sizeKey: "S", name: "Black Cap", target: 2, minQty: 1, reorderPoint: 1 },
    ], count: 1 } };
  }
  return { data: CENSUS };
});
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callableMock(...a) }));
vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true } }));

const EnginePolicyCard = (await import("./EnginePolicyCard.jsx")).default;
const OWNER = { email: "gunidmoh@gmail.com" };

async function renderCard() {
  let tree;
  await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={OWNER} onExit={() => {}} />); });
  return tree;
}
const textOf = (tree) => JSON.stringify(tree.toJSON());
const styleTag = (tree) => tree.root.findAllByType("style").map((n) => n.children.join("")).join("");

beforeEach(() => { callableMock.mockClear(); });

describe("the rebuilt screen", () => {
  it("lists every category that has a policy of any kind, and says which", async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("Caps &amp; Beanies".replace("&amp;", "&"));
    expect(t).toContain("Sneakers");
    // The grouped one says so on the list, before it is opened.
    expect(t).toContain("in All footwear except soccer boots");
  });

  it('says "N with their own rows", never "overridden"', async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("94 with their own rows");
    expect(t.toLowerCase()).not.toContain("overridden");
  });

  it('has NO "Clear the N old rows" control anywhere', async () => {
    // The button was removed outright. Its absence is the assertion, because a
    // control that deletes hundreds of hand-made rows must not come back by
    // accident.
    const tree = await renderCard();
    const t = textOf(tree).toLowerCase();
    expect(t).not.toContain("clear the");
    expect(t).not.toContain("old rows");
  });

  it("shows a group as not armed, and explains what that means", async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("All footwear except soccer boots");
    expect(t).toContain("not armed");
    expect(t).toContain("cannot produce a single refill");
  });

  it("has NO bottom tab bar — out of scope for this branch", async () => {
    const tree = await renderCard();
    const t = textOf(tree).toLowerCase();
    expect(t).not.toContain("position\":\"fixed\"");
  });
});

describe("the layout that was broken", () => {
  it("keeps the stat block at two columns until 720px", () => {
    // The requirement is literal: never more than two columns at phone width.
    const tree = { root: { findAllByType: () => [] } };
    void tree;
    // Read the rule out of the component's own stylesheet rather than a copy.
    return renderCard().then((t) => {
      const css = styleTag(t);
      expect(css).toMatch(/\.ep-stats\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
      expect(css).toMatch(/@media\s*\(min-width:720px\)\s*\{\s*\.ep-stats\s*\{[^}]*repeat\(4,/);
    });
  });

  it("gives the location label a shrinkable track that ellipses instead of wrapping", async () => {
    const tree = await renderCard();
    const css = styleTag(tree);
    // minmax(0,1fr) is what lets the track shrink below its content; without it
    // the label pushed the inputs off the row, which is the bug being fixed.
    expect(css).toMatch(/\.ep-loc\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
    expect(css).toMatch(/\.ep-loc-name\s*>\s*span\s*\{[^}]*white-space:nowrap/);
    expect(css).toMatch(/text-overflow:ellipsis/);
  });

  it("stacks the numbers below the label at phone width and beside it above 560px", async () => {
    const tree = await renderCard();
    const css = styleTag(tree);
    expect(css).toMatch(/@media\s*\(min-width:560px\)\s*\{[\s\S]*?\.ep-loc\s*\{[^}]*minmax\(0,1fr\)\s+260px/);
  });
});

describe("the category detail screen", () => {
  const openFirst = async (tree, label) => {
    const btn = tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === `Open ${label}`)[0];
    await act(async () => { btn.props.onClick(); });
  };

  it("shows the four stats, the legend and a Preview button", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Caps & Beanies");
    const t = textOf(tree);
    for (const s of ["On hand", "Products", "Locations", "Own rows"]) expect(t).toContain(s);
    expect(t).toContain("how many the shelf should hold when it is full");
    expect(t).toContain("hold the request back until the shelf drops");
    expect(t).toContain("Preview");
    expect(t).toContain("Save policy");
    expect(t).toContain("Policy history");
  });

  it("shows an em dash for a location with no policy, with the reason and its action", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Caps & Beanies");
    const t = textOf(tree);
    expect(t).toContain("—");
    expect(t).toContain("not stocked by the engine here");
    expect(t).toContain("Stock here");
    expect(t).toContain("not carried");
    expect(t).toContain("Arm this store");
  });

  it("warns that saving a grouped category takes it out of the group", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    expect(textOf(tree)).toContain("takes it out of");
  });

  it("expands a sized category into one row per size, in size order", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const labels = tree.root.findAll((n) => n.type === "input")
      .map((n) => n.props["aria-label"]).filter((l) => /Hub 2 .* Keep$/.test(l || ""));
    expect(labels).toEqual(["Hub 2 5.5 Keep", "Hub 2 7 Keep", "Hub 2 8 Keep"]);
  });

  it("refuses a per-size editor when the size run cannot be derived", async () => {
    const c = { ...CENSUS, categories: [{ ...CENSUS.categories[1], sizeRun: [], sizeRunEmpty: true }] };
    callableMock.mockImplementationOnce(async () => ({ data: c }));
    const tree = await renderCard();
    await act(async () => {
      tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === "Open Sneakers")[0].props.onClick();
    });
    expect(textOf(tree)).toContain("No size run can be worked out");
  });

  it("opens the explicit rows for editing from the chip", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Caps & Beanies");
    const chip = tree.root.findAll((n) => n.type === "button"
      && String(n.props.children).includes("with their own rows"))[0];
    await act(async () => { chip.props.onClick({ stopPropagation() {} }); });
    const t = textOf(tree);
    expect(t).toContain("Black Cap");
    expect(t).toContain("BEFORE it reads the category policy");
    // …and there is no CONTROL that removes one. (The prose says rows are never
    // deleted, so a naive substring check on "delete" would match its own
    // reassurance — the assertion is on the buttons.)
    const buttonText = tree.root.findAll((n) => n.type === "button")
      .map((n) => JSON.stringify(n.props.children)).join(" ").toLowerCase();
    for (const word of ["delete", "remove", "clear"]) expect(buttonText).not.toContain(word);
    expect(t).toContain("Rows are never deleted from this screen");
  });
});
