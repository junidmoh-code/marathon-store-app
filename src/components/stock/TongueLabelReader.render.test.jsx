// ─── THE SHARED READER, RENDERED FOR REAL ────────────────────────────────────
// Every other label test mocks TongueLabelReader away and drives its props.
// This file renders the REAL reader and the REAL LabelCamera, and proves the
// owner's 2026-08-23 contract on the one implementation every surface shares:
//
//   • the camera OPENS on the tap (getUserMedia is requested) and a burst
//     COMPLETES into the consumer's handler
//   • a Lacoste label yields the article code, the production code and the
//     model line as SEPARATE tokens; a Timberland label yields BOTH codes
//   • a multi-code read without a server pick NEVER asks "which code" — the
//     consumer's onCode fires at once with the full set riding `allCodes`
//   • where getUserMedia is unavailable the tap goes straight to the file
//     input — the flow is never lost
//   • the reader's typed escape can be switched off by a host with its own field
//
// Mutation-proved in scripts/mutation-proof-label-reader.mjs.

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const readCalls = [];
let readResponses = [];
vi.mock("firebase/functions", () => ({
  httpsCallable: (_f, name) => async (args) => {
    if (name !== "readStyleCodeLabel") return { data: {} };
    readCalls.push(args);
    const next = readResponses.length > 1 ? readResponses.shift() : readResponses[0];
    if (next instanceof Error) throw next;
    return { data: next || { candidates: [], tokens: [], errors: [] } };
  },
}));
vi.mock("../../firebase", () => ({ functions: {}, auth: { currentUser: { uid: "u1" } }, database: {} }));
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class { constructor() {} scanFile() { return Promise.reject(new Error("no QR")); } clear() {} },
  Html5QrcodeSupportedFormats: {},
}));
vi.mock("./hubCleanupStore", () => ({ learnLabelLayout: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../utils/labelPhoto", () => ({
  prepareLabelPhoto: async () => ({ dataUrl: "data:image/jpeg;base64,ZmlsZQ==", base64: "ZmlsZQ==", blob: {} }),
}));

const { TongueLabelReader, LabelCamera, cameraStreamAvailable } = await import("./TongueLabelReader.jsx");

// ── the label fixtures, as the live callable returns them (probed 2026-08-23) ─
const LACOSTE = {
  candidates: ["45SMA0018", "352890625"], displayCandidates: ["45SMA0018", "352890-625"],
  autoPick: null, preferred: null,
  tokens: ["45SMA0018", "BRKR", "CTT", "LGUARD", "SFA"],
  modelName: "LGUARD BRKR CTT 225 2 SFA", colorway: null, upc: null, errors: [],
};
const TIMBERLAND = {
  candidates: ["A6CWNEN3", "A8425"], displayCandidates: ["A6CWNEN3", "A8425"],
  autoPick: null, preferred: null,
  tokens: ["A6CWNEN3", "A8425", "GTX", "MID", "MOTION", "TIMBERLAND"],
  modelName: "TIMBERLAND MOTION 6 MID GTX", colorway: null, upc: null, errors: [],
};
const NIKE = {
  candidates: ["CT8527016"], displayCandidates: ["CT8527-016"], tokens: ["CT8527", "DUNK", "LOW", "RETRO"],
  modelName: null, colorway: "WHITE/BLACK", upc: null, errors: [],
};
const FRAMES = [{ base64: "f1", blob: {}, dataUrl: "data:f1" }, { base64: "f2", blob: {}, dataUrl: "data:f2" }, { base64: "f3", blob: {}, dataUrl: "data:f3" }];

const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const textOf = (tr) => JSON.stringify(tr.toJSON());
const buttonWith = (tr, needle) => tr.root.findAll((n) => n.type === "button" && textIn(n).includes(needle))[0];

// Node 22 exposes a read-only `navigator` getter on globalThis — redefine it.
function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}
let getUserMedia;
let stopped;
beforeEach(() => {
  readCalls.length = 0;
  readResponses = [];
  stopped = 0;
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }));
  setNavigator({ mediaDevices: { getUserMedia } });
});
afterEach(() => { setNavigator(undefined); });

async function mount(props = {}) {
  let tr;
  await act(async () => { tr = TestRenderer.create(<TongueLabelReader onCode={props.onCode || vi.fn()} onTokens={props.onTokens || null} {...props} />); });
  return tr;
}

describe("the camera opens and a burst completes", () => {
  it("the tap opens the camera overlay and requests the rear camera stream", async () => {
    const tr = await mount();
    expect(tr.root.findAllByType(LabelCamera)).toHaveLength(0);
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    expect(tr.root.findAllByType(LabelCamera)).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toEqual({ video: { facingMode: "environment" } });
    expect(textOf(tr)).toContain("Capture the label");
  });

  it("three frames reach the OCR one by one (a multi-frame burst), and the consumer's onCode fires once", async () => {
    readResponses = [NIKE];
    const onCode = vi.fn();
    const tr = await mount({ onCode });
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    const cam = tr.root.findByType(LabelCamera);
    await act(async () => { await cam.props.onFrames(FRAMES); });
    // One clean candidate short-circuits on the first frame — one bill, not three.
    expect(readCalls.length).toBe(1);
    expect(readCalls[0]).toEqual({ imageBase64: "f1", mimeType: "image/jpeg" });
    expect(onCode).toHaveBeenCalledTimes(1);
    expect(onCode.mock.calls[0][0]).toBe("CT8527-016");
    expect(onCode.mock.calls[0][1]).toMatchObject({ source: "label", colorway: "WHITE/BLACK", tokens: ["CT8527", "DUNK", "LOW", "RETRO"] });
    // The camera overlay is gone once the burst is handed over.
    expect(tr.root.findAllByType(LabelCamera)).toHaveLength(0);
  });

  it("a code-less label needs agreement across frames: tokens seen in ≥2 of 3 survive, the rest are dropped", async () => {
    readResponses = [
      { candidates: [], tokens: ["CLOUDNOVA", "MONO", "UNDYED", "NOISE1"], errors: [] },
      { candidates: [], tokens: ["CLOUDNOVA", "MONO", "NOISE2"], errors: [] },
      { candidates: [], tokens: ["CLOUDNOVA", "UNDYED", "NOISE3"], errors: [] },
    ];
    const onTokens = vi.fn();
    const tr = await mount({ onTokens });
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    await act(async () => { await tr.root.findByType(LabelCamera).props.onFrames(FRAMES); });
    expect(readCalls.length).toBe(3);
    expect(onTokens).toHaveBeenCalledTimes(1);
    expect(onTokens.mock.calls[0][0]).toEqual(["CLOUDNOVA", "MONO", "UNDYED"]);
    expect(onTokens.mock.calls[0][1].tokens).toEqual(["CLOUDNOVA", "MONO", "UNDYED"]);
  });
});

describe("the label is a SET — every token, as separate tokens", () => {
  it("Lacoste: article code, production code and the model line arrive as separate tokens, no question asked", async () => {
    readResponses = [LACOSTE];
    const onCode = vi.fn();
    const tr = await mount({ onCode });
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    await act(async () => { await tr.root.findByType(LabelCamera).props.onFrames(FRAMES); });
    expect(onCode).toHaveBeenCalledTimes(1);
    const [display, meta] = onCode.mock.calls[0];
    expect(display).toBe("45SMA0018");                          // the head of the set (labelPrimary rule)
    expect(meta.allCodes).toEqual(["45SMA0018", "352890625"]);   // article AND production code
    expect(meta.modelName).toBe("LGUARD BRKR CTT 225 2 SFA");   // the model line, whole
    expect(meta.tokens).toEqual(["45SMA0018", "BRKR", "CTT", "LGUARD", "SFA"]);
    expect(meta.auto).toBe(true);
    expect(meta.autoSource).toBe("rule");
    // NEVER a question: the old blocking prompt is gone; the override note is
    // informational and the flow has already proceeded.
    expect(textOf(tr)).not.toContain("tap the style number:");
    expect(textOf(tr)).toContain("every number on this label is saved with it");
  });

  it("Timberland: BOTH codes ride allCodes; the rule heads the set with the more specific A6CWNEN3", async () => {
    readResponses = [TIMBERLAND];
    const onCode = vi.fn();
    const tr = await mount({ onCode });
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    await act(async () => { await tr.root.findByType(LabelCamera).props.onFrames(FRAMES); });
    const [display, meta] = onCode.mock.calls[0];
    expect(display).toBe("A6CWNEN3");
    expect(meta.allCodes).toEqual(["A6CWNEN3", "A8425"]);
    expect(meta.modelName).toBe("TIMBERLAND MOTION 6 MID GTX");
  });

  it("the override chip re-fires onCode with the other token, still carrying the full set AND the same evidence", async () => {
    readResponses = [{ ...TIMBERLAND, colorway: "WHEAT/NUBUCK", upc: "0194213000001" }];
    const onCode = vi.fn();
    const tr = await mount({ onCode });
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    await act(async () => { await tr.root.findByType(LabelCamera).props.onFrames(FRAMES); });
    const chip = buttonWith(tr, "A8425");
    expect(chip).toBeTruthy();
    await act(async () => { chip.props.onClick(); });
    expect(onCode).toHaveBeenCalledTimes(2);
    expect(onCode.mock.calls[1][0]).toBe("A8425");
    expect(onCode.mock.calls[1][1].allCodes).toEqual(["A6CWNEN3", "A8425"]);
    // An override must never cost the consumer the read's evidence.
    expect(onCode.mock.calls[1][1]).toMatchObject({
      colorway: "WHEAT/NUBUCK", upc: "0194213000001", modelName: "TIMBERLAND MOTION 6 MID GTX",
      tokens: TIMBERLAND.tokens, autoSource: "override", tokensAgreed: false,
    });
  });
});

describe("the flow is never lost", () => {
  it("without getUserMedia the tap CLICKS the file input directly — no overlay, no dead end", async () => {
    setNavigator(undefined);
    expect(cameraStreamAvailable()).toBe(false);
    const click = vi.fn();
    let tr;
    await act(async () => {
      tr = TestRenderer.create(<TongueLabelReader onCode={vi.fn()} />, {
        createNodeMock: (el) => (el.type === "input" && el.props.type === "file" ? { click } : null),
      });
    });
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    expect(tr.root.findAllByType(LabelCamera)).toHaveLength(0);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("with a stream API that REJECTS, the overlay offers the single-photo fallback", async () => {
    getUserMedia.mockImplementation(async () => { throw new Error("NotAllowedError"); });
    const tr = await mount();
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    await act(async () => { await Promise.resolve(); });
    expect(textOf(tr)).toContain("Take one photo");
  });

  it("the single-photo file input runs the SAME frame pipeline", async () => {
    readResponses = [LACOSTE];
    const onCode = vi.fn();
    const tr = await mount({ onCode });
    const fileInput = tr.root.findAll((n) => n.type === "input" && n.props.type === "file")[0];
    await act(async () => { await fileInput.props.onChange({ target: { files: [{}], value: "" } }); });
    expect(readCalls.length).toBe(1);
    expect(readCalls[0].imageBase64).toBe("ZmlsZQ==");
    expect(onCode.mock.calls[0][1].allCodes).toEqual(["45SMA0018", "352890625"]);
  });

  it("one failing frame does not discard the others; ALL failing says so and offers typing", async () => {
    readResponses = [new Error("boom"), LACOSTE, LACOSTE];
    const onCode = vi.fn();
    const tr = await mount({ onCode });
    await act(async () => { buttonWith(tr, "Photograph the tongue label").props.onClick(); });
    await act(async () => { await tr.root.findByType(LabelCamera).props.onFrames(FRAMES); });
    expect(onCode).toHaveBeenCalledTimes(1);

    readResponses = [new Error("503 no instance")];
    const tr2 = await mount({ onCode: vi.fn() });
    await act(async () => { buttonWith(tr2, "Photograph the tongue label").props.onClick(); });
    await act(async () => { await tr2.root.findByType(LabelCamera).props.onFrames(FRAMES); });
    expect(textOf(tr2)).toContain("Could not read that label");
    expect(textOf(tr2)).toContain("type the style number");
  });

  it("a host with its own code field switches the typed escape off", async () => {
    const tr = await mount({ typed: false });
    expect(tr.root.findAll((n) => n.type === "input" && n.props.placeholder && /type the style number/.test(n.props.placeholder))).toHaveLength(0);
    const tr2 = await mount();
    expect(tr2.root.findAll((n) => n.type === "input" && n.props.placeholder && /type the style number/.test(n.props.placeholder))).toHaveLength(1);
  });
});
