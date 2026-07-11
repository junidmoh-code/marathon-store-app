import { describe, it, expect } from "vitest";
import { buildOrderSlipsHtml } from "./orderSlip";

const order = (over = {}) => ({
  id: "042", productName: "Nike Tech Fleece", size: "M",
  customerName: "Thabo M.", placedStore: "central",
  createdAt: new Date("2026-07-11T08:40:00+02:00").getTime(), ...over,
});

describe("buildOrderSlipsHtml", () => {
  it("renders one slip per order with its number, product and size", () => {
    const html = buildOrderSlipsHtml([order()]);
    expect(html).toContain("042");
    expect(html).toContain("Nike Tech Fleece");
    expect(html).toContain("Size M");
    expect((html.match(/class="slip"/g) || []).length).toBe(1);
  });

  it("folds the wait time quietly into the thank-you text (no prominent badge)", () => {
    const html = buildOrderSlipsHtml([order()]);
    expect(html).toContain("about 15 minutes");
    expect(html).not.toContain("Ready in");   // no prominent ETA pill
  });

  it("has no barcode and no hand emoji", () => {
    const html = buildOrderSlipsHtml([order()]);
    expect(html).not.toContain('class="barcode"');
    expect(html).not.toContain("🙏");
  });

  it("stacks multiple orders in one document with a tear divider between", () => {
    const html = buildOrderSlipsHtml([order(), order({ id: "043", productName: "adidas Samba" })]);
    expect((html.match(/class="slip"/g) || []).length).toBe(2);
    expect((html.match(/class="tear"/g) || []).length).toBe(1);
    expect(html).toContain("043");
  });

  it("honours a custom ETA", () => {
    expect(buildOrderSlipsHtml([order()], { etaMinutes: 20 })).toContain("about 20 minutes");
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
