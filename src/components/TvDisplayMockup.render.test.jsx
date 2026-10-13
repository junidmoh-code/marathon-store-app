// Pins the queue board's contract with the outside world:
//  1. the ONLY database read the board itself makes is `.info/connected`
//     (client-side metadata, no download) — orders arrive as a prop from the
//     bandwidth-scoped listener upstream;
//  2. live orders land in their column, newest five, full total as the count;
//  3. ?demo=1 draws the mockup's dummy orders whatever the live list holds;
//  4. the footer follows .info/connected: "Connecting" through the SDK's
//     pre-handshake false, green when connected, red "Reconnecting" only after
//     a drop has lasted the grace period (or a boot never connects in 15 s).
// Firebase is fully mocked — no test touches live data.
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { create, act } from "react-test-renderer";

const listeners = [];
vi.mock("../firebase", () => ({ database: { __mockDb: true } }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb, errCb) => {
    listeners.push({ path: r.path, cb, errCb });
    return () => {};
  },
}));
// Ads + specials have their own tests; keep their reads out of this one.
vi.mock("./TvAdOverlay", () => ({ default: () => null }));

import TvDisplayMockup from "./TvDisplayMockup.jsx";

const snap = (v) => ({ val: () => v });
const text = (node) => (typeof node === "string" ? node : (node.children || []).map(text).join(""));
const byClass = (tree, cls) => tree.root.findAll((n) => typeof n.type === "string" && String(n.props.className || "").split(" ").includes(cls));

// No DOM in this repo's test env: the board needs only a viewport size, resize
// listeners and the URL.
const setUrl = (search) => {
  vi.stubGlobal("window", {
    innerWidth: 1920, innerHeight: 1080,
    location: { search, hash: "#tv" },
    addEventListener: () => {}, removeEventListener: () => {},
  });
};
beforeEach(() => { listeners.length = 0; setUrl(""); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("the board's own reads are .info/connected only", () => {
  act(() => { create(<TvDisplayMockup orders={[]} specials={[]} />); });
  expect(listeners.map((l) => l.path)).toEqual([".info/connected"]);
});

test("live orders fill their columns: newest five first, full total, then the next page", () => {
  vi.useFakeTimers();
  const now = Date.now();
  const orders = Array.from({ length: 7 }, (_, i) => ({
    id: String(10 + i).padStart(3, "0"), status: "incoming", createdAt: new Date(now - i * 60000).toISOString(),
  })).concat([{ id: "099", status: "ready", createdAt: new Date(now).toISOString(), readyAt: new Date(now - 120000).toISOString() }]);
  let tree;
  act(() => { tree = create(<TvDisplayMockup orders={orders} specials={[]} />); });
  const counts = byClass(tree, "qb-col-count").map(text);
  expect(counts).toEqual(["7", "1", "0", "0"]);
  const nums = byClass(tree, "qb-num").map(text);
  expect(nums).toEqual(["010", "011", "012", "013", "014", "099"]);
  expect(byClass(tree, "qb-demo")).toHaveLength(0);
  expect(byClass(tree, "qb-page-dot")).toHaveLength(2);       // incoming has 2 pages; ready has none
  act(() => { vi.advanceTimersByTime(8000); });
  expect(byClass(tree, "qb-num").map(text)).toEqual(["015", "016", "099"]);
});

test("?demo=1 draws the mockup's dummy orders over the live list", () => {
  vi.useFakeTimers();
  setUrl("?demo=1");
  let tree;
  act(() => { tree = create(<TvDisplayMockup orders={[{ id: "001", status: "incoming", createdAt: new Date().toISOString() }]} specials={[]} />); });
  expect(byClass(tree, "qb-col-count").map(text)).toEqual(["12", "8", "3", "5"]);
  const nums = byClass(tree, "qb-num").map(text);
  expect(nums).toEqual(["L-366", "L-365", "L-364", "L-363", "L-362", "071", "064", "065", "047", "039",
    "L-358", "L-352", "L-349", "L-371", "L-370", "L-369", "L-368", "L-367"]);
  expect(byClass(tree, "qb-demo")).toHaveLength(1);
  // The busy demo columns page like live ones (12 → 3 pages, 8 → 2).
  expect(byClass(tree, "qb-page-dot")).toHaveLength(5);
});

test("the footer follows .info/connected, with a grace period on drops", () => {
  vi.useFakeTimers();
  let tree;
  act(() => { tree = create(<TvDisplayMockup orders={[]} specials={[]} />); });
  const conn = () => byClass(tree, "qb-conn")[0];
  expect(text(conn())).toBe("Connecting");
  const l = listeners.find((x) => x.path === ".info/connected");
  act(() => { l.cb(snap(false)); vi.advanceTimersByTime(5000); });
  expect(text(conn())).toBe("Connecting");          // the SDK's pre-handshake false is not an outage
  act(() => { l.cb(snap(true)); });
  expect(text(conn())).toBe("System connected");
  act(() => { l.cb(snap(false)); });
  expect(text(conn())).toBe("System connected");   // a blip is not an outage
  act(() => { vi.advanceTimersByTime(3000); });
  expect(text(conn())).toBe("Reconnecting");
  act(() => { l.cb(snap(true)); });
  expect(text(conn())).toBe("System connected");
});

test("a boot that never connects goes red after 15 s", () => {
  vi.useFakeTimers();
  let tree;
  act(() => { tree = create(<TvDisplayMockup orders={[]} specials={[]} />); });
  const l = listeners.find((x) => x.path === ".info/connected");
  act(() => { l.cb(snap(false)); vi.advanceTimersByTime(14000); });
  expect(text(byClass(tree, "qb-conn")[0])).toBe("Connecting");
  act(() => { vi.advanceTimersByTime(1000); });
  expect(text(byClass(tree, "qb-conn")[0])).toBe("Reconnecting");
});

test("the stage fills the screen edge to edge without ever cutting off the board", async () => {
  const { stageScale } = await import("./TvDisplayMockup.jsx");
  // 16:9 TV: exact fit, no crop.
  expect(stageScale(1920, 1080)).toBeCloseTo(1);
  expect(stageScale(3840, 2160)).toBeCloseTo(2);
  // A wider browser window: full bleed (cover), photo cropped top/bottom only.
  const wide = stageScale(2000, 1060);
  expect(wide).toBeCloseTo(2000 / 1920);
  // ...and the board still fits: 1060 px tall viewport holds y 50…940 around centre.
  expect(500 * wide * 2).toBeLessThanOrEqual(1060 + 1e-9);
  // A portrait window: capped so the columns fit the width (gap filled by the blurred wall).
  const tall = stageScale(581, 649);
  expect(880 * 2 * tall).toBeLessThanOrEqual(581 + 1e-9);
  expect(tall).toBeLessThan(649 / 1080);
  // With a special running, its band reaches the stage's bottom edge (y 1080):
  // on a wide screen the whole stage height must then fit, never cropped.
  for (const [vw, vh] of [[2560, 1080], [2000, 1060], [1920, 1080], [3440, 1440]]) {
    expect(1080 * stageScale(vw, vh, true)).toBeLessThanOrEqual(vh + 1e-9);
  }
  expect(stageScale(1920, 1080, true)).toBeCloseTo(1);   // a 16:9 TV is unchanged
});

test("until Black Friday the tape crosses the floor and the connection status moves under the clock", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
  let tree;
  act(() => { tree = create(<TvDisplayMockup orders={[]} specials={[]} />); });
  expect(byClass(tree, "qb-tape")).toHaveLength(1);
  expect(byClass(tree, "qb-tape-band")).toHaveLength(2);
  expect(byClass(tree, "qb-footer")).toHaveLength(0);
  expect(byClass(tree, "qb-status-top")[0].findAll((n) => n.props.className === "qb-conn")).toHaveLength(1);
});

test("from Black Friday the tape is gone and the footer is back", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T08:00:00Z"));
  let tree;
  act(() => { tree = create(<TvDisplayMockup orders={[]} specials={[]} />); });
  expect(byClass(tree, "qb-tape")).toHaveLength(0);
  expect(byClass(tree, "qb-status-top")).toHaveLength(0);
  expect(byClass(tree, "qb-footer")[0].findAll((n) => n.props.className === "qb-conn")).toHaveLength(1);
});
