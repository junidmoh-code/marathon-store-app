// ─── ONE READER, FIVE SURFACES — the camera opens and a capture completes ────
// (Owner spec 2026-08-23.) Every surface that reads a tongue label is mounted
// here with the REAL shared reader (stock/TongueLabelReader.jsx) and the REAL
// LabelCamera, and for each one the same three things are proved:
//
//   1. the surface shows the shared "Photograph the tongue label" button —
//      the ONE implementation, not a copy
//   2. tapping it opens the camera overlay and requests the rear stream
//   3. a three-frame burst completes into THAT surface's own handler and the
//      surface reacts the way its job requires (a list, a field, a panel)
//
// The surfaces: register display and count (HubCleanup), the merge target
// picker (MergeProducts), the assistant product finder (AssistantLabelFinder),
// add-product intake (admin StyleCodeGate). A guard at the end pins that no
// file in src/ other than the reader (and the perfume box-barcode capture,
// which deliberately reuses the same callable) talks to readStyleCodeLabel —
// so a second copy cannot grow back unnoticed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── the OCR callable, scripted per test ─────────────────────────────────────
const readCalls = [];
let readResponse = null;
const labelAliasCall = vi.fn(async () => ({ data: { owners: [], resolved: null } }));
vi.mock("firebase/functions", () => ({
  httpsCallable: (_f, name) => async (args) => {
    if (name === "readStyleCodeLabel") { readCalls.push(args); return { data: readResponse }; }
    if (name === "labelAlias") return labelAliasCall(args);
    return { data: {} };
  },
}));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class { constructor() {} scanFile() { return Promise.reject(new Error("no QR")); } clear() {} },
  Html5QrcodeSupportedFormats: {},
}));
vi.mock("../../utils/labelPhoto", () => ({ prepareLabelPhoto: async () => ({ dataUrl: "d", base64: "b", blob: {} }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1754300000000, serverNowIso: () => "2026-08-23T08:00:00.000Z" }));
vi.mock("../../config/styleCode", async () => ({
  ...(await vi.importActual("../../config/styleCode")),
  STYLE_CODE_LOOKUP_ENABLED: false,
}));

// ── the stores every surface talks to ───────────────────────────────────────
const lookupStyleClaim = vi.fn(async () => null);
const resolveAnyCodes = vi.fn(async () => ({ resolved: null, owners: [] }));
const matchLabelAlias = vi.fn(async () => ({ band: "low", candidates: [] }));
const fetchProductFollowingMerge = vi.fn(async () => null);
const recordLabelCodes = vi.fn(async () => ({ ok: true, attached: [], conflicts: [] }));
const addLabelAlias = vi.fn(async () => ({ ok: true }));
const registerDisplayUnit = vi.fn(async () => ({ ok: true }));
const learnLabelLayout = vi.fn(async () => ({ ok: true }));
vi.mock("./hubCleanupStore", () => ({
  loadRegister: async () => ({}),
  loadUnresolved: async () => ({}),
  registerDisplayUnit: (...a) => registerDisplayUnit(...a),
  addExtraDisplayUnit: async () => ({ ok: true }),
  recordUnresolvedScan: async () => ({ ok: true }),
  lookupBarcode: async () => null,
  loadAllStock: async () => ({}),
  loadDuplicateCandidates: async () => ({}),
  fetchProductFollowingMerge: (...a) => fetchProductFollowingMerge(...a),
  lookupStyleClaim: (...a) => lookupStyleClaim(...a),
  matchLabelAlias: (...a) => matchLabelAlias(...a),
  addLabelAlias: (...a) => addLabelAlias(...a),
  answerStyleCodeSibling: async () => ({}),
  lookupCodeAlias: async () => null,
  resolveAnyCodes: (...a) => resolveAnyCodes(...a),
  recordLabelCodes: (...a) => recordLabelCodes(...a),
  learnLabelLayout: (...a) => learnLabelLayout(...a),
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
vi.mock("../../config/hubSneakerCount", () => ({ canAdjustHubCount: () => false }));
vi.mock("./CameraScanner.jsx", () => ({ default: () => null }));
vi.mock("./HubSneakerCount.jsx", () => ({ default: () => null }));

const { TongueLabelReader, LabelCamera } = await import("./TongueLabelReader.jsx");
const { default: HubCleanup } = await import("./HubCleanup.jsx");
const { default: MergeProducts } = await import("./MergeProducts.jsx");
const { default: AssistantLabelFinder } = await import("../assistant/AssistantLabelFinder.jsx");
const { default: StyleCodeGate } = await import("../admin/StyleCodeGate.jsx");

// ── fixtures ────────────────────────────────────────────────────────────────
// A Timberland tongue label prints TWO codes; each is registered to a
// different product here, so every surface must LIST both (never pick one).
const TIMBER = { id: "pTimber", name: "Timberland 6-Inch Wheat", styleCodeNormalised: "A6CWNEN3",
                 sizes: { a: "8" }, photoUrl: "https://x/timber.jpg", categoryKey: "sneakers" };
const EURO = { id: "pEuro", name: "Timberland Euro Hiker Black", styleCodeNormalised: "A8425",
               sizes: { a: "8" }, photoUrl: "https://x/euro.jpg", categoryKey: "sneakers" };
const LOSER = { id: "pDup", name: "timberland boot (dup)", sizes: { a: "8" }, photoUrl: "https://x/dup.jpg", categoryKey: "sneakers" };
const PRODUCTS = [TIMBER, EURO, LOSER];
const TIMBERLAND_READ = {
  candidates: ["A6CWNEN3", "A8425"], displayCandidates: ["A6CWNEN3", "A8425"],
  autoPick: null, preferred: null,
  tokens: ["A6CWNEN3", "A8425", "GTX", "MID", "MOTION", "TIMBERLAND"],
  modelName: "TIMBERLAND MOTION 6 MID GTX", colorway: null, upc: null, errors: [],
};
const FRAMES = [{ base64: "f1", blob: {}, dataUrl: "data:f1" }, { base64: "f2", blob: {}, dataUrl: "data:f2" }, { base64: "f3", blob: {}, dataUrl: "data:f3" }];

const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const textOf = (tr) => JSON.stringify(tr.toJSON());
const buttonWith = (tr, needle) => tr.root.findAll((n) => n.type === "button" && textIn(n).includes(needle))[0];
const cardFor = (tr, name) => tr.root.findAll((n) => n.type === "div" && n.props.role === "button" && textIn(n).includes(name))[0];

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}
let getUserMedia;
beforeEach(() => {
  vi.clearAllMocks();
  readCalls.length = 0;
  readResponse = TIMBERLAND_READ;
  lookupStyleClaim.mockImplementation(async () => null);
  resolveAnyCodes.mockImplementation(async () => ({ resolved: null, owners: [] }));
  matchLabelAlias.mockImplementation(async () => ({ band: "low", candidates: [] }));
  fetchProductFollowingMerge.mockImplementation(async () => null);
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop() {} }] }));
  setNavigator({ mediaDevices: { getUserMedia } });
});
afterEach(() => setNavigator(undefined));

// The shared three steps, run against whatever tree the surface mounted.
async function openCameraAndCapture(tr) {
  const readers = tr.root.findAllByType(TongueLabelReader);
  expect(readers.length).toBeGreaterThanOrEqual(1);
  const btn = buttonWith(tr, "Photograph the tongue label");
  expect(btn).toBeTruthy();
  await act(async () => { btn.props.onClick(); });
  const cam = tr.root.findByType(LabelCamera);
  expect(getUserMedia).toHaveBeenCalled();
  await act(async () => { await cam.props.onFrames(FRAMES); });
  expect(readCalls.length).toBeGreaterThanOrEqual(1);
  expect(tr.root.findAllByType(LabelCamera)).toHaveLength(0);
}

describe("the camera opens and a capture completes on every surface", () => {
  it("COUNT (HubCleanup): the burst pools BOTH Timberland owners into the choose panel, nothing auto-picked", async () => {
    let tr;
    await act(async () => { tr = TestRenderer.create(<HubCleanup products={PRODUCTS} actorRole="warehouse" viewer={{}} />); });
    const countTab = tr.root.findAll((n) => n.type === "button" && n.children.join("") === "Count")[0];
    await act(async () => { countTab.props.onClick(); });
    await openCameraAndCapture(tr);
    const t = textOf(tr);
    expect(cardFor(tr, "Timberland 6-Inch Wheat")).toBeTruthy();
    expect(cardFor(tr, "Timberland Euro Hiker Black")).toBeTruthy();
    // Nothing was counted or filed before a tap.
    expect(recordLabelCodes).not.toHaveBeenCalled();
    expect(t).not.toContain("tap the style number:");
  });

  it("REGISTER (HubCleanup RegisterPanel): the burst lands the head of the set AND keeps every token for the save", async () => {
    const NEW = { id: "pNew", name: "Timberland Motion 6 Mid", sizes: { a: "8" }, photoUrl: null, categoryKey: "sneakers" };
    let tr;
    await act(async () => { tr = TestRenderer.create(<HubCleanup products={[NEW]} actorRole="warehouse" viewer={{}} />); });
    const search = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "Search the catalogue by name…")[0];
    await act(async () => { search.props.onChange({ target: { value: "Motion 6" } }); });
    const row = tr.root.findAll((n) => (n.type === "button" || n.props?.role === "button") && textIn(n).includes("Timberland Motion 6 Mid"))[0];
    await act(async () => { row.props.onClick(); });
    await openCameraAndCapture(tr);
    const t = textOf(tr);
    expect(t).toContain("Style number:");
    expect(t).toContain("A8425");           // the deterministic head of the set
    expect(t).not.toContain("tap the style number:");
    // Pick the size and fire the ONE register action (the shop picker is
    // driven elsewhere; the handler is invoked directly here): the store
    // receives the code, EVERY code, and the label's wording — one save.
    const sizeBtn = buttonWith(tr, "8");
    await act(async () => { sizeBtn.props.onClick(); });
    const save = buttonWith(tr, "✓ REGISTER");
    expect(save).toBeTruthy();
    expect(textIn(save)).toContain("+ style number");
    await act(async () => { await save.props.onClick(); });
    const payload = registerDisplayUnit.mock.calls[0]?.[0]?.styleCode;
    expect(payload).toBeTruthy();
    expect(payload.code).toBe("A8425");
    expect(payload.source).toBe("label");
    expect(payload.allCodes).toEqual(["A6CWNEN3", "A8425"]);
    expect(payload.aliasTokens).toEqual(["A6CWNEN3", "A8425", "GTX", "MID", "MOTION", "TIMBERLAND"]);
  });

  it("MERGE PICKER: the burst lists both owners through the shared cards; nothing advances without a tap", async () => {
    let tr;
    await act(async () => {
      tr = TestRenderer.create(<MergeProducts initialLoser={LOSER} products={PRODUCTS} allStock={{}} registry={{}} onClose={() => {}} onMerged={() => {}} />);
    });
    await openCameraAndCapture(tr);
    expect(cardFor(tr, "Timberland 6-Inch Wheat")).toBeTruthy();
    expect(cardFor(tr, "Timberland Euro Hiker Black")).toBeTruthy();
    expect(textOf(tr)).not.toContain("SURVIVES");
  });

  it("ASSISTANT FINDER: the burst lists both owners through the shared cards; onFound waits for the tap", async () => {
    const onFound = vi.fn();
    let tr;
    await act(async () => { tr = TestRenderer.create(<AssistantLabelFinder products={PRODUCTS} onFound={onFound} onClose={() => {}} />); });
    await openCameraAndCapture(tr);
    expect(onFound).not.toHaveBeenCalled();
    expect(cardFor(tr, "Timberland 6-Inch Wheat")).toBeTruthy();
    expect(cardFor(tr, "Timberland Euro Hiker Black")).toBeTruthy();
    await act(async () => { cardFor(tr, "Timberland Euro Hiker Black").props.onClick(); });
    expect(onFound).toHaveBeenCalledWith(EURO);
  });

  it("ADD-PRODUCT (StyleCodeGate): the burst fills the code field with the head of the set; no 'tap the right one'", async () => {
    let tr;
    await act(async () => {
      tr = TestRenderer.create(<StyleCodeGate products={PRODUCTS} onCancel={() => {}} onAddStock={() => {}} onProceed={() => {}} />);
    });
    await openCameraAndCapture(tr);
    const field = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "CT8527-016")[0];
    expect(field.props.value).toBe("A8425");
    const t = textOf(tr);
    expect(t).toContain("read A8425 as the style number; the others are saved with it");
    expect(t).not.toContain("tap the right one");
    // The gate does not render a SECOND typed field — the reader's is off here.
    expect(tr.root.findAll((n) => n.type === "input" && /type the style number/.test(n.props.placeholder || ""))).toHaveLength(0);
  });
});

describe("ONE implementation — a second copy cannot grow back", () => {
  it("only the shared reader (and the perfume box capture that reuses its callable) talk to readStyleCodeLabel", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, "..", "..");
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(jsx?|tsx?)$/.test(name) || /\.test\./.test(name)) continue;
        const src = readFileSync(p, "utf8");
        if (/httpsCallable\([^)]*"readStyleCodeLabel"\)/.test(src)) offenders.push(p.slice(srcRoot.length + 1));
      }
    };
    walk(srcRoot);
    expect(offenders.sort()).toEqual([
      "components/admin/PrintedBarcodeCapture.jsx",
      "components/stock/TongueLabelReader.jsx",
    ]);
  });

  it("every surface mounts TongueLabelReader from the shared module", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, "..", "..");
    for (const f of ["components/stock/HubCleanup.jsx", "components/stock/MergeProducts.jsx",
                     "components/assistant/AssistantLabelFinder.jsx", "components/admin/StyleCodeGate.jsx"]) {
      const src = readFileSync(join(srcRoot, f), "utf8");
      expect(src, f).toMatch(/import \{ TongueLabelReader \} from "[./]+\/?(components\/)?(stock\/)?TongueLabelReader(\.jsx)?"/);
      expect(src, f).toMatch(/<TongueLabelReader /);
      // and no private getUserMedia / file-capture of its own
      expect(src, f).not.toMatch(/getUserMedia/);
    }
  });
});
