// ─── THE ORDER VIEW ON THE SKY DNA (design/assistant-desktop.png) ─────────────
// Sky redesign, 2026-11-02. The desktop order screen is the reference image:
// nav pill (Products · Orders · Stores), the wordmark, search + account, the
// big search pill with filter, brand LOGO chips, four-up podium cards. The
// sneaker wall and its ?view=wall switch are gone; the sidebar and drawer
// became the nav pill. Every behaviour the classic layout had is still here:
//
// AssistantDesktop is mounted for real (react-test-renderer) from App.jsx,
// with Firebase stubbed so nothing can reach a database. Proves:
//   1. the sky layout renders; no wall, no preview toggle, no ?view=wall code
//   2. Orders opens the Order panel; Stores lists the shops and asks first
//   3. the filter popover carries the sort; Sneakers / Clothing is in the store pill
//   4. KEEP #1  cards draw the full-resolution photoUrl (thumbnail = fallback),
//               or a cut-out on a podium when one exists for THIS photo
//   5. KEEP #2  "Customer wants Marathon Club deals" defaults to ticked
//   6. KEEP #3  the Confirm order panel is a fixed size (no reflow)
//   7. KEEP #4  search matches brand names
//   8. KEEP #5  no-stock pills: dim, struck through, no ⊘ cursor, no tooltip
//   9. the popup: style code, hub, per-size counts, chosen size pressed

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

const cls = (n, c) => typeof n.props?.className === "string" && n.props.className.split(" ").includes(c);
const all = (r, c) => r.root.findAll(n => typeof n.type === "string" && cls(n, c));
const click = (node) => act(() => { node.props.onClick({ stopPropagation() {}, currentTarget: { classList: { add() {}, remove() {} } } }); });

describe("the sky layout", () => {
  it("renders the nav pill, the wordmark, the search pill, logo chips and the card grid", () => {
    const r = mount();
    const t = text(r);
    for (const s of ["Products", "Orders", "Stores", "marathon", "CLUB", "All"]) expect(t).toContain(s);
    expect(all(r, "ad-navpill")).toHaveLength(1);
    expect(all(r, "sky-search")).toHaveLength(1);
    expect(all(r, "ad-card")).toHaveLength(2);
    // Nike and Adidas are drawn as simple-icons marks, not names.
    const chips = all(r, "sky-chip");
    expect(chips.length).toBeGreaterThanOrEqual(3);
    expect(chips.find(c => c.props["aria-label"] === "Nike (1)").findAll(n => n.type === "path")).toHaveLength(1);
    expect(t).toContain("Air Force 1 Low QS Kobe Yellow");
    expect(t).toContain("R750");
  });
  it("names the store every order goes to", () => {
    const r = mount({ effectiveShop: "trophy" });
    expect(byTestId(r, "store-tag")).toHaveLength(1);
  });
  it("has no wall, no preview toggle and no ?view=wall switch anywhere", () => {
    const r = mount({ userEmail: "gunidmoh@gmail.com" });
    expect(byTestId(r, "preview-toggle")).toHaveLength(0);
    expect(text(r)).not.toContain("Preview new design");
    for (const gone of ["SneakerWall", "orderViewPreview", "isWallPreviewOn", "wallPreview", "WallAlternatives", "ad-root--wall"])
      expect(APP).not.toContain(gone);
    expect(APP).toContain("limit: MAX_ALTERNATIVES_SHOWN,");
  });
  it("Orders opens the Order panel with Place order; the cart count rides on the nav", () => {
    const r = mount({ cart: [{ product: KOBE, size: "6" }] });
    expect(JSON.stringify(byTestId(r, "nav-orders-count")[0].children)).toContain("1");
    expect(all(r, "ad-drawer")).toHaveLength(0);
    click(byTestId(r, "nav-orders")[0]);
    expect(all(r, "ad-drawer")).toHaveLength(1);
    expect(text(r)).toContain("Place order");
  });
  it("Stores lists the shops and a different shop goes through the red confirm", () => {
    let picked = null;
    const r = mount({ onSelectShop: (id) => { picked = id; } });
    click(byTestId(r, "nav-stores")[0]);
    const items = r.root.findAll(n => n.type === "button" && n.props.role === "menuitemradio");
    expect(items).toHaveLength(2);
    click(items[1]);
    expect(picked).toBe(null);                       // not switched yet
    expect(all(r, "ad-danger")).toHaveLength(1);     // the alarm confirm
    click(r.root.findAll(n => n.type === "button" && n.children.includes("Yes, switch"))[0]);
    expect(picked).toBe("trophy");
  });
  it("the filter popover sorts; Sneakers / Clothing is in the store pill, not on the page", () => {
    let m = null;
    const r = mount({ setMode: (v) => { m = v; } });
    click(r.root.findAll(n => n.type === "button" && n.props["aria-label"] === "Filter and sort")[0]);
    expect(text(r)).toContain("Price · high");
    expect(r.root.findAll(n => n.type === "button" && n.children.includes("Clothing"))).toHaveLength(0);
    click(r.root.findAll(n => n.props?.["data-testid"] === "store-tag" && n.type === "button")[0]);
    click(r.root.findAll(n => n.type === "button" && n.props["data-group"] === "mode" && n.children.includes("Clothing"))[0]);
    expect(m).toBe("clothing");
  });
});

describe("KEEP #1 — cards draw the high-resolution photo", () => {
  it("the card <img> is the product's own photoUrl, not the mirrored thumbnail", () => {
    const r = mount();
    const card = all(r, "ad-card")[0];
    const img = card.findAll(n => n.type === "img")[0];
    expect(img.props.src).toBe(FULL);
    expect(img.props["data-mirrored"]).toBeUndefined();   // not MirroredImg
    expect(img.props.loading).toBe("lazy");
  });
  it("falls back to the mirrored thumbnail when the original fails", () => {
    const r = mount();
    const card = () => all(r, "ad-card")[0];
    act(() => { card().findAll(n => n.type === "img")[0].props.onError(); });
    const img = card().findAll(n => n.type === "img")[0];
    expect(img.props["data-mirrored"]).toBe("pKobe");
  });
  it("cut-outs are OFF (Junid, 3 Nov): even a gate-passed footwear cut-out shows the original photo", () => {
    const CUT = "https://x/cutout.png";
    const shoe = { ...KOBE, category: "Footwear", photoCutoutUrl: CUT, photoCutoutFor: FULL, photoCutoutQuality: "shoe" };
    for (const p of [shoe, { ...shoe, category: "Perfume" }, { ...shoe, photoCutoutQuality: "fallback" }, KOBE]) {
      const r = mount({ searchResults: [p] });
      expect(all(r, "sky-podium")).toHaveLength(0);
      expect(all(r, "sky-cutout")).toHaveLength(0);
      expect(all(r, "sky-frame")).toHaveLength(1);
    }
  });
});

describe("KEEP #2 — Marathon Club deals defaults to ticked", () => {
  it("AssistantView starts ticked and resets to ticked", () => {
    expect(APP).toContain("const [marketingOptIn, setMarketingOptIn]             = useState(true);");
    expect(APP).toMatch(/const closeCheckout = \(\) => \{[^}]*setMarketingOptIn\(true\); \};/);
    expect(APP).not.toContain("setMarketingOptIn(false)");
  });
  it("the Confirm order checkbox shows it", () => {
    const r = openCheckout();
    const box = r.root.findAll(n => n.type === "input" && n.props.type === "checkbox")[0];
    expect(box.props.checked).toBe(true);
    expect(text(r)).toContain("Customer wants Marathon Club deals");
  });
});

function openCheckout(over) {
  const r = mount({ cart: [{ product: KOBE, size: "6" }], ...over });
  click(byTestId(r, "nav-orders")[0]);
  click(all(r, "ad-place")[0]);
  return r;
}

describe("KEEP #3 — the Confirm order panel is a fixed size", () => {
  it("the summary box is a fixed height whatever the cart holds", () => {
    const one = byTestId(openCheckout(), "confirm-summary")[0].props.style;
    const many = byTestId(openCheckout({ cart: Array.from({ length: 9 }, (_, i) => ({ product: i % 2 ? KOBE : SAMBA, size: String(6 + i) })) }), "confirm-summary")[0].props.style;
    expect(one.height).toBe(172);
    expect(one.maxHeight).toBeUndefined();
    expect(many).toEqual(one);
  });
  it("the phone hint's line is reserved, typed or not", () => {
    const empty = byTestId(openCheckout(), "phone-hint")[0];
    const bad = byTestId(openCheckout({ customerPhone: "071" }), "phone-hint")[0];
    expect(empty.props.style).toEqual(bad.props.style);
    expect(empty.props.style.minHeight).toBe(15);
    expect(JSON.stringify(bad.children)).toContain("Enter a 10-digit number");
  });
  it("the panel does not clip, so a customer dropdown floats instead of adding a scrollbar", () => {
    expect(byTestId(openCheckout(), "confirm-order")[0].props.style.overflow).toBe("visible");
  });
  it("on a short screen the stage scrolls — the panel has no max-height to spill past", () => {
    const panel = byTestId(openCheckout(), "confirm-order")[0];
    expect(panel.props.style.maxHeight).toBe("none");
    expect(panel.parent.props.className).toBe("ad-stage");
    expect(panel.parent.props.style.overflow).toBe("auto");
  });
});

describe("KEEP #4 — search matches brand names", () => {
  it("AssistantView's one search narrows by brand whatever the layout", () => {
    expect(APP).toContain("const brandIndex = useMemo(() => buildBrandIndex(base), [base]);");
    expect(APP).toContain("const bq = matchBrandQuery(brandIndex, q);");
  });
});

describe("KEEP #5 — no-stock size pills", () => {
  const szOf = (r, label) => all(r, "ad-card")[0].findAll(n => n.type === "button" && cls(n, "ad-sz")).find(b => b.children.includes(label));
  it("dim, struck through, no ⊘ cursor, no tooltip — and an in-stock pill is untouched", () => {
    const r = mount();
    const out = szOf(r, "7");
    expect(out.props.style.textDecoration).toBe("line-through");
    expect(out.props.style.cursor).not.toBe("not-allowed");
    expect(out.props.title).toBeUndefined();
    expect(szOf(r, "6").props.style).toBeUndefined();
  });
  it("a clothing no-stock pill (nothing to open) has a plain arrow, not ⊘", () => {
    const r = mount({ mode: "clothing", hubQty: (pid, sz) => (sz === "7" ? 0 : 5) });
    const out = szOf(r, "7");
    expect(out.props.disabled).toBe(true);
    expect(out.props.style.cursor).toBe("default");
    expect(out.props.style.textDecoration).toBe("line-through");
    expect(out.props.title).toBeUndefined();
  });
});

describe("the product popup", () => {
  it("is a dialog with style code, hub, per-size counts; a chosen size is pressed", () => {
    const r = mount({
      searchResults: [{ ...KOBE, styleCode: "DD1234-100" }],
      sizeOnHand: (p, sz) => (sz === "7" ? 0 : 3), hubLabelForSize: () => "Hub 1",
    });
    click(all(r, "ad-card")[0]);
    const sv = byTestId(r, "product-popup")[0];
    expect(sv.props.role).toBe("dialog");
    expect(sv.props["aria-modal"]).toBe("true");
    expect(JSON.stringify(byTestId(r, "popup-stylecode")[0].children)).toContain("DD1234-100");
    expect(JSON.stringify(byTestId(r, "popup-hub")[0].children)).toContain("Hub 1");
    expect(byTestId(r, "size-onhand").map(n => n.children.join(""))).toEqual(["3", "0", "3"]);
    const six = sv.findAll(n => n.type === "button" && n.props["aria-pressed"] !== undefined)[0];
    click(six);
    expect(byTestId(r, "product-popup")[0].findAll(n => n.type === "button" && n.props["aria-pressed"] === true)).toHaveLength(1);
  });
});
