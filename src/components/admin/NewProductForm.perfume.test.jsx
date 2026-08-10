// ─── THE BARCODE STEP IS PERFUME-ONLY, AND IT IS NEVER A DEAD END ────────────
// Two things the form must guarantee:
//   • PERFUME cannot be saved until the barcode question has an ANSWER —
//     either the printed code was captured, or the operator deliberately chose
//     a shop-generated one. Falling through silently would mint a code for a
//     box that already carries one, which is the waste this exists to stop.
//   • EVERY OTHER CATEGORY never sees the step at all and saves exactly as it
//     did before, with its barcode auto-generated.

import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("./CategorySelect.jsx", () => ({ default: () => null }));
vi.mock("./SizeQtyBoxes.jsx", () => ({ default: () => null, totalUnits: () => 0 }));
vi.mock("../stock/widgets.jsx", () => ({ LocationPicker: () => null }));
vi.mock("../stock/locations.js", () => ({ labelFor: () => "Hub 2", transferTargets: [] }));
// Counts MOUNTS, not renders — the remount is the guard being tested, and a
// mount counter does not depend on React internals the way a fiber key does.
let captureMounts = 0;
vi.mock("./PrintedBarcodeCapture.jsx", async () => {
  const React = await import("react");
  return {
    default: () => {
      React.useEffect(() => { captureMounts++; }, []);
      return null;
    },
  };
});

const NewProductForm = (await import("./NewProductForm.jsx")).default;
const PrintedBarcodeCapture = (await import("./PrintedBarcodeCapture.jsx")).default;

// toJSON() nodes carry children on .children; element nodes on props.children.
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

const baseForm = {
  name: "Oud Mood", categoryKey: "perfumes", sizeRun: [], photo: "", photoUrl: null,
  hubs: ["hub2"], stockPrice: "", retailPrice: "", hasShoeBoxOption: true,
  printedBarcode: null, printedBarcodeAuto: false,
};

async function mount(props = {}) {
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(NewProductForm, {
      styleCode: null, suggestedImageUrl: null, onChangeStyleCode: null,
      form: baseForm, setForm: vi.fn(),
      taxonomy: {}, taxonomySource: "live",
      selectedCat: { key: "perfumes", label: "Perfumes" },
      formSizes: ["_"], formOneSize: true, formIsClothing: false,
      selectCategory: vi.fn(), toggleHub: vi.fn(), toggleShoebox: vi.fn(),
      recvQtys: {}, setRecvQtys: vi.fn(),
      recvLoc: "hub2", setRecvLoc: vi.fn(), recvRegistry: {},
      fileInputRef: { current: null }, handleImageUpload: vi.fn(),
      products: [], isPerfume: true,
      onCapturePrintedBarcode: vi.fn(), onClearPrintedBarcode: vi.fn(), onUseAutoBarcode: vi.fn(),
      saving: false, saveAttempted: false, onSave: vi.fn(),
      ...props,
    }));
  });
  return r;
}

describe("perfume: the barcode step replaces auto-generation", () => {
  it("renders the capture step", async () => {
    const r = await mount();
    expect(r.root.findAllByType(PrintedBarcodeCapture).length).toBe(1);
  });

  it("BLOCKS the save until the question is answered", async () => {
    const r = await mount();
    expect(saveBtn(r).props.disabled).toBe(true);
  });

  it("allows the save once the printed code is captured", async () => {
    const r = await mount({ form: { ...baseForm, printedBarcode: "6291106065114" } });
    expect(saveBtn(r).props.disabled).toBe(false);
  });

  it("says the box's own code will be used, not a generated one", async () => {
    const r = await mount({ form: { ...baseForm, printedBarcode: "6291106065114" } });
    expect(allText(r)).toMatch(/barcode printed on its box/i);
    expect(allText(r)).not.toMatch(/SKU \+ barcode are assigned automatically/);
  });

  it("explains what is missing once a blocked save has been attempted", async () => {
    const r = await mount({ saveAttempted: true });
    expect(allText(r)).toMatch(/Photograph the barcode on the box/i);
  });

  it("never blocks on a missing style code — perfume has none", async () => {
    // Perfume is not in the enforced set; the step must not import that gate.
    const r = await mount({ form: { ...baseForm, printedBarcode: "6291106065114" }, styleCode: null });
    expect(saveBtn(r).props.disabled).toBe(false);
  });
});

describe("nobody is ever stuck", () => {
  it("the deliberate auto-generation tap unblocks the save on its own", async () => {
    const r = await mount({ form: { ...baseForm, printedBarcode: null, printedBarcodeAuto: true } });
    expect(saveBtn(r).props.disabled).toBe(false);
  });

  it("and then the footer says a barcode WILL be generated", async () => {
    const r = await mount({ form: { ...baseForm, printedBarcodeAuto: true } });
    expect(allText(r)).toMatch(/SKU \+ barcode are assigned automatically/);
  });

  it("REMOUNTS the capture when the perfume category changes", async () => {
    // The capture invalidates in-flight work when its productId changes, but
    // in Add Product productId is always null — so a perfume→perfume category
    // switch would let a capture started before the switch land afterwards,
    // re-arming an answer selectCategory had just cleared. The key is the whole
    // guard, and without a test a refactor could drop it silently.
    // (CodeRabbit, PR #340.)
    captureMounts = 0;
    const r = await mount();
    expect(captureMounts).toBe(1);

    await act(async () => {
      r.update(React.createElement(NewProductForm, {
        styleCode: null, suggestedImageUrl: null, onChangeStyleCode: null,
        form: { ...baseForm, categoryKey: "perfumes-niche" }, setForm: vi.fn(),
        taxonomy: {}, taxonomySource: "live",
        selectedCat: { key: "perfumes-niche", label: "Niche Perfumes" },
        formSizes: ["_"], formOneSize: true, formIsClothing: false,
        selectCategory: vi.fn(), toggleHub: vi.fn(), toggleShoebox: vi.fn(),
        recvQtys: {}, setRecvQtys: vi.fn(),
        recvLoc: "hub2", setRecvLoc: vi.fn(), recvRegistry: {},
        fileInputRef: { current: null }, handleImageUpload: vi.fn(),
        products: [], isPerfume: true,
        onCapturePrintedBarcode: vi.fn(), onClearPrintedBarcode: vi.fn(), onUseAutoBarcode: vi.fn(),
        saving: false, saveAttempted: false, onSave: vi.fn(),
      }));
    });

    // A changed key forces a REMOUNT — which is what drops in-flight work.
    // Without the key React would reuse the instance and the count stays 1.
    expect(captureMounts).toBe(2);
    expect(r.root.findAllByType(PrintedBarcodeCapture).length).toBe(1);
  });

  it("passes the fallback handler down so the tap exists at all", async () => {
    const onUseAutoBarcode = vi.fn();
    const r = await mount({ onUseAutoBarcode });
    expect(r.root.findByType(PrintedBarcodeCapture).props.onUseAuto).toBe(onUseAutoBarcode);
  });
});

describe("every other category is untouched", () => {
  it("renders NO barcode step for a sneaker", async () => {
    const r = await mount({
      isPerfume: false,
      form: { ...baseForm, categoryKey: "sneakers", sizeRun: ["9"] },
      formSizes: ["9"], formOneSize: false,
      selectedCat: { key: "sneakers", label: "Sneakers" },
    });
    expect(r.root.findAllByType(PrintedBarcodeCapture).length).toBe(0);
  });

  it("saves a sneaker with no barcode answer at all", async () => {
    const r = await mount({
      isPerfume: false,
      form: { ...baseForm, categoryKey: "sneakers", sizeRun: ["9"], printedBarcode: null, printedBarcodeAuto: false },
      formSizes: ["9"], formOneSize: false,
      selectedCat: { key: "sneakers", label: "Sneakers" },
    });
    expect(saveBtn(r).props.disabled).toBe(false);
    expect(allText(r)).toMatch(/SKU \+ barcode are assigned automatically/);
  });

  it("keeps auto-generation for one-size ACCESSORIES, which are not perfume", async () => {
    // Watches, belts and bags are also size "_" — the step must key off the
    // category classifier, not off one-size-ness.
    const r = await mount({
      isPerfume: false,
      form: { ...baseForm, categoryKey: "watches" },
      selectedCat: { key: "watches", label: "Watches" },
    });
    expect(r.root.findAllByType(PrintedBarcodeCapture).length).toBe(0);
    expect(saveBtn(r).props.disabled).toBe(false);
  });
});
