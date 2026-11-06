import { describe, it, expect, vi, beforeAll } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

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

// ─── COMPACT TOP BAND (Junid, 5 Nov) ─────────────────────────────────────────
// The store AND the product type live in the header pill ("TROPHY · SNEAKERS");
// no Sneakers/Clothing toggle, no store row, no "Place order" heading. Same
// store and mode state: a store pick still goes through the existing switch
// handler (the red confirm), a product pick calls the same mode setter.
// The cart bar appears only once something is in the cart.

const { default: AssistantPhone } = await import("../sky/AssistantPhone.jsx");
const { AssistantDesktop } = await import("../../App.jsx");
const { lastUsedStoreDiffers } = await import("../sky/Sky.jsx");

const SHOPS = [{ id: "concrete" }, { id: "marathon-pe" }, { id: "pine" }, { id: "trophy" }];
const NAMES = { concrete: "Concrete", "marathon-pe": "Marathon PE", pine: "Pine", trophy: "Trophy" };
const KOBE = { id: "pKobe", name: "Kobe", brand: "Nike", retailPrice: 750, sizes: ["6"], photoUrl: "https://x/k.jpg" };

function mountPhone(over = {}) {
  const calls = { shop: [], mode: [] };
  const props = {
    mode: "sneaker", onMode: (v) => calls.mode.push(v), shops: SHOPS, effectiveShop: "trophy",
    shopLabel: (id) => NAMES[id], onShop: (id) => calls.shop.push(id),
    search: "", onSearch: () => {}, onScan: () => {}, products: [KOBE], onOpen: () => {},
    cartCount: 0, onCart: () => {}, onExit: () => {}, ...over,
  };
  let r;
  act(() => { r = TestRenderer.create(<AssistantPhone {...props} />); });
  return { r, calls };
}
const json = (r) => JSON.stringify(r.toJSON());
const byTestId = (r, id) => r.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string");
const items = (r, g = "store") => r.root.findAll((n) => n.type === "button" && n.props.role === "menuitemradio" && n.props["data-group"] === g);
const allItems = (r) => r.root.findAll((n) => n.type === "button" && n.props.role === "menuitemradio");
const press = (n) => act(() => { n.props.onClick({ stopPropagation() {} }); });

describe("phone: the store lives in the header pill", () => {
  it("the pill names the store in caps-ready text with a chevron; no ASSISTANT tag, no store row, no heading", () => {
    const { r } = mountPhone();
    const pill = byTestId(r, "store-pill")[0];
    expect(pill.type).toBe("button");
    expect(pill.findAll((n) => n.type === "span")[0].children).toEqual(["Trophy · Sneakers"]);
    expect(pill.findAll((n) => n.type === "svg")).toHaveLength(1);         // the chevron
    const t = json(r);
    for (const gone of ["ASSISTANT", "Place order", "Choose products to add to your cart", "ap-shops", "Order for\"}"])
      expect(t).not.toContain(gone);
    // No segmented control on the page at all: no store row, no Sneakers / Clothing toggle.
    expect(r.root.findAll((n) => n.props?.role === "group")).toHaveLength(0);
    expect(r.root.findAll((n) => n.type === "button" && n.children.includes("Clothing"))).toHaveLength(0);
  });
  it("tapping opens the four stores, current one checked; a pick closes it and goes to the same switch handler", () => {
    const { r, calls } = mountPhone();
    expect(allItems(r)).toHaveLength(0);
    press(byTestId(r, "store-pill")[0]);
    const list = items(r);
    expect(list.map((b) => JSON.stringify(b.children))).toEqual(['["Concrete"]', '["Marathon PE"]', '["Pine"]', '["Trophy"]']);
    expect(list.map((b) => b.props["aria-checked"])).toEqual([false, false, false, true]);
    press(list[1]);
    expect(calls.shop).toEqual(["marathon-pe"]);
    expect(calls.mode).toEqual([]);
    expect(allItems(r)).toHaveLength(0);                                      // closed
  });
  it("picking the current store changes nothing", () => {
    const { r, calls } = mountPhone();
    press(byTestId(r, "store-pill")[0]);
    press(items(r)[3]);
    expect(calls.shop).toEqual([]);
  });
  it("one store only: the pill still opens, with just the product types", () => {
    const { r, calls } = mountPhone({ shops: [], effectiveShop: "pine", mode: "clothing" });
    const pill = byTestId(r, "store-pill")[0];
    expect(pill.type).toBe("button");
    expect(pill.findAll((n) => n.type === "span")[0].children).toEqual(["Pine · Clothing"]);
    press(pill);
    expect(items(r)).toHaveLength(0);                                         // no stores to pick
    press(items(r, "mode")[0]);
    expect(calls.mode).toEqual(["sneaker"]);
  });
  it("one store and no mode setter: a plain pill", () => {
    const { r } = mountPhone({ shops: [], effectiveShop: "pine", onMode: null });
    expect(byTestId(r, "store-pill")[0].type).toBe("span");
  });
  it("the pill's Products group drives the same mode setter; the current type is checked; same type = no-op", () => {
    const { r, calls } = mountPhone();
    press(byTestId(r, "store-pill")[0]);
    const m = items(r, "mode");
    expect(m.map((b) => JSON.stringify(b.children))).toEqual(['["Sneakers"]', '["Clothing"]']);
    expect(m.map((b) => b.props["aria-checked"])).toEqual([true, false]);
    press(m[0]);
    expect(calls.mode).toEqual([]);
    press(byTestId(r, "store-pill")[0]);
    press(items(r, "mode")[1]);
    expect(calls.mode).toEqual(["clothing"]);
    expect(calls.shop).toEqual([]);
  });
  it("the cart bar is hidden while the cart is empty and appears with the first item", () => {
    expect(byTestId(mountPhone().r, "sky-cartbar")).toHaveLength(0);
    const bar = byTestId(mountPhone({ cartCount: 2 }).r, "sky-cartbar");
    expect(bar).toHaveLength(1);
    expect(bar[0].findAll((n) => n.type === "span" && n.children.join("") === "2 items")).toHaveLength(1);
    const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
    expect(APP).toContain("{!checkoutOpen && !selected && !isDesktop && cart.length > 0 && (");
    const css = readFileSync(new URL("../../styles/sky.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sky-bottombar \{[^}]*min-height: 48px/);
  });
});

describe("the pulse: once, only when the store differs from this device's last-used store", () => {
  const withStore = (v, fn) => {
    const prev = globalThis.localStorage;
    globalThis.localStorage = { getItem: (k) => (k === "storeAssistantShop" ? v : null), setItem() {} };
    try { return fn(); } finally { globalThis.localStorage = prev; }
  };
  it("differs → pulse class; same or unknown → none; storage is only read", () => {
    expect(withStore("marathon-pe", () => lastUsedStoreDiffers("trophy"))).toBe(true);
    expect(withStore("trophy", () => lastUsedStoreDiffers("trophy"))).toBe(false);
    expect(withStore(null, () => lastUsedStoreDiffers("trophy"))).toBe(false);
    const cls = withStore("marathon-pe", () => byTestId(mountPhone().r, "store-pill")[0].props.className);
    expect(cls).toContain("sky-storepill--pulse");
    const calm = withStore("trophy", () => byTestId(mountPhone().r, "store-pill")[0].props.className);
    expect(calm).not.toContain("sky-storepill--pulse");
  });
  it("reduced motion switches the animation off (CSS)", () => {
    const css = readFileSync(new URL("../../styles/sky.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.sky-storepill--pulse \{ animation: none; \} \}/);
    expect(css).toMatch(/\.sky-storepill--pulse \{ animation: skyStorePulse 600ms ease-out 1; \}/);
  });
});

describe("desktop: store pill + Stores tab share one store list, no store row", () => {
  function mountDesktop(over = {}) {
    const props = {
      products: [KOBE], searchResults: [KOBE], effectiveShop: "marathon-pe", availableShops: SHOPS.slice(1, 4),
      onSelectShop: () => {}, shopRegistry: null, search: "", setSearch: () => {}, onLabelFind: null, cart: [],
      onQuickAdd: () => 1, onRemoveOne: () => {}, onAddDisplayPartner: () => {}, onViewPhoto: () => {},
      onSwitchView: () => {}, userEmail: "a@b.c", mode: "sneaker", setMode: () => {},
      customerName: "", setCustomerName: () => {}, customerPhone: "", setCustomerPhone: () => {},
      marketingOptIn: true, setMarketingOptIn: () => {}, submitting: false, onPlaceOrder: async () => true,
      customerIndex: [], onPickCustomer: () => {}, onAddClothing: () => {}, onPlaceRefill: () => {},
      onOpenTracking: () => {}, trackingPending: 0, hubQty: () => 5, servingHubLabel: "Hub 1",
      sneakerOut: () => false, sneakerOutWhy: () => null, sneakerDisplayInfo: () => null,
      alternativesFor: () => null, deadForOrder: () => false, ...over,
    };
    let r;
    act(() => { r = TestRenderer.create(<AssistantDesktop {...props} />); });
    return r;
  }
  it("the pill opens the store list and a pick goes through the red confirm", () => {
    let picked = null;
    const r = mountDesktop({ onSelectShop: (id) => { picked = id; } });
    press(byTestId(r, "store-tag")[0]);
    expect(items(r)).toHaveLength(3);
    press(items(r)[2]);
    expect(picked).toBe(null);
    press(r.root.findAll((n) => n.type === "button" && n.children.includes("Yes, switch"))[0]);
    expect(picked).toBe("trophy");
  });
  it("the pill and the Stores tab never show two store lists at once", () => {
    const r = mountDesktop();
    press(byTestId(r, "store-tag")[0]);
    expect(items(r)).toHaveLength(3);
    press(byTestId(r, "nav-stores")[0]);
    expect(allItems(r)).toHaveLength(3);                                     // swapped, not doubled
    expect(byTestId(r, "store-tag")[0].props["aria-expanded"]).toBe(false);
  });
  it("no segmented rows on the page; the pill's Products group sets the mode", () => {
    let m = null;
    const r = mountDesktop({ setMode: (v) => { m = v; } });
    expect(r.root.findAll((n) => n.props?.role === "group" && ["Order for", "Product type"].includes(n.props["aria-label"]))).toHaveLength(0);
    // Laptop (Junid, 6 Nov): ONE small pill beside the account — store · type.
    expect(byTestId(r, "store-tag")[0].findAll((n) => n.type === "span")[0].children).toEqual(["Marathon PE · Sneakers"]);
    press(byTestId(r, "store-tag")[0]);
    press(items(r, "mode")[1]);
    expect(m).toBe("clothing");
  });
  it("no cart bar on desktop while the cart is empty", () => {
    expect(byTestId(mountDesktop(), "sky-cartbar")).toHaveLength(0);
  });
});
