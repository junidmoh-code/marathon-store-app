// ─── ORDER VIEW RESTORE — the classic layout is the default again ────────────
// (Junid, 2026-10-20.) The Sneaker order screen goes back to the layout staff
// know — sidebar (ORDER FOR · FLOW · Switch view · user), search with the
// brand dropdown and Featured sort, the card grid, the right-hand Order panel
// with Place order — for everyone. The sneaker wall mounts only with the
// preview on (?view=wall or localStorage mc.orderView = "wall"), and the
// "Preview new design" toggle shows for Junid and MC only.
//
// AssistantDesktop is mounted for real (react-test-renderer) from App.jsx,
// with Firebase stubbed so nothing can reach a database. Proves:
//   1. default: classic layout, no wall component mounted
//   2. wallPreview: the wall mounts instead
//   3. the toggle: absent for a normal staff account, present for Junid / MC
//   4. KEEP #1  cards draw the full-resolution photoUrl (thumbnail = fallback)
//   5. KEEP #2  "Customer wants Marathon Club deals" defaults to ticked
//   6. KEEP #3  the Confirm order panel is a fixed size (no reflow)
//   7. KEEP #4  search matches brand names, preview or not
//   8. KEEP #5  no-stock pills: dim, struck through, no ⊘ cursor, no tooltip

import { describe, it, expect, vi, beforeAll } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

vi.mock("../../firebase", () => ({
  app: {}, database: {}, functions: {}, functionsUS: {}, storage: {}, googleProvider: {},
  auth: { currentUser: null, onAuthStateChanged: () => () => {} },
}));
// Every database call is a stub: this test cannot read or write anything.
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

// Node has no DOM; AssistantDesktop only adds key listeners.
beforeAll(() => {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { search: "", hash: "" } };
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, activeElement: null };
});

const { AssistantDesktop } = await import("../../App.jsx");
const { default: SneakerWall } = await import("./SneakerWall.jsx");
const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

const FULL = "https://firebasestorage.googleapis.com/v0/b/b/o/products%2FpKobe%2Fphoto.jpg?alt=media&token=t";
const KOBE = { id: "pKobe", name: "Air Force 1 Low QS Kobe Yellow", brand: "Nike", retailPrice: 750, sizes: ["6", "7", "8"], photoUrl: FULL };
const SAMBA = { id: "pSamba", name: "Samba OG", brand: "Adidas", retailPrice: 1900, sizes: ["8"], photoUrl: "https://x/samba.jpg" };
const PRODUCTS = [KOBE, SAMBA];
const SHOPS = [{ id: "pe" }, { id: "trophy" }];

function mount(over = {}) {
  const props = {
    products: PRODUCTS, searchResults: PRODUCTS, effectiveShop: "pe", availableShops: SHOPS, onSelectShop: () => {},
    shopRegistry: null, search: "", setSearch: () => {}, onLabelFind: null, cart: [],
    onQuickAdd: () => 1, onRemoveOne: () => {}, onAddDisplayPartner: () => {}, onViewPhoto: () => {},
    onSwitchView: () => {}, userEmail: "yasmin@marathon.internal", mode: "sneaker", setMode: () => {},
    customerName: "", setCustomerName: () => {}, customerPhone: "", setCustomerPhone: () => {},
    marketingOptIn: true, setMarketingOptIn: () => {}, submitting: false, onPlaceOrder: async () => true,
    customerIndex: [], onPickCustomer: () => {}, onAddClothing: () => {}, onPlaceRefill: () => {},
    onOpenTracking: () => {}, trackingPending: 0,
    hubQty: () => 5, servingHubLabel: "Hub 1",
    // Kobe size 7 has no stock at the serving hub.
    sneakerOut: (p, sz) => p.id === "pKobe" && sz === "7",
    sneakerOutWhy: () => ({ booked: 0, available: 0, hubLabel: "Hub 1" }),
    sneakerDisplayInfo: () => null,
    alternativesFor: () => null, deadForOrder: () => false,
    ...over,
  };
  let r;
  act(() => { r = TestRenderer.create(<AssistantDesktop {...props} />); });
  return r;
}
const text = (r) => JSON.stringify(r.toJSON());
const byTestId = (r, id) => r.root.findAll(n => n.props?.["data-testid"] === id && typeof n.type === "string");

describe("default route — the classic layout, no wall", () => {
  it("renders the sidebar, search + brand + Featured, the card grid and the Order panel", () => {
    const r = mount();
    const t = text(r);
    for (const s of ["Order for", "Flow", "Sneaker order", "Clothing order", "Switch view", "Place order", "Featured", "All brands"])
      expect(t).toContain(s);
    expect(r.root.findAll(n => n.props?.className === "ad-side").length).toBe(1);
    expect(r.root.findAll(n => n.props?.className === "ad-drawer").length).toBe(1);
    expect(r.root.findAll(n => n.props?.className === "ad-card").length).toBe(2);
    // Each card: brand badge, name, price and "N sizes".
    expect(t).toContain("Air Force 1 Low QS Kobe Yellow");
    expect(t).toContain('"3"," size","s"');   // "3 sizes", as React splits it
    expect(r.root.findAll(n => n.props?.className === "ad-root").length).toBe(1);
  });
  it("mounts no wall component at all", () => {
    const r = mount();
    expect(r.root.findAllByType(SneakerWall)).toHaveLength(0);
    expect(r.root.findAll(n => typeof n.props?.className === "string" && /\bsw-|ad-root--wall/.test(n.props.className))).toHaveLength(0);
  });
  it("clothing order is the classic layout too", () => {
    const r = mount({ mode: "clothing" });
    expect(r.root.findAllByType(SneakerWall)).toHaveLength(0);
    expect(r.root.findAll(n => n.props?.className === "ad-side").length).toBe(1);
  });
});

describe("preview on (?view=wall or mc.orderView) — the wall", () => {
  it("mounts the sneaker wall instead of the classic grid", () => {
    const r = mount({ wallPreview: true });
    expect(r.root.findAllByType(SneakerWall)).toHaveLength(1);
    expect(r.root.findAll(n => n.props?.className === "ad-side")).toHaveLength(0);
    expect(r.root.findAll(n => n.props?.className === "ad-root ad-root--wall")).toHaveLength(1);
  });
  it("clothing order stays classic even with the preview on (the wall is sneakers only)", () => {
    const r = mount({ wallPreview: true, mode: "clothing" });
    expect(r.root.findAllByType(SneakerWall)).toHaveLength(0);
  });
});

describe("KEEP #1 — cards draw the high-resolution photo", () => {
  it("the card <img> is the product's own photoUrl, not the mirrored thumbnail", () => {
    const r = mount();
    const card = r.root.findAll(n => n.props?.className === "ad-card")[0];
    const img = card.findAll(n => n.type === "img")[0];
    expect(img.props.src).toBe(FULL);
    expect(img.props["data-mirrored"]).toBeUndefined();   // not MirroredImg
    expect(img.props.loading).toBe("lazy");
    expect(img.props.style.objectFit).toBe("contain");      // the old card fit
  });
  it("falls back to the mirrored thumbnail when the original fails", () => {
    const r = mount();
    const card = () => r.root.findAll(n => n.props?.className === "ad-card")[0];
    act(() => { card().findAll(n => n.type === "img")[0].props.onError(); });
    const img = card().findAll(n => n.type === "img")[0];
    expect(img.props["data-mirrored"]).toBe("pKobe");
  });
});

describe("KEEP #2 — Marathon Club deals defaults to ticked", () => {
  it("AssistantView starts ticked and resets to ticked", () => {
    expect(APP).toContain("const [marketingOptIn, setMarketingOptIn]             = useState(true);");
    expect(APP).toMatch(/const closeCheckout = \(\) => \{[^}]*setMarketingOptIn\(true\); \};/);
    expect(APP).not.toContain("setMarketingOptIn(false)");
  });
  it("the Confirm order checkbox shows it", () => {
    const r = mount({ cart: [{ product: KOBE, size: "6" }] });
    act(() => { r.root.findAll(n => n.props?.className === "ad-place")[0].props.onClick(); });
    const box = r.root.findAll(n => n.type === "input" && n.props.type === "checkbox")[0];
    expect(box.props.checked).toBe(true);
    expect(text(r)).toContain("Customer wants Marathon Club deals");
  });
});

describe("KEEP #3 — the Confirm order panel is a fixed size", () => {
  const open = (over) => {
    const r = mount({ cart: [{ product: KOBE, size: "6" }], ...over });
    act(() => { r.root.findAll(n => n.props?.className === "ad-place")[0].props.onClick(); });
    return r;
  };
  it("the summary box is a fixed height whatever the cart holds", () => {
    const one = byTestId(open(), "confirm-summary")[0].props.style;
    const many = byTestId(open({ cart: Array.from({ length: 9 }, (_, i) => ({ product: i % 2 ? KOBE : SAMBA, size: String(6 + i) })) }), "confirm-summary")[0].props.style;
    expect(one.height).toBe(172);
    expect(one.maxHeight).toBeUndefined();
    expect(many).toEqual(one);
  });
  it("the phone hint's line is reserved, typed or not", () => {
    const empty = byTestId(open(), "phone-hint")[0];
    const bad = byTestId(open({ customerPhone: "071" }), "phone-hint")[0];
    expect(empty.props.style).toEqual(bad.props.style);
    expect(empty.props.style.minHeight).toBe(15);
    expect(JSON.stringify(bad.children)).toContain("Enter a 10-digit number");
  });
  it("the panel does not clip, so a customer dropdown floats instead of adding a scrollbar", () => {
    expect(byTestId(open(), "confirm-order")[0].props.style.overflow).toBe("visible");
  });
});

describe("KEEP #4 — search matches brand names", () => {
  it("AssistantView's one search narrows by brand whatever the layout", () => {
    expect(APP).toContain("const brandIndex = useMemo(() => buildBrandIndex(base), [base]);");
    expect(APP).toContain("const bq = matchBrandQuery(brandIndex, q);");
    // Not gated on the preview.
    const filterBody = APP.slice(APP.indexOf("const filtered = useMemo(() => {"), APP.indexOf("}, [deferredSearch, base, browse, fuse, brandIndex]);"));
    expect(filterBody).not.toContain("wallPreview");
  });
});

describe("KEEP #5 — no-stock size pills", () => {
  it("dim, struck through, no ⊘ cursor, no tooltip — and an in-stock pill is untouched", () => {
    const r = mount();
    const kobe = r.root.findAll(n => n.props?.className === "ad-card")[0];
    const sz = (label) => kobe.findAll(n => n.type === "button" && n.props.className === "ad-sz")
      .find(b => b.children.includes(label));
    const out = sz("7");
    expect(out.props.style.textDecoration).toBe("line-through");
    expect(out.props.style.color).toBe("rgba(233,238,255,.62)");
    expect(out.props.style.cursor).not.toBe("not-allowed");
    expect(out.props.title).toBeUndefined();
    const ok = sz("6");
    expect(ok.props.style).toBeUndefined();
  });
  it("a clothing no-stock pill (nothing to open) has a plain arrow, not ⊘", () => {
    const r = mount({ mode: "clothing", hubQty: (pid, sz) => (sz === "7" ? 0 : 5) });
    const kobe = r.root.findAll(n => n.props?.className === "ad-card")[0];
    const out = kobe.findAll(n => n.type === "button" && n.props.className === "ad-sz").find(b => b.children.includes("7"));
    expect(out.props.disabled).toBe(true);
    expect(out.props.style.cursor).toBe("default");
    expect(out.props.style.textDecoration).toBe("line-through");
    expect(out.props.title).toBeUndefined();
  });
});
