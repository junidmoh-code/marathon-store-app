// ─── MISSING PRODUCTS — ITS OWN TILE AND ROUTE; THE OLD WAY IN LEADS THERE ───
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMissingProductsHash, MISSING_PRODUCTS_ROLE } from "./missingProductsRoute";

const APP = readFileSync(join(process.cwd(), "src", "App.jsx"), "utf8");
const HEALTH = readFileSync(join(process.cwd(), "src", "components", "stock", "HealthView.jsx"), "utf8");

describe("isMissingProductsHash", () => {
  it("knows the new link and the old one under Inventory Health", () => {
    for (const h of ["#missing-products", "#/missing-products", "#health/missing-products", "#inventory-health/missing-products", "#Health/Missing-Products", "#health/missingProducts", "#missing-products/"]) {
      expect(isMissingProductsHash(h), h).toBe(true);
    }
  });
  it("is not fooled by anything else", () => {
    for (const h of ["", null, undefined, "#health", "#admin", "#missing-sizes", "#health/missing-sizes", "#product/missing-products", "#missing-products-x", "missing-products"]) {
      expect(isMissingProductsHash(h), String(h)).toBe(false);
    }
  });
});

describe("App wiring", () => {
  it("the role, the home tile, the route and the access gate — same access as Inventory Health", () => {
    expect(APP).toContain(`MISSING_PRODUCTS: "${MISSING_PRODUCTS_ROLE}"`);
    expect(APP).toMatch(/canAccessStock\s+&& \{ key:"missing_products", icon:RoleIcons\.missing_products, name:"Missing Products",[^}]*onSelect\(ROLES\.MISSING_PRODUCTS\) \}/);
    expect(APP).toContain("else if (role === ROLES.MISSING_PRODUCTS) view = canAccessStock ? <MissingProductsScreen products={products} onExit={() => setRole(null)} /> : null;");
    // a stored role cannot outlive the stock role that opened it
    expect(APP).toMatch(/role === ROLES\.HEALTH \|\| role === ROLES\.MISSING_PRODUCTS \|\|[^)]*\) && !canAccessStock\) \{ setRole\(null\); return; \}/);
  });
  it("an old Inventory Health link redirects: the hash opens the screen, once access is known, and is replaced (Back does not bounce)", () => {
    const at = APP.indexOf("if (!isMissingProductsHash(hash) || !canAccessStock) return;");
    expect(at).toBeGreaterThan(-1);
    const effect = APP.slice(at, at + 320);
    expect(effect).toContain("setRole(ROLES.MISSING_PRODUCTS);");
    expect(effect).toContain('window.history.replaceState(null, "", window.location.pathname + window.location.search);');
    expect(effect).toContain('setHash("");');
    expect(effect).toContain("}, [hash, canAccessStock]);");
    expect(effect).not.toContain('window.location.hash = ""');
  });
  it("Inventory Health no longer has the tab — its tile takes you to the screen", () => {
    expect(APP).toContain("onOpenMissingProducts={() => setRole(ROLES.MISSING_PRODUCTS)}");
    expect(HEALTH).toMatch(/<StatCard label="Missing Products"[\s\S]{0,200}onClick=\{onOpenMissingProducts \|\| undefined\}/);
    expect(HEALTH).not.toContain('case "missingProducts"');
    expect(HEALTH).not.toContain('setScreen("missingProducts")');
  });
});
