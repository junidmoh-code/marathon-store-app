// ─── A SCAN MUST NEVER DEAD-END — the link panel, rendered for real ──────────
// (Owner spec 2026-08-12, the Lacoste per-size incident: 745SMA004-21G and
// 745SMA006-21G are ONE shoe, one colourway, two sizes — a product registered
// off one size's label rejected every other size's label mid-count.) The
// claims pinned here are WIRING claims, so the real component renders:
//
//   1. A clean style-number read that nothing owns opens the LINK panel —
//      never the silent "noted as never registered" write.
//   2. Picking a product in the link panel files the code through the
//      EXISTING labelAlias door (recordLabelCodes) and counting continues.
//   3. "Note as never registered" survives as the deliberate second exit.
//   4. A code the alias store already knows resolves SILENTLY into the count
//      panel — the linked reading never asks twice.
//   5. A token reading nothing matches opens the same link panel and files
//      through addLabelAlias.
//   6. A code shared by TWO products (Nike prints one code across every
//      colourway) still ASKS via the choose panel — no auto-pick.
//   7. None of these paths writes a product record — no register, no adjust,
//      no merge: an alias row is the only write.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// ── The callable boundary, captured ──────────────────────────────────────────
const lookupStyleClaim = vi.fn(async () => null);
const lookupCodeAlias = vi.fn(async () => null);
const recordLabelCodes = vi.fn(async () => ({ ok: true, attached: [], conflicts: [] }));
const addLabelAlias = vi.fn(async () => ({ ok: true }));
const recordUnresolvedScan = vi.fn(async () => ({ ok: true }));
const matchLabelAlias = vi.fn(async () => ({ band: "low", candidates: [] }));
const registerDisplayUnit = vi.fn(async () => ({ ok: true }));
const addExtraDisplayUnit = vi.fn(async () => ({ ok: true }));
const confirmCell = vi.fn(async () => ({ ok: true, record: {} }));
const adjustCell = vi.fn(async () => ({ ok: true, record: {} }));
const flagCell = vi.fn(async () => ({ ok: true, record: {} }));

vi.mock("./hubCleanupStore", () => ({
  loadRegister: async () => ({}),
  loadUnresolved: async () => ({}),
  registerDisplayUnit: (...a) => registerDisplayUnit(...a),
  addExtraDisplayUnit: (...a) => addExtraDisplayUnit(...a),
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
  confirmCell: (...a) => confirmCell(...a),
  adjustCell: (...a) => adjustCell(...a),
  flagCell: (...a) => flagCell(...a),
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

// The live shapes, verbatim: the Audysol carries one size's Lacoste code; the
// two Nikes share one code across colourways (the HF5509-002 reality).
const PRODUCTS = [
  { id: "pAud", name: "Lacoste Audysol White", styleCodeNormalised: "745SMA00421G", sizes: { a: "6", b: "9" }, photoUrl: null },
  { id: "pMissouri", name: "Lacoste Missouri Mid Green Grey", styleCodeNormalised: "743SMA01691M3", sizes: { a: "6" }, photoUrl: null },
  { id: "pNikeWhite", name: "Nike P-6000 White", styleCodeNormalised: "HF5509002", sizes: { a: "6" }, photoUrl: null },
  { id: "pNikeBlack", name: "Nike P-6000 Black", styleCodeNormalised: "HF5509002", sizes: { a: "6" }, photoUrl: null },
];

const textOf = (tr) => JSON.stringify(tr.toJSON());
// Text under one rendered instance (TestInstance children are instances or strings).
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

describe("the count's unresolved-scan link panel", () => {
  it("a clean code nothing owns opens the LINK panel — never a silent never-registered note", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("CT8527-999", null); });
    expect(textOf(tr)).toContain("link it");
    expect(textOf(tr)).toContain("CT8527-999");
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("picking a product files the code via recordLabelCodes and counting continues", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("CT8527-999", null); });
    const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "This is the same shoe as…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Audysol" } }); });
    const row = buttonWith(tr, "Audysol");
    await act(async () => { await row.props.onClick(); });
    expect(recordLabelCodes).toHaveBeenCalledWith({ productId: "pAud", chosenCode: "CT8527999", otherCodes: [] });
    const after = textOf(tr);
    expect(after).not.toContain("link it");
    expect(after).toContain("Lacoste Audysol White");   // the count panel, open on the pick
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("«note as never registered» survives as the deliberate second exit", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("CT8527-999", null); });
    const note = buttonWith(tr, "never registered");
    await act(async () => { await note.props.onClick(); });
    expect(recordUnresolvedScan).toHaveBeenCalledWith({ hub: "hub1", code: "CT8527-999", context: "count" });
    expect(textOf(tr)).not.toContain("link it");
  });

  it("a code the alias store knows resolves SILENTLY into the count panel", async () => {
    lookupCodeAlias.mockImplementation(async () => "pAud");
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("CT8527-999", null); });
    const after = textOf(tr);
    expect(after).not.toContain("link it");
    expect(after).toContain("Lacoste Audysol White");
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("a token reading nothing matches opens the link panel and files via addLabelAlias", async () => {
    const tr = await mountOnCountTab();
    const tokens = ["MADE", "WITH", "PRIDE", "USM7"];
    await act(async () => { await readerProps.onTokens(tokens); });
    expect(textOf(tr)).toContain("link it");
    const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "This is the same shoe as…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Audysol" } }); });
    const row = buttonWith(tr, "Audysol");
    await act(async () => { await row.props.onClick(); });
    expect(addLabelAlias).toHaveBeenCalledWith({ productId: "pAud", tokens });
    expect(recordLabelCodes).not.toHaveBeenCalled();
  });

  it("a code shared across colourways still ASKS — the choose panel, no auto-pick", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("HF5509-002", null); });
    const after = textOf(tr);
    expect(after).toContain("Nike P-6000 White");
    expect(after).toContain("Nike P-6000 Black");
    expect(after).not.toContain("link it");
    expect(recordLabelCodes).not.toHaveBeenCalled();
  });

  it("745SMA004-21G and 745SMA006-21G resolve to the SAME product — one by stamp, one by the per-size rule", async () => {
    // The registered size resolves through its own stamped code:
    const tr1 = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("745SMA004-21G", null); });
    expect(textOf(tr1)).toContain("Lacoste Audysol White");
    expect(textOf(tr1)).not.toContain("link it");
    // The OTHER size's label auto-links: filed via recordLabelCodes, counted
    // on the same product, no question asked:
    const tr2 = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("745SMA006-21G", null); });
    expect(recordLabelCodes).toHaveBeenCalledWith({ productId: "pAud", chosenCode: "745SMA00621G", otherCodes: [] });
    const after = textOf(tr2);
    expect(after).toContain("Lacoste Audysol White");
    expect(after).not.toContain("link it");
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("an auto-link whose OTHER label token collides still warns — no silent conflict", async () => {
    // The label carried a second code that another product owns: the server
    // flags it; the operator must hear it even on the auto path.
    recordLabelCodes.mockImplementation(async () => ({ ok: true, attached: ["745SMA00621G"], conflicts: [{ code: "38019001", ownerId: "pOther" }] }));
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("745SMA006-21G", { allCodes: ["745SMA00621G", "380190-01"] }); });
    const after = textOf(tr);
    expect(after).toContain("Lacoste Audysol White");        // counting continues
    expect(after).toContain("already belongs to another product"); // …but the clash is said out loud
  });

  it("a different colourway suffix NEVER auto-links — it asks via the link panel", async () => {
    // 743SMA0169-4M3 is the Missouri Mid in ANOTHER colour than the registered
    // …1M3. One character apart — and the rule must stay silent.
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("743SMA0169-4M3", null); });
    expect(recordLabelCodes).not.toHaveBeenCalled();
    expect(textOf(tr)).toContain("link it");
  });

  it("a near-miss Nike code never auto-links — Lacoste's rule is Lacoste-only", async () => {
    // HF5509-004 is one digit off the registered HF5509-002 — but Nike prints
    // one code across every size AND colourway, so a digit off means a
    // DIFFERENT code, and the human decides.
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("HF5509-004", null); });
    expect(recordLabelCodes).not.toHaveBeenCalled();
    expect(textOf(tr)).toContain("link it");
  });

  it("no path here writes a product record — alias rows are the only writes", async () => {
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("CT8527-999", null); });
    const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "This is the same shoe as…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Audysol" } }); });
    const row = buttonWith(tr, "Audysol");
    await act(async () => { await row.props.onClick(); });
    for (const write of [registerDisplayUnit, addExtraDisplayUnit, confirmCell, adjustCell, flagCell]) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});
