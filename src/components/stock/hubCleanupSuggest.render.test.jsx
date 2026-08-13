// ─── THE LINK PANEL OPENS WITH SUGGESTIONS — never blank (owner spec
// 2026-08-13) ── the real component renders; the claims are WIRING claims:
//
//   1. A scan one code family away opens the panel WITH the family on screen
//      before the operator types anything — photo, name, code and the reason
//      all rendered.
//   2. Tapping a suggestion files through the EXISTING recordLabelCodes door
//      and counting continues — and NOTHING files before the tap: opening the
//      panel writes nothing (suggest, never decide).
//   3. The label's printed model name (meta.modelName) becomes suggestions.
//   4. A token reading's below-band match candidates — previously discarded —
//      surface as suggestions; the tap files addLabelAlias with the tokens.
//   5. A code with no plausible relative STILL fills the panel — the closest
//      catalogue rows under the honest "nothing matched closely" heading
//      (owner spec 2026-08-13: a blank panel sends the operator back to name
//      search, the duplicate-creating move) — and the name search still works.
//   6. "Note as never registered" stays available below the suggestions.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const lookupStyleClaim = vi.fn(async () => null);
const lookupCodeAlias = vi.fn(async () => null);
const recordLabelCodes = vi.fn(async () => ({ ok: true, attached: [], conflicts: [] }));
const addLabelAlias = vi.fn(async () => ({ ok: true }));
const recordUnresolvedScan = vi.fn(async () => ({ ok: true }));
const matchLabelAlias = vi.fn(async () => ({ band: "low", candidates: [] }));
const registerDisplayUnit = vi.fn(async () => ({ ok: true }));

vi.mock("./hubCleanupStore", () => ({
  loadRegister: async () => ({}),
  loadUnresolved: async () => ({}),
  registerDisplayUnit: (...a) => registerDisplayUnit(...a),
  addExtraDisplayUnit: async () => ({ ok: true }),
  recordUnresolvedScan: (...a) => recordUnresolvedScan(...a),
  lookupBarcode: async () => null,
  loadAllStock: async () => ({}),
  loadDuplicateCandidates: async () => ({}),
  fetchProductFollowingMerge: async () => null,
  lookupStyleClaim: (...a) => lookupStyleClaim(...a),
  matchLabelAlias: (...a) => matchLabelAlias(...a),
  addLabelAlias: (...a) => addLabelAlias(...a),
  answerStyleCodeSibling: async () => ({}),
  lookupCodeAlias: (...a) => lookupCodeAlias(...a),
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

// The five live Gripshot records, ids and codes verbatim from the catalogue.
const GRIPSHOTS = [
  { id: "g5", name: "Lacoste Gripshot Mid White", styleCodeNormalised: "742CFA00052G4", sizes: { a: "6" }, photoUrl: "https://x/g5.jpg" },
  { id: "g6", name: "Lacoster gripshot mid white and brown", styleCodeNormalised: "742CFA00062G4", sizes: { a: "6" }, photoUrl: "https://x/g6.jpg" },
  { id: "g7", name: "Lacoste Gripshot Mid Green", styleCodeNormalised: "742CFA00072G4", sizes: { a: "6" }, photoUrl: "https://x/g7.jpg" },
  { id: "g12", name: "Lacoste Gripshot White Green Orange", styleCodeNormalised: "742CFA00122G4", sizes: { a: "6" }, photoUrl: "https://x/g12.jpg" },
  { id: "g16", name: "Lacoster gripshot green", styleCodeNormalised: "742CFA00162G4", sizes: { a: "6" }, photoUrl: "https://x/g16.jpg" },
];
const PRODUCTS = [
  ...GRIPSHOTS,
  { id: "pAud", name: "Lacoste Audysol White", styleCodeNormalised: "745SMA00421G", sizes: { a: "6" }, photoUrl: null },
  { id: "nk", name: "Nike P-6000 White", styleCodeNormalised: "HF5509002", sizes: { a: "6" }, photoUrl: null },
];

const textOf = (tr) => JSON.stringify(tr.toJSON());
const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const buttonWith = (tr, needle) => tr.root.findAll((n) => n.type === "button" && textIn(n).includes(needle))[0];

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
  matchLabelAlias.mockImplementation(async () => ({ band: "low", candidates: [] }));
  recordLabelCodes.mockImplementation(async () => ({ ok: true, attached: [], conflicts: [] }));
});

describe("the link panel's ranked suggestions", () => {
  it("742CFA0011-2G4 opens the panel with ALL FIVE Gripshots on screen — photo, code and reason rendered, nothing typed", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("742CFA0011-2G4", null); });
    const after = textOf(tr);
    expect(after).toContain("link it");
    expect(after).toContain("Is it one of these");
    // The four visible immediately; the fifth behind "Show more".
    const suggested = GRIPSHOTS.filter((g) => after.includes(g.name));
    expect(suggested.length).toBeGreaterThanOrEqual(4);
    const more = buttonWith(tr, "more suggestion");
    if (more) await act(async () => { more.props.onClick(); });
    const full = textOf(tr);
    for (const g of GRIPSHOTS) expect(full).toContain(g.name);
    // WHY, verbatim per the owner spec:
    expect(full).toContain("same code family — 742CFA00••-2G4");
    // The photo is essential — the operator is holding the shoe:
    const photos = tr.root.findAll((n) => n.type === "img" && String(n.props.src || "").includes("/g"));
    expect(photos.length).toBeGreaterThanOrEqual(4);
    // And the registered code shows on the row:
    expect(full).toContain("742CFA00122G4");
  });

  it("opening the panel files NOTHING — suggest, never decide", async () => {
    await mountOnCountTab();
    await act(async () => { await readerProps.onCode("742CFA0011-2G4", null); });
    expect(recordLabelCodes).not.toHaveBeenCalled();
    expect(addLabelAlias).not.toHaveBeenCalled();
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("tapping a suggestion files the code via recordLabelCodes and counting continues on that product", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("742CFA0011-2G4", null); });
    const row = buttonWith(tr, "Lacoste Gripshot White Green Orange");
    await act(async () => { await row.props.onClick(); });
    expect(recordLabelCodes).toHaveBeenCalledWith({ productId: "g12", chosenCode: "742CFA00112G4", otherCodes: [] });
    const after = textOf(tr);
    expect(after).not.toContain("link it");
    expect(after).toContain("Lacoste Gripshot White Green Orange"); // the count panel
  });

  it("the label's printed model name becomes suggestions (meta.modelName)", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("999ZZ9999", { modelName: "GRIPSHOT MID 2233SP2" }); });
    const after = textOf(tr);
    expect(after).toContain("Is it one of these");
    expect(after).toContain("the label prints");
    expect(after).toContain("GRIPSHOT");
  });

  it("a token reading's below-band candidates surface — and the tap files addLabelAlias with the tokens", async () => {
    matchLabelAlias.mockImplementation(async () => ({
      band: "low",
      candidates: [{ productId: "g7", score: 0.45, shared: 3 }],
    }));
    const tr = await mountOnCountTab();
    const tokens = ["SOMETHING", "WHOLLY", "UNMATCHED", "WORDS"];
    await act(async () => { await readerProps.onTokens(tokens); });
    const after = textOf(tr);
    expect(after).toContain("Is it one of these");
    expect(after).toContain("Lacoste Gripshot Mid Green");
    expect(after).toContain("3 words");
    const row = buttonWith(tr, "Lacoste Gripshot Mid Green");
    await act(async () => { await row.props.onClick(); });
    expect(addLabelAlias).toHaveBeenCalledWith({ productId: "g7", tokens });
    expect(recordLabelCodes).not.toHaveBeenCalled();
  });

  it("a token read whose ONLY evidence is meta.modelName still gets name suggestions (CodeRabbit, PR #349)", async () => {
    const tr = await mountOnCountTab();
    // The merged token set is junk (address-line words), but one frame's OCR
    // read the model-name line cleanly — it must reach the panel's name tier.
    await act(async () => {
      await readerProps.onTokens(["FABRIQUE", "IMPORTED", "DESIGNED", "CAMBODIA"], { modelName: "GRIPSHOT MID 2233SP2" });
    });
    const after = textOf(tr);
    expect(after).toContain("Is it one of these");
    expect(after).toContain("GRIPSHOT");
    expect(after).toContain("the label prints");
  });

  it("THE SFA/SMA FLOOR CASE: a Lacoste label from another article family opens the panel with the shoe on top — same colour code", async () => {
    // pAud is registered as 745SMA00421G; the label in hand prints the OTHER
    // size band's family, 745SFA0005-21G — gender letters and length both
    // differ, only the trailing colour code 21G survives (owner spec
    // 2026-08-13, staff blocked mid-count).
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("745SFA0005-21G", null); });
    const after = textOf(tr);
    expect(after).toContain("Is it one of these");
    expect(after).toContain("Lacoste Audysol White");
    expect(after).toContain("same colour code 21G");
    // And the tap files through the EXISTING alias door, nothing before it:
    expect(recordLabelCodes).not.toHaveBeenCalled();
    const row = buttonWith(tr, "Lacoste Audysol White");
    await act(async () => { await row.props.onClick(); });
    expect(recordLabelCodes).toHaveBeenCalledWith({ productId: "pAud", chosenCode: "745SFA000521G", otherCodes: [] });
  });

  it("a code with no plausible relative STILL fills the panel — closest rows, honest heading — and the name search still works", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("CT8527-999", null); });
    const after = textOf(tr);
    expect(after).toContain("link it");
    // NEVER EMPTY: the honest heading replaces the match claim, and every
    // catalogue product (7 in this fixture) renders as a tappable row.
    expect(after).not.toContain("Is it one of these");
    expect(after).toContain("Nothing matched closely");
    for (const p of PRODUCTS) expect(after).toContain(p.name);
    // Search still reaches everything:
    const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "This is the same shoe as…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Audysol" } }); });
    const row = buttonWith(tr, "Audysol");
    await act(async () => { await row.props.onClick(); });
    expect(recordLabelCodes).toHaveBeenCalledWith({ productId: "pAud", chosenCode: "CT8527999", otherCodes: [] });
  });

  it("REGISTER: a captured code one step from ANOTHER product's code shows the wrong-shoe heads-up (non-blocking)", async () => {
    // The operator registers a shoe with NO code on file (the only case the
    // register reader captures a fresh code) and the label reads
    // 742CFA0013-2G4 — one article digit from g12's AND g16's registered
    // codes. The panel must warn, not block.
    const withCategory = [
      ...PRODUCTS.map((p) => ({ ...p, categoryKey: "sneakers" })),
      { id: "gNew", name: "Lacoste Gripshot Navy", sizes: { a: "6" }, photoUrl: null, categoryKey: "sneakers" },
    ];
    let tr;
    await act(async () => {
      tr = TestRenderer.create(<HubCleanup products={withCategory} actorRole="warehouse" viewer={{}} />);
    });
    const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "Search the catalogue by name…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Gripshot Navy" } }); });
    const row = tr.root.findAll((n) => n.type === "button" && textIn(n).includes("Lacoste Gripshot Navy"))[0];
    await act(async () => { row.props.onClick(); });
    expect(readerProps).toBeTruthy();
    await act(async () => { readerProps.onCode("742CFA0013-2G4", { source: "label", labelPhoto: null }); });
    const after = textOf(tr);
    expect(after).toContain("Heads-up");
    expect(after).toContain("Make sure the shoe you're holding");
    // Non-blocking: the style step still reads as satisfied (green box present).
    expect(after).toContain("Style number:");
  });

  it("REGISTER: the heads-up names the STRONGEST relative, not the first in catalogue order (Sonnet review, PR #351)", async () => {
    // Catalogue order puts a weak truncated-tier relative FIRST (aTrunc,
    // registered 742CFA0013 — suffix-less, prefix of the captured code) and a
    // strong family-tier relative after it (g12/g16). The note must name a
    // family member, never the truncated hit.
    const withCategory = [
      { id: "aTrunc", name: "Lacoste Mystery Base", styleCodeNormalised: "742CFA0013", sizes: { a: "6" }, photoUrl: null, categoryKey: "sneakers" },
      ...PRODUCTS.map((p) => ({ ...p, categoryKey: "sneakers" })),
      { id: "gNew", name: "Lacoste Gripshot Navy", sizes: { a: "6" }, photoUrl: null, categoryKey: "sneakers" },
    ];
    let tr;
    await act(async () => {
      tr = TestRenderer.create(<HubCleanup products={withCategory} actorRole="warehouse" viewer={{}} />);
    });
    const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "Search the catalogue by name…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Gripshot Navy" } }); });
    const row = tr.root.findAll((n) => n.type === "button" && textIn(n).includes("Lacoste Gripshot Navy"))[0];
    await act(async () => { row.props.onClick(); });
    await act(async () => { readerProps.onCode("742CFA0013-2G4", { source: "label", labelPhoto: null }); });
    const after = textOf(tr);
    expect(after).toContain("Heads-up");
    // The truncated-tier hit must not be the one named…
    expect(after).not.toContain("Lacoste Mystery Base");
    // …the top family-tier member must be (g12 — first 93-scorer, stable sort).
    expect(after).toContain("Lacoste Gripshot White Green Orange");
  });

  it("REGISTER: a clean unrelated code shows NO heads-up", async () => {
    const withCategory = [
      ...PRODUCTS.map((p) => ({ ...p, categoryKey: "sneakers" })),
      { id: "gNew", name: "Lacoste Gripshot Navy", sizes: { a: "6" }, photoUrl: null, categoryKey: "sneakers" },
    ];
    let tr;
    await act(async () => {
      tr = TestRenderer.create(<HubCleanup products={withCategory} actorRole="warehouse" viewer={{}} />);
    });
    const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "Search the catalogue by name…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Gripshot Navy" } }); });
    const row = tr.root.findAll((n) => n.type === "button" && textIn(n).includes("Lacoste Gripshot Navy"))[0];
    await act(async () => { row.props.onClick(); });
    expect(readerProps).toBeTruthy();
    await act(async () => { readerProps.onCode("999AAA9999ZZ9", { source: "label", labelPhoto: null }); });
    expect(textOf(tr)).not.toContain("Heads-up");
  });

  it("«note as never registered» stays available below the suggestions", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("742CFA0011-2G4", null); });
    const note = buttonWith(tr, "never registered");
    expect(note).toBeTruthy();
    await act(async () => { await note.props.onClick(); });
    expect(recordUnresolvedScan).toHaveBeenCalledWith({ hub: "hub1", code: "742CFA0011-2G4", context: "count" });
  });
});
