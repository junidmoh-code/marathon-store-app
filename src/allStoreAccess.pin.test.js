// ─── ALL-STORE ACCESS — pins on App.jsx behaviour that has no export ─────────
// Run: npx vitest run src/allStoreAccess.pin.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const fnBody = (name, end) => APP.slice(APP.indexOf(name), APP.indexOf(end, APP.indexOf(name)));

describe("a shop switch never shows the previous shop's orders", () => {
  const body = fnBody("function useOrders(scopeShop = null, enabled = true) {", "// ─── TV ORDERS");
  it("every answer is tagged with the scope it was read for", () => {
    expect(body.match(/\{ settled: true \}/g)).toBeNull();
    expect(body.match(/\{ settled: true, scope: scopeShop \}/g).length).toBeGreaterThanOrEqual(4);
  });
  it("a different scope gets an empty UNSETTLED list until its own answer", () => {
    expect(body).toContain("if (orders.scope !== scopeShop) return pendingForScope;");
    expect(body).toContain("Object.assign([], { settled: false, scope: scopeShop })");
  });
  it("a refused read for a new scope does not keep the old shop's rows", () => {
    expect(body).toContain("Object.assign([], { settled: false, error: true, scope: scopeShop })");
  });
});

describe("the cart belongs to one shop", () => {
  it("a change of the active shop empties a non-empty cart and says so", () => {
    expect(APP).toContain("const cartShopRef = useRef(effectiveShop);");
    expect(APP).toMatch(/if \(prev === effectiveShop\) return;\s*\n\s*setCart\(\(c\) => \{/);
    expect(APP).toContain('data-testid="cart-cleared-note"');
  });
});
