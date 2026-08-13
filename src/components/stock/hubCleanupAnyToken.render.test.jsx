// ─── ANY-TOKEN RESOLUTION IN THE COUNT FLOW — wiring claims (owner spec
// 2026-08-13) ── the real component renders; the claims:
//
//   1. The tapped token resolves to NOTHING but another token on the same
//      label is registered → ONE resolveAnyCodes round trip, the count panel
//      opens on that product, and EVERY token files through the existing
//      recordLabelCodes door.
//   2. Two tokens owned by two DIFFERENT products → the choose panel, both
//      candidates on screen, NOTHING files silently.
//   3. resolveAnyCodes failing → the link panel (degrade), never a false
//      never-registered note.
//   4. The link panel's ranked list POOLS the label's other tokens — a row
//      found via the other token renders with that reason.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const lookupStyleClaim = vi.fn(async () => null);
const lookupCodeAlias = vi.fn(async () => null);
const resolveAnyCodes = vi.fn(async () => ({ resolved: null, owners: [] }));
const recordLabelCodes = vi.fn(async () => ({ ok: true, attached: [], conflicts: [] }));
const addLabelAlias = vi.fn(async () => ({ ok: true }));
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
  addLabelAlias: (...a) => addLabelAlias(...a),
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

// "Lacoster white" as registered today: it holds the PRODUCTION line.
const PRODUCTS = [
  { id: "pLW", name: "Lacoster white", styleCodeNormalised: "352890625", sizes: { a: "6" }, photoUrl: "https://x/lw.jpg" },
  { id: "pOther", name: "Some Other Boot", styleCodeNormalised: "CT8527016", sizes: { a: "6" }, photoUrl: "https://x/o.jpg" },
];

// Every token the Lacoste label prints, as the reader now delivers them.
const LACOSTE_META = { allCodes: ["45SMA0018", "352890625", "TTJJ21FB00001"], modelName: null, tokens: ["LGUARD", "BRKR", "CTT"] };

const textOf = (tr) => JSON.stringify(tr.toJSON());

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

describe("any-token resolution in the count flow", () => {
  it("the tapped article code resolves via the PRODUCTION token — count panel opens, every token files", async () => {
    // The scan led with 45SMA0018 (nothing owns it). The server finds the
    // production token's owner. NOTE: the local catalogue also stamps
    // 352890625, but the wiring must work even when only the server knows —
    // so the claim/alias for the tapped token stay null here.
    resolveAnyCodes.mockImplementation(async () => ({
      resolved: "pLW", owners: [{ productId: "pLW", code: "352890625", via: "index" }],
    }));
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("45SMA0018", LACOSTE_META); });

    expect(resolveAnyCodes).toHaveBeenCalledTimes(1);
    expect(resolveAnyCodes.mock.calls[0][0].sort()).toEqual(["352890625", "TTJJ21FB00001"]);
    const after = textOf(tr);
    expect(after).toContain("Lacoster white");           // the count panel
    expect(after).not.toContain("link it");              // NOT the link panel
    // Every token files as an identity of the resolved product.
    expect(recordLabelCodes).toHaveBeenCalledWith({
      productId: "pLW", chosenCode: "45SMA0018",
      otherCodes: ["352890625", "TTJJ21FB00001"],
    });
  });

  it("two tokens, two owners → the choose panel with both on screen; nothing files silently", async () => {
    resolveAnyCodes.mockImplementation(async () => ({
      resolved: null,
      owners: [
        { productId: "pLW", code: "352890625", via: "index" },
        { productId: "pOther", code: "TTJJ21FB00001", via: "alias" },
      ],
    }));
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("45SMA0018", LACOSTE_META); });
    const after = textOf(tr);
    // The CHOOSE panel specifically — the link panel also lists both products
    // (fillToMin browses the whole catalogue), so the panel TITLE is the
    // assertion that distinguishes "the human is asked to pick between
    // owners" from "the scan fell through to browsing".
    expect(after).toContain("One code, more than one product");
    expect(after).not.toContain("link it");
    expect(after).toContain("Lacoster white");
    expect(after).toContain("Some Other Boot");
    expect(recordLabelCodes).not.toHaveBeenCalled();
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("a FAILED any-token lookup degrades to the link panel — never a false never-registered", async () => {
    resolveAnyCodes.mockImplementation(async () => { throw new Error("network down"); });
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("45SMA0018", LACOSTE_META); });
    const after = textOf(tr);
    expect(after).toContain("link it");
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("same-code owners the index registers as SIBLINGS get the colourway picker, never the merge framing (review #354)", async () => {
    // Both owners rode ONE code, and the claim vouches for both — a
    // registered colourway set. The collision framing would offer the live
    // Merge affordance; merging two legitimate colourways destroys stock
    // history.
    resolveAnyCodes.mockImplementation(async () => ({
      resolved: null,
      owners: [
        { productId: "pLW", code: "352890625", via: "index" },
        { productId: "pOther", code: "352890625", via: "index" },
      ],
    }));
    // The TAPPED code must own nothing — otherwise the ordinary claim path
    // resolves before the any-token branch is ever reached. Only the SHARED
    // owner code carries the sibling claim.
    lookupStyleClaim.mockImplementation(async (code) => (code === "352890625"
      ? { productId: "pLW", claimedAt: 1, siblings: { pOther: { addedAt: 1 } } }
      : null));
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("45SMA0018", LACOSTE_META); });
    const after = textOf(tr);
    expect(after).toContain("Which colourway is it?");
    expect(after).not.toContain("One code, more than one product");
  });

  it("a resolved owner whose product fetch THROWS surfaces an error — never the link panel (review #354)", async () => {
    // The server just PROVED an owner exists; a network blink must not
    // degrade that into 'link it' (duplicate-minting) or a never-registered
    // note. Same rule as the claim and alias branches.
    resolveAnyCodes.mockImplementation(async () => ({
      resolved: "pUnknown", owners: [{ productId: "pUnknown", code: "352890625", via: "index" }],
    }));
    fetchProductFollowingMerge.mockImplementation(async () => { throw new Error("network down"); });
    const tr = await mountOnCountTab();
    await act(async () => { await readerProps.onCode("45SMA0018", LACOSTE_META); });
    const after = textOf(tr);
    expect(after).not.toContain("link it");
    expect(after).toContain("couldn't be loaded");
    expect(recordUnresolvedScan).not.toHaveBeenCalled();
  });

  it("the TOKEN-OVERLAP fallback resolves a pre-widening label silently on a HIGH band (review #354)", async () => {
    // A label registered pre-widening as a token reading now extracts its
    // serial as a single candidate and lands in the code flow — the alias
    // store's HIGH-band answer must still resolve it.
    matchLabelAlias.mockImplementation(async () => ({
      band: "high", candidates: [{ productId: "pLW", score: 0.92, shared: 4 }],
    }));
    const tr = await mountOnCountTab();
    await act(async () => {
      await readerProps.onCode("TTJJ21FB00001", { allCodes: ["TTJJ21FB00001"], modelName: null, tokens: ["LGUARD", "BRKR", "CTT"] });
    });
    expect(matchLabelAlias).toHaveBeenCalledWith(["LGUARD", "BRKR", "CTT"]);
    const after = textOf(tr);
    expect(after).toContain("Lacoster white");
    expect(after).not.toContain("link it");
    expect(recordLabelCodes).not.toHaveBeenCalled(); // single candidate → fileAllCodes has nothing extra to file
  });

  it("a below-band token match rides the CODE link panel as alias-tier rows (review #354)", async () => {
    matchLabelAlias.mockImplementation(async () => ({
      band: "low", candidates: [{ productId: "pLW", score: 0.4, shared: 2 }],
    }));
    const tr = await mountOnCountTab();
    await act(async () => {
      await readerProps.onCode("TTJJ21FB00001", { allCodes: ["TTJJ21FB00001"], modelName: null, tokens: ["LGUARD", "BRKR", "CTT"] });
    });
    const after = textOf(tr);
    expect(after).toContain("link it");
    expect(after).toContain("its saved label reading shares");
  });

  it("the link panel POOLS the label's other tokens into its ranked rows", async () => {
    // Nothing resolves anywhere (server sees no owner), but the local
    // catalogue holds the production token's product — the pooled ranking
    // must surface it, reason naming the other token.
    const tr = await mountOnCountTab();
    await act(async () => {
      await readerProps.onCode("45SMA0099", { allCodes: ["45SMA0099", "352890625"], modelName: null, tokens: null });
    });
    const after = textOf(tr);
    expect(after).toContain("link it");
    expect(after).toContain("Lacoster white");
    expect(after).toContain("other token 352890-625");
  });
});
