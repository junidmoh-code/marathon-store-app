// Health: proof only. HealthView.jsx and useStock.js are on
// the junid-approved guard list, so they are NOT edited; their reads already go
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
const stock = await import("../../components/stock/useStock.js");

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
  const reopened = priced(opens.slice(first));
  expect(reopened).toEqual([]);
  const after = bytesOf(reopened);
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

const useHealthReads = () => {
  stock.useStockExceptions(); stock.useStrandedTransit(); stock.useEngineShadow();
  stock.useRetryState(); stock.useStockTargets();
};

describe("Health — leave, another app, back", () => {
  it("measured reads: 3,983,626 B on the way in; a return costs 0 B (was 3,983,626 B)", () => {
    expect(oldReturnCost(useHealthReads)).toBe(3_983_626);
    live._resetSharedLiveReadsForTests(); opens.length = 0; handlers.clear();
    const { firstBytes, after } = returnCost(useHealthReads);
    expect(firstBytes).toBe(3_983_626);
    expect(after).toBe(0);
  });
});

