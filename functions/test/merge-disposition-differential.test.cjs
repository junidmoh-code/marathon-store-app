// ─── THE TWO COPIES MUST AGREE — a differential fuzz, not a table ─────────────
// mergeDisposition exists twice on purpose: the client renders the outcome per
// location before the operator confirms, and the server decides it again from
// its own reads. If they ever disagree, the screen states one thing and the
// merge does another — on stock.
//
// A hand-written table only proves the cases somebody thought of. This runs
// BOTH copies over the same randomised worlds and compares the whole plan,
// which is what catches the case nobody thought of (the lesson from the engine
// mirror: two reviews missed what one fuzz found).
//
// The generator deliberately produces the awkward shapes: negative quantities,
// zero cells, half-size keys, the one-size sentinel, counted records on the
// loser, on the survivor, on both and on neither, staled and unsettled records,
// and locations with no count session at all.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const server = require("../lib/merge-disposition.cjs");

// A tiny deterministic PRNG — a fuzz that cannot be replayed is not evidence.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const LOCS = ["hub1", "hub2", "hub3", "central", "marathon-pine", "trophy"];
const SIZES = ["6", "7", "9", "10", "5_5", "_", "11"];

function makeWorld(rand) {
  const loserId = "L";
  const survivorId = "S";
  const loserCells = {};
  const countedByLoc = {};
  const countedNodes = {};
  for (const loc of LOCS) {
    if (rand() < 0.35) continue;                       // loser holds nothing here
    const cells = {};
    for (const size of SIZES) {
      if (rand() < 0.6) continue;
      const roll = rand();
      const qty = roll < 0.15 ? 0 : roll < 0.35 ? -Math.ceil(rand() * 4) : Math.ceil(rand() * 20);
      cells[size] = { qty, v: Math.floor(rand() * 9) };
    }
    if (!Object.keys(cells).length) continue;
    loserCells[loc] = cells;

    // The counted node for this location, in the RAW shape the database holds
    // — so both copies fold it with their own countedCellKeys.
    const node = {};
    if (rand() < 0.7) {
      for (const size of SIZES) {
        for (const [pid, p] of [[loserId, 0.25], [survivorId, 0.55]]) {
          if (rand() > p) continue;
          const r = rand();
          node[`${pid}::${size}`] = r < 0.15
            ? { settled: true, staleAt: 1 }
            : r < 0.25
              ? { settled: false }
              : { settled: true, action: "confirm", actual: Math.floor(rand() * 10) };
        }
      }
    }
    countedNodes[loc] = node;
    countedByLoc[loc] = server.countedCellKeys(node);
  }
  return { loserId, survivorId, loserCells, countedNodes, countedByLoc };
}

test("the client mirror and the server module produce the SAME plan, 600 random worlds", async () => {
  const client = await import("../../src/components/stock/mergeDisposition.js");
  let worldsWithRemovals = 0;
  let worldsWithTransfers = 0;
  for (let seed = 1; seed <= 600; seed += 1) {
    const rand = rng(seed);
    const { loserId, survivorId, loserCells, countedNodes } = makeWorld(rand);

    // Each copy folds the RAW nodes itself — a drift in countedCellKeys or in
    // countRecordCounts has to show up here, not just a drift in the planner.
    const serverCounted = {};
    const clientCounted = {};
    for (const [loc, node] of Object.entries(countedNodes)) {
      serverCounted[loc] = server.countedCellKeys(node);
      clientCounted[loc] = client.countedCellKeys(node);
    }
    const a = server.planMerge({ loserId, survivorId, loserCells, countedByLoc: serverCounted });
    const b = client.planMerge({ loserId, survivorId, loserCells, countedByLoc: clientCounted });
    assert.deepStrictEqual(b, a, `seed ${seed}: the screen and the server disagree`);

    if (a.some((r) => r.removeQty !== 0)) worldsWithRemovals += 1;
    if (a.some((r) => r.transferQty !== 0)) worldsWithTransfers += 1;
  }
  // A fuzz that never exercised either branch would pass vacuously.
  assert.ok(worldsWithRemovals > 50, `only ${worldsWithRemovals} worlds produced a removal — the fuzz is too tame`);
  assert.ok(worldsWithTransfers > 50, `only ${worldsWithTransfers} worlds produced a transfer`);
});

test("every planned quantity is one of the loser's own cell quantities — nothing is invented", async () => {
  const client = await import("../../src/components/stock/mergeDisposition.js");
  for (let seed = 700; seed <= 780; seed += 1) {
    const { loserId, survivorId, loserCells, countedByLoc } = makeWorld(rng(seed));
    const plan = client.planMerge({ loserId, survivorId, loserCells, countedByLoc });
    for (const row of plan) {
      const cells = loserCells[row.loc];
      for (const c of [...row.transfer, ...row.remove]) {
        assert.strictEqual(c.qty, cells[c.sizeKey].qty, `seed ${seed}: ${row.loc}/${c.sizeKey}`);
      }
      // and every non-zero cell is accounted for exactly once
      const planned = new Set([...row.transfer, ...row.remove].map((c) => c.sizeKey));
      const expected = Object.entries(cells).filter(([, c]) => c.qty !== 0).map(([k]) => k);
      assert.deepStrictEqual([...planned].sort(), expected.sort(), `seed ${seed}: ${row.loc}`);
    }
  }
});
