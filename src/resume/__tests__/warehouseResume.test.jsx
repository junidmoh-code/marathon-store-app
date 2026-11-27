// Warehouse / TV (in-app DISPLAY): proof only. useLaybyPulls already reads
// through the shared live layer, and the resume layer (hide grace + parked
// holds) covers them as they are. Production hooks, counted listeners.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react-test-renderer";
import { bytesOf, mountProbe } from "./resumeHarness.jsx";

const opens = [];
const handlers = new Map();
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { opens.push(r.path); handlers.set(r.path, cb); return () => handlers.delete(r.path); },
  query: (r) => r, orderByKey: () => ({}), orderByChild: () => ({}), limitToLast: () => ({}), equalTo: () => ({}),
  update: vi.fn(), get: vi.fn(async () => ({ val: () => null })), runTransaction: vi.fn(), push: vi.fn(), set: vi.fn(),
  serverTimestamp: () => 0,
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));

const live = await import("../../utils/sharedLiveRead.js");
const layby = await import("../../components/layby/useLayby.js");

const answer = () => act(() => { for (const [, cb] of [...handlers]) cb({ val: () => ({}) }); });
const priced = (list) => list.filter((p) => p !== ".info/connected");

beforeEach(() => { vi.useFakeTimers(); live._resetSharedLiveReadsForTests(); live._setHoldingForTests(true); opens.length = 0; handlers.clear(); });
afterEach(() => { live._resetSharedLiveReadsForTests(); live._setHoldingForTests(live.holdsInMode("test")); vi.useRealTimers(); });

function returnCost(useReads) {
  const g = live._hideGraceForTests();
  const s = mountProbe(useReads); answer();
  const first = opens.length;
  const firstBytes = bytesOf(priced(opens));
  s.unmount();
  act(() => g.hidden()); vi.advanceTimersByTime(60_000); act(() => g.visible());
  const again = mountProbe(useReads);
  const after = bytesOf(priced(opens.slice(first)));
  again.unmount();
  return { firstBytes, after };
}
function oldReturnCost(useReads) {
  const s = mountProbe(useReads); answer();
  const first = opens.length;
  s.unmount();
  live.releaseIdleLiveReads();           // the old visibilitychange→hidden handler
  const again = mountProbe(useReads); answer();
  const before = bytesOf(priced(opens.slice(first)));
  again.unmount();
  return before;
}

const useWarehouseReads = () => { layby.useLaybyPulls(); };

describe("Warehouse / TV — layby pulls", () => {
  it("a return costs 0 B (was 287,615 B)", () => {
    expect(oldReturnCost(useWarehouseReads)).toBe(287_615);
    live._resetSharedLiveReadsForTests(); opens.length = 0; handlers.clear();
    expect(returnCost(useWarehouseReads).after).toBe(0);
  });
});
