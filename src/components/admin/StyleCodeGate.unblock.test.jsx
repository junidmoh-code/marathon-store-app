// ─── THE GATE MUST NEVER BE A DEAD END (enforcement mode) ────────────────────
// A live outage: the vendor returned 403 on every call, so every lookup landed
// on the "unavailable" step — which offered only Retry and Back. Staff could not
// add ANY new product. A gate whose failure mode is "nobody can work" is worse
// than the duplicate it was guarding against.
//
// The guard was never load-bearing on this screen either. Uniqueness is enforced
// by the create-once claim on /style_code_index at SAVE time: if the code
// already belongs to a product, the save is refused and the operator is routed
// to add stock on it. The database has the last word, not this step.
//
// These tests pin the two escapes. Both are behavioural — the change is in what
// renders, so a pure-logic test could not see it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const resolveMock = vi.fn();
// These escapes only exist on the LOOKUP path, so this file pins enforcement ON.
// With it off (the current default) the gate bypasses the lookup entirely and
// staff go straight to the form — covered in StyleCodeGate.captureOnly.test.jsx.
vi.mock("../../config/styleCode", async () => ({
  ...(await vi.importActual("../../config/styleCode")),
  STYLE_CODE_LOOKUP_ENABLED: true,
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: (_fns, name) => (...a) => (name === "resolveStyleCode" ? resolveMock(...a) : Promise.resolve({ data: {} })),
}));
vi.mock("../../firebase", () => ({ functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1754300000000 }));
vi.mock("../../utils/labelPhoto", () => ({ prepareLabelPhoto: async () => ({ dataUrl: "d", base64: "b", blob: {} }) }));

const StyleCodeGate = (await import("./StyleCodeGate.jsx")).default;

beforeEach(() => { resolveMock.mockReset(); });

function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.props) return textOf(n.props.children);
  return "";
}
const btn = (root, re) => root.findAllByType("button").find((b) => re.test(textOf(b.props.children)));

async function mount(onProceed = vi.fn()) {
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(StyleCodeGate, {
      products: [], onCancel: vi.fn(), onAddStock: vi.fn(), onProceed,
    }));
  });
  return { r, onProceed };
}

async function typeAndContinue(r, code = "CT8527-016") {
  const field = r.root.findAllByType("input").find((i) => i.props.placeholder === "CT8527-016");
  await act(async () => { field.props.onChange({ target: { value: code } }); });
  await act(async () => { await btn(r.root, /Continue/).props.onClick(); });
}

// THE OUTAGE, reproduced: vendor 403 on every call.
const VENDOR_403 = {
  data: {
    normalised: "CT8527016", displayCode: "CT8527-016", found: false, model: null,
    source: null, tier: null, fromCache: false, cached: false, claim: null,
    claimOrphaned: false, existingProducts: [], duplicate: false,
    errors: [{ provider: "kicksdb", message: "kicksdb HTTP 403" }],
  },
};

describe("a failed lookup must still let staff add the product", () => {
  it("THE OUTAGE: a vendor error offers a way forward, not just Retry", async () => {
    resolveMock.mockResolvedValue(VENDOR_403);
    const { r } = await mount();
    await typeAndContinue(r);

    expect(btn(r.root, /Try the lookup again/)).toBeDefined();
    // The escape that was missing. Without it, Add Product is unusable.
    expect(btn(r.root, /Add it anyway/)).toBeDefined();
  });

  it("'Add it anyway' proceeds to the form with the style code RETAINED", async () => {
    resolveMock.mockResolvedValue(VENDOR_403);
    const { r, onProceed } = await mount();
    await typeAndContinue(r);
    await act(async () => { btn(r.root, /Add it anyway/).props.onClick(); });

    expect(onProceed).toHaveBeenCalledTimes(1);
    const p = onProceed.mock.calls[0][0];
    expect(p.styleCodeNormalised).toBe("CT8527016");
    expect(p.styleCodeSource).toBe("manual");
    // Nothing is prefilled — the lookup never succeeded, so there is nothing to trust.
    expect(p.suggestedName).toBe("");
    expect(p.suggestedImageUrl).toBeNull();
  });

  it("the wording no longer claims the shoe is absent from the catalogue", async () => {
    resolveMock.mockResolvedValue(VENDOR_403);
    const { r } = await mount();
    await typeAndContinue(r);
    const screen = JSON.stringify(r.toJSON());
    expect(screen).toMatch(/Couldn't check the catalogue/i);
    expect(screen).not.toMatch(/Not in the catalogue/i);
  });

  it("a callable that THROWS is also escapable, not a dead end", async () => {
    resolveMock.mockRejectedValue(new Error("internal"));
    const { r, onProceed } = await mount();
    await typeAndContinue(r);
    expect(btn(r.root, /Add it anyway/)).toBeDefined();
    await act(async () => { btn(r.root, /Add it anyway/).props.onClick(); });
    expect(onProceed).toHaveBeenCalledTimes(1);
  });
});

describe("a shoe with no code is still addable — but deliberately", () => {
  // The one-tap escape is GONE on purpose. A bypass that costs the same as
  // doing the job properly becomes the default path within a week. It is now a
  // subordinate link opening a panel that demands a duplicate check AND a
  // reason — see StyleCodeGate.bypass.test.jsx for the full gating.
  it("the escape is a subordinate LINK, not a button beside scan and type", async () => {
    const { r } = await mount();
    const link = btn(r.root, /no style code/i);
    expect(link).toBeDefined();
    // Visually subordinate: underlined text, no filled background.
    expect(link.props.style.textDecoration).toBe("underline");
    expect(link.props.style.background).toBe("none");
  });

  it("tapping it does NOT proceed — it opens the panel that asks why", async () => {
    const { r, onProceed } = await mount();
    await act(async () => { btn(r.root, /no style code/i).props.onClick(); });
    expect(onProceed).not.toHaveBeenCalled();
    expect(JSON.stringify(r.toJSON())).toMatch(/Adding without a style code/i);
  });
});

describe("the honest paths are unchanged", () => {
  it("a CLEAN empty answer still says 'not in the catalogue'", async () => {
    resolveMock.mockResolvedValue({
      data: { normalised: "IE3437", displayCode: "IE3437", found: false, existingProducts: [], errors: [] },
    });
    const { r } = await mount();
    await typeAndContinue(r, "IE3437");
    expect(JSON.stringify(r.toJSON())).toMatch(/Not in the catalogue/i);
  });

  it("an EXISTING product still routes to add-stock, never to the create form", async () => {
    const onAddStock = vi.fn();
    resolveMock.mockResolvedValue({
      data: {
        normalised: "IE3437", displayCode: "IE3437", found: false,
        existingProducts: [{ id: "p1", name: "adidas Samba" }],
        claim: { productId: "p1" }, errors: [],
      },
    });
    let r;
    await act(async () => {
      r = TestRenderer.create(React.createElement(StyleCodeGate, {
        products: [{ id: "p1", name: "adidas Samba" }],
        onCancel: vi.fn(), onAddStock, onProceed: vi.fn(),
      }));
    });
    await typeAndContinue(r, "IE3437");
    expect(JSON.stringify(r.toJSON())).toMatch(/We already have this shoe/i);
    expect(btn(r.root, /Add it anyway/)).toBeUndefined();
  });
});
