// ─── INTAKE ASKS BEFORE THE FORM OPENS — the pre-duplicate question ──────────
// (Owner spec 2026-08-13.) The gate's save-time claim only refuses EXACT
// codes; a per-size sibling, a one-character misread or a truncated read of an
// existing product's code sailed straight into the create form — the exact
// mechanism that split the Gripshot into five records. The real component
// renders; the claims are wiring claims:
//
//   1. ENFORCED lookup, outcome UNKNOWN: a code one digit inside the live
//      Gripshot family shows the family as ADD-STOCK cards (photo, code,
//      reason) before "Enter the details".
//   2. Outcome FOUND (the vendor knows the code): the same cards appear as a
//      "we may already have this shoe" warning before Confirm.
//   3. Tapping a card routes to onAddStock with that product id — no form.
//   4. The escape stays: "Enter the details" still opens the form with the
//      code kept (onProceed), suggestions or not.
//   5. A code with no plausible relative shows NO cards — the unknown step is
//      unchanged for genuinely new shoes.
//   6. weak rows (brandSegment/substring — browsing evidence) NEVER trip this
//      gate: a code whose only relatives share a prefix shows NO cards
//      (2026-08-13 loosening: the gate filters s.weak).
//   7. The SFA/SMA colour-code relative DOES trip it — that is the label that
//      used to sail into the create form and mint a duplicate.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const resolveStyleCode = vi.fn();
vi.mock("../../firebase", () => ({ functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("firebase/functions", () => ({
  httpsCallable: (_f, name) => (args) => {
    if (name === "resolveStyleCode") return resolveStyleCode(args);
    return Promise.resolve({ data: {} });
  },
}));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1755072000000, serverNowIso: () => "2026-08-13T08:00:00.000Z" }));
vi.mock("../stock/hubCleanupStore", () => ({ learnLabelLayout: vi.fn(async () => ({})) }));
vi.mock("../../config/styleCode", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, STYLE_CODE_LOOKUP_ENABLED: true };
});

const { default: StyleCodeGate } = await import("./StyleCodeGate.jsx");

const GRIPSHOTS = [
  { id: "g5", name: "Lacoste Gripshot Mid White", styleCodeNormalised: "742CFA00052G4", photoUrl: "https://x/g5.jpg" },
  { id: "g7", name: "Lacoste Gripshot Mid Green", styleCodeNormalised: "742CFA00072G4", photoUrl: "https://x/g7.jpg" },
  { id: "g12", name: "Lacoste Gripshot White Green Orange", styleCodeNormalised: "742CFA00122G4", photoUrl: "https://x/g12.jpg" },
  { id: "g16", name: "Lacoster gripshot green", styleCodeNormalised: "742CFA00162G4", photoUrl: "https://x/g16.jpg" },
];

const textOf = (tr) => JSON.stringify(tr.toJSON());
const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const buttonWith = (tr, needle) => tr.root.findAll((n) => (n.type === "button" || n.props?.role === "button") && textIn(n).includes(needle))[0];

async function mountAndLookup(code, { onProceed = vi.fn(), onAddStock = vi.fn(), products = GRIPSHOTS } = {}) {
  let tr;
  await act(async () => {
    tr = TestRenderer.create(
      <StyleCodeGate products={products} onCancel={() => {}} onProceed={onProceed} onAddStock={onAddStock} />,
    );
  });
  const input = tr.root.findAll((n) => n.type === "input" && n.props.placeholder === "CT8527-016")[0];
  await act(async () => { input.props.onChange({ target: { value: code } }); });
  const go = buttonWith(tr, "Continue");
  await act(async () => { await go.props.onClick(); });
  return { tr, onProceed, onAddStock };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default resolver outcome: the code is unknown everywhere.
  resolveStyleCode.mockImplementation(async ({ code }) => ({
    data: { normalised: String(code).toUpperCase().replace(/[^A-Z0-9]/g, ""), displayCode: code, found: false, existingProducts: [], errors: [] },
  }));
});

describe("the intake gate's pre-duplicate question", () => {
  it("UNKNOWN outcome: a code inside the Gripshot family shows the family as add-stock cards, with photo, code and reason", async () => {
    const { tr } = await mountAndLookup("742CFA0011-2G4");
    const after = textOf(tr);
    expect(after).toContain("Not in the catalogue");
    expect(after).toContain("But check these first");
    expect(after).toContain("Lacoste Gripshot White Green Orange");
    expect(after).toContain("same code family — 742CFA00••-2G4");
    expect(after).toContain("ADD STOCK");
    const photos = tr.root.findAll((n) => n.type === "img" && String(n.props.src || "").includes("/g"));
    expect(photos.length).toBeGreaterThanOrEqual(1);
  });

  it("FOUND outcome: the vendor knowing the code does not hide that WE may already have the shoe", async () => {
    resolveStyleCode.mockImplementation(async ({ code }) => ({
      data: {
        normalised: String(code).toUpperCase().replace(/[^A-Z0-9]/g, ""), displayCode: code, found: true,
        existingProducts: [], errors: [], source: "api",
        model: { brand: "Lacoste", model: "Gripshot Mid", name: "Lacoste Gripshot Mid", colorwayName: "Navy", imageUrl: null },
      },
    }));
    const { tr } = await mountAndLookup("742CFA0011-2G4");
    const after = textOf(tr);
    expect(after).toContain("We may already have this shoe");
    expect(after).toContain("Lacoste Gripshot White Green Orange");
    expect(after).toContain("Confirm — this is it"); // the step's own exits survive
  });

  it("tapping a card routes to ADD STOCK on that product — the form never opens", async () => {
    const { tr, onAddStock, onProceed } = await mountAndLookup("742CFA0011-2G4");
    const card = buttonWith(tr, "Lacoste Gripshot White Green Orange");
    await act(async () => { card.props.onClick(); });
    expect(onAddStock).toHaveBeenCalledWith("g12");
    expect(onProceed).not.toHaveBeenCalled();
  });

  it("the escape stays: Enter the details opens the form with the code kept", async () => {
    const { tr, onProceed } = await mountAndLookup("742CFA0011-2G4");
    const enter = buttonWith(tr, "Enter the details");
    await act(async () => { enter.props.onClick(); });
    expect(onProceed).toHaveBeenCalled();
    expect(onProceed.mock.calls[0][0].styleCodeNormalised).toBe("742CFA00112G4");
  });

  it("a genuinely new code shows NO cards — the unknown step is unchanged", async () => {
    const { tr } = await mountAndLookup("CT8527-999");
    const after = textOf(tr);
    expect(after).toContain("Not in the catalogue");
    expect(after).not.toContain("But check these first");
    expect(after).not.toContain("ADD STOCK");
  });

  it("weak rows NEVER trip the gate: a prefix-cousin-only code shows NO cards (claim 6)", async () => {
    // 742CFA0099-9Z9 shares the Gripshots' 742CFA00 lead and nothing else —
    // browsing evidence in the count panel, but an interstitial here on every
    // registration would be the gate crying wolf. The gate filters s.weak.
    const { tr } = await mountAndLookup("742CFA0099-9Z9");
    const after = textOf(tr);
    expect(after).toContain("Not in the catalogue");
    expect(after).not.toContain("But check these first");
    expect(after).not.toContain("ADD STOCK");
  });

  it("the SFA/SMA colour-code relative DOES trip the gate (claim 7) — the duplicate-minting label", async () => {
    // The floor case of 2026-08-13: Audysol registered off the women's-family
    // label, the men's-family label in hand. Registering it as new is exactly
    // how the duplicate gets minted — the gate must ask first.
    const AUDYSOL = { id: "aud", name: "Lacoste Audysol White", styleCodeNormalised: "745SFA000521G", photoUrl: "https://x/aud.jpg" };
    const { tr, onAddStock } = await mountAndLookup("745SMA004-21G", { products: [...GRIPSHOTS, AUDYSOL] });
    const after = textOf(tr);
    expect(after).toContain("But check these first");
    expect(after).toContain("Lacoste Audysol White");
    expect(after).toContain("same colour code 21G");
    const card = buttonWith(tr, "Lacoste Audysol White");
    await act(async () => { card.props.onClick(); });
    expect(onAddStock).toHaveBeenCalledWith("aud");
  });
});
