// SKY-WALL v3 (Junid, 6 Nov): the phone size picker is a bottom sheet that
// closes on the close button, on the dimmed area and on Escape — and never on a
// tap inside it; the tiles carry no three-dot; there is no back-to-top button.
// The drag-to-close, the sticky header and the safe areas are driven in a real
// browser by scripts/sky-wall-v3.e2e.mjs.
import { describe, it, expect, vi, beforeAll } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { SkySheet, SkySheetHead } from "./SkySheet.jsx";

const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (!globalThis.document) {
    globalThis.document = { addEventListener() {}, removeEventListener() {}, body: { style: {} } };
  }
});

function mount(onClose) {
  let r;
  act(() => {
    r = TestRenderer.create(
      <SkySheet onClose={onClose} label="Shoe" testId="phone-popup">
        <SkySheetHead p={{ id: "p1", name: "Shoe", photo: "👟" }} onClose={onClose} chips={["W2401", "Hub 1"]} price="R750" />
        <button type="button" data-testid="inside">Size 8</button>
      </SkySheet>, { createNodeMock: () => ({ setPointerCapture() {} }) });
  });
  return r;
}
const byTestId = (r, id) => r.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string")[0];

describe("the bottom sheet", () => {
  it("opens as a dialog over a dimmed scrim, with a handle", () => {
    const r = mount(() => {});
    expect(byTestId(r, "phone-popup").props.role).toBe("dialog");
    expect(byTestId(r, "phone-popup").props["aria-modal"]).toBe("true");
    expect(byTestId(r, "phone-popup-scrim").props.className).toBe("sky-sheetscrim");
    expect(r.root.findAll((n) => n.props?.className === "sky-sheet__handle")).toHaveLength(1);
  });
  it("the close button closes it", () => {
    const onClose = vi.fn();
    const r = mount(onClose);
    act(() => byTestId(r, "sheet-close").props.onClick());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("a tap on the dimmed area closes it; a tap inside the sheet does not", () => {
    const onClose = vi.fn();
    const r = mount(onClose);
    const scrim = byTestId(r, "phone-popup-scrim");
    act(() => scrim.props.onClick({ target: "inner", currentTarget: scrim }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => scrim.props.onClick({ target: scrim, currentTarget: scrim }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("a drag down on the handle closes it; a short one does not", () => {
    const onClose = vi.fn();
    const r = mount(onClose);
    const sheet = () => byTestId(r, "phone-popup");
    const handle = { closest: (s) => (s.includes("data-sheet-grab") || s.includes("sky-sheet__handle") ? {} : null) };
    const ev = (y) => ({ target: handle, clientY: y, pointerId: 1, currentTarget: { setPointerCapture() {} } });
    act(() => sheet().props.onPointerDown(ev(100)));
    act(() => sheet().props.onPointerMove(ev(130)));
    act(() => sheet().props.onPointerUp(ev(130)));
    expect(onClose).not.toHaveBeenCalled();
    act(() => sheet().props.onPointerDown(ev(100)));
    act(() => sheet().props.onPointerMove(ev(200)));
    act(() => sheet().props.onPointerMove(ev(260)));
    act(() => sheet().props.onPointerUp(ev(260)));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("App.jsx: the phone order view", () => {
  it("the size picker is the SkySheet, closing through the same resetSheet", () => {
    expect(APP).toContain('<SkySheet onClose={resetSheet} label={selected.name} testId="phone-popup">');
    expect(APP).not.toContain('background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:1000 }}>\n          <div style={sheetStyle} className="sky-sheet" data-testid="phone-popup">');
  });
  it("no three-dot on the tiles: AssistantPhone gets no renderActions, the sheet carries the actions", () => {
    const i = APP.indexOf("<AssistantPhone");
    const block = APP.slice(i, APP.indexOf("showBar={false}>", i));
    expect(block).not.toMatch(/renderActions=/);
    expect(APP).toContain("actions={<ProductActionsButton product={selected} products={products} />}");
  });
  it("no back-to-top button", () => {
    expect(APP).not.toContain('aria-label="Scroll to top"');
    expect(APP).not.toMatch(/setShowScrollTop/);
  });
});
