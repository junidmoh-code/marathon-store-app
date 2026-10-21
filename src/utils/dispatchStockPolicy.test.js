// A WEBSITE hub order can never deduct twice: Mark as Sent moves no stock for
// it (clothing or footwear), so the POS Pack is its one deduction.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchSkipsStock } from "./dispatchStockPolicy";

describe("dispatchSkipsStock", () => {
  it("skips every website order — sneaker or clothing, whatever the catalogue says", () => {
    expect(dispatchSkipsStock({ channel: "online", productType: "sneaker" })).toBe("online_order_deducts_at_pack");
    expect(dispatchSkipsStock({ channel: "online", productType: "clothing" })).toBe("online_order_deducts_at_pack");
  });
  it("leaves every shop order exactly as before", () => {
    expect(dispatchSkipsStock({ customerName: "Thabo", productType: "clothing" })).toBeNull();
    expect(dispatchSkipsStock({ channel: "pos" })).toBeNull();
    expect(dispatchSkipsStock(null)).toBeNull();
  });
});

describe("Mark as Sent consults it FIRST", () => {
  const app = readFileSync(join(process.cwd(), "src", "App.jsx"), "utf8");
  const fn = app.match(/const recordDispatchTransfer = async \(order, sentSize\) => \{[\s\S]*?\n {2}\};/)?.[0] || "";
  it("before the footwear gate and before any applyMovement", () => {
    expect(fn).not.toBe("");
    const skipAt = fn.indexOf("dispatchSkipsStock(order)");
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(fn.indexOf("isFootwearLine("));
    const move = fn.indexOf("applyMovement");
    expect(move === -1 || skipAt < move).toBe(true);
    expect(fn).toMatch(/if \(skip\) return \{ moved: false, reason: skip, skipped: true \};/);
  });
});
