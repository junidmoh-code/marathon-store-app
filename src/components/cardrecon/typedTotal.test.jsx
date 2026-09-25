// ─── JUNID'S TYPED TOTAL IS JUNID'S ALONE, AND NEVER TRAVELS WITHOUT A PHOTO ──
// Some printers print half the slip, so the total is not on the paper. The
// owner may type it beside the photo; nobody else is ever offered the field.
// The server refuses everyone else regardless (functions/test/
// card-declared-total.test.cjs) — this pins the half that a manager SEES.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const ESTATE = {
  "0000Z4M6": { label: "Trophy Till 2", storeId: "trophy", tillId: "till-2" },
  "0000HP1X": { label: "Marathon Till 2", storeId: "pe", tillId: "till-2" },
};

const auth = { currentUser: null };
const calls = [];
vi.mock("../../firebase", () => ({ database: {}, functions: {}, storage: {}, get auth() { return auth; } }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (refOrQuery, cb) => {
    cb({ val: () => (String(refOrQuery?.path ?? "").includes("cardTerminals") ? ESTATE : {}) });
    return () => {};
  },
  query: (r) => r, orderByChild: () => {}, limitToLast: () => {},
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: () => async (payload) => {
    calls.push(payload);
    return { data: payload.action === "extract" ? { ok: true, draftId: "draft-0000001" } : { ok: true } };
  },
}));
vi.mock("../../utils/serverTime", () => ({
  serverNowMs: () => Date.parse("2026-09-25T16:40:00Z"),
  saDateStringAt: () => "2026-09-25",
}));
vi.mock("../shopify/imageDecode", () => ({
  decodeImageFile: async () => ({ source: {}, width: 1000, height: 2000, release: () => {} }),
  isAcceptedImageFile: () => true, describePickedFile: () => "",
}));

const CardReconScreen = (await import("./CardReconScreen")).default;

const render = () => {
  let tree;
  act(() => { tree = TestRenderer.create(<CardReconScreen onExit={() => {}} />); });
  return tree;
};
const toggles = (tree) => tree.root.findAll((n) => n.type === "button" && /Type it/.test(String(n.props.children)));
const typedInputs = (tree) => tree.root.findAll((n) => n.type === "input" && n.props.inputMode === "decimal");
const fileInputs = (tree) => tree.root.findAll((n) => n.type === "input" && n.props.type === "file");

beforeEach(() => {
  calls.length = 0;
  // The downscale draws on a canvas; the renderer has no DOM.
  globalThis.document = { createElement: () => ({
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => "data:image/jpeg;base64,QUJDRA==",
  }) };
});

describe("the typed total on the capture screen", () => {
  it("a manager is never offered it", () => {
    auth.currentUser = { email: "manager@marathon.co.za" };
    const tree = render();
    expect(toggles(tree)).toHaveLength(0);
    expect(typedInputs(tree)).toHaveLength(0);
    expect(fileInputs(tree)).toHaveLength(2);   // just the two till cards
  });

  it("Junid's git address is not his admin identity — not offered either", () => {
    auth.currentUser = { email: "junidmoh@gmail.com" };
    expect(toggles(render())).toHaveLength(0);
  });

  it("Junid is offered it on every camera till, and the photo stays disabled until he types", () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    expect(toggles(tree)).toHaveLength(2);
    act(() => { toggles(tree)[0].props.onClick(); });
    expect(typedInputs(tree)).toHaveLength(1);
    const typedPhoto = fileInputs(tree).find((n) => n.props.disabled === true);
    expect(typedPhoto, "the typed path's photo cannot be picked with nothing typed").toBeTruthy();
  });

  it("the typed figure goes up WITH the photo, as typed, summary-only", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    act(() => { toggles(tree)[0].props.onClick(); });
    act(() => { typedInputs(tree)[0].props.onChange({ target: { value: "43,530.00" } }); });
    // Document order: the first till's card, ITS typed-total box, the second card.
    const inputs = fileInputs(tree);
    expect(inputs).toHaveLength(3);
    const typedPhoto = inputs[1];
    expect(typedPhoto.props.disabled).toBe(false);
    await act(async () => {
      await typedPhoto.props.onChange({ target: { files: [{ name: "slip.jpg" }], value: "" } });
    });
    const extract = calls.find((c) => c.action === "extract");
    expect(extract.declaredTotal).toBe("43,530.00");
    expect(extract.photos).toHaveLength(1);
    expect(extract.photos[0].base64).toBe("QUJDRA==");
    expect(extract.summaryOnly).toBe(true);
    expect(calls.some((c) => c.action === "submit")).toBe(true);
  });

  it("the ordinary card sends no typed figure, even for Junid", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    const cardPhoto = fileInputs(tree)[0];
    await act(async () => {
      await cardPhoto.props.onChange({ target: { files: [{ name: "slip.jpg" }], value: "" } });
    });
    const extract = calls.find((c) => c.action === "extract");
    expect(extract).toBeTruthy();
    expect("declaredTotal" in extract).toBe(false);
  });
});
