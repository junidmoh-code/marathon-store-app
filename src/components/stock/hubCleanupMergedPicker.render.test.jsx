// ─── THE COUNT USES THE ADMIN PICKER — no token is auto-picked (2026-08-15) ──
// THE DEFECT: a label carrying two or three style-shaped numbers was read in
// full, ONE token was auto-picked (a learned layout rule, or tier 2's own
// preference), and the count then resolved against that token alone. Everything
// the label's OTHER numbers owned was invisible — the operator was shown one
// product and no sign that a second existed.
//
// The admin intake gate never had this problem: its candidate list is built
// from the token SET while the auto-pick only fills the text field. This suite
// proves the port. The real component renders; these are wiring claims:
//
//   1. THREE tokens → ONE list holding candidates from all three.
//   2. NO AUTO-PICK: the picked token owning exactly one product no longer
//      short-circuits when another token owns another product.
//   3. Every row carries the product PHOTO, the name, and the number that
//      found it.
//   4. "It's not one of these — show me everything" opens the full list.
//   5. A pick files every token through the existing recordLabelCodes door,
//      and the next scan then resolves silently.
//   6. Every existing fallback survives on the far side of that escape.
//   7. A single-token label is byte-for-byte the road it always was.
//   8. Exactly one candidate across every token still resolves in one step.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const lookupStyleClaim = vi.fn(async () => null);
const lookupCodeAlias = vi.fn(async () => null);
const resolveAnyCodes = vi.fn(async () => ({ resolved: null, owners: [] }));
const recordLabelCodes = vi.fn(async () => ({ ok: true, attached: [], conflicts: [] }));
const recordUnresolvedScan = vi.fn(async () => ({ ok: true }));
const matchLabelAlias = vi.fn(async () => ({ band: "low", candidates: [] }));
const fetchProductFollowingMerge = vi.fn(async () => null);

vi.mock("./hubCleanupStore", () => ({
  loadRegister: async () => ({}),
  loadUnresolved: async () => ({}),
  registerDisplayUnit: async () => ({ ok: true }),
  addExtraDisplayUnit: async () => ({ ok: true }),
  recordUnresolvedScan: (...a) => recordUnresolvedScan(...a),
  lookupBarcode: async () => null,
  loadAllStock: async () => ({}),
  loadDuplicateCandidates: async () => ({}),
  fetchProductFollowingMerge: (...a) => fetchProductFollowingMerge(...a),
  lookupStyleClaim: (...a) => lookupStyleClaim(...a),
  matchLabelAlias: (...a) => matchLabelAlias(...a),
  addLabelAlias: async () => ({ ok: true }),
  answerStyleCodeSibling: async () => ({}),
  lookupCodeAlias: (...a) => lookupCodeAlias(...a),
  resolveAnyCodes: (...a) => resolveAnyCodes(...a),
  recordLabelCodes: (...a) => recordLabelCodes(...a),
  fetchColourwayAnswers: async () => [],
  recordColourwayAnswer: async () => ({}),
  unresolvedScanKey: (code) => String(code ?? "").replace(/[.#$/\[\]\s]/g, "_").slice(0, 64) || "_",
  REGISTER_REASON: "display_registration",
}));
vi.mock("./hubCountStore", () => ({
  loadHubStock: async () => ({}),
  openOrResumeSession: async () => ({ sessionId: "s1" }),
  loadCounted: async () => ({}),
  publishSessionTotal: async () => {},
  confirmCell: async () => ({ ok: true, record: {} }),
  adjustCell: async () => ({ ok: true, record: {} }),
  flagCell: async () => ({ ok: true, record: {} }),
  useLocationRegistryOnce: () => ({}),
  rememberHub: () => {},
  rememberedHub: () => "hub1",
}));
vi.mock("./offShelf", () => ({
  loadOffShelfSources: async () => ({ laybyItems: 0, slots: {}, register: {}, readyCells: {} }),
  offShelfForCell: () => ({ total: 0, parts: [] }),
  expectedOnShelf: (b) => Number(b) || 0,
}));
vi.mock("./displaySlots", () => ({ loadDisplaySlots: async () => ({}) }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));
vi.mock("../../update/updateChecker", () => ({ setUpdateBusy: () => {} }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: null }) }));
vi.mock("../../config/hubSneakerCount", () => ({ canAdjustHubCount: () => false }));

let readerProps = null;
vi.mock("./TongueLabelReader.jsx", () => ({
  TongueLabelReader: (props) => { readerProps = props; return null; },
}));
vi.mock("./CameraScanner.jsx", () => ({ default: () => null }));
vi.mock("./MergeProducts.jsx", () => ({ default: () => null }));
vi.mock("./HubSneakerCount.jsx", () => ({ default: () => null }));

const { default: HubCleanup } = await import("./HubCleanup.jsx");

// The owner's live case: a Timberland tongue label printing BOTH A6CWNEN3 and
// A8425. Each number is registered to a different product.
const TIMBER = { id: "pTimber", name: "Timberland 6-Inch Wheat", styleCodeNormalised: "A6CWNEN3",
                 sizes: { a: "8" }, photoUrl: "https://x/timber.jpg" };
const EURO = { id: "pEuro", name: "Timberland Euro Hiker Black", styleCodeNormalised: "A8425",
               sizes: { a: "8" }, photoUrl: "https://x/euro.jpg" };
const SPRINT = { id: "pSprint", name: "Timberland Sprint Trekker", styleCodeNormalised: "TB0A2Q1M",
                 sizes: { a: "8" }, photoUrl: "https://x/sprint.jpg" };
// Owned ONLY through the alias store — no local stamp, so nothing but the
// server sweep can see it.
const ALIASED = { id: "pAliased", name: "Timberland Field Boot", styleCodeNormalised: null,
                  sizes: { a: "8" }, photoUrl: "https://x/field.jpg" };

const PRODUCTS = [TIMBER, EURO, SPRINT, ALIASED];

// What the reader hands over after auto-picking A6CWNEN3 off a two-number label.
const TWO_TOKENS = { allCodes: ["A6CWNEN3", "A8425"], auto: true, modelName: null, tokens: null };
const THREE_TOKENS = { allCodes: ["A6CWNEN3", "A8425", "TB0A2Q1M"], auto: true, modelName: null, tokens: null };

const textOf = (tr) => JSON.stringify(tr.toJSON());
// Test-instance text, not element JSON — React elements are circular.
const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const buttonWith = (tr, needle) =>
  tr.root.findAll((n) => n.type === "button" && textIn(n).includes(needle))[0];
// A card is a role="button" div (shared/CandidateCards) or a real <button>
// (the link panel's rows) — either way, the row that names this product.
const rowFor = (tr, name) =>
  tr.root.findAll((n) => (n.props?.role === "button" || n.type === "button") && textIn(n).includes(name))[0];

async function mountOnCountTab() {
  let tr;
  await act(async () => {
    tr = TestRenderer.create(<HubCleanup products={PRODUCTS} actorRole="warehouse" viewer={{}} />);
  });
  const countTab = tr.root.findAll((n) => n.type === "button" && n.children.join("") === "Count")[0];
  await act(async () => { countTab.props.onClick(); });
  expect(readerProps).toBeTruthy();
  return tr;
}

beforeEach(() => {
  vi.clearAllMocks();
  readerProps = null;
  lookupStyleClaim.mockImplementation(async () => null);
  lookupCodeAlias.mockImplementation(async () => null);
  resolveAnyCodes.mockImplementation(async () => ({ resolved: null, owners: [] }));
  recordLabelCodes.mockImplementation(async () => ({ ok: true, attached: [], conflicts: [] }));
  matchLabelAlias.mockImplementation(async () => ({ band: "low", candidates: [] }));
  fetchProductFollowingMerge.mockImplementation(async () => null);
});

describe("the count flow no longer auto-picks a token", () => {
  it("NO AUTO-PICK: the picked token owns a product, but the other token's product is shown too", async () => {
    // THE BUG, DIRECTLY. A6CWNEN3 is stamped on pTimber, so every branch of
    // the old chain returned at the first hit and pEuro — the owner of the
    // OTHER number on the very same label — was never gathered.
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("A6CWNEN3", TWO_TOKENS); });
    const after = textOf(tr);

    expect(after).toContain("This label's numbers name more than one product");
    expect(after).toContain("Timberland 6-Inch Wheat");
    expect(after).toContain("Timberland Euro Hiker Black");
    // The count panel resolves a product outright; it must NOT have opened.
    expect(after).not.toContain("Count this size");
    // Nothing was decided for the operator.
    expect(recordLabelCodes).not.toHaveBeenCalled();
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("THREE tokens produce ONE list holding candidates from all three", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("A6CWNEN3", THREE_TOKENS); });
    const after = textOf(tr);
    expect(after).toContain("Timberland 6-Inch Wheat");
    expect(after).toContain("Timberland Euro Hiker Black");
    expect(after).toContain("Timberland Sprint Trekker");
    expect(after).toContain("name more than one product");
    // ONE list, not three panels: the header counts the whole set. The phrase,
    // not the bare digit — textOf serialises inline styles too, so "3" alone
    // matches a font size and pins nothing (CodeRabbit, PR #371).
    expect(after).toContain("\"3\",\" products\"");
    // Each of the three numbers is named on its own row.
    expect(after).toContain("matched A6CWNEN3");
    expect(after).toContain("matched A8425");
    expect(after).toContain("matched TB0A2Q1M");
  });

  it("EVERY row carries the photo, the name and the number that found it", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("A6CWNEN3", TWO_TOKENS); });
    const after = textOf(tr);
    expect(after).toContain("https://x/timber.jpg");
    expect(after).toContain("https://x/euro.jpg");
    expect(after).toContain("matched A6CWNEN3");
    expect(after).toContain("matched A8425");
    // Large enough to judge a shoe by — the whole reason the operator picks
    // from photos rather than codes.
    expect(after).toContain('"width":120,"height":120');
  });

  it("an ALIAS-ONLY owner of the other token reaches the same list", async () => {
    // pAliased carries no code at all; only the server's any-token sweep can
    // see that A8425 identifies it. It must land in the same merged list.
    resolveAnyCodes.mockImplementation(async () => ({
      resolved: null, owners: [{ productId: "pAliased", code: "A8425", via: "alias" }],
    }));
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("A6CWNEN3", TWO_TOKENS); });
    const after = textOf(tr);
    expect(after).toContain("Timberland 6-Inch Wheat");
    expect(after).toContain("Timberland Field Boot");
    // The sweep carries the WHOLE token set — one question for the label.
    expect(resolveAnyCodes.mock.calls[0][0].sort()).toEqual(["A6CWNEN3", "A8425"]);
  });

  it("ONE candidate across every token still resolves in one step, and files every token", async () => {
    // Only A8425 is registered, to pEuro; A6CWNEN3 belongs to nobody. One
    // unambiguous answer — it resolves as it always did, no question asked.
    const tr = await mountOnCountTab();
    await act(async () => {
      await readerProps.onCode("ZZZ9999", { allCodes: ["ZZZ9999", "A8425"], auto: true, modelName: null, tokens: null });
    });
    const after = textOf(tr);
    expect(after).toContain("Timberland Euro Hiker Black");
    expect(after).not.toContain("name more than one product");
    expect(after).not.toContain("link it");
    expect(recordLabelCodes).toHaveBeenCalledWith({
      productId: "pEuro", chosenCode: "ZZZ9999", otherCodes: ["A8425"],
    });
  });

  it("the \"Linked\" toast is never a claim nothing backs (CodeRabbit, PR #371)", async () => {
    // A read whose `display` is ABSENT from meta.allCodes, with one code in
    // it: the token SET still has two members, so the merged branch runs and
    // resolves via the other number — and the toast says "Linked; the next
    // scan resolves by itself". Gating the filing on meta.allCodes.length > 1
    // made that a lie: nothing was recorded and the next scan asked again.
    const tr = await mountOnCountTab();
    await act(async () => {
      await readerProps.onCode("ZZZ9999", { allCodes: ["A8425"], auto: true, modelName: null, tokens: null });
    });
    const after = textOf(tr);
    expect(after).toContain("Timberland Euro Hiker Black");
    expect(after).toContain("Linked; the next scan resolves by itself");
    expect(recordLabelCodes).toHaveBeenCalledWith({
      productId: "pEuro", chosenCode: "ZZZ9999", otherCodes: ["A8425"],
    });
  });

  it("a SINGLE-token label is the road it always was — no sweep, no picker", async () => {
    const tr = await mountOnCountTab();
    await act(async () => {
      await readerProps.onCode("A6CWNEN3", { allCodes: ["A6CWNEN3"], modelName: null, tokens: null });
    });
    expect(resolveAnyCodes).not.toHaveBeenCalled();
    const after = textOf(tr);
    expect(after).toContain("Timberland 6-Inch Wheat");
    expect(after).not.toContain("name more than one product");
  });
});

describe("the pick, and what it files", () => {
  it("a tap files EVERY token as an identity of the picked product, then counts it", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("A6CWNEN3", TWO_TOKENS); });
    const row = rowFor(tr, "Timberland 6-Inch Wheat");
    await act(async () => { row.props.onClick(); });

    expect(recordLabelCodes).toHaveBeenCalledWith({
      productId: "pTimber", chosenCode: "A6CWNEN3", otherCodes: ["A8425"],
    });
    expect(textOf(tr)).toContain("Timberland 6-Inch Wheat");
  });

  it("after the filing, the next scan of the same label resolves SILENTLY", async () => {
    // A label whose numbers nobody owns yet — the road that used to dead-end.
    const FRESH = { allCodes: ["ZZZ0001", "ZZZ0002"], auto: true, modelName: null, tokens: null };
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("ZZZ0001", FRESH); });
    expect(textOf(tr)).toContain("link it");

    // The operator finds the shoe and taps it. ONE alias write, every token.
    const search = tr.root.findAll((n) => n.type === "input"
      && n.props.placeholder === "This is the same shoe as…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Euro Hiker" } }); });
    await act(async () => { await rowFor(tr, "Timberland Euro Hiker Black").props.onClick(); });
    expect(recordLabelCodes).toHaveBeenCalledWith({
      productId: "pEuro", chosenCode: "ZZZ0001", otherCodes: ["ZZZ0002"],
    });

    // Scan two: the alias store now answers, so nothing is asked at all.
    resolveAnyCodes.mockImplementation(async () => ({
      resolved: "pEuro", owners: [{ productId: "pEuro", code: "ZZZ0002", via: "alias" }],
    }));
    await act(async () => { await readerProps.onCode("ZZZ0001", FRESH); });
    const after = textOf(tr);
    expect(after).toContain("Timberland Euro Hiker Black");
    expect(after).not.toContain("name more than one product");   // no question this time
    expect(after).not.toContain("link it");
  });
});

describe("\"it's not one of these\" — the escape, and every fallback behind it", () => {
  async function openTheFullList() {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("A6CWNEN3", TWO_TOKENS); });
    const escape = buttonWith(tr, "show me everything");
    expect(escape).toBeTruthy();
    await act(async () => { escape.props.onClick(); });
    return tr;
  }

  it("opens the full list, and does not pretend nothing owns the label", async () => {
    const tr = await openTheFullList();
    const after = textOf(tr);
    expect(after).toContain("Everything close to this label");
    // The claim on the dead-end road would be a lie here — something DOES own
    // one of these numbers, the operator just said it isn't their shoe.
    expect(after).not.toContain("isn't registered to any product");
  });

  it("the full list still holds the exact owners the picker had shown, AS exact owners", async () => {
    const tr = await openTheFullList();
    const after = textOf(tr);
    expect(after).toContain("Timberland 6-Inch Wheat");
    expect(after).toContain("Timberland Euro Hiker Black");
    // Not merely present as a padded "closest we have" filler — the panel's
    // dead-end road drops confirmed exact owners on purpose (they resolve
    // before it opens). Here they must be carried, and carried as what they
    // are, or the escape is a NARROWER list than the picker it replaced.
    const timberRow = rowFor(tr, "Timberland 6-Inch Wheat");
    expect(textIn(timberRow)).toContain("already registered with exactly this code");
    // Strongest evidence sorts first (exact scores above every other tier).
    const rankedNames = tr.root.findAll((n) => n.type === "button" && textIn(n).includes("Link →"))
      .map((n) => textIn(n));
    expect(rankedNames[0]).toContain("Timberland 6-Inch Wheat");
  });

  it("the pooled ranking names WHICH token found each row", async () => {
    const tr = await openTheFullList();
    expect(textOf(tr)).toContain("other token A8425");
  });

  it("FALLBACK — free search by name survives", async () => {
    const tr = await openTheFullList();
    const search = tr.root.findAll((n) => n.type === "input"
      && n.props.placeholder === "This is the same shoe as…")[0];
    expect(search).toBeTruthy();
    await act(async () => { search.props.onChange({ target: { value: "Sprint" } }); });
    expect(textOf(tr)).toContain("Timberland Sprint Trekker");
  });

  it("FALLBACK — \"genuinely not in the catalogue\" survives, and still notes the scan", async () => {
    const tr = await openTheFullList();
    const note = buttonWith(tr, "genuinely not in the catalogue");
    expect(note).toBeTruthy();
    await act(async () => { await note.props.onClick(); });
    expect(recordUnresolvedScan).toHaveBeenCalledWith(
      expect.objectContaining({ hub: "hub1", code: "A6CWNEN3", context: "count" }));
  });

  it("FALLBACK — picking from the full list files through the SAME alias door", async () => {
    const tr = await openTheFullList();
    const row = rowFor(tr, "Timberland Euro Hiker Black");
    await act(async () => { await row.props.onClick(); });
    expect(recordLabelCodes).toHaveBeenCalledWith({
      productId: "pEuro", chosenCode: "A6CWNEN3", otherCodes: ["A8425"],
    });
  });

  it("the OTHER answer survives beside it — \"it's a new colourway\" is still its own button", async () => {
    // The two are different answers. "Show me everything" says the shoe is
    // probably in the catalogue; "new colourway" says it is not. Losing the
    // second would turn an incomplete list into the only possible answer.
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("A6CWNEN3", TWO_TOKENS); });
    const newColourway = buttonWith(tr, "it's a new colourway");
    expect(newColourway).toBeTruthy();
    await act(async () => { await newColourway.props.onClick(); });
    expect(recordUnresolvedScan).toHaveBeenCalledWith(
      expect.objectContaining({ code: "A6CWNEN3 (new colourway)", context: "count" }));
  });
});
