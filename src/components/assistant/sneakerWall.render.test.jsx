// ─── SNEAKER WALL — rendered: Junid's touch rules hold ───────────────────────
// (Design signed off 2026-10-19.) Mounted for real through react-test-renderer
// with a live cart harness, so the order pill reads the SAME grouping the
// drawer does. Proves:
//   1. every tile is a <button> named by the product, and the resting tile
//      shows the photo only — no name, price or size pills
//   2. the FIRST tap opens the overlay and adds nothing
//   3. only one tile is open at a time
//   4. a size the gate says is out is disabled, struck, and adds nothing
//   5. a size tap adds through quickAdd and the order pill's count + total
//      update from the cart
//   6. a mouse opens a tile on hover; a touch "hover" does not
//   7. a zero add (quickAdd refused) leaves the count where it was

import { describe, it, expect, vi } from "vitest";
import React, { useMemo, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("../../offline/MirroredImg.jsx", () => ({
  MirroredImg: ({ productId, src, ...rest }) => <img src={src} data-pid={productId} {...rest} />,
}));
vi.mock("../stock/locations", () => ({ labelFor: (id) => ({ pe: "Marathon PE", pine: "Pine", trophy: "Trophy" }[id] || id) }));

const { default: SneakerWall } = await import("./SneakerWall.jsx");
const { groupOrderLines, orderLinesTotal } = await import("./assistantOrderModel");

const KOBE = { id: "pKobe", name: "Air Force 1 Low QS Kobe Yellow", brand: "Nike", retailPrice: 750, sizes: ["6", "7", "8", "10"], photoUrl: "https://x/kobe.jpg" };
const PANDA = { id: "pPanda", name: "Nike Dunk Low Panda", brand: "Nike", retailPrice: 1500, sizes: ["7", "9"], photoUrl: "https://x/panda.jpg" };
const PRODUCTS = [KOBE, PANDA];
const SHOPS = [{ id: "pe" }, { id: "pine" }, { id: "trophy" }];

// Kobe size 10 has no stock at the serving hub.
const sizeGate = {
  clothingOrder: false,
  hubQty: () => 0,
  sneakerOut: (p, sz) => p.id === "pKobe" && sz === "10",
  sneakerOutWhy: () => ({ booked: 0, hubLabel: "Hub 1" }),
  sneakerDisplayInfo: () => null,
  deadForOrder: () => false,
  hubLabelFor: () => "Hub 1",
};

function Harness({ refuse = false, quickAddSpy }) {
  const [cart, setCart] = useState([]);
  const grouped = useMemo(() => groupOrderLines(cart), [cart]);
  const units = grouped.reduce((s, g) => s + g.qty, 0);
  const onQuickAdd = (p, size, n) => {
    quickAddSpy?.(p, size, n);
    if (refuse) return 0;
    setCart(c => [...c, { product: p, size, productType: "sneaker" }]);
    return 1;
  };
  return (
    <SneakerWall availableShops={SHOPS} effectiveShop="pe" shopRegistry={null} onPickShop={() => {}}
                 mode="sneaker" setMode={() => {}} onSwitchView={() => {}} userEmail="a@b.c"
                 search="" setSearch={() => {}} searchRef={{ current: null }} onLabelFind={() => {}}
                 shownCount={PRODUCTS.length} visible={PRODUCTS} onShowMore={() => {}}
                 sizeGate={sizeGate} onQuickAdd={onQuickAdd} onOpenDetails={() => {}} onViewPhoto={() => {}}
                 grouped={grouped} units={units} total={orderLinesTotal(grouped)}
                 onRemoveOne={() => {}} onAddDisplayPartner={() => {}} onCheckout={() => {}} />
  );
}

function mount(props = {}) {
  let tr;
  act(() => { tr = TestRenderer.create(<Harness {...props} />); });
  return tr;
}
const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(""));
const tileButton = (tr, name) => tr.root.find(n => n.type === "button" && n.props.className === "sw-tbtn" && n.props["aria-label"] === name);
const tileOf = (tr, name) => tileButton(tr, name).parent;
const sizePills = (tr) => tr.root.findAll(n => n.type === "button" && n.props.className === "sw-sz");
const pill = (tr, label) => sizePills(tr).find(n => textIn(n) === label);
const openTiles = (tr) => tr.root.findAll(n => n.type === "div" && n.props.className === "sw-tile" && n.props["data-open"] === true);
const count = (tr) => textIn(tr.root.find(n => n.props["data-testid"] === "order-count"));
const total = (tr) => textIn(tr.root.find(n => n.props["data-testid"] === "order-total"));
const tap = (node) => act(() => { node.props.onClick({ currentTarget: { classList: { add() {}, remove() {} } } }); });

describe("the resting wall", () => {
  it("draws every product as a real button named by the product, photo only", () => {
    const tr = mount();
    expect(tileButton(tr, KOBE.name)).toBeTruthy();
    expect(tileButton(tr, PANDA.name)).toBeTruthy();
    // No overlay anywhere: no size pills, no price, no visible name text.
    expect(sizePills(tr)).toHaveLength(0);
    expect(openTiles(tr)).toHaveLength(0);
    const tiles = tr.root.findAll(n => n.type === "div" && n.props.className === "sw-tile");
    for (const t of tiles) {
      expect(textIn(t)).not.toContain("R750");
      expect(textIn(t)).not.toContain(KOBE.name);
    }
  });
  it("the store chips replace the sidebar, the selected one pressed", () => {
    const tr = mount();
    const chips = tr.root.findAll(n => n.type === "button" && n.props.className === "sw-chip");
    expect(chips.map(textIn)).toEqual(["Marathon PE", "Pine", "Trophy"]);
    expect(chips.map(c => c.props["aria-pressed"])).toEqual([true, false, false]);
  });
});

describe("touch: the first tap opens, it never adds", () => {
  it("tapping a tile opens its overlay with name, price and sizes — and adds nothing", () => {
    const spy = vi.fn();
    const tr = mount({ quickAddSpy: spy });
    tap(tileButton(tr, KOBE.name));
    expect(spy).not.toHaveBeenCalled();
    expect(openTiles(tr)).toHaveLength(1);
    const t = tileOf(tr, KOBE.name);
    expect(textIn(t)).toContain(KOBE.name);
    expect(textIn(t)).toContain("750");
    expect(sizePills(tr).map(textIn)).toEqual(["6", "7", "8", "10"]);
    expect(count(tr)).toBe("0");
  });
});

describe("only one tile is open at a time", () => {
  it("opening a second tile closes the first", () => {
    const tr = mount();
    tap(tileButton(tr, KOBE.name));
    tap(tileButton(tr, PANDA.name));
    expect(openTiles(tr)).toHaveLength(1);
    expect(tileOf(tr, PANDA.name).props["data-open"]).toBe(true);
    expect(tileOf(tr, KOBE.name).props["data-open"]).toBe(false);
    // Panda's sizes, not Kobe's.
    expect(sizePills(tr).map(textIn)).toEqual(["7", "9"]);
  });
  it("a mouse opens on hover and closes on leave; a touch pointerenter does not open", () => {
    const tr = mount();
    act(() => { tileOf(tr, PANDA.name).props.onPointerEnter({ pointerType: "touch" }); });
    expect(openTiles(tr)).toHaveLength(0);
    act(() => { tileOf(tr, PANDA.name).props.onPointerEnter({ pointerType: "mouse" }); });
    expect(tileOf(tr, PANDA.name).props["data-open"]).toBe(true);
    act(() => { tileOf(tr, KOBE.name).props.onPointerEnter({ pointerType: "mouse" }); });
    expect(openTiles(tr)).toHaveLength(1);
    expect(tileOf(tr, KOBE.name).props["data-open"]).toBe(true);
    act(() => { tileOf(tr, KOBE.name).props.onPointerLeave({ pointerType: "mouse" }); });
    expect(openTiles(tr)).toHaveLength(0);
  });
});

describe("a size with no stock is not tappable", () => {
  it("is disabled, says why, and a tap adds nothing", () => {
    const spy = vi.fn();
    const tr = mount({ quickAddSpy: spy });
    tap(tileButton(tr, KOBE.name));
    const ten = pill(tr, "10");
    expect(ten.props.disabled).toBe(true);
    expect(ten.props["aria-label"]).toBe("Size 10, not available");
    expect(ten.props.title).toContain("Size 10 isn't available at Hub 1");
    tap(ten);
    expect(spy).not.toHaveBeenCalled();
    expect(count(tr)).toBe("0");
    // The in-stock neighbours are live buttons.
    expect(pill(tr, "8").props.disabled).toBe(false);
  });
  it("the struck-through style belongs to the disabled state", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./SneakerWall.jsx", import.meta.url), "utf8");
    expect(css).toMatch(/\.sw-sz:disabled\{[^}]*color:#6e6e78[^}]*text-decoration:line-through[^}]*cursor:not-allowed/);
  });
});

describe("the order pill follows the cart", () => {
  it("a size tap adds through quickAdd and the count and total update", () => {
    const spy = vi.fn();
    const tr = mount({ quickAddSpy: spy });
    expect(count(tr)).toBe("0");
    expect(total(tr)).toBe("R0");
    tap(tileButton(tr, KOBE.name));
    tap(pill(tr, "8"));
    expect(spy).toHaveBeenCalledWith(KOBE, "8", 1);
    expect(count(tr)).toBe("1");
    expect(total(tr)).toBe("R750");
    tap(pill(tr, "8"));
    tap(tileButton(tr, PANDA.name));
    tap(pill(tr, "9"));
    expect(count(tr)).toBe("3");
    // en-ZA groups thousands with a (no-break) space: R3 000.
    expect(total(tr).replace(/\s/g, " ")).toBe("R3 000");
  });
  it("a refused add (quickAdd → 0) leaves the pill where it was", () => {
    const tr = mount({ refuse: true });
    tap(tileButton(tr, KOBE.name));
    tap(pill(tr, "8"));
    expect(count(tr)).toBe("0");
    expect(total(tr)).toBe("R0");
  });
  it("tapping the pill opens the order drawer with the same Place order button", () => {
    const tr = mount();
    tap(tileButton(tr, KOBE.name));
    tap(pill(tr, "6"));
    tap(tr.root.find(n => n.type === "button" && n.props.className === "sw-pill"));
    const drawer = tr.root.find(n => n.type === "aside" && n.props.className === "sw-drawer");
    expect(textIn(drawer)).toContain(KOBE.name);
    const place = drawer.find(n => n.type === "button" && n.props.className === "ad-place");
    expect(place.props.disabled).toBe(false);
    act(() => { drawer.find(n => n.type === "button" && n.props["aria-label"] === "Close order").props.onClick(); });
    expect(tr.root.findAll(n => n.type === "aside" && n.props.className === "sw-drawer")).toHaveLength(0);
  });
});
