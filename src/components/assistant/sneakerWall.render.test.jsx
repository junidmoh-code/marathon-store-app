// ─── SNEAKER WALL — rendered: Junid's round-3 tap rule holds ────────────────
// (Design signed off 2026-10-19; round 3 the same day.) Mounted for real
// through react-test-renderer. Proves:
//   1. every tile is ONE <button> named by the product holding the photo and
//      nothing else — no child controls, no text, no hover state but a ring
//   2. a single tap opens the product popup (onOpenDetails) and adds nothing;
//      no double-tap handler delays it
//   3. Escape: the popup's own handler closes it; the wall's yields to it
//   4. the popup's large photo opens the lightbox; the ⋯ actions moved into
//      the popup header
//   5. the tile draws the full-resolution photoUrl the lightbox opens — the
//      mirrored 300px thumbnail only as the offline fallback (item 2)
//   6. the order pill and drawer still follow the cart

import { describe, it, expect, vi } from "vitest";
import React, { useMemo, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("../../offline/MirroredImg.jsx", () => ({
  MirroredImg: ({ productId, src, ...rest }) => <img src={src} data-mirrored={productId} {...rest} />,
}));
vi.mock("../stock/locations", () => ({ labelFor: (id) => ({ pe: "Marathon PE", pine: "Pine", trophy: "Trophy" }[id] || id) }));

const { default: SneakerWall, tilePhotoSrc, TilePhoto } = await import("./SneakerWall.jsx");
const { groupOrderLines, orderLinesTotal } = await import("./assistantOrderModel");
const WALL = readFileSync(new URL("./SneakerWall.jsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

const KOBE = { id: "pKobe", name: "Air Force 1 Low QS Kobe Yellow", brand: "Nike", retailPrice: 750, sizes: ["6", "7", "8", "10"], photoUrl: "https://firebasestorage.googleapis.com/v0/b/b/o/products%2FpKobe%2Fphoto.jpg?alt=media&token=t" };
const PANDA = { id: "pPanda", name: "Nike Dunk Low Panda", brand: "Nike", retailPrice: 1500, sizes: ["7", "9"], photoUrl: "https://x/panda.jpg" };
const BARE = { id: "pBare", name: "No Photo Runner", brand: "Nike", retailPrice: 500, sizes: ["8"] };
const PRODUCTS = [KOBE, PANDA, BARE];
const SHOPS = [{ id: "pe" }, { id: "pine" }, { id: "trophy" }];

function Harness({ onOpenDetails = () => {}, quickAddSpy, initialCart = [] }) {
  const [cart, setCart] = useState(initialCart);
  const grouped = useMemo(() => groupOrderLines(cart), [cart]);
  const units = grouped.reduce((s, g) => s + g.qty, 0);
  const onQuickAdd = (p, size, n) => { quickAddSpy?.(p, size, n); setCart(c => [...c, { product: p, size, productType: "sneaker" }]); return 1; };
  return (
    <SneakerWall availableShops={SHOPS} effectiveShop="pe" shopRegistry={null} onPickShop={() => {}}
                 mode="sneaker" setMode={() => {}} onSwitchView={() => {}} userEmail="a@b.c"
                 search="" setSearch={() => {}} searchRef={{ current: null }} onLabelFind={() => {}}
                 shownCount={PRODUCTS.length} visible={PRODUCTS} onShowMore={() => {}}
                 onQuickAdd={onQuickAdd} onOpenDetails={onOpenDetails}
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
const tiles = (tr) => tr.root.findAll(n => n.type === "button" && n.props.className === "sw-tile");
const tile = (tr, name) => tiles(tr).find(n => n.props["aria-label"] === name);
const count = (tr) => textIn(tr.root.find(n => n.props["data-testid"] === "order-count"));
const total = (tr) => textIn(tr.root.find(n => n.props["data-testid"] === "order-total"));
const click = (node) => act(() => { node.props.onClick({ currentTarget: {} }); });

describe("a tile is the photo and nothing else", () => {
  it("one real button per product, named by it, with no child controls and no text", () => {
    const tr = mount();
    expect(tiles(tr)).toHaveLength(3);
    for (const p of [KOBE, PANDA]) {
      const t = tile(tr, p.name);
      expect(t.props.type).toBe("button");                       // Enter/Space open it natively
      expect(t.findAll(n => n !== t && ["button", "a", "input", "select"].includes(n.type))).toHaveLength(0);
      expect(t.findAll(n => n.type === "img")).toHaveLength(1);
      expect(textIn(t)).toBe("");                                  // no name, price or size
    }
    // Nothing else on the wall is a per-product control: no ⓘ, ⋯ or zoom.
    expect(tr.root.findAll(n => n.type === "button" && /sw-(ib|sz|tbtn)|ad-zoom/.test(n.props.className || ""))).toHaveLength(0);
    expect(tr.root.findAll(n => /^(More about|Enlarge photo|Actions for)/.test(n.props["aria-label"] || ""))).toHaveLength(0);
  });
  it("has no hover or touch state in code — only the 2px accent ring in CSS — and no double-tap", () => {
    const t = tile(mount(), KOBE.name);
    for (const k of ["onPointerEnter", "onPointerLeave", "onMouseEnter", "onFocus", "onDoubleClick", "onTouchEnd"]) expect(t.props[k]).toBeUndefined();
    expect(WALL).toContain(".sw-tile:hover::after,.sw-tile:focus-visible::after{box-shadow:inset 0 0 0 2px #5b63ff}");
    expect(WALL).not.toMatch(/sw-ov|sw-szrow|sw-tools|data-open/);
  });
  it("a product without a photo shows its name on the dark ground", () => {
    expect(textIn(tile(mount(), BARE.name))).toBe(BARE.name);
  });
});

describe("a single tap opens the popup", () => {
  it("calls onOpenDetails once with that product and adds nothing", () => {
    const open = vi.fn(); const spy = vi.fn();
    const tr = mount({ onOpenDetails: open, quickAddSpy: spy });
    click(tile(tr, PANDA.name));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(PANDA);
    expect(spy).not.toHaveBeenCalled();
    expect(count(tr)).toBe("0");
  });
  it("the host wires the tap to the product popup (openQv)", () => {
    expect(APP).toMatch(/<SneakerWall[\s\S]*?onQuickAdd=\{onQuickAdd\} onOpenDetails=\{openQv\}/);
    expect(APP).not.toContain("renderTileActions");
    expect(APP).not.toContain("onOutSize=");
  });
});

describe("the popup's own behaviour", () => {
  it("Escape closes it; the wall's Escape yields while it is open", () => {
    expect(APP).toContain('if (e.key === "Escape") setQv(null);');
    expect(APP).toContain("modalOpen={!!qv || coOpen || !!pendingShop}");
    expect(WALL).toContain('if (e.key !== "Escape" || modalOpen) return;');
  });
  it("its large photo opens the full-screen lightbox", () => {
    expect(APP).toContain('<div className="ad-svimg" onClick={() => qv.photoUrl && onViewPhoto(productPhotos(qv))}');
  });
  it("the deactivate / merge ⋯ sits in its header, on the wall", () => {
    expect(APP).toContain('{wall && <div className="ad-svacts"><ProductActionsButton product={qv} products={products} /></div>}');
  });
});

describe("full-resolution tile photos (item 2)", () => {
  it("the tile URL is the product's own photoUrl — what the lightbox opens — never the 300px thumbnail", () => {
    expect(tilePhotoSrc(KOBE)).toBe(KOBE.photoUrl);
    expect(tilePhotoSrc(KOBE)).not.toMatch(/thumb_300/);
    expect(tilePhotoSrc(BARE)).toBeNull();
    // The lightbox's list starts with the same URL.
    expect(APP).toContain("if (p?.photoUrl) out.push(p.photoUrl);");
  });
  it("the rendered <img> loads it directly — lazy, async — not through the photo mirror", () => {
    const img = tile(mount(), KOBE.name).find(n => n.type === "img");
    expect(img.props.src).toBe(KOBE.photoUrl);
    expect(img.props["data-mirrored"]).toBeUndefined();
    expect(img.props.loading).toBe("lazy");
    expect(img.props.decoding).toBe("async");
  });
  it("offline: a failed original drops to the cached thumbnail, then to the name", () => {
    let tr;
    act(() => { tr = TestRenderer.create(<TilePhoto p={KOBE} />); });
    act(() => { tr.root.find(n => n.type === "img").props.onError(); });
    const thumb = tr.root.find(n => n.type === "img");
    expect(thumb.props["data-mirrored"]).toBe("pKobe");
    act(() => { thumb.props.onError(); });
    expect(tr.root.findAll(n => n.type === "img")).toHaveLength(0);
    expect(textIn(tr.root.find(n => n.props.className === "sw-noimg"))).toBe(KOBE.name);
  });
  it("the popup's photo is full-resolution too", () => {
    expect(APP).toContain("? <HiResPhoto key={`${qv.id}|${qv.photoUrl || \"\"}`} p={qv} alt={qv.name}");
  });
});

describe("compact bar, five columns, three full rows (Junid, 2026-10-19)", () => {
  it("the CSS geometry gives three complete rows at 1440×900 and 1280×800", () => {
    const css = WALL;
    expect(css).toMatch(/\.sw-top\{[^}]*height:44px;box-sizing:content-box;padding:12px 16px/);
    expect(css).toMatch(/\.sw-grid\{display:grid;grid-template-columns:repeat\(5,minmax\(0,1fr\)\);gap:10px\}/);
    expect(css).toMatch(/\.sw-tile\{[^}]*aspect-ratio:5\/4/);
    expect(css).toMatch(/\.sw-scroll\{[^}]*padding:0 16px 16px/);
    // bar 68 + three rows + two gaps must fit the viewport height.
    const rows3 = (w, cols) => 68 + 3 * ((w - 32 - 10 * (cols - 1)) / cols) * 0.8 + 20;
    expect(rows3(1440, 5)).toBeLessThanOrEqual(900);
    expect(rows3(1280, 5)).toBeLessThanOrEqual(800);
    expect(css).toMatch(/@media\(max-width:1199px\)\{\.sw-grid\{grid-template-columns:repeat\(4/);
  });
});

describe("the order pill follows the cart", () => {
  it("reads the cart's count and total", () => {
    const tr = mount({ initialCart: [{ product: KOBE, size: "8", productType: "sneaker" }, { product: PANDA, size: "9", productType: "sneaker" }] });
    expect(count(tr)).toBe("2");
    expect(total(tr).replace(/\s/g, " ")).toBe("R2 250");
  });
  it("tapping the pill opens the order drawer with the same Place order button", () => {
    const tr = mount({ initialCart: [{ product: KOBE, size: "6", productType: "sneaker" }] });
    click(tr.root.find(n => n.type === "button" && n.props.className === "sw-pill"));
    const drawer = tr.root.find(n => n.type === "aside" && n.props.className === "sw-drawer");
    expect(textIn(drawer)).toContain(KOBE.name);
    const place = drawer.find(n => n.type === "button" && n.props.className === "ad-place");
    expect(place.props.disabled).toBe(false);
    act(() => { drawer.find(n => n.type === "button" && n.props["aria-label"] === "Close order").props.onClick(); });
    expect(tr.root.findAll(n => n.type === "aside" && n.props.className === "sw-drawer")).toHaveLength(0);
  });
});
