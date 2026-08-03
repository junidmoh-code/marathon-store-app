// ─── DISPLAY REGISTER — THE TWO GATES ─────────────────────────────────────────
// These tests exist to make DELETING EITHER GATE FAIL CI, the same contract
// UserManagement.gate.test.jsx holds for its route.
//
// The register shipped with its tile gated on the literal `true` and its route
// not gated at all, so every signed-in account — including POS-only till logins
// — could open it and write to /settings/displayRegister. Hiding the tile alone
// would not have fixed that: the route was still reachable through a persisted
// role. Both layers are now real, and both are pinned here.
//
// Three things are pinned:
//   1. the RULE itself — who passes, who does not
//   2. LAYER 2, the component gate, with the route bypassed: a refused viewer
//      opens NO /settings/displayRegister subscription (asserted on the
//      listener, not on what rendered)
//   3. LAYER 1, the App.jsx tile + route, asserted against the SOURCE so a
//      revert to `true &&` or to an unguarded mount fails here
//
// ── WHY react-test-renderer AND NOT A DOM ────────────────────────────────────
// Requirement 2 can only be tested by letting effects RUN — the subscription
// lives in a useEffect, so anything that skips effects would report "no
// listener" for the authorized case too and pass vacuously. Same reasoning, and
// same devDependency, as UserManagement.gate.test.jsx.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

// onValue is the thing under test: it must be called for an authorized viewer
// and never for a refused one.
const onValueMock = vi.fn(() => () => {});

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  onValue: (...args) => onValueMock(...args),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));
vi.mock("../../firebase.js", () => ({ database: { fake: true } }));
vi.mock("./useStock.js", () => ({ useLocations: () => ({}) }));
vi.mock("../../utils/serverTime.js", () => ({ serverNowIso: () => "2026-08-03T00:00:00.000Z" }));

// The viewer under test, swapped per case.
let VIEWER = { permRecord: null, hasPermission: () => false, isSuperAdmin: false };
vi.mock("../PermissionsContext.jsx", () => ({ usePermissions: () => VIEWER }));

const DisplayRegisterModule = await import("./DisplayRegister.jsx");
const DisplayRegister = DisplayRegisterModule.default;
const { mayUseDisplayRegister, hasStockAccess } = DisplayRegisterModule;

// A refused viewer must carry a destShop. Without one the register would open no
// listener EVEN IF the gate were deleted (it waits for a shop), so the "no
// listener" assertions below would pass vacuously — verified by mutation: with
// destShop absent, removing the layer-2 gate left them green.
const withPerms = (...granted) => ({
  permRecord: { stockRole: null, destShop: "marathon-pe" },
  hasPermission: (p) => granted.includes(p),
  isSuperAdmin: false,
});

function renderRegister() {
  let tree;
  act(() => { tree = TestRenderer.create(<DisplayRegister products={[]} standalone />); });
  return tree;
}

beforeEach(() => {
  onValueMock.mockClear();
  VIEWER = { permRecord: null, hasPermission: () => false, isSuperAdmin: false };
});

// ── THE RULE ─────────────────────────────────────────────────────────────────
describe("mayUseDisplayRegister — who may open the register", () => {
  it("admits stock-capable users", () => {
    expect(mayUseDisplayRegister({ canAccessStock: true, hasPermission: () => false })).toBe(true);
  });

  it("admits store assistants and display staff — the people who put pairs on the floor", () => {
    expect(mayUseDisplayRegister({ canAccessStock: false, hasPermission: (p) => p === "store_assistant" })).toBe(true);
    expect(mayUseDisplayRegister({ canAccessStock: false, hasPermission: (p) => p === "display_checks" })).toBe(true);
  });

  // display_refills is DEAD — removed from the permission catalog and documented
  // as gating nothing (UserManagement.jsx). Gating on it would admit the five
  // legacy records that still carry it and silently lock out every store
  // assistant created afterwards, whose preset is ["store_assistant","place_orders"].
  it("does NOT rely on the retired display_refills permission", () => {
    expect(mayUseDisplayRegister({ canAccessStock: false, hasPermission: (p) => p === "display_refills" })).toBe(false);
  });

  it("admits a FUTURE store assistant created from the role preset", () => {
    const preset = ["store_assistant", "place_orders"];
    expect(mayUseDisplayRegister({ canAccessStock: false, hasPermission: (p) => preset.includes(p) })).toBe(true);
  });

  it("refuses an account with neither — a POS-only till login", () => {
    expect(mayUseDisplayRegister({ canAccessStock: false, hasPermission: () => false })).toBe(false);
  });

  it("refuses an unrelated permission — the rule is a whitelist, not a catch-all", () => {
    expect(mayUseDisplayRegister({ canAccessStock: false, hasPermission: (p) => p === "product_admin" })).toBe(false);
    expect(mayUseDisplayRegister({ canAccessStock: false, hasPermission: (p) => p === "place_orders" })).toBe(false);
  });

  it("is defensive when called with nothing", () => {
    expect(mayUseDisplayRegister()).toBe(false);
    expect(mayUseDisplayRegister({})).toBe(false);
  });
});

// The stock-access derivation is SHARED with App.jsx rather than copied, so the
// two gates cannot drift. Pinned here because a divergent copy is invisible.
describe("hasStockAccess — one derivation, used by both gates", () => {
  it("admits admin and warehouse stockRoles", () => {
    expect(hasStockAccess({ permRecord: { stockRole: "admin" } })).toBe(true);
    expect(hasStockAccess({ permRecord: { stockRole: "warehouse" } })).toBe(true);
  });
  it("admits the stock_management permission without a stockRole", () => {
    expect(hasStockAccess({ permRecord: {}, hasPermission: (p) => p === "stock_management" })).toBe(true);
  });
  it("treats the super-admin as admin", () => {
    expect(hasStockAccess({ permRecord: null, isSuperAdmin: true })).toBe(true);
  });
  it("refuses a POS stockRole and an empty record", () => {
    expect(hasStockAccess({ permRecord: { stockRole: "pos" } })).toBe(false);
    expect(hasStockAccess({})).toBe(false);
    expect(hasStockAccess()).toBe(false);
  });
});

// ── LAYER 2 — the component gate, with the route gate bypassed ───────────────
describe("LAYER 2 — a refused viewer opens no register subscription", () => {
  it("registers NO listener for a POS-only account mounted directly", () => {
    VIEWER = withPerms();
    renderRegister();
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("registers NO listener when there is no permRecord at all", () => {
    VIEWER = { permRecord: { destShop: "trophy" }, hasPermission: () => false, isSuperAdmin: false };
    renderRegister();
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("registers NO listener for an unrelated permission", () => {
    VIEWER = withPerms("product_admin", "place_orders");
    renderRegister();
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("DOES register the listener for a store assistant — so the refusals are not vacuous", () => {
    VIEWER = { permRecord: { stockRole: null, destShop: "marathon-pe" }, hasPermission: (p) => p === "store_assistant", isSuperAdmin: false };
    renderRegister();
    expect(onValueMock).toHaveBeenCalled();
    expect(onValueMock.mock.calls[0][0].path).toMatch(/^settings\/displayRegister\//);
  });

  it("DOES register the listener for a warehouse stockRole", () => {
    VIEWER = { permRecord: { stockRole: "warehouse", destShop: "trophy" }, hasPermission: () => false, isSuperAdmin: false };
    renderRegister();
    expect(onValueMock).toHaveBeenCalled();
  });

  it("admits the super-admin, who has no stockRole of their own", () => {
    // No destShop, so the register waits for a shop to be picked before it
    // subscribes — the gate is proven by the ABSENCE of the refusal screen, not
    // by a listener that legitimately has nothing to listen to yet.
    VIEWER = { permRecord: { destShop: null }, hasPermission: () => false, isSuperAdmin: true };
    const json = JSON.stringify(renderRegister().toJSON());
    expect(json).not.toMatch(/don’t have access|do not have access/);
  });

  it("shows the refusal screen rather than a blank page", () => {
    VIEWER = withPerms();
    const json = JSON.stringify(renderRegister().toJSON());
    expect(json).toMatch(/Display Register/);
    expect(json).toMatch(/don’t have access|do not have access/);
  });
});

// ── LAYER 1 — the App.jsx tile + route, independent of the component ─────────
describe("LAYER 1 — the App.jsx gates, asserted against the source", () => {
  const appSrc = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

  it("gates the TILE on the shared rule, never on a literal true", () => {
    const at = appSrc.indexOf('key:"display_register"');
    expect(at, "the display_register tile must exist").toBeGreaterThan(-1);
    // The gate expression sits immediately before the tile object.
    const gateWindow = appSrc.slice(Math.max(0, at - 400), at);
    expect(gateWindow).toMatch(/mayUseDisplayRegister\(\{[^}]*\}\)/);
    // The exact regression this replaces: `true && { key:"display_register" … }`.
    expect(appSrc).not.toMatch(/\btrue\s*&&\s*\{\s*key:\s*"display_register"/);
  });

  it("gates the ROUTE on the same rule — hiding the tile is not a gate", () => {
    // Anchor on the ROUTE MOUNT specifically — `role === ROLES.DISPLAY_REGISTER`
    // also appears in the persisted-role safety net above it.
    const start = appSrc.indexOf("else if (role === ROLES.DISPLAY_REGISTER)");
    expect(start, "the DISPLAY_REGISTER route mount must exist").toBeGreaterThan(-1);
    const routeBlock = appSrc.slice(start, start + 600);
    expect(routeBlock).toMatch(/mayUseDisplayRegister/);
    // Authorized arm first, refusal second.
    expect(routeBlock).toMatch(/mayUseDisplayRegister[\s\S]*\?[\s\S]*<DisplayRegister/);
    const afterColon = routeBlock.slice(routeBlock.indexOf(":", routeBlock.indexOf("<DisplayRegister")));
    expect(afterColon.slice(0, 200)).not.toMatch(/<DisplayRegister/);
  });

  it("has no second, ungated mount of DisplayRegister anywhere in App.jsx", () => {
    const mounts = appSrc.match(/<DisplayRegister[\s/>]/g) || [];
    expect(mounts).toHaveLength(1);
  });

  it("both layers call the SAME exported rule — they cannot drift apart", () => {
    expect(appSrc).toMatch(/import DisplayRegister,\s*\{[^}]*mayUseDisplayRegister[^}]*\}/);
    expect((appSrc.match(/mayUseDisplayRegister\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("uses the SHARED stock-access derivation instead of re-deriving it", () => {
    expect(appSrc).toMatch(/import DisplayRegister,\s*\{[^}]*hasStockAccess[^}]*\}/);
    expect(appSrc).toMatch(/const canAccessStock = hasStockAccess\(/);
    // The hand-written copy this replaces.
    expect(appSrc).not.toMatch(/const canAccessStock = stockRole === "admin"/);
  });

  it("drops a persisted DISPLAY_REGISTER role the viewer no longer qualifies for", () => {
    expect(appSrc).toMatch(/role === ROLES\.DISPLAY_REGISTER && !mayUseDisplayRegister\([\s\S]{0,120}setRole\(null\)/);
  });
});
