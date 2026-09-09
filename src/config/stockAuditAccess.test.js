// ─── STOCK AUDIT — WHO CAN OPEN IT ───────────────────────────────────────────
// It was gated on stock access. It is not any more (owner, 2026-09-09), and
// this is the test that says so out loud, because "everyone" is the kind of
// change that gets quietly re-narrowed by a later refactor reaching for the
// nearest permission check.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stockAuditVisibleForViewer } from "./stockAudit.js";

describe("stockAuditVisibleForViewer", () => {
  it("opens for ANY signed-in account, whatever it can or cannot do elsewhere", () => {
    expect(stockAuditVisibleForViewer({ signedIn: true })).toBe(true);
    // the shapes a caller might pass from the old gate — none of them may
    // narrow it any more
    expect(stockAuditVisibleForViewer({ signedIn: true, canAccessStock: false })).toBe(true);
    expect(stockAuditVisibleForViewer({ signedIn: true, isSuperAdmin: false })).toBe(true);
    expect(stockAuditVisibleForViewer({ signedIn: true, permissions: [] })).toBe(true);
  });

  it("but stays shut for nobody at all", () => {
    // Signed out is the ONE closed case: every write this screen makes needs an
    // account, and the rules refuse an anonymous one.
    for (const v of [{ signedIn: false }, { signedIn: null }, { signedIn: undefined }, {}]) {
      expect(stockAuditVisibleForViewer(v)).toBe(false);
    }
  });

  it("the tile is ungated in the group list, not gated on stock access", () => {
    // The function above is only half the door: a tile can still be filtered
    // out by the `cond && {...}` in front of it. This reads App.jsx's own
    // source, because that is where the other half lives.
    const src = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => l.includes('key:"stock_audit"'));
    expect(line).toBeTruthy();
    expect(line.trimStart().startsWith("{")).toBe(true);
    expect(line).not.toContain("canAccessStock");
    expect(line).not.toContain("hasPermission");
    expect(line).not.toContain("isSuperAdmin");
  });

  it("and the route gate asks only whether somebody is signed in", () => {
    const src = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => l.includes("const stockAuditRouteOpen"));
    expect(line).toContain("signedIn: !!authUser");
    expect(line).not.toContain("canAccessStock");
    expect(line).not.toContain("isSuperAdmin");
  });
});
