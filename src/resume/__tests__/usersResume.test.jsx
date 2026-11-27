// Super-admin Users card (UserManagement), the real component: leave it,
// another app for a minute, come back — the /users listener is not reopened.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {}, location: { hash: "#admin/users" },
  scrollY: 0, scrollTo() {}, requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

const opens = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  onValue: (r, cb) => { opens.push(r.path); if (r.path === "users") cb({ val: () => ({}) }); return () => {}; },
  update: vi.fn(async () => {}),
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../../firebase", () => ({ database: {}, functions: {} }));
vi.mock("../../utils/useNetwork", async () => {
  const { SEED_REGISTRY } = await vi.importActual("../../utils/networkRegistry");
  return { useNetwork: () => ({ registry: SEED_REGISTRY, settled: true, error: false }) };
});

const UserManagement = (await import("../../components/UserManagement.jsx")).default;
const live = await import("../../utils/sharedLiveRead.js");
const ADMIN = { uid: "admin-uid", email: "gunidmoh@gmail.com", displayName: "Junid" };
const mount = () => { let t; act(() => { t = TestRenderer.create(<UserManagement onExit={() => {}} authUser={ADMIN} />); }); return t; };
const usersOpens = () => opens.filter((p) => p === "users").length;

beforeEach(() => { vi.useFakeTimers(); live._resetSharedLiveReadsForTests(); live._setHoldingForTests(true); opens.length = 0; });
afterEach(() => { live._resetSharedLiveReadsForTests(); live._setHoldingForTests(live.holdsInMode("test")); vi.useRealTimers(); });

describe("Users card — leave, another app, back", () => {
  it("one /users download for the visit, not one per return", () => {
    const g = live._hideGraceForTests();
    const a = mount();
    expect(usersOpens()).toBe(1);
    act(() => a.unmount());
    act(() => g.hidden()); vi.advanceTimersByTime(60_000); act(() => g.visible());
    const b = mount();
    expect(usersOpens()).toBe(1);
    act(() => b.unmount());
  });
});
