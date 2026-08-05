// ─── CAPTURE-ONLY MODE — THE CODE IS SAVED, NOTHING IS LOOKED UP ─────────────
// With STYLE_CODE_LOOKUP_ENABLED off, entering a code must go STRAIGHT to the
// product form: no callable, no confirm screen, no comparison. Two reasons, each
// sufficient — the vendor route 403s on our plan, and no product carries a code
// yet, so "does this already exist?" has exactly one possible answer.
//
// The thing these tests protect is the distinction between CAPTURING a code and
// LOOKING IT UP. Those got coupled by accident and the coupling cost the shop
// floor a working Add Product screen. The switch decouples them; these pin it
// in both positions, so turning enforcement back on is a verified one-line flip.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const resolveMock = vi.fn();
const flag = { STYLE_CODE_LOOKUP_ENABLED: false };

vi.mock("../../config/styleCode", async () => ({
  ...(await vi.importActual("../../config/styleCode")),
  get STYLE_CODE_LOOKUP_ENABLED() { return flag.STYLE_CODE_LOOKUP_ENABLED; },
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: (_f, name) => (...a) => (name === "resolveStyleCode" ? resolveMock(...a) : Promise.resolve({ data: {} })),
}));
vi.mock("../../firebase", () => ({ functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1754300000000 }));
vi.mock("../../utils/labelPhoto", () => ({ prepareLabelPhoto: async () => ({ dataUrl: "d", base64: "b", blob: {} }) }));

const StyleCodeGate = (await import("./StyleCodeGate.jsx")).default;

beforeEach(() => { resolveMock.mockReset(); flag.STYLE_CODE_LOOKUP_ENABLED = false; });

function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.props) return textOf(n.props.children);
  return "";
}
const btn = (root, re) => root.findAllByType("button").find((b) => re.test(textOf(b.props.children)));

async function mount() {
  const onProceed = vi.fn(), onAddStock = vi.fn();
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(StyleCodeGate, {
      products: [], onCancel: vi.fn(), onAddStock, onProceed,
    }));
  });
  return { r, onProceed, onAddStock };
}
async function type(r, code) {
  const f = r.root.findAllByType("input").find((i) => i.props.placeholder === "CT8527-016");
  await act(async () => { f.props.onChange({ target: { value: code } }); });
}
const go = async (r) => act(async () => { await btn(r.root, /continue/i).props.onClick(); });

describe("capture-only: the code is saved, nothing is looked up", () => {
  it("THE CALLABLE IS NEVER CALLED", async () => {
    const { r } = await mount();
    await type(r, "CT8527-016");
    await go(r);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("goes STRAIGHT to the form with the code, in one step", async () => {
    const { r, onProceed } = await mount();
    await type(r, "CT8527-016");
    await go(r);

    expect(onProceed).toHaveBeenCalledTimes(1);
    const p = onProceed.mock.calls[0][0];
    expect(p.styleCodeNormalised).toBe("CT8527016");
    expect(p.styleCode).toBe("CT8527-016");
    expect(p.styleCodeSource).toBe("manual");
    // Nothing is suggested, because nothing was looked up.
    expect(p.suggestedName).toBe("");
    expect(p.suggestedImageUrl).toBeNull();
  });

  it("normalises every spelling to the same stored key", async () => {
    for (const [typed, key] of [["ct8527016", "CT8527016"], ["  ct8527 016 ", "CT8527016"], ["IE3437", "IE3437"]]) {
      const { r, onProceed } = await mount();
      await type(r, typed);
      await go(r);
      expect(onProceed.mock.calls[0][0].styleCodeNormalised).toBe(key);
    }
  });

  it("uses the server clock, not the device clock", async () => {
    const { r, onProceed } = await mount();
    await type(r, "IE3437");
    await go(r);
    expect(onProceed.mock.calls[0][0].styleCodeFetchedAt).toBe(1754300000000);
  });

  it("never shows the dead end that blocked the shop floor", async () => {
    const { r } = await mount();
    await type(r, "CT8527-016");
    await go(r);
    const screen = JSON.stringify(r.toJSON());
    expect(screen).not.toMatch(/lookup didn't complete/i);
    expect(screen).not.toMatch(/Couldn't check the catalogue/i);
    expect(screen).not.toMatch(/Not in the catalogue/i);
  });

  it("the no-code bypass is reachable, and still makes no vendor call", async () => {
    const { r } = await mount();
    await act(async () => { btn(r.root, /no style code/i).props.onClick(); });
    expect(JSON.stringify(r.toJSON())).toMatch(/Adding without a style code/i);
    // Opening the panel must not kick off a lookup — without this assertion a
    // regression that starts one would still pass. (CodeRabbit, PR #320.)
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("an unrecognised FORMAT is still accepted — shape never blocks", async () => {
    const { r, onProceed } = await mount();
    await type(r, "WEIRD-CODE-99");
    await go(r);
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(onProceed.mock.calls[0][0].styleCodeNormalised).toBe("WEIRDCODE99");
  });

  it("an EMPTY code still cannot be submitted", async () => {
    const { r, onProceed } = await mount();
    await type(r, "!!!---");
    const b = btn(r.root, /continue/i);
    expect(b.props.disabled).toBe(true);
    expect(onProceed).not.toHaveBeenCalled();
  });
});

describe("the switch really is a switch — the full flow is intact", () => {
  it("with enforcement ON, the callable IS called and the flow runs", async () => {
    flag.STYLE_CODE_LOOKUP_ENABLED = true;
    resolveMock.mockResolvedValue({
      data: { normalised: "IE3437", displayCode: "IE3437", found: false, existingProducts: [], errors: [] },
    });
    const { r, onProceed } = await mount();
    await type(r, "IE3437");
    await go(r);

    expect(resolveMock).toHaveBeenCalledTimes(1);
    // It stops on the catalogue screen instead of going straight through.
    expect(onProceed).not.toHaveBeenCalled();
    expect(JSON.stringify(r.toJSON())).toMatch(/Not in the catalogue/i);
  });

  it("with enforcement ON, an existing product still routes to add-stock", async () => {
    flag.STYLE_CODE_LOOKUP_ENABLED = true;
    resolveMock.mockResolvedValue({
      data: { normalised: "IE3437", displayCode: "IE3437", found: false,
              existingProducts: [{ id: "p1", name: "adidas Samba" }], claim: { productId: "p1" }, errors: [] },
    });
    const onProceed = vi.fn(), onAddStock = vi.fn();
    let r;
    await act(async () => {
      r = TestRenderer.create(React.createElement(StyleCodeGate, {
        products: [{ id: "p1", name: "adidas Samba" }], onCancel: vi.fn(), onAddStock, onProceed,
      }));
    });
    await type(r, "IE3437");
    await go(r);
    expect(JSON.stringify(r.toJSON())).toMatch(/We already have this shoe/i);
  });
});
