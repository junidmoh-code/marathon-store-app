// ─── THE CAPTURE SURFACE — what reaches the parent, and what never does ──────
// Manual entry is the rung every other rung falls back to, and it is the one
// place a human can put an arbitrary number into the system. So it is proven
// here that it faces the SAME check-digit gate as the camera, that a code owned
// by another product blocks instead of saving, and that an already-registered
// code is reported as the non-event it is.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const inspect = vi.fn();
vi.mock("../stock/printedBarcodeStore", () => ({
  inspectPrintedBarcode: (...args) => inspect(...args),
  ONE_SIZE: "_",
}));
vi.mock("../../firebase", () => ({ functions: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => vi.fn() }));
vi.mock("../stock/TongueLabelReader", () => ({ LabelCamera: () => null }));
vi.mock("../../utils/labelPhoto", () => ({ prepareLabelPhoto: vi.fn() }));
vi.mock("../../utils/barcodeDecode", () => ({ decodeFrames: vi.fn(), readPrintedDigits: vi.fn() }));

const PrintedBarcodeCapture = (await import("./PrintedBarcodeCapture.jsx")).default;

const OUD_MOOD = "6291106065114";
const BAD_CHECK = "6291106065115";

// react-test-renderer element trees carry children on props.children; the
// toJSON() snapshot carries them on .children. Handle both so `allText`
// (snapshot) and the button matchers (elements) can share one walker.
function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.children !== undefined) return textOf(n.children);
  if (n.props) return textOf(n.props.children);
  return "";
}
const allText = (r) => textOf(r.toJSON());
const textInput = (r) => r.root.findAllByType("input").find((i) => i.props.type !== "file");
const form = (r) => r.root.findByType("form");

async function mount(props = {}) {
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(PrintedBarcodeCapture, {
      productId: null, products: [], value: null,
      onCapture: vi.fn(), onClear: vi.fn(), ...props,
    }));
  });
  return r;
}

async function type(r, text) {
  await act(async () => { textInput(r).props.onChange({ target: { value: text } }); });
  await act(async () => { await form(r).props.onSubmit({ preventDefault() {} }); });
}

beforeEach(() => {
  inspect.mockReset();
  inspect.mockResolvedValue({ kind: "free", codes: [OUD_MOOD], indexCodes: [OUD_MOOD] });
});

describe("manual entry faces the check digit", () => {
  it("accepts a valid EAN-13 and hands it up", async () => {
    const onCapture = vi.fn();
    const r = await mount({ onCapture });
    await type(r, OUD_MOOD);
    expect(onCapture).toHaveBeenCalledWith(OUD_MOOD);
  });

  it("REFUSES a code failing its check digit — never captured, never looked up", async () => {
    const onCapture = vi.fn();
    const r = await mount({ onCapture });
    await type(r, BAD_CHECK);
    expect(onCapture).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();     // not even a read is spent on it
    expect(allText(r)).toMatch(/check digit/i);
  });

  it("refuses a wrong-length number and says what a barcode looks like", async () => {
    const onCapture = vi.fn();
    const r = await mount({ onCapture });
    await type(r, "6291106");   // 7 digits — not any retail symbology
    expect(onCapture).not.toHaveBeenCalled();
    expect(allText(r)).toMatch(/13 digits|EAN-13/);
  });
});

describe("a code already in the index", () => {
  it("on THIS product: reports already-registered and moves on", async () => {
    inspect.mockResolvedValue({ kind: "already", indexCodes: [OUD_MOOD] });
    const onCapture = vi.fn();
    const r = await mount({ productId: "pPerfume", onCapture, value: null });
    await type(r, OUD_MOOD);
    expect(onCapture).toHaveBeenCalledWith(OUD_MOOD);   // not an error — proceed
    expect(allText(r)).toMatch(/already registered/i);
  });

  it("on a DIFFERENT product: blocks, names it, and captures nothing", async () => {
    inspect.mockResolvedValue({ kind: "conflict", code: OUD_MOOD, otherProductId: "pOther", indexCodes: [OUD_MOOD] });
    const onCapture = vi.fn();
    const r = await mount({
      productId: null, onCapture,
      products: [{ id: "pOther", name: "Honeyed Fantasy 100ml" }],
    });
    await type(r, OUD_MOOD);

    expect(onCapture).not.toHaveBeenCalled();
    const text = allText(r);
    expect(text).toMatch(/already on another product/i);
    expect(text).toMatch(/Honeyed Fantasy 100ml/);      // the duplicate is NAMED
    expect(text).toMatch(/Merge Products/);             // routed to the existing flow
  });

  it("a failed index READ never passes as a free slot", async () => {
    // Accepting here would send the code to a create-only write that may be
    // denied silently — the product would show a barcode nothing resolves.
    inspect.mockRejectedValue(new Error("network down"));
    const onCapture = vi.fn();
    const r = await mount({ onCapture });
    await type(r, OUD_MOOD);
    expect(onCapture).not.toHaveBeenCalled();
    expect(allText(r)).toMatch(/could not check/i);
  });
});

describe("the accepted code is shown for confirmation", () => {
  it("renders the number large, grouped, before anything is written", async () => {
    const r = await mount({ value: OUD_MOOD });
    expect(allText(r)).toMatch(/6 291106 065114/);
    expect(allText(r)).toMatch(/check this against the box/i);
  });

  it("offers a retake that clears it", async () => {
    const onClear = vi.fn();
    const r = await mount({ value: OUD_MOOD, onClear });
    const retake = r.root.findAllByType("button").find((b) => /photograph it again/i.test(textOf(b.props.children)));
    await act(async () => { retake.props.onClick(); });
    expect(onClear).toHaveBeenCalled();
  });
});

describe("the deliberate fallback to auto-generation", () => {
  it("is offered when the parent supplies it, and takes ONE tap", async () => {
    const onUseAuto = vi.fn();
    const r = await mount({ onUseAuto });
    const btn = r.root.findAllByType("button").find((b) => /generate a shop barcode/i.test(textOf(b.props.children)));
    expect(btn).toBeTruthy();
    await act(async () => { btn.props.onClick(); });
    expect(onUseAuto).toHaveBeenCalledTimes(1);
  });

  it("says what it costs once chosen", async () => {
    const r = await mount({ onUseAuto: vi.fn(), usingAuto: true });
    expect(allText(r)).toMatch(/print and stick a label/i);
  });

  it("is NOT offered where there is nothing to fall back to (existing product)", async () => {
    const r = await mount({ productId: "pPerfume", onUseAuto: null });
    const btn = r.root.findAllByType("button").find((b) => /generate a shop barcode/i.test(textOf(b.props.children)));
    expect(btn).toBeUndefined();
  });
});
