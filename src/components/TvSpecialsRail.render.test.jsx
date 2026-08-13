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

test("marquee → static: the strip's imperative transform is cleared", () => {
  // 6 specials overflow the 1920px mock container → marquee mode drives the
  // strip with an imperative translateX. Shrinking to 1 special flips the
  // rail static — the effect cleanup must wipe the leftover transform or the
  // centred rail stays shifted off-screen (CodeRabbit PR #362 finding).
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`, name: `S${i}`, price: 100 + i, startedAt: `2026-08-0${i + 1}`,
  }));
  const nodes = [];
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  let rafCalls = 0;
  globalThis.requestAnimationFrame = (cb) => { rafCalls += 1; if (rafCalls === 1) cb(); return rafCalls; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    let tree;
    act(() => {
      tree = create(<TvSpecialsRail specials={many} />, {
        createNodeMock: () => { const n = { offsetWidth: 1920, style: {} }; nodes.push(n); return n; },
      });
    });
    const strip = nodes.find((n) => (n.style.transform || "").includes("translateX"));
    expect(strip, "marquee should have set a translateX transform").toBeTruthy();
    act(() => { tree.update(<TvSpecialsRail specials={many.slice(0, 1)} />); });
    expect(strip.style.transform).toBe("");
  } finally {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
  }
});

test("no specials → the rail renders nothing at all", () => {
  let tree;
  act(() => { tree = create(<TvSpecialsRail specials={[]} />, { createNodeMock: NODE_MOCK }); });
  expect(tree.toJSON()).toBeNull();
  act(() => { tree.update(<TvSpecialsRail specials={undefined} />); });
  expect(tree.toJSON()).toBeNull();
});
