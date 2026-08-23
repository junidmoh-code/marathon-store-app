// ─── ASSISTANT LABEL FINDER — rendered: every token, one list, never empty ───
// (Owner spec 2026-08-23.) The finder lifted out of App.jsx, driven through
// the shared reader's props (the reader itself is proved in
// stock/TongueLabelReader.render.test.jsx and mounted for real in
// stock/labelReaderSurfaces.render.test.jsx). Proves:
//   1. a multi-token label pools EVERY token's owners into ONE CandidateCards
//      list, each row naming the number that found it — no auto-pick
//   2. exactly one owner over every token opens (nothing was hidden)
//   3. THE PANEL IS NEVER EMPTY: no owner → the closest rows under an honest
//      heading; free-text search sits BELOW and still works
//   4. an alias-only owner the server sweep names joins the same list
//   5. a failed sweep is SAID and a lone hit is not opened behind it
//   6. a code-less reading pools the alias store's candidates the same way
//   7. read-only: a tap selects; nothing is filed

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const lookupStyleClaim = vi.fn(async () => null);
const resolveAnyCodes = vi.fn(async () => ({ resolved: null, owners: [] }));
const matchLabelAlias = vi.fn(async () => ({ band: "low", candidates: [] }));
const fetchProductFollowingMerge = vi.fn(async () => null);
const addLabelAlias = vi.fn();
const recordLabelCodes = vi.fn();
vi.mock("../stock/hubCleanupStore", () => ({
  lookupStyleClaim: (...a) => lookupStyleClaim(...a),
  resolveAnyCodes: (...a) => resolveAnyCodes(...a),
  matchLabelAlias: (...a) => matchLabelAlias(...a),
  fetchProductFollowingMerge: (...a) => fetchProductFollowingMerge(...a),
  addLabelAlias: (...a) => addLabelAlias(...a),
  recordLabelCodes: (...a) => recordLabelCodes(...a),
}));
let readerProps = null;
vi.mock("../stock/TongueLabelReader", () => ({
  TongueLabelReader: (props) => { readerProps = props; return null; },
}));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));

const { default: AssistantLabelFinder } = await import("./AssistantLabelFinder.jsx");

const TIMBER = { id: "pTimber", name: "Timberland 6-Inch Wheat", styleCodeNormalised: "A6CWNEN3", photoUrl: "https://x/timber.jpg" };
const EURO = { id: "pEuro", name: "Timberland Euro Hiker Black", styleCodeNormalised: "A8425", photoUrl: "https://x/euro.jpg" };
const SPRINT = { id: "pSprint", name: "Timberland Sprint Trekker", styleCodeNormalised: "TB0A2Q1M", photoUrl: "https://x/sprint.jpg" };
const LACOSTER = { id: "pLW", name: "Lacoster white", styleCodeNormalised: "352890625", photoUrl: "https://x/lw.jpg" };
const ALIASED = { id: "pAliased", name: "Timberland Field Boot", styleCodeNormalised: null, photoUrl: "https://x/field.jpg" };
const NIKE = { id: "pNike", name: "Nike Dunk Low Panda", styleCodeNormalised: "DD1391100", photoUrl: "https://x/panda.jpg" };
const PRODUCTS = [TIMBER, EURO, SPRINT, LACOSTER, ALIASED, NIKE];

const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const textOf = (tr) => JSON.stringify(tr.toJSON());
const cards = (tr) => tr.root.findAll((n) => n.type === "div" && n.props.role === "button");
const cardFor = (tr, name) => cards(tr).filter((n) => textIn(n).includes(name))[0];

function mount() {
  const onFound = vi.fn();
  let tr;
  act(() => { tr = TestRenderer.create(<AssistantLabelFinder products={PRODUCTS} onFound={onFound} onClose={() => {}} />); });
  return { tr, onFound };
}

beforeEach(() => {
  vi.clearAllMocks();
  readerProps = null;
  lookupStyleClaim.mockImplementation(async () => null);
  resolveAnyCodes.mockImplementation(async () => ({ resolved: null, owners: [] }));
  matchLabelAlias.mockImplementation(async () => ({ band: "low", candidates: [] }));
  fetchProductFollowingMerge.mockImplementation(async () => null);
});

describe("every token, one list, nothing auto-picked", () => {
  it("two Timberland tokens → both owners in ONE CandidateCards list, each naming its number; onFound waits", async () => {
    const { tr, onFound } = mount();
    await act(async () => { await readerProps.onCode("A8425", { allCodes: ["A6CWNEN3", "A8425"], auto: true, modelName: null, tokens: null }); });
    expect(onFound).not.toHaveBeenCalled();
    const t = textOf(tr);
    expect(t).toContain("on more than one product — tap the right one");
    const timber = cardFor(tr, "Timberland 6-Inch Wheat");
    const euro = cardFor(tr, "Timberland Euro Hiker Black");
    expect(timber && euro).toBeTruthy();
    expect(textIn(timber)).toContain("found by A6CWNEN3");
    expect(textIn(euro)).toContain("found by A8425");
    // Photos are on the cards (the operator picks by photo).
    expect(timber.findAll((n) => n.type === "img").map((n) => n.props.src)).toContain("https://x/timber.jpg");
    // A tap selects exactly that product.
    await act(async () => { euro.props.onClick(); });
    expect(onFound).toHaveBeenCalledWith(EURO);
  });

  it("THE RECOVERY: a Lacoste label resolves the product holding ONLY the production code — one owner over every token opens", async () => {
    const { onFound } = mount();
    await act(async () => { await readerProps.onCode("45SMA0018", { allCodes: ["45SMA0018", "352890625"], auto: true }); });
    expect(onFound).toHaveBeenCalledWith(LACOSTER);
  });

  it("an alias-only owner the server sweep names joins the same list", async () => {
    resolveAnyCodes.mockImplementation(async () => ({ resolved: null, owners: [{ productId: "pAliased", code: "TB0A2Q1M", via: "alias" }] }));
    const { tr, onFound } = mount();
    await act(async () => { await readerProps.onCode("A8425", { allCodes: ["A8425", "TB0A2Q1M"], auto: true }); });
    expect(onFound).not.toHaveBeenCalled();
    expect(cardFor(tr, "Timberland Euro Hiker Black")).toBeTruthy();
    expect(cardFor(tr, "Timberland Field Boot")).toBeTruthy();
    expect(cardFor(tr, "Timberland Sprint Trekker")).toBeTruthy();
  });

  it("a FAILED sweep is said, and a lone local hit is NOT opened behind it", async () => {
    resolveAnyCodes.mockImplementation(async () => { throw new Error("index down"); });
    const { tr, onFound } = mount();
    await act(async () => { await readerProps.onCode("A8425", { allCodes: ["A8425", "ZZ9999999"], auto: true }); });
    expect(onFound).not.toHaveBeenCalled();
    expect(textOf(tr)).toContain("label-code index couldn't be reached");
    expect(cardFor(tr, "Timberland Euro Hiker Black")).toBeTruthy();
  });
});

describe("the panel is NEVER empty", () => {
  it("no owner anywhere → the closest rows under an honest heading, and name search below still works", async () => {
    const { tr, onFound } = mount();
    await act(async () => { await readerProps.onCode("ZZ9999999", { allCodes: ["ZZ9999999"], auto: false, modelName: null, tokens: null }); });
    expect(onFound).not.toHaveBeenCalled();
    const t = textOf(tr);
    expect(t).toContain("nothing matched closely, but these are the closest we have");
    expect(cards(tr).length).toBeGreaterThanOrEqual(Math.min(6, PRODUCTS.length));
    // Free-text search sits BELOW the suggestions and filters the catalogue.
    const search = tr.root.findAll((n) => n.type === "input" && /search by name/.test(n.props.placeholder || ""))[0];
    expect(search).toBeTruthy();
    expect(t.indexOf("closest we have")).toBeLessThan(t.indexOf("search by name"));
    await act(async () => { search.props.onChange({ target: { value: "Panda" } }); });
    const panda = cards(tr).filter((n) => textIn(n).includes("Nike Dunk Low Panda") && textIn(n).includes("name search"))[0];
    expect(panda).toBeTruthy();
    await act(async () => { panda.props.onClick(); });
    expect(onFound).toHaveBeenCalledWith(NIKE);
  });

  it("a near-miss (one digit off a registered code) ranks the relative first, honestly worded as close", async () => {
    const { tr } = mount();
    await act(async () => { await readerProps.onCode("DD1391-101", { allCodes: ["DD1391101"], auto: false }); });
    const t = textOf(tr);
    expect(t).toContain("but these are close");
    expect(cards(tr)[0] && textIn(cards(tr)[0])).toContain("Nike Dunk Low Panda");
  });

  it("a code-less reading pools the alias store's candidates the same way — MID band lists, never auto-opens", async () => {
    matchLabelAlias.mockImplementation(async () => ({ band: "mid", candidates: [{ productId: "pSprint", score: 0.6 }, { productId: "pTimber", score: 0.5 }] }));
    const { tr, onFound } = mount();
    await act(async () => { await readerProps.onTokens(["TIMBERLAND", "SPRINT", "TREKKER"], { modelName: null, tokens: ["TIMBERLAND", "SPRINT", "TREKKER"] }); });
    expect(onFound).not.toHaveBeenCalled();
    expect(textIn(cardFor(tr, "Timberland Sprint Trekker"))).toContain("found by this label's wording");
    expect(cardFor(tr, "Timberland 6-Inch Wheat")).toBeTruthy();
  });

  it("a code-less reading with NO alias match still fills the panel", async () => {
    const { tr } = mount();
    await act(async () => { await readerProps.onTokens(["GRIPSHOT", "MID", "2233SP2"], { modelName: "GRIPSHOT MID 2233SP2" }); });
    expect(cards(tr).length).toBeGreaterThan(0);
    expect(textOf(tr)).toMatch(/closest we have|these are close/);
  });
});

describe("read-only", () => {
  it("nothing is filed from the finder on any road", async () => {
    const { tr } = mount();
    await act(async () => { await readerProps.onCode("A8425", { allCodes: ["A6CWNEN3", "A8425"], auto: true }); });
    await act(async () => { cardFor(tr, "Timberland Euro Hiker Black").props.onClick(); });
    expect(addLabelAlias).not.toHaveBeenCalled();
    expect(recordLabelCodes).not.toHaveBeenCalled();
  });
});
