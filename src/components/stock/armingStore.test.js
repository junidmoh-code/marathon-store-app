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
// The delete is RECURSIVE. RTDB removes a key whose value becomes empty at EVERY
// depth, not only at the node a write addressed — so `{ p1: {} }` is a shape the
// database cannot hold, and a fake that kept it would let a test pass over an
// impossible fixture. `[]` is pruned identically: RTDB cannot store an empty
// array, and a last-child delete on one removes the key outright.
function prune(value) {
  if (value == null) return undefined;
  if (typeof value !== "object") return value;
  const arr = Array.isArray(value);
  const out = arr ? [] : {};
  let kept = 0;
  for (const k of Object.keys(value)) {
    const v = prune(value[k]);
    if (v === undefined) continue;
    out[k] = v; kept += 1;
  }
  return kept ? out : undefined;
}
function setNode(path, value) {
  const pruned = prune(value);
  if (pruned === undefined) delete NODES[path];
  else NODES[path] = pruned;
}

const reads = [];
// A hook the concurrency test swaps in to watch how many reads are in flight at
// once. Default is a no-op, so every other test is unaffected.
let gate = null;
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    reads.push(r.path);
    if (gate) await gate();
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
  gate = null;
});

// ── THE SUBSCRIPTIONS THE HOOKS OPEN ────────────────────────────────────────
// This module opens none — it is the ONE file on the Arming path that touches
// firebase/database, and the assertion below is what makes "four one-shot
// get()s" a fact about the code rather than a sentence in a comment. The two
// listeners the TAB opens (/locations, /config/refillEngine) come from
// ./useStock, which every render suite mocks, so they are named in
// armingStore.js's header instead. (Adversarial review, PR #601.)
describe("the read surface", () => {
  it("imports exactly `ref` and `get` — no listener, no writer", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./armingStore.js", import.meta.url), "utf8");
    expect(src).toContain('import { ref, get } from "firebase/database";');
    // COMMENTS STRIPPED. This file's header names onValue in order to say which
    // listeners the TAB opens; matching against prose would fail on its own
    // honesty.
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const banned of ["onValue", ".set(", "update(", "remove(", "runTransaction", "httpsCallable"]) {
      expect(code, `armingStore must not use ${banned}`).not.toContain(banned);
    }
  });

  it("and neither does armingCore or the tab itself", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["./armingCore.js", "./ArmingTab.jsx"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(code, `${f} must not import firebase/database`).not.toContain("firebase/database");
    }
  });
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

  it("…at every depth, and for an empty ARRAY as much as an empty object", async () => {
    // RTDB cannot store an empty array and cannot hold an empty child. A product
    // whose last cell is deleted takes the product key with it; a location left
    // with no products takes the location. storeCarries asks whether the product
    // map exists and is non-empty, so a fake that kept `{ p1: {} }` would be
    // testing a state the database cannot produce.
    setNode("stock/hub1", { p1: {}, p2: [], p3: { 8: cell(1) } });
    const { stock } = await readArmingContext();
    expect(Object.keys(stock.hub1)).toEqual(["p3"]);

    setNode("stock/hub2", { p1: { 8: [] } });
    const again = await readArmingContext();
    expect(again.stock.hub2).toBeUndefined();
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

  it("reports progress in PRODUCTS, which is the unit the screen names", async () => {
    const pids = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const seen = [];
    await resolveUndecided(pids, ["central"], { onProgress: (n, t) => seen.push([n, t]) });
    expect(seen).toEqual([[24, 30], [30, 30]]);
    expect(seen[seen.length - 1]).toEqual([30, 30]);
  });

  it("…and still in products when there are several locations per product", async () => {
    const pids = Array.from({ length: 6 }, (_, i) => `p${i}`);
    const seen = [];
    await resolveUndecided(pids, ["central", "trophy", "hub3"], { onProgress: (n, t) => seen.push([n, t]) });
    // 18 jobs, batches of 24 → one pass, and progress must land on 6/6, not
    // 18/6 or 24/6.
    expect(seen).toEqual([[6, 6]]);
  });

  it("bounds the REQUESTS in flight, not the products", async () => {
    // The batch used to slice the product list and then multiply each product by
    // every location, so a "batch of 24" put 24 × 8 = 192 gets on the wire at
    // once. The comment claimed the opposite. (CodeRabbit, PR #601.)
    let live = 0, peak = 0;
    gate = async () => { live += 1; peak = Math.max(peak, live); await Promise.resolve(); live -= 1; };
    const pids = Array.from({ length: 40 }, (_, i) => `p${i}`);
    await resolveUndecided(pids, ["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(peak).toBeLessThanOrEqual(24);
    expect(peak).toBeGreaterThan(1);      // not accidentally serialised
  });

  it("counts its own reads, so the screen can add them to the bill", async () => {
    const { readCount } = await resolveUndecided(["p1", "p2"], ["central", "trophy"]);
    expect(readCount).toBe(4);
  });

  it("reads nothing when there is nothing undecided", async () => {
    await resolveUndecided([], ["central"]);
    expect(reads).toEqual([]);
  });
});
