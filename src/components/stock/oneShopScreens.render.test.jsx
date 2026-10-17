// ─── ONE-SHOP ACCOUNTS ON THE TILES EVERY ACCOUNT HAS (owner, 2026-10-17) ─────
// Barcodes and Print Labels are open to every signed-in account. A Marathon PE
// assistant (destShop "marathon-pe") must not see Trophy's stock on either —
// not as a location to pick, not inside an on-hand figure — and the other way
// round. No destShop = exactly as before.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));
vi.mock("firebase/database", () => ({ ref: () => ({}), set: async () => {}, onValue: () => () => {} }));
vi.mock("./printers", () => ({
  TRANSPORTS: [], printLabels: async () => ({ ok: true }), printTest: async () => ({ ok: true }),
  connectTransport: async () => ({}), getXprinterDiag: () => null, defaultTransportId: () => "none", rememberTransport: () => {},
}));
vi.mock("./PrinterStatus", () => ({ default: () => null }));
vi.mock("./barcodeStore", () => ({ ensureBarcode: async () => "123", getBarcode: async () => null }));

// One product, one size, stock at PE (3), Trophy (5) and Hub 1 (7).
const CELLS = {
  "marathon-pe": { p1: { "8": { qty: 3 } } },
  trophy: { p1: { "8": { qty: 5 } } },
  hub1: { p1: { "8": { qty: 7 } } },
};
const READ_PATHS = [];
vi.mock("./useStock", () => ({
  useLocations: () => ({}),
  useStockCells: (loc) => { READ_PATHS.push(loc || "ALL"); return loc ? (CELLS[loc]?.p1 ? { p1: CELLS[loc].p1 } : {}) : CELLS; },
}));

// Just enough browser for these two screens (no jsdom in this repo's tests).
const store = new Map();
globalThis.window ??= { innerWidth: 400, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
globalThis.localStorage ??= { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.navigator ??= { userAgent: "test" };

const { default: BarcodeCatalog } = await import("./BarcodeCatalog.jsx");
const { default: LabelPrintView } = await import("../LabelPrintView.jsx");

const PRODUCTS = [{ id: "p1", name: "Samba OG", category: "Footwear", sizes: ["8"], retailPrice: 1899 }];
const json = (t) => JSON.stringify(t.toJSON());
// Every rendered text leaf, so a number is matched as text and never inside a style.
const leaves = (t) => { const out = []; const walk = (n) => { if (n == null) return; if (typeof n === "string" || typeof n === "number") return out.push(String(n).trim()); if (Array.isArray(n)) return n.forEach(walk); walk(n.children); }; walk(t.toJSON()); return out; };
const mount = (el) => { let t; act(() => { t = TestRenderer.create(el); }); return t; };
const optionLabels = (t) => t.root.findAll((n) => n.type === "option" || (n.props && typeof n.props.label === "string" && n.props.options)).flatMap((n) =>
  n.type === "option" ? [String(n.props.children)] : n.props.options.map((o) => o.label));
const buttonTexts = (t) => t.root.findAllByType("button").map((b) => JSON.stringify(b.props.children));

const locationOptions = (t) => t.root.findAll((n) => n.props && n.props.label === "Location" && Array.isArray(n.props.options))[0].props.options.map((o) => o.label);
// The product row expands to its sizes; the on-hand figure is the size chip's number.
const instText = (inst) => (typeof inst === "string" ? inst : (inst?.children || []).map(instText).join(""));
const openRow = (t) => act(() => { t.root.findAll((n) => n.type === "div" && typeof n.props.onClick === "function" && instText(n).includes("Samba OG"))[0].props.onClick(); });

describe("Barcodes for a one-shop account", () => {
  it("unscoped (no destShop): every location is offered and on-hand counts them all, as before", () => {
    const t = mount(<BarcodeCatalog products={PRODUCTS} canMint={false} onExit={() => {}} />);
    expect(locationOptions(t)).toEqual(expect.arrayContaining(["Marathon PE", "Trophy"]));
    openRow(t);
    expect(leaves(t)).toContain("15"); // 3 + 5 + 7
  });

  it("a Marathon PE assistant is offered PE and its hubs, never Trophy, and Trophy's 5 is never counted", () => {
    const t = mount(<BarcodeCatalog products={PRODUCTS} canMint={false} onExit={() => {}} myShop="marathon-pe" />);
    const opts = locationOptions(t);
    expect(opts).toContain("Marathon PE");
    expect(opts).not.toContain("Trophy");
    openRow(t);
    expect(leaves(t)).toContain("10"); // 3 + 7
    expect(leaves(t)).not.toContain("15");
  });

  it("a Trophy assistant is offered Trophy and its hubs, never PE", () => {
    const t = mount(<BarcodeCatalog products={PRODUCTS} canMint={false} onExit={() => {}} myShop="trophy" />);
    const opts = locationOptions(t);
    expect(opts).toContain("Trophy");
    expect(opts).not.toContain("Marathon PE");
    openRow(t);
    expect(leaves(t)).toContain("12"); // 5 + 7
  });
});

describe("Print Labels for a one-shop account", () => {
  it("unscoped: both shops in the store picker", () => {
    const t = mount(<LabelPrintView products={PRODUCTS} onExit={() => {}} />);
    const s = json(t);
    expect(s).toContain("Marathon PE");
    expect(s).toContain("Trophy");
    expect(s).toContain("All stores");
  });

  it("a Trophy assistant picks only Trophy, and a PE pick can never be read", () => {
    READ_PATHS.length = 0;
    const t = mount(<LabelPrintView products={PRODUCTS} onExit={() => {}} myShop="trophy" />);
    const s = json(t);
    expect(s).toContain("Trophy");
    expect(s).not.toContain("Marathon PE");
    expect(s).toContain("All products");
    expect(READ_PATHS).not.toContain("marathon-pe");
  });
});
