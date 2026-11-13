import { describe, it, expect } from "vitest";
import { rrpFor, rrpOffPct, rrpDiscountPctOf, formatRands, rrpPreview, RRP_DISCOUNT_CHOICES } from "./shopifyRrp.js";

describe("rrpFor", () => {
  it("no usable price → null (no RRP shown)", () => {
    for (const v of [0, null, undefined, NaN, "", "abc", -5, Infinity, true, false, {}]) {
      expect(rrpFor(v)).toBeNull();
    }
  });

  it("the worked examples: R199 → R599, R629 → R1,799", () => {
    expect(rrpFor(199)).toBe(599);
    expect(rrpFor(629)).toBe(1799);
    expect(rrpFor("629.00")).toBe(1799);
  });

  it("70% uses price / 0.30 with the same rounding", () => {
    expect(rrpFor(199, 70)).toBe(699); // 663.33 → 699
    expect(rrpFor(629, 70)).toBe(2099); // 2096.67 → 2099
    expect(rrpFor(450, 70)).toBe(1599); // exactly 1500 → 1599
  });

  it("an unknown discount falls back to 65%", () => {
    expect(rrpFor(629, 50)).toBe(rrpFor(629, 65));
    expect(rrpFor(629, "70")).toBe(rrpFor(629, 70));
  });

  it("boundaries land on the right side: an exact …99 minimum is kept, one cent over goes up", () => {
    // 349.65 / 0.35 = 999 exactly → 999 stays.
    expect(rrpFor(349.65)).toBe(999);
    expect(rrpFor(349.66)).toBe(1099);
    // 0.35 × 1799 = 629.65 — the most a R1,799 RRP can carry at 65%.
    expect(rrpFor(629.65)).toBe(1799);
    expect(rrpFor(629.66)).toBe(1899);
  });

  it("over every price R1–R20,000 (and cents): > price, ends in 99, ≥ the discount, the smallest such", () => {
    for (const pct of RRP_DISCOUNT_CHOICES) {
      const keep = (100 - pct) / 100;
      for (let cents = 100; cents <= 2_000_000; cents += cents < 10_000 ? 1 : 37) {
        const price = cents / 100;
        const rrp = rrpFor(price, pct);
        expect(Number.isInteger(rrp)).toBe(true);
        expect(rrp % 100).toBe(99);
        expect(rrp).toBeGreaterThan(price);
        // saving ≥ pct, checked in integer cents
        expect(rrp * (100 - pct)).toBeGreaterThanOrEqual(cents);
        // and the next lower …99 would NOT give the discount
        expect((rrp - 100) * keep * 100).toBeLessThan(cents + 1e-6);
      }
    }
  });
});

describe("rrpOffPct", () => {
  it("rounds DOWN — never claims more than the real saving", () => {
    expect(rrpOffPct(629, 1799)).toBe(65); // 65.03
    expect(rrpOffPct(199, 599)).toBe(66); // 66.78
  });
  it("null when there is no saving or no price", () => {
    expect(rrpOffPct(0, 599)).toBeNull();
    expect(rrpOffPct(600, 599)).toBeNull();
    expect(rrpOffPct(599, 599)).toBeNull();
    expect(rrpOffPct(100, null)).toBeNull();
  });
  it("every rrpFor result shows at least its discount", () => {
    for (const pct of RRP_DISCOUNT_CHOICES) {
      for (let p = 1; p < 30000; p += 7) expect(rrpOffPct(p, rrpFor(p, pct))).toBeGreaterThanOrEqual(pct);
    }
  });
});

describe("rrpDiscountPctOf", () => {
  it("absent or invalid → 65; 70 only when set", () => {
    expect(rrpDiscountPctOf(null)).toBe(65);
    expect(rrpDiscountPctOf({})).toBe(65);
    expect(rrpDiscountPctOf({ rrpDiscountPct: 50 })).toBe(65);
    expect(rrpDiscountPctOf({ rrpDiscountPct: "x" })).toBe(65);
    expect(rrpDiscountPctOf({ rrpDiscountPct: 70 })).toBe(70);
    expect(rrpDiscountPctOf({ rrpDiscountPct: 65 })).toBe(65);
  });
});

describe("formatRands", () => {
  it("formats with a thousands comma", () => {
    expect(formatRands(1799)).toBe("R1,799");
    expect(formatRands(599)).toBe("R599");
  });
});

describe("rrpPreview — the chip's line", () => {
  it("reads like the website", () => {
    expect(rrpPreview(629).label).toBe("RRP R1,799 · 65% off");
    expect(rrpPreview(629, 70).label).toBe("RRP R2,099 · 70% off");
    expect(rrpPreview(0)).toBeNull();
  });
});
