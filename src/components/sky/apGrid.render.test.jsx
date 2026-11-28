// The phone/iPad order grid (AssistantPhone → ApGrid), Junid's recording of
// 27 Nov: cards never render empty (every card's name, price and + are drawn
// from the list at once, no content-visibility), only cards near the screen
// mount their photo, a photo once mounted stays, and the cards scroll in an
// area that starts BELOW the brand row (never under the logos or the search).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

vi.mock("../../offline/MirroredImg.jsx", () => ({ MirroredImg: ({ productId, src, ...rest }) => <img src={src} {...rest} /> }));

const observers = [];
beforeAll(() => {
  globalThis.window ??= globalThis;
  window.innerWidth = 390;
  window.addEventListener ??= () => {};
  window.removeEventListener ??= () => {};
  globalThis.IntersectionObserver = class {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.els = new Set(); observers.push(this); }
    observe(el) { this.els.add(el); }
    unobserve(el) { this.els.delete(el); }
    disconnect() { this.els.clear(); }
  };
});
afterAll(() => { delete globalThis.IntersectionObserver; });

const { default: AssistantPhone, CHUNK_ROWS, WINDOW_MARGIN, apColumns, chunkList } = await import("./AssistantPhone.jsx");
const SRC = readFileSync(new URL("./AssistantPhone.jsx", import.meta.url), "utf8");

const products = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `Sample sneaker ${i}`, retailPrice: 700 + i, sizes: ["8"], photoUrl: `/photo/${i}.jpg`, brand: "Nike" }));
const textOf = (n) => (typeof n === "string" ? n : (n.children || []).map(textOf).join(""));

function mount() {
  let r;
  act(() => {
    r = TestRenderer.create(
      <AssistantPhone mode="sneaker" shops={[]} effectiveShop="marathon-pe" shopLabel={() => "Marathon PE"} onShop={() => {}}
        search="" onSearch={() => {}} onScan={() => {}} products={products} selectedId={null} onOpen={() => {}}
        onExit={() => {}} brands={[["All", 100], ["Nike", 100]]} brand="All" onBrand={() => {}} />,
      { createNodeMock: (el) => ({
        getBoundingClientRect: () => ({ height: el.props?.["data-testid"] === "ap-brands-float" ? 50 : 120, width: 390, left: 0, right: 390, top: 0, bottom: 120 }),
        dataset: { chunk: el.props?.["data-chunk"] }, querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {}, scrollTo() {}, scrollLeft: 0, scrollTop: 0, scrollWidth: 390, clientWidth: 390,
        scrollHeight: 100000, clientHeight: 700, style: {}, classList: { add() {}, remove() {}, toggle() {} },
      }) });
  });
  return r;
}
const cards = (r) => r.root.findAll((n) => n.type === "article" && /\bap-card\b/.test(n.props.className || ""));

describe("the phone order grid", () => {
  it("chunks are whole rows of the CSS grid's columns", () => {
    expect([apColumns(390), apColumns(600), apColumns(820)]).toEqual([2, 3, 4]);
    expect(chunkList(products, 2 * CHUNK_ROWS).map((c) => c.length).slice(0, 2)).toEqual([8, 8]);
    expect(WINDOW_MARGIN).toBe("250% 0px");
  });

  it("every card draws its name and price from the list, and only the first chunks mount photos", async () => {
    vi.useFakeTimers();
    let r;
    try {
      r = mount();
      await act(async () => { for (let k = 0; k < 20; k++) vi.advanceTimersByTime(250); });
    } finally { vi.useRealTimers(); }
    const all = cards(r);
    expect(all).toHaveLength(100);
    for (const [i, c] of all.entries()) {
      expect(textOf(c)).toContain(`Sample sneaker ${i}`);
      expect(textOf(c)).toContain(`R${700 + i}`);
    }
    const on = all.filter((c) => c.props["data-photo"] === "on");
    expect(on).toHaveLength(3 * 2 * CHUNK_ROWS);          // INITIAL_LIVE chunks
    // no empty box outside the window: the stage holds a placeholder
    const off = all.find((c) => c.props["data-photo"] === "off");
    expect(off.findAll((n) => n.props?.className === "ap-waiting")).toHaveLength(1);
  });

  it("a chunk coming near turns its photos on and they stay on after it leaves", async () => {
    const r = mount();
    await act(async () => { await new Promise((res) => setTimeout(res, 50)); });
    const io = observers[observers.length - 1];
    expect(io.opts.rootMargin).toBe(WINDOW_MARGIN);
    const chunk6 = { dataset: { chunk: "6" } };
    await act(async () => { io.cb([{ target: chunk6, isIntersecting: true }]); await new Promise((res) => setTimeout(res, 50)); });
    const photosOn = () => cards(r).filter((c) => c.props["data-photo"] === "on").length;
    const withSix = photosOn();
    expect(withSix).toBeGreaterThan(3 * 2 * CHUNK_ROWS);
    await act(async () => { io.cb([{ target: chunk6, isIntersecting: false }]); await new Promise((res) => setTimeout(res, 50)); });
    expect(photosOn()).toBe(withSix);
  });

  it("the scroller starts below the brand row; cards keep the glass, never content-visibility", () => {
    const r = mount();
    const sc = r.root.find((n) => n.props?.["data-testid"] === "ap-scroll");
    expect(sc.props.style.paddingTop).toBe(11);
    expect(SRC).toContain("style={{ top: topH + brandsH, paddingTop: 11 }}");
    expect(SRC).toContain(".ap-root .ap-card{content-visibility:visible}");
    expect(SRC).not.toMatch(/data-lite/);
  });
});
