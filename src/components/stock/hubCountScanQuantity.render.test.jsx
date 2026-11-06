// ─── HUB 3: SCAN + QUANTITY, EVERY CATEGORY (Junid, 6 Nov 2026) ───────────────
// The real HubCleanup renders at Hub 3. Claims:
//   1. A clothing item's shop barcode opens ITS count panel on the scanned size.
//   2. Each further scan of the same item+size adds one to the count box.
//   3. Adjust writes the ABSOLUTE count through the existing adjustCell path.
//   4. A one-size bag opens on "One size" and is countable.
//   5. The count-mode toggle shows for an admin stock account at Hub 3.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const adjustCell = vi.fn(async () => ({ ok: true, record: { action: "adjust", actual: 3 } }));
const confirmCell = vi.fn(async () => ({ ok: true, record: { action: "confirm", actual: 0 } }));
let barcodeRows = {};
let emitScan = null;

vi.mock("./hubCleanupStore", () => ({
  loadRegister: async () => ({}),
  loadUnresolved: async () => ({}),
  registerDisplayUnit: async () => ({ ok: true }),
  addExtraDisplayUnit: async () => ({ ok: true }),
  recordUnresolvedScan: async () => ({ ok: true }),
  lookupBarcode: async (code) => barcodeRows[code] || null,
  loadAllStock: async () => ({}),
  loadDuplicateCandidates: async () => ({}),
  fetchProductFollowingMerge: async () => null,
  lookupStyleClaim: async () => null,
  matchLabelAlias: async () => ({ band: "low", candidates: [] }),
  addLabelAlias: async () => ({ ok: true }),
  answerStyleCodeSibling: async () => ({}),
  lookupCodeAlias: async () => null,
  recordLabelCodes: async () => ({ ok: true, attached: [], conflicts: [] }),
  fetchColourwayAnswers: async () => [],
  recordColourwayAnswer: async () => ({}),
  unresolvedScanKey: (code) => String(code ?? "").replace(/[.#$/\[\]\s]/g, "_").slice(0, 64) || "_",
  REGISTER_REASON: "display_registration",
}));
const HUB3_STOCK = { t1: { S: { qty: 0, v: 1 }, M: { qty: 0, v: 1 }, L: { qty: 0, v: 1 } }, b1: { _: { qty: 0, v: 1 } } };
vi.mock("./hubCountStore", () => ({
  loadHubStock: async () => HUB3_STOCK,
  openOrResumeSession: async () => ({ sessionId: "s1" }),
  loadCounted: async () => ({}),
  publishSessionTotal: async () => {},
  confirmCell: (...a) => confirmCell(...a),
  adjustCell: (...a) => adjustCell(...a),
  flagCell: async () => ({ ok: true, record: {} }),
  useLocationRegistryOnce: () => ({}),
  rememberHub: () => {},
  rememberedHub: () => "hub3",
  loadHubCountMode: async () => ({ paused: true, countMode: true, on: true }),
  setHubCountMode: async () => ({ ok: true }),
}));
vi.mock("./offShelf", () => ({
  loadOffShelfSources: async () => ({ laybyItems: 0, slots: {}, register: {}, readyCells: {} }),
  offShelfForCell: () => ({ total: 0, parts: [] }),
  expectedOnShelf: (b) => Number(b) || 0,
}));
vi.mock("./displaySlots", () => ({ loadDisplaySlots: async () => ({}) }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: (fn) => { emitScan = fn; return () => {}; } }));
vi.mock("../../update/updateChecker", () => ({ setUpdateBusy: () => {} }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: null }) }));
vi.mock("../../config/hubSneakerCount", () => ({ canAdjustHubCount: () => true }));
vi.mock("./TongueLabelReader.jsx", () => ({ TongueLabelReader: () => null }));
vi.mock("./CameraScanner.jsx", () => ({ default: () => null }));
vi.mock("./MergeProducts.jsx", () => ({ default: () => null }));
vi.mock("./HubSneakerCount.jsx", () => ({ default: () => null }));

const { default: HubCleanup } = await import("./HubCleanup.jsx");

const PRODUCTS = [
  { id: "t1", name: "Concrete Logo Tee", category: "Clothing", subcategory: "T-Shirts", productType: "clothing", sizes: ["S", "M", "L"] },
  { id: "b1", name: "Concrete Tote", category: "Bags", productType: "clothing" },
];
const textOf = (tr) => JSON.stringify(tr.toJSON());
const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));

async function mountCount() {
  let tr;
  await act(async () => { tr = TestRenderer.create(<HubCleanup products={PRODUCTS} actorRole="admin" viewer={{ stockRole: "admin" }} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const countTab = tr.root.findAll((n) => n.type === "button" && n.children.join("") === "Count")[0];
  await act(async () => { countTab.props.onClick(); });
  return tr;
}
const scan = async (code) => { await act(async () => { await emitScan(code); }); };
const countBox = (tr) => tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "Different? Enter the real count")[0];

beforeEach(() => {
  vi.clearAllMocks();
  emitScan = null;
  barcodeRows = { "00001234": { productId: "t1", size: "M" }, "00009999": { productId: "b1" } };
});

describe("Hub 3 count — scan + quantity", () => {
  it("says it counts every category, and shows the count-mode toggle to an admin", async () => {
    const tr = await mountCount();
    expect(tr.root.findAll((n) => n.props?.["data-testid"] === "all-category-help").length).toBe(1);
    expect(tr.root.findAll((n) => n.props?.["data-testid"] === "count-mode-toggle").length).toBe(1);
    expect(textOf(tr)).toContain("Hub 3 counting — engine paused, uncounted sales not deducted");
  });

  it("each scan of the same item+size adds one; Adjust sets the absolute count", async () => {
    const tr = await mountCount();
    await scan("00001234");
    expect(textOf(tr)).toContain("Concrete Logo Tee");
    expect(countBox(tr).props.value).toBe("1");
    await scan("00001234");
    await scan("00001234");
    expect(countBox(tr).props.value).toBe("3");
    const tally = tr.root.findAll((n) => n.props?.["data-testid"] === "scan-tally")[0];
    expect(textIn(tally).replace(/\s+/g, " ")).toContain("Scanned 3");
    expect(textOf(tr)).toContain('"units"," of size ","M"');
    const adjust = tr.root.findAll((n) => n.type === "button" && textIn(n).trim() === "Adjust")[0];
    await act(async () => { await adjust.props.onClick(); });
    expect(adjustCell).toHaveBeenCalledTimes(1);
    expect(adjustCell.mock.calls[0][0]).toMatchObject({ hub: "hub3", productId: "t1", sizeKey: "M", expected: 0, actual: 3 });
  });

  it("a one-size bag opens on One size and is countable", async () => {
    const tr = await mountCount();
    await scan("00009999");
    await scan("00009999");
    expect(textOf(tr)).toContain("Concrete Tote");
    expect(textOf(tr)).toContain("One size");
    expect(countBox(tr).props.value).toBe("2");
  });
});
