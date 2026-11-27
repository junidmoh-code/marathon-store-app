// TV specials rail and the Customers broadcast history: raw listeners moved to
// the shared held read. Both nodes are empty today (4 B each, measured 27 Nov
// 2026), so this is consistency rather than money: a return reopens nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react-test-renderer";
import { mountProbe } from "./resumeHarness.jsx";

const opens = [];
vi.mock("../firebase", () => ({
  app: {}, database: {}, functions: {}, functionsUS: {}, storage: {}, googleProvider: {},
  auth: { currentUser: { uid: "u1" }, onAuthStateChanged: () => () => {} },
}));
vi.mock("firebase/database", async (orig) => {
  const real = await orig();
  const stub = {};
  for (const k of Object.keys(real)) stub[k] = typeof real[k] === "function" ? vi.fn(() => ({})) : real[k];
  const off = () => () => {};
  return { ...stub, ref: (_d, path) => ({ path: path ?? "" }),
    onValue: (r, cb) => { opens.push(r.path); cb({ val: () => null }); return () => {}; },
    onChildAdded: off, onChildChanged: off, onChildRemoved: off,
    get: async () => ({ val: () => null, exists: () => false }) };
});
vi.mock("firebase/auth", async (orig) => ({ ...(await orig()), onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { search: "", hash: "" } };
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, activeElement: null, getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} }, body: { appendChild() {} } };
const mem = new Map();
globalThis.localStorage ??= { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { useBroadcastHistory } = await import("../App.jsx");
const { useSpecials } = await import("../components/TvSpecialsRail.jsx");
const live = await import("../utils/sharedLiveRead.js");

beforeEach(() => { vi.useFakeTimers(); live._resetSharedLiveReadsForTests(); live._setHoldingForTests(true); opens.length = 0; });
afterEach(() => { live._resetSharedLiveReadsForTests(); live._setHoldingForTests(live.holdsInMode("test")); vi.useRealTimers(); });

for (const [name, useIt, path] of [["TV specials", useSpecials, "specials"], ["Customers broadcasts", useBroadcastHistory, "broadcasts"]]) {
  describe(`${name} — leave, another app, back`, () => {
    it("one listener for the visit; the return reopens nothing", () => {
      const g = live._hideGraceForTests();
      const a = mountProbe(useIt);
      expect(opens.filter((p) => p === path).length).toBe(1);
      a.unmount();
      act(() => g.hidden()); vi.advanceTimersByTime(60_000); act(() => g.visible());
      const b = mountProbe(useIt);
      expect(opens.filter((p) => p === path).length).toBe(1);
      b.unmount();
    });
  });
}
