// ─── FOOTWEAR CANNOT BE SAVED WITHOUT THE SHOE AND ITS BOX ───────────────────
// Owner spec 2026-10-02. The form half of the gate (App's addProductOnce
// re-checks the same pure missingPhotoSteps):
//   • footwear: two guided steps; Save stays disabled until BOTH are taken,
//     and the form says which one is missing
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
  photoSourceBlob: null, boxBlob: null, boxPreviewUrl: null,
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

describe("footwear: shoe + box, both required", () => {
  it("renders the two guided steps in order", async () => {
    const r = await mount();
    expect(r.root.findAllByType(GuidedPhotoStep).map((s) => s.props.step.id)).toEqual(["shoe", "box"]);
  });

  it("refuses to save with no photos, and says both are needed", async () => {
    const r = await mount();
    expect(saveBtn(r).props.disabled).toBe(true);
    expect(allText(r)).toMatch(/Still needed before saving: shoe photo and box photo/);
  });

  it("refuses to save with the shoe but WITHOUT the box photo", async () => {
    const r = await mount({ form: { ...shoeForm, photoBlob: {}, photoUrl: "data:x" } });
    expect(saveBtn(r).props.disabled).toBe(true);
    expect(allText(r)).toMatch(/Still needed before saving: box photo/);
  });

  it("allows the save once both are taken", async () => {
    const r = await mount({ form: { ...shoeForm, photoBlob: {}, photoUrl: "data:x", boxBlob: {}, boxPreviewUrl: "data:y" } });
    expect(saveBtn(r).props.disabled).toBe(false);
    expect(allText(r)).not.toMatch(/Still needed/);
  });

  it("a blocked save paints the missing step red", async () => {
    const r = await mount({ form: { ...shoeForm, photoBlob: {} }, saveAttempted: true });
    const [shoe, box] = r.root.findAllByType(GuidedPhotoStep);
    expect(shoe.props.invalid).toBe(false);
    expect(box.props.invalid).toBe(true);
  });

  it("a step's capture goes to onGuidedPhoto with its step", async () => {
    const onGuidedPhoto = vi.fn();
    const r = await mount({ onGuidedPhoto });
    const box = r.root.findAllByType(GuidedPhotoStep)[1];
    const file = { name: "box.jpg" };
    await act(async () => { box.props.onFile(file); });
    expect(onGuidedPhoto).toHaveBeenCalledWith(box.props.step, file);
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
