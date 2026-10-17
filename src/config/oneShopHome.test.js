// Owner, 2026-10-17: a one-shop account (destShop) sees nothing of the other
// shop on its home screen. "To restock" counts /restock_log across every shop,
// so it is dropped for a destShop viewer who doesn't hold Source; the order
// figures come off the destShop-scoped feed and stay.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

describe("home stats for a one-shop account", () => {
  it("drops the network-wide 'To restock' for a destShop viewer without Source", () => {
    expect(src).toMatch(/\]\.filter\(\(s\) => !\(s\.role === ROLES\.SOURCE && homePerm\?\.destShop && !hasPermission\(ROLE_TO_PERMISSION\[ROLES\.SOURCE\]\)\)\);/);
  });
  it("keeps the order figures, which are already that shop's own", () => {
    expect(src).toMatch(/\{ k: "Orders today", v: assistantBadge, role: ROLES\.WAREHOUSE \}/);
    expect(src).toMatch(/const myShop = isSuperAdmin \? null : \(permRecord\?\.destShop \|\| null\);\s*\n\s*const orders = useOrders\(myShop\)/);
  });
});
