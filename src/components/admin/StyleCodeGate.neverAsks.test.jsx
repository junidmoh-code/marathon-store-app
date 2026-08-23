// ─── THE INTAKE GATE NEVER ASKS WHICH CODE — and files every token ───────────
// (Owner spec 2026-08-23.) The gate is a consumer of the shared reader now
// (stock/TongueLabelReader.jsx); this file drives the REAL reader's file input
// and proves what the gate does with a multi-code read the server offers NO
// pick for (no learned layout rule, no tier-2 preference):
//   1. no "tap the right one" question — the field fills with the head of the
//      set chosen by the deterministic rule, the full set is announced
//   2. on continue, EVERY other token rides the payload as labelOtherCodes,
//      bound to the photo — the save files them all (recordLabelCodes)
//   3. a token already owned by a DIFFERENT product routes to the
//      pre-duplicate question (the existing duplicate flow) — never silently on
//   4. only ONE typed field is on screen (the reader's own is switched off)
//   5. a code-less reading keeps the wording as evidence and says the ways forward

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let labelRead = vi.fn(async () => ({ data: TIMBERLAND_NO_PICK }));
const TIMBERLAND_NO_PICK = {
  candidates: ["A6CWNEN3", "A8425"], displayCandidates: ["A6CWNEN3", "A8425"],
  autoPick: null, preferred: null,
  tokens: ["A6CWNEN3", "A8425", "GTX", "MID", "MOTION", "TIMBERLAND"],
  colorway: null, upc: null, modelName: "TIMBERLAND MOTION 6 MID GTX",
  source: "gemini", fromCache: false, errors: [],
};
vi.mock("../../config/styleCode", async () => ({
  ...(await vi.importActual("../../config/styleCode")),
  STYLE_CODE_LOOKUP_ENABLED: false,
}));
const labelAliasCall = vi.fn(async () => ({ data: { owners: [], resolved: null } }));
vi.mock("firebase/functions", () => ({
  httpsCallable: (_f, name) => (...a) => (
    name === "readStyleCodeLabel" ? labelRead(...a)
      : name === "labelAlias" ? labelAliasCall(...a)
        : Promise.resolve({ data: {} })),
}));
vi.mock("../../firebase", () => ({ functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1754300000000 }));
vi.mock("../../utils/labelPhoto", () => ({ prepareLabelPhoto: async () => ({ dataUrl: "d", base64: "b", blob: {} }) }));
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class { constructor() {} scanFile() { return Promise.reject(new Error("no QR")); } clear() {} },
  Html5QrcodeSupportedFormats: {},
}));
vi.mock("../stock/hubCleanupStore", () => ({ learnLabelLayout: vi.fn(async () => ({})) }));

const StyleCodeGate = (await import("./StyleCodeGate.jsx")).default;

function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.props) return textOf(n.props.children);
  return "";
}
const btn = (root, re) => root.findAllByType("button").find((b) => re.test(textOf(b.props.children)));
const field = (r) => r.root.findAllByType("input").find((i) => i.props.placeholder === "CT8527-016");

async function mountAndPhotograph(products = []) {
  const onProceed = vi.fn(), onAddStock = vi.fn();
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(StyleCodeGate, { products, onCancel: vi.fn(), onAddStock, onProceed }));
  });
  const file = r.root.findAllByType("input").find((i) => i.props.type === "file");
  await act(async () => { await file.props.onChange({ target: { files: [{}], value: "" } }); });
  return { r, onProceed, onAddStock };
}

beforeEach(() => {
  vi.clearAllMocks();
  labelRead = vi.fn(async () => ({ data: TIMBERLAND_NO_PICK }));
  labelAliasCall.mockImplementation(async () => ({ data: { owners: [], resolved: null } }));
});

describe("never asks which code", () => {
  it("a two-code read with NO server pick fills the field with the rule's choice and announces the set — no question", async () => {
    const { r } = await mountAndPhotograph();
    expect(field(r).props.value).toBe("A6CWNEN3");
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Read from the label: A6CWNEN3 — and 1 other number on it is saved with it");
    expect(text).not.toContain("tap the right one");
    expect(text).not.toContain("tap the style number:");
    // One typed field only — the reader's own escape is off inside the gate.
    expect(r.root.findAllByType("input").filter((i) => /type the style number/.test(i.props.placeholder || ""))).toHaveLength(0);
  });

  it("on continue EVERY other token rides the payload, bound to the photo", async () => {
    const { r, onProceed } = await mountAndPhotograph();
    await act(async () => { await btn(r.root, /continue/i).props.onClick(); });
    expect(onProceed).toHaveBeenCalledTimes(1);
    const payload = onProceed.mock.calls[0][0];
    expect(payload.styleCodeNormalised).toBe("A6CWNEN3");
    expect(payload.labelOtherCodes).toEqual(["A8425"]);
    expect(payload.labelPhoto).toBeTruthy();
  });

  it("a token owned by a DIFFERENT product routes to the duplicate question — never a silent attach", async () => {
    const euro = { id: "pEuro", name: "Timberland Euro Hiker Black", styleCodeNormalised: "A8425", photoUrl: "https://x/euro.jpg" };
    const { r, onProceed } = await mountAndPhotograph([euro]);
    // The OTHER token (A8425) belongs to an existing product — the gate must
    // stop and show it before anything is created.
    await act(async () => { await btn(r.root, /continue/i).props.onClick(); });
    expect(onProceed).not.toHaveBeenCalled();
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Timberland Euro Hiker Black");
    expect(text).toMatch(/other token A8425|already registered with exactly this code/);
  });

  it("a code-less reading keeps the wording as evidence and names the ways forward", async () => {
    labelRead = vi.fn(async () => ({ data: { candidates: [], tokens: ["CLOUDNOVA", "MONO", "UNDYED"], modelName: null, errors: [] } }));
    const { r, onProceed } = await mountAndPhotograph();
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("No style code on that label");
    expect(text).toContain("no readable style number");
    expect(field(r).props.value).toBe("");
    expect(onProceed).not.toHaveBeenCalled();
  });
});
