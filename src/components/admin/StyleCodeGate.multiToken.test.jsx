// ─── THE GATE ASKS THE DUPLICATE QUESTION WITH EVERY TOKEN (owner spec
// 2026-08-13) ── the recovery proof at REGISTRATION: a staff member scans the
// Lacoste label to register "a new shoe" — but the shoe already exists,
// registered under its PRODUCTION line (352890-625). The article code the
// reader prefers (45SMA0018) matches nothing; the production token must still
// surface the existing product in the blocking pre-duplicate step, photo
// first, BEFORE a duplicate record can be created.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

// The reader's response for the Lacoste label: every token, tier-2 preferred.
const labelRead = vi.fn(async () => ({
  data: {
    candidates: ["45SMA0018", "352890625", "TTJJ21FB00001"],
    displayCandidates: ["45SMA0018", "352890-625", "TTJJ21FB00001"],
    preferred: "45SMA0018",
    tokens: ["45SMA0018", "BRKR", "CTT", "LGUARD", "SFA", "TTJJ21FB00001"],
    colorway: null, upc: null, modelName: null,
    source: "vision", fromCache: false, errors: [],
  },
}));

vi.mock("../../config/styleCode", async () => ({
  ...(await vi.importActual("../../config/styleCode")),
  STYLE_CODE_LOOKUP_ENABLED: false,
}));
const labelAliasCall = vi.fn(async () => ({ data: { owners: [], resolved: null } }));

vi.mock("firebase/functions", () => ({
  httpsCallable: (_f, name) => (...a) => (
    name === "readStyleCodeLabel" ? labelRead(...a)
      : name === "labelAlias" ? labelAliasCall(...a)
        : Promise.resolve({ data: {} })),
}));
vi.mock("../../firebase", () => ({ functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1754300000000 }));
vi.mock("../../utils/labelPhoto", () => ({ prepareLabelPhoto: async () => ({ dataUrl: "d", base64: "b", blob: {} }) }));

const StyleCodeGate = (await import("./StyleCodeGate.jsx")).default;

const PRODUCTS = [
  { id: "pLW", name: "Lacoster white", styleCodeNormalised: "352890625", photoUrl: "https://x/lw.jpg" },
];

function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.props) return textOf(n.props.children);
  return "";
}
const btn = (root, re) => root.findAllByType("button").find((b) => re.test(textOf(b.props.children)));

async function mountAndPhotograph() {
  const onProceed = vi.fn(), onAddStock = vi.fn();
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(StyleCodeGate, {
      products: PRODUCTS, onCancel: vi.fn(), onAddStock, onProceed,
    }));
  });
  const file = r.root.findAllByType("input").find((i) => i.props.type === "file");
  await act(async () => { await file.props.onChange({ target: { files: [{}], value: "" } }); });
  return { r, onProceed, onAddStock };
}

beforeEach(() => {
  vi.clearAllMocks();
  labelAliasCall.mockImplementation(async () => ({ data: { owners: [], resolved: null } }));
});

describe("the gate pools every label token into the pre-duplicate question", () => {
  it("the preferred code fills the field and the full set is announced", async () => {
    const { r } = await mountAndPhotograph();
    const field = r.root.findAllByType("input").find((i) => i.props.placeholder === "CT8527-016");
    expect(field.props.value).toBe("45SMA0018");
    expect(textOf(r.root.findByType("div"))).toContain("read 45SMA0018 as the style number");
  });

  it("THE RECOVERY: continuing blocks on 'Lacoster white' via the production token — photo shown, nothing proceeds", async () => {
    const { r, onProceed } = await mountAndPhotograph();
    await act(async () => { await btn(r.root, /continue/i).props.onClick(); });
    expect(onProceed).not.toHaveBeenCalled();
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Lacoster white");
    expect(text).toMatch(/other token 352890-625/);
    const photos = r.root.findAll((n) => n.type === "img" && String(n.props.src || "").includes("lw.jpg"));
    expect(photos.length).toBeGreaterThanOrEqual(1);
  });

  it("an ALIAS-ONLY owner the local scan cannot see still BLOCKS, via the server round trip (review #354)", async () => {
    // The count flow files code aliases that never stamp a product row — the
    // in-memory ranking is blind to them. The gate asks the server the same
    // any-token question and the known owner blocks photo-first.
    const aliasOnly = { id: "pAlias", name: "Timberland Motion 6 Mid Khaki", photoUrl: "https://x/tk.jpg" }; // no code fields
    labelAliasCall.mockImplementation(async (args) => {
      expect(args.action).toBe("resolveAnyCode");
      return { data: { owners: [{ productId: "pAlias", code: "45SMA0018", via: "alias" }], resolved: "pAlias" } };
    });
    const onProceed = vi.fn();
    let r;
    await act(async () => {
      r = TestRenderer.create(React.createElement(StyleCodeGate, {
        products: [aliasOnly], onCancel: vi.fn(), onAddStock: vi.fn(), onProceed,
      }));
    });
    const file = r.root.findAllByType("input").find((i) => i.props.type === "file");
    await act(async () => { await file.props.onChange({ target: { files: [{}], value: "" } }); });
    await act(async () => { await btn(r.root, /continue/i).props.onClick(); });
    expect(onProceed).not.toHaveBeenCalled();
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Timberland Motion 6 Mid Khaki");
    expect(text).toContain("a number on this label already identifies this product");
  });

  it("without the label photo (typed code only), the same code does NOT pool tokens it never read", async () => {
    const onProceed = vi.fn();
    let r;
    await act(async () => {
      r = TestRenderer.create(React.createElement(StyleCodeGate, {
        products: PRODUCTS, onCancel: vi.fn(), onAddStock: vi.fn(), onProceed,
      }));
    });
    const field = r.root.findAllByType("input").find((i) => i.props.placeholder === "CT8527-016");
    await act(async () => { field.props.onChange({ target: { value: "45SMA0018" } }); });
    await act(async () => { await btn(r.root, /continue/i).props.onClick(); });
    // No photo evidence → no pooled tokens → nothing similar → straight through.
    expect(onProceed).toHaveBeenCalledTimes(1);
  });
});
