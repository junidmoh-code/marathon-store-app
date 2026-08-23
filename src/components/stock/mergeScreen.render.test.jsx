// ─── THE MERGE SCREEN — findable rows, and an outcome that is not a question ─
// Owner spec 2026-08-23, the two claims this suite exists to hold:
//
//   PART 2  every search row carries the PHOTO, the name, the style code and
//           every location with its quantity; the list is uncapped and paged;
//           a zero-stock / photoless / codeless footwear product is offered and
//           a non-footwear one is not; a code or an alias finds its product.
//
//   PART 5  the confirm screen STATES the outcome per location in plain words,
//           with before/after totals, and offers NO CHOICE and NO TOGGLE about
//           what happens to the stock.
//
// The real MergeProducts renders. The stores are boundaries: this suite must
// not be able to change what the count records or the identity map mean.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("./hubCleanupStore", () => ({
  fetchProductFollowingMerge: async () => null,
  lookupStyleClaim: async () => null,
  resolveAnyCodes: async () => ({ resolved: null, owners: [] }),
  matchLabelAlias: async () => ({ band: "low", candidates: [] }),
}));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
const mergeCall = vi.fn(async () => ({ data: { moved: [], removed: [], barcodesRepointed: [] } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => mergeCall(...a) }));
vi.mock("./TongueLabelReader.jsx", () => ({ TongueLabelReader: () => null }));
vi.mock("./CameraScanner.jsx", () => ({ default: () => null }));

// The identity map the screen sees — set per test, read by the hook mock.
let IDENTITY = {};
vi.mock("../../utils/labelIdentityStore", () => ({
  useLabelIdentity: () => ({ map: IDENTITY, ready: true }),
  invalidateIdentity: () => {},
}));

// The count state the confirm screen plans against.
let COUNTED = {};
vi.mock("./mergeDispositionStore", () => ({
  loadCountedFor: async ({ locations }) => ({
    countedByLoc: Object.fromEntries(locations.map((l) => [l, new Set(COUNTED[l] || [])])),
    failed: [],
  }),
}));

const { default: MergeProducts } = await import("./MergeProducts.jsx");

const sneaker = (id, name, over = {}) => ({ id, name, categoryKey: "sneakers", ...over });
const LOSER = sneaker("loser", "Lacoste Audyssor White Gray (dup)");
const TWIN = sneaker("twin", "Lacoste Audysol White", { photoUrl: "https://x/twin.jpg" });

const ALL_STOCK = {
  hub1: { loser: { "9": { qty: 6, v: 1 } }, twin: { "9": { qty: 17, v: 2 } } },
  central: { loser: { "9": { qty: 16, v: 1 } }, twin: { "9": { qty: 0, v: 1 } } },
  hub3: { twin: { "9": { qty: -2, v: 0 } } },
};
const REGISTRY = {
  hub1: { id: "hub1", label: "Hub 1" }, central: { id: "central", label: "Central" },
  hub3: { id: "hub3", label: "Hub 3" },
};

const textOf = (tr) => JSON.stringify(tr.toJSON());

// Walk the RENDERED tree (not the fiber tree — its props hold React elements
// that JSON.stringify cannot follow) and collect the host <button>s whose own
// text matches. toJSON keeps host props, so onClick is still callable.
function walk(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return; }
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
}
const flatText = (node) => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatText).join("");
  return flatText(node.children);
};
function buttonsSaying(tr, re) {
  const all = [];
  walk(tr.toJSON(), all);
  return all.filter((n) => n.type === "button" && re.test(flatText(n)));
}
function allButtons(tr) {
  const all = [];
  walk(tr.toJSON(), all);
  return all.filter((n) => n.type === "button");
}
function allOfType(tr, type) {
  const all = [];
  walk(tr.toJSON(), all);
  return all.filter((n) => n.type === type);
}

async function render(props) {
  let tr;
  await act(async () => {
    tr = TestRenderer.create(
      <MergeProducts initialLoser={LOSER} allStock={ALL_STOCK} registry={REGISTRY}
                     onClose={() => {}} onMerged={() => {}} {...props} />,
    );
  });
  return tr;
}

beforeEach(() => { IDENTITY = {}; COUNTED = {}; mergeCall.mockClear(); });

describe("the target list", () => {
  it("shows a zero-stock, photoless, codeless footwear product", async () => {
    const bare = sneaker("bare", "Puma Suede Classic");
    const tr = await render({ products: [bare] });
    expect(textOf(tr)).toContain("Puma Suede Classic");
    expect(textOf(tr)).toContain("No stock anywhere");
    expect(textOf(tr)).toContain("No style code on record");
  });

  it("does NOT show a non-footwear product for a footwear loser", async () => {
    const tr = await render({ products: [{ id: "t", name: "Nike Dri-FIT Tee", categoryKey: "t-shirts" }] });
    expect(textOf(tr)).not.toContain("Dri-FIT");
  });

  it("does NOT show a product that was already merged away", async () => {
    const tr = await render({ products: [sneaker("g", "Ghost Record", { mergedInto: "twin" }), TWIN] });
    expect(textOf(tr)).not.toContain("Ghost Record");
    expect(textOf(tr)).toContain("Lacoste Audysol White");
  });

  it("every row carries the photo, the name, the code and every location with its quantity", async () => {
    IDENTITY = { twin: { c: ["745SMA00421G"], a: [["LACOSTE", "AUDYSOL"]] } };
    const tr = await render({ products: [TWIN] });
    const json = textOf(tr);
    expect(tr.root.findAll((n) => n.type === "img" && n.props.src === "https://x/twin.jpg").length).toBe(1);
    expect(json).toContain("Lacoste Audysol White");
    expect(json).toContain("745SMA00421G");
    // The location chips themselves, not merely the strings somewhere on screen.
    const chips = allOfType(tr, "span").map(flatText);
    expect(chips).toContain("Hub 1 · 17");
    expect(chips).toContain("Hub 3 · -2");   // a negative cell is shown as a negative
    // Central holds ZERO of the twin, so it is not a location it holds stock at
    // — the row lists where the stock IS, not every location that ever had a cell.
    expect(json).not.toContain("Central");
  });

  it("is paged, not capped — a 100-product catalogue says how many more there are", async () => {
    const many = Array.from({ length: 100 }, (_, i) => sneaker(`p${i}`, `Air Force ${String(i).padStart(3, "0")}`));
    const tr = await render({ products: many });
    expect(textOf(tr)).toContain("100 products");
    expect(buttonsSaying(tr, /Show 40 more/).length).toBe(1);
    await act(async () => { buttonsSaying(tr, /Show 40 more/)[0].props.onClick(); });
    expect(textOf(tr)).toContain("showing 80");
    await act(async () => { buttonsSaying(tr, /Show 20 more/)[0].props.onClick(); });
    expect(buttonsSaying(tr, /Show \d+ more/).length).toBe(0);
    expect(textOf(tr)).toContain("showing 100");
  });

  it("searching a STYLE CODE finds its product", async () => {
    IDENTITY = { twin: { c: ["745SMA00421G"], a: [] } };
    const other = sneaker("o", "Adidas Samba OG");
    const tr = await render({ products: [TWIN, other] });
    const box = tr.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "745SMA004-21G" } }); });
    const json = textOf(tr);
    expect(json).toContain("Lacoste Audysol White");
    expect(json).not.toContain("Adidas Samba OG");
  });

  it("searching a LABEL ALIAS word finds its product", async () => {
    IDENTITY = { twin: { c: [], a: [["LACOSTE", "AUDYSOL", "ELITE"]] } };
    const tr = await render({ products: [TWIN, sneaker("o", "Adidas Samba OG")] });
    const box = tr.root.findAll((n) => n.type === "input")[0];
    await act(async () => { box.props.onChange({ target: { value: "audysol" } }); });
    expect(textOf(tr)).toContain("Lacoste Audysol White");
    expect(textOf(tr)).not.toContain("Adidas Samba OG");
  });
});

describe("the confirm screen states the outcome and asks nothing", () => {
  const openConfirm = async () => {
    COUNTED = { hub1: ["twin::9"], central: [] };
    const tr = await render({ products: [TWIN], initialSurvivor: TWIN });
    await act(async () => {});   // let the plan land
    return tr;
  };

  it("says what will be REMOVED and what will MOVE ACROSS, per location", async () => {
    const tr = await openConfirm();
    const json = textOf(tr);
    expect(json).toContain("6 at Hub 1 will be removed — already counted under this product");
    expect(json).toContain("16 at Central will move across");
  });

  it("shows the per-location totals before and after, as one composed line", async () => {
    // Asserting the individual numbers was VACUOUS: "17" is also the stock
    // chip, "16" is also the outcome sentence, and "0" matches any inline
    // style number in the serialised tree. Deleting the whole totals line
    // still passed. The composed string can only come from that line.
    const tr = await openConfirm();
    const lines = [...allOfType(tr, "div"), ...allOfType(tr, "span")].map(flatText);
    // A removal: the survivor's total at Hub 1 does NOT move.
    expect(lines.some((l) => l.includes("Lacoste Audysol White at Hub 1: 17 → 17"))).toBe(true);
    // A transfer: Central goes 0 → 16.
    expect(lines.some((l) => l.includes("Lacoste Audysol White at Central: 0 → 16"))).toBe(true);
    // And the loser ends at zero at both.
    expect(lines.some((l) => l.includes("Lacoste Audyssor White Gray (dup): 6 → 0"))).toBe(true);
    expect(lines.some((l) => l.includes("Lacoste Audyssor White Gray (dup): 16 → 0"))).toBe(true);
  });

  it("offers NO choice and NO toggle about what happens to the stock", async () => {
    const tr = await openConfirm();
    const labels = allButtons(tr).map(flatText);
    // Every button on the confirm is navigation or the single commit — nothing
    // that lets the operator pick remove-vs-transfer.
    for (const l of labels) {
      expect(l).not.toMatch(/keep|remove instead|move instead|transfer instead|choose what|write off/i);
    }
    expect(allOfType(tr, "input").filter((n) => n.props.type === "checkbox").length).toBe(0);
    expect(allOfType(tr, "input").filter((n) => n.props.type === "radio").length).toBe(0);
    expect(allOfType(tr, "select").length).toBe(0);
  });

  it("still shows EVERY stock cell of both products — the visual confirm is intact", async () => {
    const tr = await openConfirm();
    const lines = [...allOfType(tr, "div"), ...allOfType(tr, "span")].map(flatText);
    // the loser's cells
    expect(lines).toContain("Hub 1 · 6");
    expect(lines).toContain("Central · 16");
    // the survivor's cells
    expect(lines).toContain("Hub 1 · 17");
    expect(lines).toContain("Hub 3 · -2");
  });

  it("commits with the two ids and nothing else — the server decides again", async () => {
    const tr = await openConfirm();
    const commit = buttonsSaying(tr, /MERGE — one product remains/)[0];
    await act(async () => { commit.props.onClick(); });
    expect(mergeCall).toHaveBeenCalledTimes(1);
    expect(mergeCall.mock.calls[0][0]).toEqual({ loserId: "loser", survivorId: "twin" });
  });

  it("will not commit before the outcome has been worked out", async () => {
    let resolvePlan;
    // A plan that never lands: the button must stay disabled and say so.
    const mod = await import("./mergeDispositionStore");
    const spy = vi.spyOn(mod, "loadCountedFor").mockImplementation(
      () => new Promise((r) => { resolvePlan = r; }),
    );
    const tr = await render({ products: [TWIN], initialSurvivor: TWIN });
    const waiting = buttonsSaying(tr, /Working out what happens/);
    expect(waiting.length).toBe(1);
    expect(waiting[0].props.disabled).toBe(true);
    spy.mockRestore();
    if (resolvePlan) resolvePlan({ countedByLoc: {}, failed: [] });
  });
});

describe("when the outcome cannot be worked out", () => {
  it("never claims the loser holds no stock, and refuses to commit", async () => {
    const mod = await import("./mergeDispositionStore");
    const spy = vi.spyOn(mod, "loadCountedFor").mockRejectedValue(new Error("denied"));
    let tr;
    await act(async () => {
      tr = TestRenderer.create(
        <MergeProducts initialLoser={LOSER} initialSurvivor={TWIN} products={[TWIN]}
                       allStock={ALL_STOCK} registry={REGISTRY}
                       onClose={() => {}} onMerged={() => {}} />,
      );
    });
    await act(async () => {});
    const json = textOf(tr);
    // The sentence that would have been a lie: this loser holds 22 units.
    expect(json).not.toContain("holds no stock anywhere");
    expect(json).toContain("The outcome could not be worked out");
    const commit = buttonsSaying(tr, /Can.t merge/);
    expect(commit.length).toBe(1);
    expect(commit[0].props.disabled).toBe(true);
    expect(buttonsSaying(tr, /MERGE — one product remains/).length).toBe(0);
    await act(async () => { commit[0].props.onClick?.(); });
    expect(mergeCall).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
