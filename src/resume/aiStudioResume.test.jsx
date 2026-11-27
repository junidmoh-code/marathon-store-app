// AI Studio: the two review lists, through the production hooks in App.jsx.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react-test-renderer";
import { bytesOf, mountProbe } from "./resumeHarness.jsx";

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
  return { ...stub, ref: (_d, path) => ({ path: path ?? "" }),
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

const { useNameProposals, usePhotoProposals } = await import("../App.jsx");
const live = await import("../utils/sharedLiveRead.js");

// AI Studio mounts the name list once and the photo list twice (the view and
// its default Review Photos tab).
const useAiStudioReads = () => { useNameProposals(); usePhotoProposals(); usePhotoProposals(); };
const answer = () => act(() => { for (const [, cb] of [...handlers]) cb({ val: () => ({}) }); });

beforeEach(() => { vi.useFakeTimers(); live._resetSharedLiveReadsForTests(); live._setHoldingForTests(true); opens.length = 0; handlers.clear(); });
afterEach(() => { live._resetSharedLiveReadsForTests(); live._setHoldingForTests(live.holdsInMode("test")); vi.useRealTimers(); });

describe("AI Studio — leave, another app, back", () => {
  it("first open: ONE listener per list (the photo list used to open twice: 2,059,452 B, now 1,466,551 B)", () => {
    const s = mountProbe(useAiStudioReads); answer();
    expect(opens.filter((p) => p.startsWith("aiAssistant/")).sort()).toEqual(["aiAssistant/nameProposals", "aiAssistant/photoProposals"]);
    expect(bytesOf(opens)).toBe(1_466_551);
    expect(bytesOf(["aiAssistant/nameProposals", "aiAssistant/photoProposals", "aiAssistant/photoProposals"])).toBe(2_059_452);
    s.unmount();
  });
  it("back to the card after a minute in another app: 0 B (was 2,059,452 B — raw listeners re-opened on every mount)", () => {
    const g = live._hideGraceForTests();
    const s = mountProbe(useAiStudioReads); answer();
    const first = opens.length;
    s.unmount();
    act(() => g.hidden()); vi.advanceTimersByTime(60_000); act(() => g.visible());
    const again = mountProbe(useAiStudioReads);
    expect(bytesOf(opens.slice(first))).toBe(0);
    again.unmount();
  });
});
