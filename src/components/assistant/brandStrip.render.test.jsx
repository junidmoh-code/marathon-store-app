// ─── THE PHONE BRAND STRIP (sky redesign, 5 Nov 2026) ────────────────────────
// Proves, on the real components:
//   1. brandOptions is the desktop's old ranking, unchanged (most first,
//      "Needs brand" then "Other" last), and filterByBrand its old filter
//   2. reconcileBrand keeps a brand that still exists, else All
//   3. AssistantPhone draws the strip: "All" first as text, then every brand
//      in option order — a simple-icons mark where there is one, bold caps
//      where there is not; no "…" chip
//   4. tapping a brand selects it; tapping the active chip again is All
//   5. no strip without brands (refill mode), and the CSS hides it ≥768px
//   6. AssistantDesktop with a lifted brand shows/sets THAT value

import { describe, it, expect, vi, beforeAll } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { brandOptions, filterByBrand, reconcileBrand } from "./brandFilter.js";

vi.mock("../../firebase", () => ({
  app: {}, database: {}, functions: {}, functionsUS: {}, storage: {}, googleProvider: {},
  auth: { currentUser: null, onAuthStateChanged: () => () => {} },
}));
vi.mock("firebase/database", async (orig) => {
  const real = await orig();
  const stub = {};
  for (const k of Object.keys(real)) stub[k] = typeof real[k] === "function" ? vi.fn(() => ({})) : real[k];
  const off = () => () => {};
  return { ...stub, onValue: off, onChildAdded: off, onChildChanged: off, onChildRemoved: off,
           get: async () => ({ val: () => null, exists: () => false }) };
});
vi.mock("../../offline/MirroredImg.jsx", () => ({
  MirroredImg: ({ productId, src, ...rest }) => <img src={src} data-mirrored={productId} {...rest} />,
}));

beforeAll(() => {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { search: "", hash: "" } };
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, activeElement: null };
});

const P = (id, brand, extra = {}) => ({ id, name: `${brand || "x"} ${id}`, brand, retailPrice: 750, sizes: ["8"], ...extra });
const CATALOG = [
  P("a", "Nike"), P("b", "Nike"), P("c", "Nike"), P("d", "Adidas"), P("e", "Adidas"),
  P("f", "Lacoste"), P("g", null), P("h", null, { brandFlag: "unrecognised" }),
];

describe("brandOptions / filterByBrand / reconcileBrand", () => {
  it("ranks by count, then name; Needs brand and Other last; All first with the total", () => {
    expect(brandOptions(CATALOG)).toEqual([["All", 8], ["Nike", 3], ["Adidas", 2], ["Lacoste", 1], ["Needs brand", 1], ["Other", 1]]);
    expect(brandOptions([])).toEqual([["All", 0]]);
  });
  it("filters exactly as the desktop always did", () => {
    expect(filterByBrand(CATALOG, "All")).toBe(CATALOG);
    expect(filterByBrand(CATALOG, "Nike").map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(filterByBrand(CATALOG, "Other").map((p) => p.id)).toEqual(["g"]);
    expect(filterByBrand(CATALOG, "Needs brand").map((p) => p.id)).toEqual(["h"]);
  });
  it("keeps a brand that still exists, else All", () => {
    const opts = brandOptions(CATALOG);
    expect(reconcileBrand("Adidas", opts)).toBe("Adidas");
    expect(reconcileBrand("Puma", opts)).toBe("All");
    expect(reconcileBrand("All", opts)).toBe("All");
  });
});

const { default: AssistantPhone } = await import("../sky/AssistantPhone.jsx");
const { AssistantDesktop } = await import("../../App.jsx");

function mountPhone(over = {}) {
  let brand = over.brand || "All";
  const props = {
    mode: "sneaker", onMode: () => {}, shops: [], effectiveShop: "pe", shopLabel: (x) => x, onShop: () => {},
    search: "", onSearch: () => {}, onScan: () => {}, products: CATALOG, onOpen: () => {},
    cartCount: 0, onCart: () => {}, onExit: () => {},
    brands: brandOptions(CATALOG), brand, onBrand: (b) => { brand = b; },
    ...over,
  };
  let r;
  act(() => { r = TestRenderer.create(<AssistantPhone {...props} />); });
  return { r, picked: () => brand };
}
const strip = (r) => r.root.findAll((n) => n.props?.["data-testid"] === "brand-strip" && typeof n.type === "string");
const chips = (r) => strip(r)[0].findAll((n) => n.type === "button");
const click = (n) => act(() => { n.props.onClick(); });

describe("the phone brand strip", () => {
  it("draws All first, then every brand in option order: marks where simple-icons has one, caps where not", () => {
    const { r } = mountPhone();
    expect(strip(r)).toHaveLength(1);
    const c = chips(r);
    expect(c.map((b) => b.props["aria-label"] || b.children.join(""))).toEqual(
      ["All", "Nike (3)", "Adidas (2)", "Lacoste (1)", "Needs brand (1)", "Other (1)"]);
    expect(c[0].props["aria-pressed"]).toBe(true);
    expect(c[1].findAll((n) => n.type === "path")).toHaveLength(1);              // Nike: logo
    expect(c[2].findAll((n) => n.type === "path")).toHaveLength(1);              // Adidas: logo
    expect(c[3].findAll((n) => n.type === "span" && n.children.includes("LACOSTE"))).toHaveLength(1);                  // no mark: caps
    expect(c[3].findAll((n) => n.type === "svg")).toHaveLength(0);
    expect(JSON.stringify(r.toJSON())).not.toContain("More brands");             // no "…" chip
  });
  it("tapping a brand picks it; tapping the active chip again is All", () => {
    const a = mountPhone();
    click(chips(a.r)[2]);
    expect(a.picked()).toBe("Adidas");
    const b = mountPhone({ brand: "Adidas" });
    expect(chips(b.r)[2].props["aria-pressed"]).toBe(true);
    click(chips(b.r)[2]);
    expect(b.picked()).toBe("All");
  });
  it("is absent without brands (refill mode) and hidden from 768px by CSS", () => {
    const { r } = mountPhone({ brands: null });
    expect(strip(r)).toHaveLength(0);
    const src = readFileSync(new URL("../sky/AssistantPhone.jsx", import.meta.url), "utf8");
    expect(src).toContain("@media (min-width:768px){.ap-brands{display:none}}");
    const css = readFileSync(new URL("../../styles/sky.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sky-brandstrip \{[^}]*scroll-snap-type: x mandatory/);
    expect(css).toMatch(/\.sky-brandchip \{[^}]*height: 44px/);
  });
});

describe("one brand value for both layouts", () => {
  it("AssistantView holds the brand and hands the same value to the desktop and the phone", () => {
    const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
    expect(APP).toContain("brand={brand} setBrand={setBrand}");
    expect(APP).toContain("brands={isRefillMode ? null : brandOpts} brand={brand} onBrand={setBrand}");
    expect(APP).toContain("const brandOpts = useMemo(() => brandOptions(browse), [browse]);");
  });
  it("AssistantDesktop shows the lifted brand as pressed and sets it through the lifted setter", () => {
    let set = null;
    const props = {
      products: CATALOG, searchResults: CATALOG, effectiveShop: "pe", availableShops: [{ id: "pe" }], onSelectShop: () => {},
      shopRegistry: null, search: "", setSearch: () => {}, onLabelFind: null, cart: [],
      onQuickAdd: () => 1, onRemoveOne: () => {}, onAddDisplayPartner: () => {}, onViewPhoto: () => {},
      onSwitchView: () => {}, userEmail: "x@marathon.internal", mode: "sneaker", setMode: () => {},
      customerName: "", setCustomerName: () => {}, customerPhone: "", setCustomerPhone: () => {},
      marketingOptIn: true, setMarketingOptIn: () => {}, submitting: false, onPlaceOrder: async () => true,
      customerIndex: [], onPickCustomer: () => {}, onAddClothing: () => {}, onPlaceRefill: () => {},
      onOpenTracking: () => {}, trackingPending: 0, hubQty: () => 5, servingHubLabel: "Hub 1",
      sneakerOut: () => false, sneakerOutWhy: () => ({}), sneakerDisplayInfo: () => null,
      alternativesFor: () => null, deadForOrder: () => false,
      brand: "Adidas", setBrand: (b) => { set = b; },
    };
    let r;
    act(() => { r = TestRenderer.create(<AssistantDesktop {...props} />); });
    const deskChips = r.root.findAll((n) => n.type === "button" && typeof n.props.className === "string" && n.props.className.includes("sky-chip"));
    const adidas = deskChips.find((c) => c.props["aria-label"] === "Adidas (2)");
    expect(adidas.props["aria-pressed"]).toBe(true);
    expect(r.root.findAll((n) => typeof n.props?.className === "string" && n.props.className.split(" ").includes("ad-card"))).toHaveLength(2);
    act(() => { adidas.props.onClick(); });
    expect(set).toBe("All");
  });
});
