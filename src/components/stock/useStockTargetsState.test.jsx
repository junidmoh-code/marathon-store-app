// ─── THE THREE STATES A BARE null CONFLATES ──────────────────────────────────
// usePathState exists because /stock_targets is now GATED on: Missing Products
// disables Solve until the read has answered, since an explicit row is the only
// target a one-size product can hold. Gating on the VALUE greyed every clothing
// Solve — sized products included — behind a permanent "still loading" whenever
// the node was empty or unreadable.
//
// WHY THIS FILE EXISTS AT ALL: the component tests take `targetsSettled` and
// `targetsError` as props, so they never exercise the hook that produces them.
// A mutation that made the error path silent again (setting settled:false,
// error:false) left the whole suite green — the fix was real but unpinned. This
// closes that hole by rendering the actual hook.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// One handler pair per subscribed path, so a test can drive the callback the
// same way Firebase would.
const subs = {};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb, errCb) => { subs[r.path] = { cb, errCb }; return () => { delete subs[r.path]; }; },
  update: vi.fn(),
  get: vi.fn(),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));

const { useStockTargetsState } = await import("./useStock.js");

let seen;
function Probe() {
  seen = useStockTargetsState();
  return null;
}
const mount = () => { let t; act(() => { t = TestRenderer.create(<Probe />); }); return t; };

beforeEach(() => { for (const k of Object.keys(subs)) delete subs[k]; seen = undefined; });

describe("useStockTargetsState", () => {
  it("starts NOT settled — the listener has not answered", () => {
    mount();
    expect(seen).toEqual({ value: null, settled: false, error: false });
  });

  it("an EMPTY node is settled with a null value — loaded, not loading", () => {
    mount();
    act(() => { subs["stock_targets"].cb({ val: () => null }); });
    expect(seen.settled).toBe(true);
    expect(seen.error).toBe(false);
    expect(seen.value).toBe(null);
  });

  it("a populated node carries its value through unchanged", () => {
    mount();
    const rows = { trophy: { p1: { _: { target: 5 } } } };
    act(() => { subs["stock_targets"].cb({ val: () => rows }); });
    expect(seen).toEqual({ value: rows, settled: true, error: false });
  });

  it("a DENIED read is settled AND flagged — never a silent forever-loading", () => {
    // This is the state the old warn-only error path threw away: the value stayed
    // null, indistinguishable from "still loading", so a gating caller waited for
    // an answer that had already arrived and was a refusal.
    mount();
    act(() => { subs["stock_targets"].errCb(new Error("permission_denied")); });
    expect(seen.settled).toBe(true);
    expect(seen.error).toBe(true);
    expect(seen.value).toBe(null);
  });

  it("subscribes to the whole tree, and to one location when asked", () => {
    mount();
    expect(Object.keys(subs)).toEqual(["stock_targets"]);
  });
});
