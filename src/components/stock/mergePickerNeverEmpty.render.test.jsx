// ─── MERGE TARGET PICKER — the shared cards, never empty, an honest escape ───
// (Owner spec 2026-08-23.) Extends mergePickerCamera.render.test.jsx (which
// proves the port of the reader and the pooled gather). This file proves the
// three things that pass added:
//   1. rows render through the SHARED CandidateCards (photo, name, the number
//      that found it) — the same renderer the count, gate and finder use
//   2. THE PANEL IS NEVER EMPTY: a label nothing owns still lists the closest
//      catalogue rows under an honest heading; name search stays below
//   3. "It's not one of these — show me everything" opens the full list
//      (paged), and the loser is never offered
//   4. a code-less reading with no alias match also fills the panel

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const lookupStyleClaim = vi.fn(async () => null);
const resolveAnyCodes = vi.fn(async () => ({ resolved: null, owners: [] }));
const matchLabelAlias = vi.fn(async () => ({ band: "low", candidates: [] }));
const fetchProductFollowingMerge = vi.fn(async () => null);
vi.mock("./hubCleanupStore", () => ({
  fetchProductFollowingMerge: (...a) => fetchProductFollowingMerge(...a),
  lookupStyleClaim: (...a) => lookupStyleClaim(...a),
  resolveAnyCodes: (...a) => resolveAnyCodes(...a),
  matchLabelAlias: (...a) => matchLabelAlias(...a),
}));
const mergeCall = vi.fn(async () => ({ data: { moved: [], barcodesRepointed: [] } }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => mergeCall(...a) }));
let readerProps = null;
vi.mock("./TongueLabelReader.jsx", () => ({ TongueLabelReader: (props) => { readerProps = props; return null; } }));
vi.mock("./CameraScanner.jsx", () => ({ default: () => null }));

const { default: MergeProducts } = await import("./MergeProducts.jsx");
const { default: CandidateCards } = await import("../shared/CandidateCards.jsx");

const LOSER = { id: "pDup", name: "timberland boot (dup)", photoUrl: "https://x/dup.jpg" };
const TIMBER = { id: "pTimber", name: "Timberland 6-Inch Wheat", styleCodeNormalised: "A6CWNEN3", photoUrl: "https://x/timber.jpg" };
const EURO = { id: "pEuro", name: "Timberland Euro Hiker Black", styleCodeNormalised: "A8425", photoUrl: "https://x/euro.jpg" };
const OTHERS = Array.from({ length: 50 }, (_, i) => ({ id: `pO${i}`, name: `Other Shoe ${i}`, styleCodeNormalised: null, photoUrl: null }));
const PRODUCTS = [LOSER, TIMBER, EURO, ...OTHERS];

const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const textOf = (tr) => JSON.stringify(tr.toJSON());
const cards = (tr) => tr.root.findAll((n) => n.type === "div" && n.props.role === "button");
const cardFor = (tr, name) => cards(tr).filter((n) => textIn(n).includes(name))[0];
const buttonWith = (tr, needle) => tr.root.findAll((n) => n.type === "button" && textIn(n).includes(needle))[0];

function mount() {
  let tr;
  act(() => {
    tr = TestRenderer.create(<MergeProducts initialLoser={LOSER} products={PRODUCTS} allStock={{}} registry={{}} onClose={() => {}} onMerged={() => {}} />);
  });
  return tr;
}
beforeEach(() => {
  vi.clearAllMocks();
  readerProps = null;
  lookupStyleClaim.mockImplementation(async () => null);
  resolveAnyCodes.mockImplementation(async () => ({ resolved: null, owners: [] }));
  matchLabelAlias.mockImplementation(async () => ({ band: "low", candidates: [] }));
});

describe("the shared cards", () => {
  it("rows are CandidateCards — photo, name, and the number that found each", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A8425", { allCodes: ["A6CWNEN3", "A8425"], auto: true }); });
    expect(tr.root.findAllByType(CandidateCards).length).toBeGreaterThanOrEqual(1);
    const timber = cardFor(tr, "Timberland 6-Inch Wheat");
    expect(timber).toBeTruthy();
    expect(timber.findAll((n) => n.type === "img").map((n) => n.props.src)).toContain("https://x/timber.jpg");
    expect(textIn(timber)).toContain("found by A6CWNEN3");
    expect(textIn(cardFor(tr, "Timberland Euro Hiker Black"))).toContain("found by A8425");
    expect(textOf(tr)).toContain("found 2 products — tap the right one");
    // Nothing advanced: no survivor yet.
    expect(textOf(tr)).not.toContain("SURVIVES");
  });
});

describe("never empty", () => {
  it("a label nothing owns still lists the closest rows under an honest heading; name search stays below", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("ZZ9999999", { allCodes: ["ZZ9999999"], auto: false }); });
    const t = textOf(tr);
    expect(t).toContain("Nothing matched this label closely — these are the closest we have");
    expect(cards(tr).length).toBeGreaterThanOrEqual(8);
    // The loser is never one of them.
    expect(cardFor(tr, "timberland boot (dup)")).toBeUndefined();
    // Search is below the rows.
    const search = tr.root.findAll((n) => n.type === "input" && /search by name/.test(n.props.placeholder || ""))[0];
    expect(search).toBeTruthy();
    expect(t.indexOf("closest we have")).toBeLessThan(t.indexOf("search by name"));
  });

  it("a code-less reading with no alias match also fills the panel", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onTokens(["TIMBERLAND", "MOTION", "GTX"], { modelName: "TIMBERLAND MOTION 6 MID GTX" }); });
    expect(cards(tr).length).toBeGreaterThanOrEqual(8);
    // The word tier surfaces the Timberlands on top (name match), not random fillers.
    expect(textIn(cards(tr)[0])).toMatch(/Timberland/);
  });

  it("\"It's not one of these — show me everything\" opens the full list, paged, without the loser", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A8425", { allCodes: ["A8425"], auto: false }); });
    const esc = buttonWith(tr, "show me everything");
    expect(esc).toBeTruthy();
    await act(async () => { esc.props.onClick(); });
    const t = textOf(tr);
    expect(t).toContain("Everything else");
    // The first page shows 40; the rest waits behind "Show more".
    const more = buttonWith(tr, "Show more");
    expect(more).toBeTruthy();
    const before = cards(tr).length;
    await act(async () => { more.props.onClick(); });
    expect(cards(tr).length).toBeGreaterThan(before);
    expect(cardFor(tr, "timberland boot (dup)")).toBeUndefined();
    // Tapping a row from the full list still reaches the confirm screen.
    await act(async () => { cardFor(tr, "Other Shoe 49").props.onClick(); });
    expect(textOf(tr)).toContain("SURVIVES");
  });
});
