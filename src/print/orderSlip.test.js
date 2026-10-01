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
    expect(html).toContain("up to <b>15 minutes</b>");
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
    expect(buildOrderSlipsHtml([order()], { etaMinutes: 20 })).toContain("up to <b>20 minutes</b>");
  });

  it("escapes HTML in product/customer names (no markup injection)", () => {
    const html = buildOrderSlipsHtml([order({ productName: "<script>x</script>", customerName: "A&B" })]);
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A&amp;B");
  });

  it("prints for a thermal head: no greys, no light weights, no hairlines", () => {
    const html = buildOrderSlipsHtml([order()]);
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(css).not.toMatch(/color:\s*#(?!000\b|fff\b)[0-9a-f]{3,6}\b/i);
    expect(css).not.toMatch(/font-weight:\s*[1-5]00\b/);
    expect(css).not.toMatch(/opacity:\s*0/);
    for (const [, mm] of css.matchAll(/border(?:-top|-bottom)?:\s*([\d.]+)mm/g)) expect(Number(mm)).toBeGreaterThanOrEqual(0.5);
    for (const [, w] of html.matchAll(/stroke-width="([\d.]+)"/g)) expect(Number(w)).toBeGreaterThanOrEqual(2.6);
  });

  it("shrinks long numbers so they never overflow the 72mm slip", () => {
    expect(buildOrderSlipsHtml([order({ id: "342" })])).toContain('class="number"');
    expect(buildOrderSlipsHtml([order({ id: "1042" })])).toContain('class="number long"');
    expect(buildOrderSlipsHtml([order({ id: "10420" })])).toContain('class="number long"');
    expect(buildOrderSlipsHtml([order({ id: "104200" })])).toContain('class="number xlong"');
  });

  it("maps a one-size / '_' sentinel to 'One size'", () => {
    expect(buildOrderSlipsHtml([order({ size: "_" })])).toContain("One size");
  });

  it("accepts a single order (not just an array)", () => {
    expect((buildOrderSlipsHtml(order()).match(/class="slip"/g) || []).length).toBe(1);
  });
});
