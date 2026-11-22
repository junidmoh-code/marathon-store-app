// ─── useSlicedRows — rows worked out in slices, and kept up to date ──────────
import { describe, it, expect } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useSlicedRows } from "./useSlicedRows";

const slow = () => { const t = Date.now(); while (Date.now() - t < 2) { /* a build that takes time */ } };
const row = (pid, stock) => ({ key: pid, pid, name: pid, photo: null, source: "central", stock, twin: null, dests: [{ id: "hub1", ok: true, sizes: ["8"], units: 1 }] });
let out;
function Probe({ cards, stock, version }) {
  out = useSlicedRows({ buckets: [{ id: "b", cards, build: (c) => { slow(); return row(c.pid, stock); } }], active: "b", version, ready: true });
  return null;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("useSlicedRows", () => {
  it("a pass that needs MANY slices completes, and a later change still refreshes the rows (CodeRabbit, PR #964)", async () => {
    const cards = Array.from({ length: 30 }, (_, i) => ({ pid: `p${i}` }));
    let tree;
    await act(async () => { tree = TestRenderer.create(<Probe cards={cards} stock={1} version={1} />); });
    for (let i = 0; i < 100 && !out.complete.b; i++) await act(async () => { await wait(10); });
    expect(out.complete.b).toBe(true);
    expect(out.rows.b.length).toBe(30);
    expect(out.rows.b[0].stock).toBe(1);
    // the data moves: within the throttle window the rows follow
    await act(async () => { tree.update(<Probe cards={cards} stock={7} version={2} />); });
    for (let i = 0; i < 400 && out.rows.b[29].stock !== 7; i++) await act(async () => { await wait(10); });
    expect(out.rows.b.every((r) => r.stock === 7)).toBe(true);
    // and once more — a finished pass leaves nothing behind that blocks the next
    await act(async () => { tree.update(<Probe cards={cards.slice(0, 5)} stock={9} version={3} />); });
    for (let i = 0; i < 400 && !(out.rows.b.length === 5 && out.rows.b[4].stock === 9); i++) await act(async () => { await wait(10); });
    expect(out.rows.b.map((r) => r.stock)).toEqual([9, 9, 9, 9, 9]);
  }, 20000);
});
