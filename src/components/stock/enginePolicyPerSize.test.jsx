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
  // The third pass: the group arrives as ONE ENTRY in the same list, and its
  // members are marked so the card leaves them out of the top level.
  groupEntries: [
    {
      key: "group:footwear-all", groupKey: "footwear-all", isGroup: true, label: "Sneakers",
      memberCategoryKeys: ["sneakers", "slides"], armedGroup: false, perSize: true,
      entry: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
      effectiveEntry: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
      policySource: "group", armed: ["hub2"], armedEffective: [], policyLocations: ["hub2"],
      // The live node, verbatim — what the card sends back as expectedBefore.
      rawGroup: { label: "Sneakers", armed: false, memberCategoryKeys: ["sneakers", "slides"],
        policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } } },
      sizeRun: ["5_5", "7", "8"], sizeRunPartial: ["5_5", "8"],
      sizeRunCarriedBy: { "5_5": ["sneakers"], 7: ["sneakers", "slides"], 8: ["sneakers"] },
      sizeRunExtra: [], sizeRunEmpty: false, membersWithoutRun: [],
      products: 1297, units: 17000, ownRowCells: 0, ownRowProducts: 0, overriddenProducts: 0,
      carriage: { hub2: { carries: true, products: 940, units: 9400 } },
      members: [
        { key: "sneakers", label: "Sneakers", products: 1246, units: 16872, hasOwnPolicy: false, armedEffective: [], ownRowCells: 0, sizeRun: ["5_5", "7", "8"] },
        { key: "slides", label: "Slides", products: 51, units: 128, hasOwnPolicy: false, armedEffective: [], ownRowCells: 0, sizeRun: ["7"] },
      ],
      imageUrl: null,
    },
  ],
  categories: [
    {
      key: "caps-beanies", label: "Caps & Beanies", products: 94, units: 512, perSize: false,
      entry: { hub2: { target: 10, minQty: 5, reorderPoint: 2 } },
      effectiveEntry: { hub2: { target: 10, minQty: 5, reorderPoint: 2 } },
      armed: ["hub2"], armedEffective: ["hub2"], policySource: "category", groupKey: null,
      carriage: { hub2: { carries: true, products: 94, units: 400 }, "marathon-pe": { carries: true, products: 40, units: 112 },
        trophy: { carries: false, products: 0, units: 0 } },
      ownRowCells: 188, ownRowProducts: 94, sizeRun: [], sizeRunExtra: ["S", "M"], extraSizeRowCells: 2, sizeRunEmpty: true,
      imageUrl: null,
    },
    {
      key: "sneakers", label: "Sneakers", products: 1246, units: 16872, perSize: true,
      memberOfGroup: "footwear-all",
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
// The rendered strings under a node, flattened. JSON.stringify on props.children
// cannot be used any more: a button may hold a React element (a chip), and an
// unrendered element carries a circular _owner back to its fiber.
const stringsUnder = (node) => {
  const out = [];
  const walk = (n) => {
    if (n === null || n === undefined || n === false) return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.children) walk(n.children);
  };
  walk(node.children ? node : node.toJSON ? node.toJSON() : node);
  return out.join(" ");
};
const buttonTextOf = (tree) => (tree.toJSON ? [tree.toJSON()] : [])
  .flatMap(function collect(n) {
    if (!n || typeof n !== "object") return [];
    const kids = Array.isArray(n.children) ? n.children.flatMap(collect) : [];
    return n.type === "button" ? [stringsUnder(n), ...kids] : kids;
  }).join(" ");
const styleTag = (tree) => tree.root.findAllByType("style").map((n) => n.children.join("")).join("");

beforeEach(() => { callableMock.mockClear(); });

describe("the rebuilt screen", () => {
  it("lists every category that has a policy of any kind, and says which", async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("Caps &amp; Beanies".replace("&amp;", "&"));
    expect(t).toContain("Sneakers");
    // ONE Sneakers entry, carrying how many categories it speaks for.
    expect(t).toContain("2 categories");
  });

  // ── THE GROUP IS ONE ENTRY, NOT A SECTION ────────────────────────────────
  it("has NO Groups section and none of its prose", async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).not.toContain("cannot produce a single refill");
    expect(t).not.toContain("grouping never");
    expect(t).not.toContain("Groups");
  });

  it("lists a group's member ONCE — inside the group, never beside it", async () => {
    const tree = await renderCard();
    const opens = tree.root.findAll((n) => n.type === "button" && /^Open /.test(n.props["aria-label"] || ""))
      .map((n) => n.props["aria-label"]);
    expect(opens).toContain("Open Sneakers");
    // The member category `sneakers` is hidden behind the group, so "Sneakers"
    // appears exactly once as an openable row.
    expect(opens.filter((l) => l === "Open Sneakers").length).toBe(1);
    expect(opens).toContain("Open Caps & Beanies");
  });

  it('says "N with their own rows", never "overridden"', async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("94 with their own rows");
    expect(t.toLowerCase()).not.toContain("overridden");
  });

  it('has NO control that clears rows — "N old rows" is a link that OPENS them', async () => {
    // The "Clear the N old rows" button was removed outright and must not come
    // back: it deleted hundreds of hand-made rows. The words "old rows" DO
    // appear now — as the chip that opens them for editing — so the assertion
    // is on what the controls do, not on the substring.
    const tree = await renderCard();
    expect(textOf(tree).toLowerCase()).not.toContain("clear the");
    const buttonText = buttonTextOf(tree).toLowerCase();
    for (const word of ["clear", "delete", "remove"]) expect(buttonText).not.toContain(word);
  });

  it("shows the header stamp with no author or key tail, and no subtitle", async () => {
    callableMock.mockImplementationOnce(async () => ({ data: { ...CENSUS,
      history: [{ id: "h1", at: Date.parse("2026-08-22T10:24:00Z"), by: "gunidmoh@gmail.com",
        categoryKey: "caps-beanies", status: "applied", changes: [] }] } }));
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("Last changed");
    // The header stamp itself no longer names anybody. (The change history
    // further down still does, in full — that is where provenance belongs.)
    const stamp = tree.root.findAll((n) => n.type === "div"
      && typeof n.props.children === "string" && /^Last changed/.test(n.props.children))[0];
    expect(stamp.props.children).not.toContain("gunidmoh@gmail.com");
    expect(stamp.props.children).not.toContain("caps-beanies");
    expect(t).not.toContain("when the engine asks for more");
  });

  it("has NO explanatory sub-line under any stat card", async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    for (const gone of ["fall through to the engine", "shared across every category",
      "none armed", "units across every location", "in this category", "carry it today",
      "rows the engine reads first"]) {
      expect(t).not.toContain(gone);
    }
  });

  it("has NO bottom tab bar — out of scope for this branch", async () => {
    const tree = await renderCard();
    const t = textOf(tree).toLowerCase();
    expect(t).not.toContain("position\":\"fixed\"");
  });
});

describe("the layout that was broken", () => {
  const openFirst2 = async (tree, label) => {
    const btn = tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === `Open ${label}`)[0];
    await act(async () => { btn.props.onClick(); });
  };
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
    expect(css).toMatch(/\.ep-box-head\s*>\s*\.ep-name\s*\{[^}]*white-space:nowrap/);
    expect(css).toMatch(/text-overflow:ellipsis/);
  });

  it("gives every location its own bordered box, and renders one per location", async () => {
    const tree = await renderCard();
    const css = styleTag(tree);
    expect(css).toMatch(/\.ep-box\s*\{[^}]*border:1px solid/);
    // …and the boxes are actually rendered, one per location, rather than the
    // rule existing with nothing using it. (CodeRabbit, PR #404.)
    await openFirst2(tree, "Caps & Beanies");
    const boxes = tree.root.findAll((n) => n.props && n.props.className === "ep-box");
    expect(boxes.length).toBe(CENSUS.destinations.length);
  });

  it("keeps the error on its OWN row so it cannot overlap the control below", async () => {
    const tree = await renderCard();
    const css = styleTag(tree);
    // Full-width, its own grid row, and padding ABOVE rather than a negative
    // margin — the layout that put "Keep is required" on top of the next row.
    expect(css).toMatch(/\.ep-err\s*\{[^}]*grid-column:1 \/ -1/);
    expect(css).not.toMatch(/\.ep-err\s*\{[^}]*margin-top:-/);
  });
});

describe("the category detail screen", () => {
  const openFirst = async (tree, label) => {
    const btn = tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === `Open ${label}`)[0];
    await act(async () => { btn.props.onClick(); });
  };

  it("shows the four stats and a Preview button, and NO legend", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Caps & Beanies");
    const t = textOf(tree);
    for (const s of ["On hand", "Products", "Locations", "Own rows"]) expect(t).toContain(s);
    // The legend block is gone: the three names live over the three inputs now,
    // in every location box.
    expect(t).not.toContain("how many the shelf should hold when it is full");
    expect(t).not.toContain("hold the request back until the shelf drops");
    expect(t).toContain("Preview");
    expect(t).toContain("Save policy");
    expect(t).toContain("Policy history");
  });

  it("repeats the three column headings inside EVERY location box, coloured to its input", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Caps & Beanies");
    const heads = tree.root.findAll((n) => n.props && n.props.className === "ep-colhead");
    const boxes = tree.root.findAll((n) => n.props && n.props.className === "ep-box");
    expect(boxes.length).toBe(3);
    expect(heads.length).toBe(boxes.length);
    for (const h of heads) {
      const cells = h.findAllByType("div").filter((d) => typeof d.props.children === "string");
      expect(cells.map((d) => d.props.children)).toEqual(["Keep", "Minimum", "Ask at"]);
      // Each heading carries its own input's accent colour, so the pairing is
      // visible without reading a legend somewhere else.
      const colours = cells.map((d) => d.props.style.color);
      expect(new Set(colours).size).toBe(3);
      // …and it is the SAME colour as the input it sits over.
      const inputs = h.parent.findAllByType("input");
      if (inputs.length >= 3) {
        expect(inputs.slice(0, 3).map((i) => i.props.style.borderLeft.split(" ").pop())).toEqual(colours);
      }
    }
  });

  it("replaces the legacy-sizes paragraph with a chip that opens those rows", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Caps & Beanies");
    const t = textOf(tree);
    expect(t).not.toContain("which are not");
    expect(t).not.toContain("edited in the");
    expect(t).toContain("2 old rows");
    const chip = tree.root.findAll((n) => n.type === "button"
      && String(n.props.children).includes("old rows"))[0];
    expect(chip).toBeTruthy();
    await act(async () => { chip.props.onClick({ stopPropagation() {} }); });
    expect(textOf(tree)).toContain("Black Cap");
  });

  it("shows an em dash for a location with no policy, with the reason and its action", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Caps & Beanies");
    const t = textOf(tree);
    expect(t).toContain("—");
    expect(t).toContain("carried");
    expect(t).toContain("Stock here");
    expect(t).toContain("not carried");
    expect(t).toContain("Arm this store");
  });

  it("opens the Sneakers policy on the same detail screen every category uses", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const t = textOf(tree);
    expect(t).toContain("Save policy");
    expect(t).toContain("On hand");
    // The member categories are reachable from inside it, as a compact list,
    // with the one rule that is not visible from the numbers.
    expect(t).toContain("Slides");
    expect(t).toContain("A category with its own numbers ignores these.");
  });

  it("marks a size only some members carry, at the size itself", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const marked = tree.root.findAll((n) => n.type === "span" && n.props.title
      && /only /.test(n.props.title));
    expect(marked.length).toBe(2);          // 5.5 and 8 — sneakers only
    expect(marked[0].props.title).toContain("sneakers");
  });

  // ── THE SAVE PAYLOAD, PINNED ─────────────────────────────────────────────
  // The failure class this guards is the one this codebase keeps hitting: a
  // save that writes a field nobody meant it to. Reading the code is not the
  // same as pinning it. (Architecture review, PR #404.)
  it("saves a group through setGroup, carrying armed and the membership untouched", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    // Preview first — Save is gated on it.
    callableMock.mockImplementationOnce(async () => ({ data: { ok: true, dryRun: true,
      hypothetical: true, armModel: { totalRequests: 3, totalUnits: 5, cap: 75, perMember: [] } } }));
    const previewBtn = tree.root.findAll((n) => n.type === "button"
      && stringsUnder(n).trim() === "Preview")[0];
    await act(async () => { previewBtn.props.onClick(); });
    const saveBtn = tree.root.findAll((n) => n.type === "button"
      && stringsUnder(n).trim() === "Save policy")[0];
    expect(saveBtn.props.disabled).toBe(false);
    callableMock.mockImplementationOnce(async () => ({ data: { ok: true, action: "setGroup" } }));
    await act(async () => { saveBtn.props.onClick(); });
    const payload = callableMock.mock.calls.map((c) => c[0]).filter((p) => p?.action === "setGroup" && !p.dryRun).pop();
    expect(payload.groupKey).toBe("footwear-all");
    expect(payload.group.armed).toBe(false);                       // never flipped by a numbers edit
    expect(payload.group.label).toBe("Sneakers");
    expect(payload.group.memberCategoryKeys).toEqual(["sneakers", "slides"]);
    expect(payload.group.policy).toEqual({ perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } });
    // expectedBefore is the LIVE NODE as the census read it, not a rebuild.
    expect(payload.expectedBefore).toEqual(CENSUS.groupEntries[0].rawGroup);
    // …and no categoryKey/policy write went out alongside it.
    expect(callableMock.mock.calls.some((c) => c[0]?.categoryKey && "policy" in c[0])).toBe(false);
  });

  it("previews a DISARMED group as hypothetical, and does not present it as what will happen", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    callableMock.mockImplementationOnce(async () => ({ data: { ok: true, dryRun: true,
      hypothetical: true, armModel: { totalRequests: 3, totalUnits: 5, cap: 75, perMember: [{ key: "sneakers", requests: 3 }] } } }));
    const previewBtn = tree.root.findAll((n) => n.type === "button"
      && stringsUnder(n).trim() === "Preview")[0];
    await act(async () => { previewBtn.props.onClick(); });
    const t = textOf(tree);
    expect(t).toContain("If this were armed");
    expect(t).not.toContain("What happens on the next scan");
  });

  it("does not offer a row list from a GROUP header — the list is keyed by category", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const chips = tree.root.findAll((n) => n.type === "button" && /rows/.test(stringsUnder(n)));
    // Any "rows" control here belongs to a MEMBER in the list below, never to
    // the group header itself.
    for (const chip of chips) expect(stringsUnder(chip)).not.toContain("with their own rows");
  });

  it("does not crash previewing a group whose numbers have all been cleared", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const stop = tree.root.findAll((n) => n.type === "button"
      && stringsUnder(n).trim() === "Stop stocking here")[0];
    await act(async () => { stop.props.onClick(); });
    // The server models nothing for a group with no policy, so armModel comes
    // back null; the panel must say so rather than read totalRequests off it.
    callableMock.mockImplementationOnce(async () => ({ data: { ok: true, dryRun: true,
      hypothetical: false, armModel: null } }));
    const previewBtn = tree.root.findAll((n) => n.type === "button"
      && stringsUnder(n).trim() === "Preview")[0];
    await act(async () => { previewBtn.props.onClick(); });
    expect(textOf(tree)).toContain("No numbers left");
  });

  it("says a disarmed group is OFF, never that it has no policy", async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("off — numbers at 1");
    await openFirst(tree, "Sneakers");
    expect(textOf(tree)).toContain("not armed");
    expect(textOf(tree)).not.toContain("No policy — the engine");
  });

  it("offers size-by-size on a SCALAR category that has a derived run", async () => {
    // The editor used to be reachable only where a per-size policy had already
    // been written by a script.
    const c = { ...CENSUS, groupEntries: [], categories: [{ ...CENSUS.categories[0],
      perSize: false, sizeRun: ["S", "M", "L"], sizeRunEmpty: false }] };
    callableMock.mockImplementationOnce(async () => ({ data: c }));
    const tree = await renderCard();
    await openFirst(tree, "Caps & Beanies");
    const btn = tree.root.findAll((n) => n.type === "button"
      && stringsUnder(n).trim() === "Set it size by size")[0];
    expect(btn).toBeTruthy();
    await act(async () => { btn.props.onClick(); });
    const labels = tree.root.findAll((n) => n.type === "input")
      .map((n) => n.props["aria-label"]).filter((l) => /Hub 2 .* Keep$/.test(l || ""));
    expect(labels).toEqual(["Hub 2 S Keep", "Hub 2 M Keep", "Hub 2 L Keep"]);
  });

  it("seeds a member opened from the group with the member's OWN sizes, not the union", async () => {
    const c = JSON.parse(JSON.stringify(CENSUS));
    // slides carries only 7; the group's policy names 5_5, 7 and 8.
    c.groupEntries[0].entry = { perSize: true, hub2: { sizes: {
      "5_5": { target: 2, minQty: 1 }, 7: { target: 2, minQty: 1 }, 8: { target: 2, minQty: 1 } } } };
    c.categories.push({ key: "slides", label: "Slides", products: 51, units: 128, perSize: true,
      memberOfGroup: "footwear-all", entry: null,
      effectiveEntry: c.groupEntries[0].entry,
      armed: [], armedEffective: ["hub2"], policySource: "group", groupKey: "footwear-all",
      groupLabel: "Sneakers", carriage: { hub2: { carries: true, products: 51, units: 128 } },
      ownRowCells: 0, ownRowProducts: 0, sizeRun: ["7"], sizeRunExtra: [], extraSizeRowCells: 0,
      sizeRunEmpty: false, imageUrl: null });
    callableMock.mockImplementationOnce(async () => ({ data: c }));
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const member = tree.root.findAll((n) => n.type === "button" && /^Slides/.test(stringsUnder(n)))[0];
    await act(async () => { member.props.onClick(); });
    const filled = tree.root.findAll((n) => n.type === "input")
      .filter((n) => /Hub 2 .* Keep$/.test(n.props["aria-label"] || "") && n.props.value !== "")
      .map((n) => n.props["aria-label"]);
    // Only its own size carries the group's number; the union's other sizes are
    // not seeded, because the server would refuse a write naming them.
    expect(filled).toEqual(["Hub 2 7 Keep"]);
  });

  it("expands a sized category into one row per size, in size order", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const labels = tree.root.findAll((n) => n.type === "input")
      .map((n) => n.props["aria-label"]).filter((l) => /Hub 2 .* Keep$/.test(l || ""));
    expect(labels).toEqual(["Hub 2 5.5 Keep", "Hub 2 7 Keep", "Hub 2 8 Keep"]);
  });

  it("refuses a per-size editor when the size run cannot be derived", async () => {
    const c = { ...CENSUS, groupEntries: [{ ...CENSUS.groupEntries[0], sizeRun: [], sizeRunEmpty: true }], categories: [] };
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
    expect(t).toContain("reads a row before the category policy");
    // …and there is no CONTROL that removes one. (The prose says rows are never
    // deleted, so a naive substring check on "delete" would match its own
    // reassurance — the assertion is on the buttons.)
    const buttonText = buttonTextOf(tree).toLowerCase();
    for (const word of ["delete", "remove", "clear"]) expect(buttonText).not.toContain(word);
    expect(t).toContain("Rows are never deleted here.");
  });
});
