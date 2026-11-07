// ─── HUB 3 IN THE REGISTER PANEL — the shop step follows the hub ─────────────
// (Junid, 7 Nov 2026.) The "which shop is this display at" step offers the
// shops the PICKED hub feeds — asked of the network registry, never a list:
//   Hub 1 / Hub 2 → Marathon PE, Trophy      Hub 3 → Marathon Pine, Concrete
// and the save hands the real location ids to registerDisplayUnit.
//
// The Hub 1 and Hub 2 panels are SNAPSHOTTED. The snapshot file was generated
// by running this test against main before the Hub 3 change (d1767b9d) and
// committed unchanged, so a pass here means the Marathon register panel renders
// byte-for-byte as it did.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const registerDisplayUnit = vi.fn(async () => ({ ok: true }));
const addExtraDisplayUnit = vi.fn(async () => ({ ok: true }));
let REMEMBERED = "hub1";

vi.mock("./hubCleanupStore", () => ({
  loadRegister: async () => ({}),
  loadUnresolved: async () => ({}),
  registerDisplayUnit: (...a) => registerDisplayUnit(...a),
  addExtraDisplayUnit: (...a) => addExtraDisplayUnit(...a),
  recordUnresolvedScan: async () => ({ ok: true }),
  lookupBarcode: async () => null,
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
  rememberedHub: () => REMEMBERED,
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
vi.mock("./TongueLabelReader.jsx", () => ({ TongueLabelReader: () => null }));
vi.mock("./CameraScanner.jsx", () => ({ default: () => null }));
vi.mock("./MergeProducts.jsx", () => ({ default: () => null }));
vi.mock("./HubSneakerCount.jsx", () => ({ default: () => null }));

const { default: HubCleanup } = await import("./HubCleanup.jsx");

const SHOE = { id: "pShoe", name: "Lacoste Court Cage White", category: "Footwear", styleCodeNormalised: "745SMA00421G", sizes: { a: "6", b: "7" }, photoUrl: null };

const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(""));
const buttons = (tr) => tr.root.findAll((n) => n.type === "button");
const buttonText = (tr, text) => buttons(tr).find((n) => textIn(n).trim() === text);

// Open the hub, go to Register, find the shoe by name, pick size 7.
async function openPanelAt(hub) {
  REMEMBERED = hub;
  let tr;
  await act(async () => { tr = TestRenderer.create(<HubCleanup products={[SHOE]} actorRole="warehouse" viewer={{}} />); });
  await act(async () => { buttonText(tr, "Register").props.onClick(); });
  const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "Search the catalogue by name…")[0];
  await act(async () => { search.props.onChange({ target: { value: "Court Cage" } }); });
  const hit = buttons(tr).find((n) => textIn(n).includes("Lacoste Court Cage White"));
  await act(async () => { hit.props.onClick(); });
  await act(async () => { buttonText(tr, "7").props.onClick(); });
  return tr;
}
// The shop step's buttons, in order: the ones after the size grid and before
// the quantity stepper (−).
function shopButtons(tr) {
  const all = buttons(tr).map((b) => textIn(b).trim());
  const seven = all.lastIndexOf("7");
  const minus = all.indexOf("−", seven);
  return all.slice(seven + 1, minus);
}

beforeEach(() => { registerDisplayUnit.mockClear(); });

describe("the shop step offers the shops the picked hub feeds", () => {
  it("Hub 1 → Marathon PE, Trophy", async () => {
    const tr = await openPanelAt("hub1");
    expect(shopButtons(tr)).toEqual(["Marathon PE", "Trophy"]);
  });
  it("Hub 2 → Marathon PE, Trophy", async () => {
    const tr = await openPanelAt("hub2");
    expect(shopButtons(tr)).toEqual(["Marathon PE", "Trophy"]);
  });
  it("Hub 3 → Marathon Pine, Concrete — and the save names hub3 and the real location id", async () => {
    const tr = await openPanelAt("hub3");
    expect(shopButtons(tr)).toEqual(["Marathon Pine", "Concrete"]);
    await act(async () => { buttonText(tr, "Marathon Pine").props.onClick(); });
    const reg = buttons(tr).find((b) => textIn(b).trim().startsWith("✓ REGISTER"));
    await act(async () => { await reg.props.onClick(); });
    expect(registerDisplayUnit).toHaveBeenCalledTimes(1);
    const arg = registerDisplayUnit.mock.calls[0][0];
    expect(arg.hub).toBe("hub3");
    expect(arg.store).toBe("marathon-pine");
    expect(arg.size).toBe("7");
    expect(arg.qty).toBe(1);
  });
  it("Hub 3 → Concrete saves as concrete", async () => {
    const tr = await openPanelAt("hub3");
    await act(async () => { buttonText(tr, "Concrete").props.onClick(); });
    const reg = buttons(tr).find((b) => textIn(b).trim().startsWith("✓ REGISTER"));
    await act(async () => { await reg.props.onClick(); });
    expect(registerDisplayUnit.mock.calls[0][0]).toMatchObject({ hub: "hub3", store: "concrete" });
  });
});

describe("Marathon's register panel is byte-for-byte what it was (snapshot from main)", () => {
  for (const hub of ["hub1", "hub2"]) {
    it(`${hub}: the register panel, size picked, before and after the shop is picked`, async () => {
      const tr = await openPanelAt(hub);
      expect(tr.toJSON()).toMatchSnapshot(`${hub} size picked`);
      await act(async () => { buttonText(tr, "Trophy").props.onClick(); });
      expect(tr.toJSON()).toMatchSnapshot(`${hub} Trophy picked`);
    });
  }
});
