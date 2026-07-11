import { describe, it, expect } from "vitest";
import { buildOrderSlipsHtml } from "./orderSlip";
import { encode128B } from "./code128";

const order = (over = {}) => ({
  id: "042", productName: "Nike Tech Fleece", size: "M",
  customerName: "Thabo M.", placedStore: "central",
  createdAt: new Date("2026-07-11T08:40:00+02:00").getTime(), ...over,
});

describe("buildOrderSlipsHtml", () => {
  it("renders one slip per order with its number, product, size and ETA", () => {
    const html = buildOrderSlipsHtml([order()]);
    expect(html).toContain("042");
    expect(html).toContain("Nike Tech Fleece");
    expect(html).toContain("Size M");
    expect(html).toContain("~15 min");
    expect((html.match(/class="slip"/g) || []).length).toBe(1);
  });

  it("stacks multiple orders in one document with a tear divider between", () => {
    const html = buildOrderSlipsHtml([order(), order({ id: "043", productName: "adidas Samba" })]);
    expect((html.match(/class="slip"/g) || []).length).toBe(2);
    expect((html.match(/class="tear"/g) || []).length).toBe(1);
    expect(html).toContain("043");
  });

  it("honours a custom ETA", () => {
    expect(buildOrderSlipsHtml([order()], { etaMinutes: 20 })).toContain("~20 min");
  });

  it("escapes HTML in product/customer names (no markup injection)", () => {
    const html = buildOrderSlipsHtml([order({ productName: "<script>x</script>", customerName: "A&B" })]);
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A&amp;B");
  });

  it("maps a one-size / '_' sentinel to 'One size'", () => {
    expect(buildOrderSlipsHtml([order({ size: "_" })])).toContain("One size");
  });

  it("accepts a single order (not just an array)", () => {
    expect((buildOrderSlipsHtml(order()).match(/class="slip"/g) || []).length).toBe(1);
  });
});

describe("encode128B (barcode sanity)", () => {
  it("brackets the payload with Start-B (104) and Stop (106) + a checksum", () => {
    const v = encode128B("042");
    expect(v[0]).toBe(104);
    expect(v[v.length - 1]).toBe(106);
    expect(v.length).toBe(3 + 3); // start + 3 data + checksum + stop
  });
});
