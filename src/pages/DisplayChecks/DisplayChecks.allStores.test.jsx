// ─── DISPLAY CHECKS — every user, every shop (Junid, 20 Nov 2026) ────────────
// Run: npx vitest run src/pages/DisplayChecks/DisplayChecks.allStores.test.jsx
// A Marathon PE staff member sees all four shop chips; tapping Concrete only
// stages the switch; confirming moves the module to Concrete, and "Handed over"
// then goes to the server for CONCRETE.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = window.scrollTo || (() => {});
window.addEventListener = window.addEventListener || (() => {});
window.removeEventListener = window.removeEventListener || (() => {});
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {}, activeElement: null };

const callMock = vi.fn(async () => ({ data: { ok: true } }));
let perm = null;
const feedFor = vi.fn();
vi.mock("../../firebase", () => ({ functions: {}, database: {}, auth: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callMock(...a) }));
vi.mock("firebase/database", () => ({ getDatabase: () => ({}), ref: (_d, p) => ({ path: p }), get: async () => ({ val: () => null }) }));
vi.mock("../../components/PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com", usePermissions: () => perm }));
vi.mock("../../utils/serverTime", () => ({ saDateString: () => "2026-11-20", serverNowMs: () => 1 }));
vi.mock("./useDisplayChecks", () => ({ useTodayFeedSources: (store) => { feedFor(store); return {
  activeItems: [{ key: `online__1__${store}`, checkId: "-W1", kind: "online_pick", status: "open", productId: "p1", productName: "Cap", size: "_", qty: 1, ref: "#1", orderNumber: 1, orderId: "1", lineIndex: 0, createdAt: 1 }],
  completedItems: [], ready: true, error: null, saDate: "2026-11-20", store,
}; } }));
vi.mock("./AvailabilityView", () => ({ default: () => null }));
vi.mock("./AnalyticsView", () => ({ default: () => null }));
vi.mock("./SettingsView", () => ({ default: () => null }));
vi.mock("./StyleCodeCapture", () => ({ default: () => null }));
vi.mock("../../config/displayChecks", async (orig) => ({
  ...(await orig()),
  primeDisplayCheckSwitches: async () => ({}),
  currentDisplayCheckSwitches: () => ({}),
}));

const S = await import("../../utils/activeStore.js");
const { default: DisplayChecks } = await import("./index.jsx");
const { default: ActiveStoreLayer } = await import("../../components/ActiveStoreLayer.jsx");
const { displayChecksVisibleForViewer, canUseDisplayChecks } = await import("../../config/displayChecks.js");

const byId = (tree, id) => tree.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string");
const STAFF = { user: { uid: "u-staff", email: "asanda@marathon.internal" }, permRecord: { permissions: ["display_checks"], destShop: "marathon-pe", displayName: "Asanda" } };

beforeEach(() => {
  callMock.mockClear(); feedFor.mockClear();
  S.__resetActiveStoreForTests();
  const m = new Map();
  S.__setActiveStoreDepsForTests({ storage: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }, log: vi.fn(async () => ({})), today: () => "2026-11-20" });
  S.bindActiveStore({ uid: "u-staff", homeShop: "marathon-pe", signIn: "s" });
  perm = STAFF;
});

const mounted = [];
afterEach(async () => { while (mounted.length) { const t = mounted.pop(); await act(async () => { t.unmount(); }); } });
async function mount() {
  let tree;
  await act(async () => { tree = TestRenderer.create(<ActiveStoreLayer><DisplayChecks onExit={() => {}} products={[]} /></ActiveStoreLayer>); });
  mounted.push(tree);
  return tree;
}

describe("Display Checks for a Marathon PE staff member", () => {
  it("shows a chip for every shop, not just their own", async () => {
    const tree = await mount();
    for (const id of ["marathon-pe", "trophy", "marathon-pine", "concrete"]) {
      expect(byId(tree, `dc-store-${id}`).length, id).toBeGreaterThan(0);
    }
  });

  it("tapping Concrete opens the confirmation and nothing moves until Yes", async () => {
    const tree = await mount();
    expect(feedFor).toHaveBeenLastCalledWith("marathon-pe");
    await act(async () => { byId(tree, "dc-store-concrete")[0].props.onClick(); });
    expect(byId(tree, "store-switch-modal")).toHaveLength(1);
    expect(feedFor).toHaveBeenLastCalledWith("marathon-pe");
    await act(async () => { byId(tree, "store-switch-cancel")[0].props.onClick(); });
    expect(feedFor).toHaveBeenLastCalledWith("marathon-pe");
  });

  it("after Yes the module works in Concrete and Handed over counts for Concrete", async () => {
    const tree = await mount();
    await act(async () => { byId(tree, "dc-store-concrete")[0].props.onClick(); });
    await act(async () => { byId(tree, "store-switch-confirm")[0].props.onClick(); });
    expect(feedFor).toHaveBeenLastCalledWith("concrete");
    expect(byId(tree, "store-away-banner")).toHaveLength(1);
    await act(async () => { byId(tree, "web-handed")[0].props.onClick(); });
    expect(callMock).toHaveBeenCalledWith(expect.objectContaining({ store: "concrete", result: "handed" }));
  });
});

describe("gates", () => {
  it("display_checks opens every shop; no grant opens none", () => {
    const staff = { email: "a@b", permissions: ["display_checks"], destShop: "marathon-pe" };
    for (const id of ["marathon-pe", "trophy", "marathon-pine", "concrete"]) expect(canUseDisplayChecks(staff, id)).toBe(true);
    expect(canUseDisplayChecks({ email: "a@b", permissions: [] }, "trophy")).toBe(false);
  });
  it("the Home card / route stays open whichever shop is active", () => {
    expect(displayChecksVisibleForViewer({ email: "a@b", permissions: ["display_checks"], destShop: "marathon-pine" })).toBe(true);
    expect(displayChecksVisibleForViewer({ email: "a@b", permissions: [] })).toBe(false);
  });
});
