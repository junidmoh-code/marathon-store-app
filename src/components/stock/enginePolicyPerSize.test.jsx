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
  sizeLabel, sizeRank, bySizeRank, canSave, mainListEntries, previewFromArmModel,
} from "./enginePolicyCore";

// ═══ THE MAIN LIST — a group is one entry, its members are inside it ════════
describe("mainListEntries", () => {
  const census = {
    categories: [
      { key: "t-shirts", label: "T-shirts", products: 300, ownRowCells: 1870, armedEffective: [], memberOfGroup: null },
      { key: "caps", label: "Caps", products: 94, ownRowCells: 188, armedEffective: ["hub2"], memberOfGroup: null },
      { key: "sneakers", label: "Sneakers", products: 1246, ownRowCells: 0, armedEffective: [], memberOfGroup: "footwear-all" },
      { key: "slides", label: "Slides", products: 51, ownRowCells: 0, armedEffective: ["hub2"], memberOfGroup: "footwear-all" },
      { key: "jeans", label: "Jeans", products: 0, ownRowCells: 0, armedEffective: [], memberOfGroup: null },
    ],
    groupEntries: [
      { key: "group:footwear-all", isGroup: true, label: "Sneakers", products: 1297, ownRowCells: 0, armed: false, armedEffective: ["hub2"] },
    ],
  };
  it("hides every member — even one with its own armed entry — and lists the group once, sorted in", () => {
    const keys = mainListEntries(census).map((c) => c.key);
    expect(keys).not.toContain("sneakers");
    expect(keys).not.toContain("slides");
    expect(keys.filter((k) => k === "group:footwear-all")).toHaveLength(1);
  });
  it("ranks a DISARMED group below the governed band even when it holds numbers", () => {
    const keys = mainListEntries(census).map((c) => c.key);
    expect(keys).toEqual(["caps", "group:footwear-all", "t-shirts", "jeans"]);
    const armed = { ...census, groupEntries: [{ ...census.groupEntries[0], armed: true }] };
    expect(mainListEntries(armed).map((c) => c.key)).toEqual(["caps", "group:footwear-all", "t-shirts", "jeans"]);
    // …alphabetical inside the governed band once armed: Caps < Sneakers
  });
  it("survives a census with no groupEntries at all (the shape before this pass)", () => {
    expect(mainListEntries({ categories: census.categories.slice(0, 2) }).map((c) => c.key)).toEqual(["caps", "t-shirts"]);
    expect(mainListEntries(null)).toEqual([]);
  });
});

describe("previewFromArmModel", () => {
  it("reshapes setGroup's dry-run model into the preview panel's fields and carries the armed state", () => {
    const m = previewFromArmModel({ totalRequests: 2176, totalUnits: 4000, cap: 75, exceedsCap: true,
      perMember: [{ key: "sneakers", requests: 2020, overriddenProducts: 3 }, { key: "slides", requests: 156 }] }, { armed: false });
    expect(m.totalRequests).toBe(2176);
    expect(m.cap).toBe(75);
    expect(m.exceedsCap).toBe(true);
    expect(m.overriddenProducts).toBe(3);
    expect(m.ifArmed).toBe(true);
    expect(m.armed).toBe(false);
    expect(previewFromArmModel(null)).toBe(null);
  });
});

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
      label: "Sneakers", armed: false,
      memberCategoryKeys: ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers"],
      policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
    },
  },
  // THE GROUP AS ONE ENTRY — the same fields a category carries, counts summed.
  groupEntries: [
    {
      key: "group:footwear-all", isGroup: true, groupKey: "footwear-all", label: "Sneakers",
      group: { label: "Sneakers", armed: false,
        memberCategoryKeys: ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers"],
        policy: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } } },
      memberCategoryKeys: ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers"],
      members: [
        { key: "sneakers", label: "Sneakers", products: 1246, units: 16872, ownPolicy: false, imageUrl: null },
        { key: "slides", label: "Slides", products: 51, units: 300, ownPolicy: true, imageUrl: null },
      ],
      armed: false, products: 1297, units: 17172, perSize: true,
      entry: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
      effectiveEntry: { perSize: true, hub2: { sizes: { 7: { target: 2, minQty: 1 } } } },
      armedEffective: ["hub2"], policySource: "group", memberOfGroup: null,
      carriage: { hub2: { carries: true, products: 951, units: 9300 }, "marathon-pe": { carries: false, products: 0, units: 0 } },
      ownRowCells: 0, ownRowProducts: 0, sizeRun: ["5_5", "7", "8"], sizeRunPartial: ["5_5"], sizeRunExtra: [], sizeRunEmpty: false,
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
      ownRowCells: 188, ownRowProducts: 94, sizeRun: [], sizeRunExtra: ["S", "M"], sizeRunEmpty: true,
      imageUrl: null,
    },
    // A MEMBER of the (disarmed) group: no entry of its own, nothing in force,
    // folded into the group on the list and reachable from inside it.
    {
      key: "sneakers", label: "Sneakers", products: 1246, units: 16872, perSize: false,
      entry: null, effectiveEntry: null,
      armed: [], armedEffective: [], policySource: null, groupKey: null, groupLabel: null,
      memberOfGroup: "footwear-all",
      carriage: { hub2: { carries: true, products: 900, units: 9000 } },
      ownRowCells: 0, ownRowProducts: 0, sizeRun: ["5_5", "7", "8"], sizeRunExtra: [], sizeRunEmpty: false,
      imageUrl: null,
    },
    {
      key: "slides", label: "Slides", products: 51, units: 300, perSize: true,
      entry: { perSize: true, hub2: { target: 3, minQty: 1 } }, effectiveEntry: { perSize: true, hub2: { target: 3, minQty: 1 } },
      armed: ["hub2"], armedEffective: ["hub2"], policySource: "category", groupKey: null, groupLabel: null,
      memberOfGroup: "footwear-all",
      carriage: { hub2: { carries: true, products: 51, units: 300 } },
      ownRowCells: 0, ownRowProducts: 0, sizeRun: ["7", "8"], sizeRunExtra: [], sizeRunEmpty: false,
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
// The rendered TEXT under a test instance — what a person reads on a button —
// rather than its React children, which carry elements (and circular fibres).
const instText = (inst) => (inst.children || []).map((c) => (typeof c === "string" ? c : instText(c))).join(" ");
const buttonTextOf = (tree) => tree.root.findAll((n) => n.type === "button").map(instText).join(" ").toLowerCase();
const styleTag = (tree) => tree.root.findAllByType("style").map((n) => n.children.join("")).join("");

beforeEach(() => { callableMock.mockClear(); });

describe("the rebuilt screen", () => {
  it("lists categories and the Sneakers GROUP as ONE entry — members folded in, not listed", async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("Caps &amp; Beanies".replace("&amp;", "&"));
    expect(t).toContain("Sneakers");
    expect(t).toContain("7 categories");
    // ONE "Sneakers" row (the group), not two: the member category is inside it.
    const opens = tree.root.findAll((n) => n.type === "button" && /^Open /.test(n.props["aria-label"] || ""))
      .map((n) => n.props["aria-label"]);
    expect(opens.filter((l) => l === "Open Sneakers")).toHaveLength(1);
    expect(opens).not.toContain("Open Slides");
    // and there is no separate GROUPS section
    expect(t).not.toContain("Groups");
  });

  it("a group entry sorts in with everything else, and a disarmed one is not ranked as governed", async () => {
    const tree = await renderCard();
    const opens = tree.root.findAll((n) => n.type === "button" && /^Open /.test(n.props["aria-label"] || ""))
      .map((n) => n.props["aria-label"]);
    // Caps is governed (armed) → first band; the disarmed group has products → second.
    expect(opens.indexOf("Open Caps & Beanies")).toBeLessThan(opens.indexOf("Open Sneakers"));
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
    // accident. The check is on BUTTONS: the words "old rows" now name a chip
    // and a stat, and neither removes anything.
    const tree = await renderCard();
    const buttonText = buttonTextOf(tree);
    for (const word of ["clear", "delete", "remove"]) expect(buttonText).not.toContain(word);
  });

  it("shows the group as not armed — and carries no paragraph explaining it", async () => {
    const tree = await renderCard();
    const t = textOf(tree);
    expect(t).toContain("not armed");
    expect(t).not.toContain("cannot produce a single refill");
    expect(t).not.toContain("grouping never");
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

  it("opens a group to its member list, a member from inside it, and says in ONE line that own numbers win", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const t = textOf(tree);
    expect(t).toContain("A category's own numbers beat the group's.");
    expect(t).toContain("Open member Slides".replace("Open member ", "")); // the member row
    // the member with its own entry says so
    expect(t).toContain("own numbers");
    // tap the member
    const btn = tree.root.findAll((n) => n.type === "button" && n.props["aria-label"] === "Open member Sneakers")[0];
    await act(async () => { btn.props.onClick(); });
    const t2 = textOf(tree);
    expect(t2).toContain("Back to Sneakers");
    expect(t2).toContain("its own numbers");
    // Back returns to the GROUP, not the list
    const back = tree.root.findAll((n) => n.type === "button" && String(n.props.children) === "Back to Sneakers")[0];
    await act(async () => { back.props.onClick(); });
    expect(textOf(tree)).toContain("A category's own numbers beat the group's.");
  });

  it("a group's Preview and Save go through setGroup with the live group as the expectation — armed untouched", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const previewBtn = tree.root.findAll((n) => n.type === "button" && String(n.props.children) === "Preview")[0];
    callableMock.mockImplementationOnce(async () => ({ data: { ok: true, dryRun: true, armModel: { totalRequests: 3, totalUnits: 5, cap: 75, perMember: [] } } }));
    await act(async () => { previewBtn.props.onClick(); });
    const dry = callableMock.mock.calls.find((c) => c[0]?.action === "setGroup" && c[0]?.dryRun === true)?.[0];
    expect(dry).toBeTruthy();
    expect(dry.groupKey).toBe("footwear-all");
    expect(dry.group.armed).toBe(false);
    expect(dry.group.label).toBe("Sneakers");
    expect(dry.group.memberCategoryKeys).toHaveLength(7);
    expect(dry.group.policy.hub2.sizes["7"]).toEqual({ target: 2, minQty: 1 });
    // Not armed → the panel says so, and shows what arming would cost
    expect(textOf(tree)).toContain("Not armed");
    expect(textOf(tree)).toContain("Refills if armed");
    // Save
    const saveBtn = tree.root.findAll((n) => n.type === "button" && String(n.props.children) === "Save policy")[0];
    callableMock.mockImplementationOnce(async () => ({ data: { ok: true, action: "setGroup", noChange: true } }));
    await act(async () => { saveBtn.props.onClick(); });
    const save = callableMock.mock.calls.find((c) => c[0]?.action === "setGroup" && c[0]?.dryRun !== true)?.[0];
    expect(save).toBeTruthy();
    expect(save.expectedBefore).toEqual(CENSUS.groupEntries[0].group);
    expect(save.group.armed).toBe(false);
    // and NO category write happened for any member
    expect(callableMock.mock.calls.some((c) => c[0]?.categoryKey && "policy" in (c[0] || {}))).toBe(false);
  });

  it("expands a sized category into one row per size, in size order", async () => {
    const tree = await renderCard();
    await openFirst(tree, "Sneakers");
    const labels = tree.root.findAll((n) => n.type === "input")
      .map((n) => n.props["aria-label"]).filter((l) => /Hub 2 .* Keep$/.test(l || ""));
    expect(labels).toEqual(["Hub 2 5.5 Keep", "Hub 2 7 Keep", "Hub 2 8 Keep"]);
  });

  it("refuses a per-size editor when the size run cannot be derived", async () => {
    const c = { ...CENSUS, categories: [], groupEntries: [{ ...CENSUS.groupEntries[0], sizeRun: [], sizeRunEmpty: true }] };
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
    const buttonText = buttonTextOf(tree);
    for (const word of ["delete", "remove", "clear"]) expect(buttonText).not.toContain(word);
    expect(t).toContain("Rows are never deleted from this screen");
  });
});
