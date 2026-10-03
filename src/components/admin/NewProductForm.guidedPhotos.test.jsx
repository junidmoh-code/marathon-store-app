// ─── FOOTWEAR CANNOT BE SAVED WITHOUT ITS ONE PHOTO (SHOE + BOX) ─────────────
// Owner spec 2026-10-02, revised 3 Oct. The form half of the gate (App's
// addProductOnce re-checks the same pure missingPhotoSteps):
//   • footwear: ONE guided step — the shoe WITH its box in the same shot; Save
//     stays disabled until it is taken, and the form says it is missing
//   • clothing: one optional garment step — Save is not blocked by it
//   • everything else: the plain photo button, unchanged

import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("./CategorySelect.jsx", () => ({ default: () => null }));
vi.mock("./SizeQtyBoxes.jsx", () => ({ default: () => null, totalUnits: () => 0 }));
vi.mock("../stock/widgets.jsx", () => ({ LocationPicker: () => null }));
vi.mock("../stock/locations.js", () => ({ labelFor: () => "Hub 2", transferTargets: [] }));
vi.mock("./PrintedBarcodeCapture.jsx", () => ({ default: () => null }));

const NewProductForm = (await import("./NewProductForm.jsx")).default;
const { GuidedPhotoStep } = await import("./GuidedPhotoCamera.jsx");

function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.children !== undefined) return textOf(n.children);
  if (n.props) return textOf(n.props.children);
  return "";
}
const allText = (r) => textOf(r.toJSON());
const saveBtn = (r) => r.root.findAllByType("button")
  .find((b) => /Save Product|Saving/.test(textOf(b.props.children)));

const shoeForm = {
  name: "Nike Dunk Low", categoryKey: "sneakers", sizeRun: ["9"], photo: "", photoUrl: null, photoBlob: null,
  photoSourceBlob: null,
  hubs: ["hub1"], stockPrice: "", retailPrice: "", hasShoeBoxOption: true,
  printedBarcode: null, printedBarcodeAuto: false,
};

async function mount(props = {}) {
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(NewProductForm, {
      styleCode: null, suggestedImageUrl: null, onChangeStyleCode: null,
      form: shoeForm, setForm: vi.fn(),
      taxonomy: {}, taxonomySource: "live",
      selectedCat: { key: "sneakers", label: "Sneakers" },
      formSizes: ["9"], formOneSize: false, formIsClothing: false,
      selectCategory: vi.fn(), toggleHub: vi.fn(), toggleShoebox: vi.fn(),
      recvQtys: {}, setRecvQtys: vi.fn(),
      recvLoc: "hub2", setRecvLoc: vi.fn(), recvRegistry: {},
      fileInputRef: { current: null }, handleImageUpload: vi.fn(), onGuidedPhoto: vi.fn(),
      products: [], isPerfume: false,
      onCapturePrintedBarcode: vi.fn(), onClearPrintedBarcode: vi.fn(), onUseAutoBarcode: vi.fn(),
      saving: false, saveAttempted: false, onSave: vi.fn(),
      ...props,
    }));
  });
  return r;
}

describe("footwear: one photo, the shoe with its box", () => {
  it("renders ONE guided step, labelled Product photo with the one-photo hint", async () => {
    const r = await mount();
    expect(r.root.findAllByType(GuidedPhotoStep).map((s) => s.props.step.id)).toEqual(["shoe"]);
    expect(allText(r)).toMatch(/Product photo/);
    expect(allText(r)).not.toMatch(/Product photos/);
    expect(allText(r)).toMatch(/one photo: the shoe with its box/);
  });

  it("refuses to save with no photo, and says the shoe + box photo is needed", async () => {
    const r = await mount();
    expect(saveBtn(r).props.disabled).toBe(true);
    expect(allText(r)).toMatch(/Still needed before saving: shoe \+ box photo\./);
  });

  it("allows the save once the one photo is taken — no box photo, no No box", async () => {
    const r = await mount({ form: { ...shoeForm, photoBlob: {}, photoUrl: "data:x" } });
    expect(saveBtn(r).props.disabled).toBe(false);
    expect(allText(r)).not.toMatch(/Still needed/);
  });

  it("the step previews the product photo", async () => {
    const r = await mount({ form: { ...shoeForm, photoBlob: {}, photoUrl: "data:x" } });
    expect(r.root.findByType(GuidedPhotoStep).props.previewUrl).toBe("data:x");
  });

  it("a blocked save paints the step red", async () => {
    const r = await mount({ saveAttempted: true });
    expect(r.root.findByType(GuidedPhotoStep).props.invalid).toBe(true);
  });

  it("the capture goes to onGuidedPhoto with its step", async () => {
    const onGuidedPhoto = vi.fn();
    const r = await mount({ onGuidedPhoto });
    const step = r.root.findByType(GuidedPhotoStep);
    const file = { name: "shoe-and-box.jpg" };
    await act(async () => { step.props.onFile(file); });
    expect(onGuidedPhoto).toHaveBeenCalledWith(step.props.step, file);
  });

  it("no No box option anywhere", async () => {
    const r = await mount({ onSkipBox: vi.fn() });
    expect(r.root.findByType(GuidedPhotoStep).props.onSkip).toBeUndefined();
    expect(allText(r)).not.toMatch(/No box/);
  });
});

describe("clothing: one optional garment step", () => {
  it("renders the garment step and does not block the save", async () => {
    const r = await mount({
      form: { ...shoeForm, categoryKey: "t-shirts", sizeRun: ["M"], hubs: ["hub2"] },
      selectedCat: { key: "t-shirts", label: "T-Shirts" }, formSizes: ["M"], formIsClothing: true,
    });
    expect(r.root.findAllByType(GuidedPhotoStep).map((s) => s.props.step.id)).toEqual(["garment"]);
    expect(saveBtn(r).props.disabled).toBe(false);
  });
});

describe("everything else: unchanged", () => {
  it("perfume keeps the plain photo button and no guided steps", async () => {
    const r = await mount({
      form: { ...shoeForm, categoryKey: "perfumes", sizeRun: [], printedBarcodeAuto: true },
      selectedCat: { key: "perfumes", label: "Perfumes" }, formSizes: ["_"], formOneSize: true, isPerfume: true,
    });
    expect(r.root.findAllByType(GuidedPhotoStep)).toHaveLength(0);
    expect(allText(r)).toMatch(/Tap to upload photo/);
    expect(saveBtn(r).props.disabled).toBe(false);
  });
});
