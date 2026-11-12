// Junid's policy (12 Nov 2026): EVERY signed-in staff member — any role, any
// store, any device — sees and can open Display Check.
// Run: npx vitest run src/config/displayChecksForEveryone.test.js
import { describe, it, expect } from "vitest";
import { displayChecksVisibleForViewer, canUseDisplayChecks } from "./displayChecks";
import { isCardHidden, isRoleHidden } from "../components/hiddenCards";

describe("Display Check is open to every signed-in staff member", () => {
  it("staff with no permission, no store, no stockRole see it", () => {
    expect(displayChecksVisibleForViewer({ uid: "u1", email: "a@b.c", permissions: [], destShop: null }, null)).toBe(true);
  });
  it("staff scoped to ANOTHER store see it (storeId no longer narrows the entry)", () => {
    expect(displayChecksVisibleForViewer({ uid: "u1", permissions: [], destShop: "trophy" }, "marathon-pe")).toBe(true);
  });
  it("a uid alone (a device login with no email) is signed in", () => {
    expect(displayChecksVisibleForViewer({ uid: "u1" }, null)).toBe(true);
  });
  it("nobody signed in → not visible", () => {
    expect(displayChecksVisibleForViewer(null, null)).toBe(false);
    expect(displayChecksVisibleForViewer({}, null)).toBe(false);
  });
  it("the owner still sees it", () => {
    expect(displayChecksVisibleForViewer({ email: "gunidmoh@gmail.com" }, null)).toBe(true);
  });
  it("completing checks stays store-scoped (unchanged)", () => {
    expect(canUseDisplayChecks({ permissions: [], destShop: "trophy" }, "trophy")).toBe(false);
    expect(canUseDisplayChecks({ permissions: ["display_checks"], destShop: "trophy" }, "trophy")).toBe(true);
  });
  it("a per-user hide list cannot take the card or the route away", () => {
    const rec = { hiddenCards: ["display_checks", "attention"] };
    expect(isCardHidden("display_checks", rec)).toBe(false);
    expect(isRoleHidden("display_checks", rec)).toBe(false);
    expect(isCardHidden("attention", rec)).toBe(true);   // other cards still hide
  });
});
