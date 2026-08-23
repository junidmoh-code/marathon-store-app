// ─── THE LEFTOVERS TAB AND THE COUNT PAGE, RENDERED FOR REAL ─────────────────
// Owner spec 2026-08-23. Two wiring claims the pure tests cannot make:
//
//   1. THE COUNT PAGE SHOWS THE CODE. Every code the product answers to and
//      every label wording filed against it, each copyable in one tap.
//   2. LEFTOVERS RECOMPUTE, THEY ARE NOT A SNAPSHOT. A registered product is
//      never listed, and when a registration lands the list drops it in the
//      same session — the component is re-rendered with new inputs, not
//      remounted and not reloaded.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("./hubCleanupStore", () => ({
  loadRegister: async () => ({}),
  loadUnresolved: async () => ({}),
  registerDisplayUnit: async () => ({ ok: true }),
  addExtraDisplayUnit: async () => ({ ok: true }),
  recordUnresolvedScan: async () => ({ ok: true }),
  lookupBarcode: async () => null,
  loadAllStock: async () => ({
    hub1: { pBare: { "9": { qty: 4, v: 0 } }, pCoded: { "9": { qty: 2, v: 0 } }, pAlias: { "9": { qty: 3, v: 0 } } },
    central: { pBare: { "9": { qty: 1, v: 0 } } },
  }),
  loadDuplicateCandidates: async () => ({}),
  fetchProductFollowingMerge: async () => null,
  lookupStyleClaim: async () => null,
  matchLabelAlias: async () => ({ band: "low", candidates: [] }),
  addLabelAlias: async () => ({ ok: true }),
  answerStyleCodeSibling: async () => ({}),
  lookupCodeAlias: async () => null,
  recordLabelCodes: async () => ({ ok: true, attached: [], conflicts: [] }),
  resolveAnyCodes: async () => ({ resolved: null, owners: [] }),
  fetchColourwayAnswers: async () => [],
  recordColourwayAnswer: async () => ({}),
  unresolvedScanKey: (c) => String(c ?? ""),
  REGISTER_REASON: "display_registration",
}));
vi.mock("./hubCountStore", () => ({
  loadHubStock: async () => ({
    pBare: { "9": { qty: 4, v: 0 } },
    pCoded: { "9": { qty: 2, v: 0 } },
    pAlias: { "9": { qty: 3, v: 0 } },
  }),
  openOrResumeSession: async () => ({ sessionId: "s1" }),
  loadCounted: async () => ({}),
  publishSessionTotal: async () => {},
  confirmCell: async () => ({ ok: true, record: {} }),
  adjustCell: async () => ({ ok: true, record: {} }),
  flagCell: async () => ({ ok: true, record: {} }),
  useLocationRegistryOnce: () => ({ hub1: { id: "hub1", label: "Hub 1" }, central: { id: "central", label: "Central" } }),
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
vi.mock("../../config/hubSneakerCount", () => ({ canAdjustHubCount: () => false, HUB_COUNT_ROOT: "settings/hubSneakerCount" }));
let readerProps = null;
vi.mock("./TongueLabelReader.jsx", () => ({
  TongueLabelReader: (props) => { readerProps = props; return null; },
}));
vi.mock("./CameraScanner.jsx", () => ({ default: () => null }));
vi.mock("./MergeProducts.jsx", () => ({ default: () => null }));
vi.mock("./HubSneakerCount.jsx", () => ({ default: () => null }));

// The identity map, swapped between renders — this is how "a registration
// lands" is modelled without a network.
let IDENTITY = { map: {}, ready: true };
vi.mock("../../utils/labelIdentityStore", () => ({
  useLabelIdentity: () => IDENTITY,
  invalidateIdentity: () => {},
}));

const { default: HubCleanup } = await import("./HubCleanup.jsx");

const shoe = (id, name, over = {}) => ({ id, name, categoryKey: "sneakers", sizes: { a: "9" }, photoUrl: null, ...over });
const PRODUCTS = [
  shoe("pBare", "Puma Suede Bare"),                                     // nothing filed anywhere
  shoe("pCoded", "Nike Air Force Coded", { styleCodeNormalised: "BQ6817302" }),
  shoe("pAlias", "Adidas Samba Alias"),                                 // alias only, via the map
];

const textOf = (tr) => JSON.stringify(tr.toJSON());
const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const buttonWith = (tr, needle) => tr.root.findAll((n) => n.type === "button" && textIn(n).includes(needle))[0];

async function mount(products = PRODUCTS) {
  let tr;
  await act(async () => {
    tr = TestRenderer.create(<HubCleanup products={products} actorRole="warehouse" viewer={{}} />);
  });
  return tr;
}
async function openTab(tr, label) {
  // The Leftovers tab carries a live count in its label ("Leftovers · 3"), so
  // it is matched by prefix rather than by an exact string.
  const tab = tr.root.findAll((n) => n.type === "button" && textIn(n).replace(/\s+/g, "").startsWith(label))[0];
  if (!tab) throw new Error(`no tab starting "${label}" — saw: ${
    tr.root.findAll((n) => n.type === "button").map((b) => textIn(b)).join(" | ")}`);
  await act(async () => { tab.props.onClick(); });
  await act(async () => {});
}

beforeEach(() => { readerProps = null; IDENTITY = { map: { pAlias: { c: [], a: [["ADIDAS", "SAMBA", "OG"]] } }, ready: true }; });

describe("Leftovers is computed, never a stored list", () => {
  it("lists the product with NO identity and neither of the registered ones", async () => {
    const tr = await mount();
    await openTab(tr, "Leftovers");
    const json = textOf(tr);
    expect(json).toContain("Puma Suede Bare");
    expect(json).not.toContain("Nike Air Force Coded");   // a style code is registration
    expect(json).not.toContain("Adidas Samba Alias");     // a label alias is registration
  });

  it("a registration landing takes the card off the list with no reload and no remount", async () => {
    const tr = await mount();
    await openTab(tr, "Leftovers");
    expect(textOf(tr)).toContain("Puma Suede Bare");

    // The alias store answers differently now — exactly what invalidateIdentity
    // causes. The SAME renderer instance is updated; nothing is remounted.
    IDENTITY = { map: { pAlias: { c: [], a: [["ADIDAS"]] }, pBare: { c: [], a: [["PUMA", "SUEDE"]] } }, ready: true };
    await act(async () => {
      tr.update(<HubCleanup products={PRODUCTS} actorRole="warehouse" viewer={{}} />);
    });
    expect(textOf(tr)).not.toContain("Puma Suede Bare");
  });

  it("a product that gains a STYLE CODE leaves in the same way", async () => {
    const tr = await mount();
    await openTab(tr, "Leftovers");
    expect(textOf(tr)).toContain("Puma Suede Bare");
    const next = [shoe("pBare", "Puma Suede Bare", { styleCodeNormalised: "DD1391100" }), ...PRODUCTS.slice(1)];
    await act(async () => {
      tr.update(<HubCleanup products={next} actorRole="warehouse" viewer={{}} />);
    });
    expect(textOf(tr)).not.toContain("Puma Suede Bare");
  });
});

describe("the count page shows the code", () => {
  it("shows every code and every label wording, each copyable in one tap", async () => {
    IDENTITY = { map: { pCoded: { c: ["BQ6817302", "745SMA00421G"], a: [["NIKE", "AIRFORCE"]] } }, ready: true };
    const tr = await mount();
    await openTab(tr, "Count");
    // The count is scan-first: a read of the shoe's own code opens its panel,
    // which is the screen the operator is standing in front of.
    await act(async () => { await readerProps.onCode("BQ6817302", null); });
    const json = textOf(tr);
    expect(json).toContain("BQ6817302");
    expect(json).toContain("745SMA00421G");
    expect(json).toContain("NIKE AIRFORCE");
    // Each chip is a button that says what tapping it does.
    expect(json).toContain("Tap to copy BQ6817302");
    expect(json).toContain("Tap to copy NIKE AIRFORCE");
  });

  it("the REGISTER panel shows the same line, and says so plainly when there is no code", async () => {
    IDENTITY = { map: {}, ready: true };
    const tr = await mount();
    await openTab(tr, "Register");
    const search = tr.root.findAll((n) => n.type === "input")[0];
    await act(async () => { search.props.onChange({ target: { value: "Puma Suede" } }); });
    const row = buttonWith(tr, "Puma Suede Bare");
    await act(async () => { row.props.onClick(); });
    expect(textOf(tr)).toContain("No style code on record");
  });
});
