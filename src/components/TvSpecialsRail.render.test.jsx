// Pins the TV specials rail contract:
//  1. useSpecials subscribes to EXACTLY the /specials node — nothing else
//     (the always-on TV must never grow a broad subscription), sorted
//     startedAt desc per the consumer contract in src/utils/specials.js;
//  2. a read error FAILS OPEN to an empty list (ads must never block the board);
//  3. the rail renders name / price / was-price for active specials;
//  4. with no specials the rail renders NOTHING (clean empty state — the
//     board falls back to its long-standing decorative conveyor).
// Firebase is fully mocked — no test touches live data.
import { test, expect, vi } from "vitest";
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

import TvSpecialsRail, { useSpecials } from "./TvSpecialsRail.jsx";

function Probe() {
  const specials = useSpecials();
  return <div data-specials={JSON.stringify(specials.map((s) => s.id))} />;
}

const snap = (v) => ({ val: () => v });

test("useSpecials subscribes to the specials node ONLY, sorted startedAt desc", () => {
  let tree;
  act(() => { tree = create(<Probe />); });
  expect(listeners.length).toBe(1);
  expect(listeners[0].path).toBe("specials");
  act(() => {
    listeners[0].cb(snap({
      older: { name: "Old", price: 100, startedAt: "2026-08-01T09:00:00" },
      newer: { name: "New", price: 200, startedAt: "2026-08-13T09:00:00" },
    }));
  });
  expect(tree.root.findByType("div").props["data-specials"]).toBe('["newer","older"]');
});

test("a read error fails OPEN to no specials", () => {
  vi.useFakeTimers();
  let tree;
  act(() => { tree = create(<Probe />); });
  const l = listeners[listeners.length - 1];
  act(() => { l.cb(snap({ p1: { name: "X", price: 50, startedAt: "2026-08-13" } })); });
  expect(tree.root.findByType("div").props["data-specials"]).toBe('["p1"]');
  act(() => { l.errCb(new Error("permission_denied")); });
  expect(tree.root.findByType("div").props["data-specials"]).toBe("[]");
  act(() => { tree.unmount(); });
  vi.useRealTimers();
});

const NODE_MOCK = () => ({ offsetWidth: 1920 });

test("rail renders name, special price and struck was-price", () => {
  const specials = [
    { id: "p1", name: "Air Max 90", price: 1499, wasPrice: 1899, photoUrl: "", startedAt: "2026-08-13" },
    { id: "p2", name: "Court Tee", price: 120, wasPrice: null, startedAt: "2026-08-12" },
  ];
  let tree;
  act(() => { tree = create(<TvSpecialsRail specials={specials} />, { createNodeMock: NODE_MOCK }); });
  const text = JSON.stringify(tree.toJSON());
  expect(text).toContain("Air Max 90");
  expect(text).toContain("R1");     // R1 499 (locale-grouped)
  expect(text).toContain("499");
  expect(text).toContain("line-through");
  expect(text).toContain("Court Tee");
  expect(text).toContain("SPECIAL");
});

test("no specials → the rail renders nothing at all", () => {
  let tree;
  act(() => { tree = create(<TvSpecialsRail specials={[]} />, { createNodeMock: NODE_MOCK }); });
  expect(tree.toJSON()).toBeNull();
  act(() => { tree.update(<TvSpecialsRail specials={undefined} />); });
  expect(tree.toJSON()).toBeNull();
});
