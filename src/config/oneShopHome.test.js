// Owner, 2026-10-17: a one-shop account (destShop) sees nothing of the other
// shop on its home screen. "To restock" counts /restock_log across every shop,
// so it is dropped for a destShop viewer who doesn't hold Source; the order
// figures come off the destShop-scoped feed and stay.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

describe("home stats for a one-shop account", () => {
  // Sky home (2026-11-02): the stat row is gone. The network-wide restock
  // count now exists ONLY as the Source card's badge, and that card is only
  // built for an account holding Source — so a destShop viewer without it
  // still sees nothing of the other shop.
  it("shows the network-wide restock count only on the Source card, gated on Source", () => {
    expect(src).toContain('hasPermission(ROLE_TO_PERMISSION[ROLES.SOURCE])    && { key:"source", icon:RoleIcons.source, name:"Source", desc:"Restock requests", badge:sourceBadge');
    expect(src).not.toContain('{ k: "To restock"');
  });
  it("keeps the order figures, which are already that shop's own", () => {
    // The Home tiles show no count (Junid, 12 Nov); the figure is still the
    // shop's own where it is used (the Admin hub card list).
    expect(src).toContain('primaryTile("assistant") && { ...primaryTile("assistant"), badge: undefined }');
    expect(src).toContain('badge:assistantBadge');
    expect(src).toMatch(/const myShop = isSuperAdmin \? null : \(permRecord\?\.destShop \|\| null\);\s*\n\s*const orders = useOrders\(myShop\)/);
  });
});
