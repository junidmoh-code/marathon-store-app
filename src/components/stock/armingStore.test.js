// ─── ARMING — THE READ, PINNED ────────────────────────────────────────────────
//
// The hard constraint on this tab is a constraint on its READS: four
// location-scoped paths and nothing else. A comment cannot hold that; this can.
//
// Run: npx vitest run src/components/stock/armingStore.test.js

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── THE FAKE, AND THE ONE RULE IT MUST REPRODUCE ─────────────────────────────
// RTDB HAS NO EMPTY CHILDREN. A node whose value becomes {} or [] is deleted,
// and reading it back gives null with exists() === false. A fake that happily
// hands back {} would let readArmingContext write `stock.hub1 = {}` and every
// storeCarries downstream would still answer "no" — a passing test over a shape
// the database cannot produce. So the fake deletes, exactly as the real one
// does, and the tests below assert on the deletion.
const NODES = {};
function setNode(path, value) {
  const empty = value == null
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === "object" && Object.keys(value).length === 0);
  if (empty) delete NODES[path];
  else NODES[path] = value;
}

const reads = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    reads.push(r.path);
    const v = Object.prototype.hasOwnProperty.call(NODES, r.path) ? NODES[r.path] : null;
    return { exists: () => v != null, val: () => v };
  },
}));
vi.mock("../../firebase", () => ({ database: { fake: true } }));

const { readArmingContext, resolveUndecided } = await import("./armingStore.js");

const cell = (qty) => ({ qty, v: 1 });

beforeEach(() => {
  for (const k of Object.keys(NODES)) delete NODES[k];
  reads.length = 0;
});

describe("readArmingContext", () => {
  it("reads FOUR location-scoped paths and no root", () => {
    setNode("stock/hub1", { p1: { 8: cell(1) } });
    setNode("stock_targets/hub2", { p1: { 8: { target: 2 } } });
    return readArmingContext().then(() => {
      expect(reads.sort()).toEqual([
        "stock/hub1", "stock/hub2", "stock_targets/hub1", "stock_targets/hub2",
      ]);
      // The reads this tab exists to avoid.
      for (const banned of ["stock", "stock_targets", "products"]) {
        expect(reads, `must never read /${banned} wholesale`).not.toContain(banned);
      }
    });
  });

  it("leaves an absent node OUT of the map rather than writing {}", async () => {
    setNode("stock/hub1", { p1: { 8: cell(1) } });
    const { stock, targets } = await readArmingContext();
    expect(Object.keys(stock)).toEqual(["hub1"]);
    expect(Object.keys(targets)).toEqual([]);
    expect("hub2" in stock).toBe(false);
  });

  it("an empty node is an ABSENT node — the database has no other shape", async () => {
    setNode("stock/hub1", {});             // the fake deletes it, as RTDB does
    const { stock } = await readArmingContext();
    expect(stock).toEqual({});
  });

  it("weighs what it actually read", async () => {
    const v = { p1: { 8: cell(1) } };
    setNode("stock/hub1", v);
    const { bytes, readCount } = await readArmingContext();
    expect(bytes).toBe(JSON.stringify(v).length);
    expect(readCount).toBe(4);
  });

  it("honours the hub list it is given", async () => {
    await readArmingContext(["hub1"]);
    expect(reads.sort()).toEqual(["stock/hub1", "stock_targets/hub1"]);
  });
});

describe("resolveUndecided", () => {
  it("reads /stock/{loc}/{pid} — the Seating tab's own scoped read", async () => {
    setNode("stock/central/p1", { 8: cell(6) });
    const { stock } = await resolveUndecided(["p1"], ["central", "trophy"]);
    expect(reads.sort()).toEqual(["stock/central/p1", "stock/trophy/p1"]);
    expect(stock).toEqual({ central: { p1: { 8: cell(6) } } });
  });

  it("merges products under one location across batches", async () => {
    const pids = Array.from({ length: 30 }, (_, i) => `p${i}`);
    for (const pid of pids) setNode(`stock/central/${pid}`, { 8: cell(1) });
    const { stock } = await resolveUndecided(pids, ["central"]);
    expect(Object.keys(stock.central).length).toBe(30);
  });

  it("reports progress so 1,500 reads are not a frozen screen", async () => {
    const pids = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const seen = [];
    await resolveUndecided(pids, ["central"], { onProgress: (n, t) => seen.push([n, t]) });
    expect(seen).toEqual([[24, 30], [30, 30]]);
  });

  it("reads nothing when there is nothing undecided", async () => {
    await resolveUndecided([], ["central"]);
    expect(reads).toEqual([]);
  });
});
