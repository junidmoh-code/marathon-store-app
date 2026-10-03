// THE product price save — one copy for the admin product page, the Marketing
// card's Edit price, Missing prices (its write) and the New Arrivals card.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("./priceStore", () => ({ applyPriceBatch: vi.fn() }));
import { saveProductPrices, planProductPriceEdit } from "./productPriceSave";

const P = { id: "p1", name: "AF1", stockPrice: 550, retailPrice: 650 };
const okApply = () => vi.fn(async () => ({ ok: true, count: 1, batchId: "pb_1" }));

describe("saveProductPrices", () => {
  it("changes BOTH existing prices in one single_edit batch, from = the stored values", async () => {
    const apply = okApply();
    const r = await saveProductPrices(P, { stockPrice: "500", retailPrice: "799" }, { apply, label: "New Arrivals: AF1" });
    expect(r).toEqual({ ok: true, count: 1, batchId: "pb_1" });
    expect(apply).toHaveBeenCalledWith({
      action: "single_edit", label: "New Arrivals: AF1",
      lines: { p1: { name: "AF1", from: { stockPrice: 550, retailPrice: 650 }, to: { stockPrice: 500, retailPrice: 799 } } },
    });
  });

  it("fills a missing price; an unchanged or absent field is not written; nothing changed → no batch", async () => {
    const apply = okApply();
    await saveProductPrices({ ...P, stockPrice: null }, { stockPrice: "400", retailPrice: "650" }, { apply });
    expect(apply.mock.calls[0][0].lines.p1).toEqual({ name: "AF1", from: { stockPrice: null }, to: { stockPrice: 400 } });
    expect(apply.mock.calls[0][0].label).toBe("Edit: AF1");
    expect(await saveProductPrices(P, { stockPrice: "550" }, { apply })).toEqual({ ok: true, count: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("'' clears (the admin page's explicit clear); 0, negatives and junk are refused", async () => {
    const apply = okApply();
    await saveProductPrices(P, { retailPrice: "" }, { apply });
    expect(apply.mock.calls[0][0].lines.p1.to).toEqual({ retailPrice: null });
    for (const bad of ["0", "-5", "abc"]) {
      expect(await saveProductPrices(P, { stockPrice: bad }, { apply })).toEqual({ ok: false, error: "Stock price must be a number above 0 (or empty to clear)." });
    }
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("retail below the resulting stock price needs a yes", async () => {
    const apply = okApply();
    const r = await saveProductPrices(P, { stockPrice: "700" }, { apply });
    expect(r).toEqual({ ok: false, needsConfirm: true, error: "Retail Price (R650) is lower than Stock Price (R700). Continue?" });
    expect(apply).not.toHaveBeenCalled();
    expect((await saveProductPrices(P, { stockPrice: "700" }, { apply, confirmed: true })).ok).toBe(true);
    expect(planProductPriceEdit(P, { retailPrice: "500" }).belowCost).toBe(true);
    expect(planProductPriceEdit({ ...P, stockPrice: null }, { retailPrice: "500" }).belowCost).toBe(false);
  });

  it("a refused batch (on special) comes back in words, with its code", async () => {
    const apply = vi.fn(async () => ({ ok: false, code: "on_special", message: "1 selected product is on special — end the special first, then reprice." }));
    expect(await saveProductPrices(P, { retailPrice: "700" }, { apply })).toEqual({ ok: false, code: "on_special", error: "1 selected product is on special — end the special first, then reprice." });
  });
});

describe("ONE copy: every price editor saves through saveProductPrices", () => {
  const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  it.each([
    ["admin product page", "../../App.jsx"],
    ["Marketing Edit price", "../stock/MarketingView.jsx"],
    ["Missing prices", "./missingPriceSave.js"],
    ["New Arrivals card", "../newArrivals/newArrivalsApi.js"],
  ])("%s", (_, f) => {
    const s = src(f);
    expect(s).toMatch(/saveProductPrices\(/);
    expect(s).not.toMatch(/action:\s*"single_edit"/);
  });
});
