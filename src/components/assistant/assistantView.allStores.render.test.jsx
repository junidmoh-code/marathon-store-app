// ─── ORDER SCREEN — mounts for real with all-store access ────────────────────
// Run: npx vitest run src/components/assistant/assistantView.allStores.render.test.jsx
// AssistantView mounted from App.jsx (Firebase stubbed — nothing can reach a
// database) as a Marathon PE account: it renders, offers every shop, and a
// confirmed switch to Concrete changes the shop it orders for.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("../../firebase", () => ({
  app: {}, database: {}, functions: {}, functionsUS: {}, storage: {}, googleProvider: {},
  auth: { currentUser: null, onAuthStateChanged: () => () => {} },
}));
vi.mock("firebase/database", async (orig) => {
  const real = await orig();
  const stub = {};
  for (const k of Object.keys(real)) stub[k] = typeof real[k] === "function" ? vi.fn(() => ({})) : real[k];
  const off = () => () => {};
  return { ...stub, onValue: off, onChildAdded: off, onChildChanged: off, onChildRemoved: off,
           get: async () => ({ val: () => null, exists: () => false }) };
});
vi.mock("../../offline/MirroredImg.jsx", () => ({ MirroredImg: ({ productId, src, ...rest }) => <img src={src} {...rest} /> }));
const perm = { current: null };
vi.mock("../PermissionsContext", async (orig) => ({ ...(await orig()), usePermissions: () => perm.current }));

const mem = new Map();
beforeAll(() => {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { search: "", hash: "" } };
  window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, activeElement: null };
  globalThis.localStorage ??= { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
});

const { AssistantView } = await import("../../App.jsx");
const S = await import("../../utils/activeStore.js");

const PE = { user: { uid: "u1", email: "a@m.internal" }, permRecord: { destShop: "marathon-pe", permissions: ["place_orders"] },
             isSuperAdmin: false, permissions: ["place_orders"], storeIds: ["central"], hasPermission: () => true,
             deviceIdentity: { deviceId: "d1", section: null } };

const mounted = [];
afterEach(async () => { while (mounted.length) { const t = mounted.pop(); await act(async () => { t.unmount(); }); } });
beforeEach(() => {
  S.__resetActiveStoreForTests();
  const m = new Map();
  S.__setActiveStoreDepsForTests({ storage: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }, log: vi.fn(async () => ({})), today: () => "2026-11-20" });
  perm.current = PE;
  S.bindActiveStore({ uid: "u1", homeShop: "marathon-pe", signIn: "s" });
});

async function mount() {
  let t;
  await act(async () => { t = TestRenderer.create(<AssistantView products={[]} onExit={() => {}} orders={Object.assign([], { settled: true })} />); });
  mounted.push(t);
  return t;
}
const shopButtons = (t) => t.root.findAll((n) => n.type === "button" && typeof n.props.children === "string"
  && ["Marathon PE", "Trophy", "Pine", "Concrete"].includes(n.props.children));

describe("order screen for a Marathon PE account", () => {
  it("renders and offers all four shops", async () => {
    const t = await mount();
    expect(shopButtons(t).map((b) => b.props.children).sort()).toEqual(["Concrete", "Marathon PE", "Pine", "Trophy"]);
  });

  it("tapping Concrete opens the app-wide confirmation; Yes moves the screen to Concrete", async () => {
    const t = await mount();
    await act(async () => { shopButtons(t).find((b) => b.props.children === "Concrete").props.onClick(); });
    expect(S.getActiveStore().pending).toBe("concrete");
    await act(async () => { S.confirmSwitch(); });
    const on = shopButtons(t).find((b) => b.props.style?.color === "#fff");
    expect(on.props.children).toBe("Concrete");
  });
});
