// ─── EVERY CONVERTED CARD: HIDE→SHOW AND DISCARD→RESTORE (27 Nov 2026) ───────
//
// Production hooks, counted listeners, measured bytes.
//
//   hide→show, card left open   — nothing reopened, however long the hide.
//   hide→show, card re-entered  — nothing reopened inside the hide grace.
//   discard→restore             — a fresh page has nothing in memory, so each
//                                 non-mirrored read comes down ONCE (it is not
//                                 a mirror leg; adding legs needs a server
//                                 deploy, out of scope). Never twice, never a
//                                 duplicate listener, and no mirrored node is
//                                 read live: the mirror's catch-up after a
//                                 restore is changes-only (pageOrder.test.js,
//                                 "catch-up on return").
//
// The two other halves of a return are proved where they live:
// sourceResume.test.jsx (the update checker never reloads during trading) and
// AuthGate.resume.test.jsx (a restored page opens on the saved record).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react-test-renderer";
import { MEASURED, bytesOf, mountProbe } from "./resumeHarness.jsx";

const opens = [];
const handlers = new Map();
vi.mock("../firebase", () => ({
  app: {}, database: {}, functions: {}, functionsUS: {}, storage: {}, googleProvider: {},
  auth: { currentUser: { uid: "u1" }, onAuthStateChanged: () => () => {} },
}));
vi.mock("firebase/database", async (orig) => {
  const real = await orig();
  const stub = {};
  for (const k of Object.keys(real)) stub[k] = typeof real[k] === "function" ? vi.fn(() => ({})) : real[k];
  const off = () => () => {};
  return { ...stub, ref: (_d, path) => ({ path: path ?? "" }), query: (r) => r,
    onValue: (r, cb) => { opens.push(r.path); handlers.set(r.path, cb); return () => handlers.delete(r.path); },
    onChildAdded: off, onChildChanged: off, onChildRemoved: off,
    get: async () => ({ val: () => null, exists: () => false }) };
});
vi.mock("firebase/auth", async (orig) => ({ ...(await orig()), onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, location: { search: "", hash: "" } };
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, activeElement: null, getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} }, body: { appendChild() {} } };
const mem = new Map();
globalThis.localStorage ??= { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const app = await import("../App.jsx");
const stock = await import("../components/stock/useStock.js");
const layby = await import("../components/layby/useLayby.js");
const { useNetwork } = await import("../utils/useNetwork.js");
const { useSpecials } = await import("../components/TvSpecialsRail.jsx");
const live = await import("../utils/sharedLiveRead.js");
const { HIDDEN_GRACE_MS } = await import("../utils/sharedLiveReadCore.js");

const CARDS = {
  Source: () => { stock.useEngineOpen(); stock.useEngineConfig(); useNetwork(); },
  Health: () => { stock.useStockExceptions(); stock.useStrandedTransit(); stock.useEngineShadow(); stock.useRetryState(); stock.useStockTargets(); },
  "Warehouse / TV": () => { layby.useLaybyPulls(); useSpecials(); },
  "AI Studio": () => { app.useNameProposals(); app.usePhotoProposals(); app.usePhotoProposals(); },
  Customers: () => { app.useBroadcastHistory(); },
};
const MIRRORED_NODES = ["refill_requests", "products", "orders", "stock", "customers", "returns_log", "restock_log", "restock_requests", "insights_log", "stock_movements"];

const answer = () => act(() => { for (const [, cb] of [...handlers]) cb({ val: () => ({}) }); });
const cardPaths = (list) => list.filter((p) => p !== ".info/connected");
const freshPage = () => { live._resetSharedLiveReadsForTests(); opens.length = 0; handlers.clear(); };

beforeEach(() => { vi.useFakeTimers(); live._setHoldingForTests(true); freshPage(); });
afterEach(() => { live._resetSharedLiveReadsForTests(); live._setHoldingForTests(live.holdsInMode("test")); vi.useRealTimers(); });

for (const [name, useCard] of Object.entries(CARDS)) {
  describe(`${name}`, () => {
    it("hide→show with the card open: nothing reopened, even after half an hour", () => {
      const g = live._hideGraceForTests();
      const c = mountProbe(useCard); answer();
      const n = opens.length;
      act(() => g.hidden()); vi.advanceTimersByTime(30 * 60_000); act(() => g.visible());
      expect(opens.length).toBe(n);
      c.unmount();
    });

    it("hide→show and back into the card inside the grace: 0 bytes", () => {
      const g = live._hideGraceForTests();
      const c = mountProbe(useCard); answer();
      const n = opens.length;
      c.unmount();
      act(() => g.hidden()); vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1000); act(() => g.visible());
      const again = mountProbe(useCard);
      expect(cardPaths(opens.slice(n))).toEqual([]);
      again.unmount();
    });

    it("discard→restore: each read once, no duplicates, no mirrored node read live", () => {
      const c = mountProbe(useCard); answer();
      c.unmount();
      freshPage();                                       // the browser threw the page away
      const restored = mountProbe(useCard); answer();
      const got = cardPaths(opens);
      expect(new Set(got).size).toBe(got.length);        // never a second listener on one path
      expect(got.filter((p) => MIRRORED_NODES.includes(p))).toEqual([]);
      for (const p of got) expect(p in MEASURED).toBe(true);
      expect(bytesOf(got)).toBeGreaterThan(0);
      restored.unmount();
    });
  });
}
