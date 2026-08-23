// ─── merge-disposition tests — the merge decides, and never destroys a count ──
// Behavioural: every assertion is about what happens to a quantity, never about
// the shape of a function. The properties pinned here are the ones a mutation
// has to break to matter:
//   • a counted survivor cell REMOVES the loser's units at that cell;
//   • an uncounted location TRANSFERS them;
//   • a counted LOSER cell transfers — a verified count is never written off;
//   • a staled or unsettled record is not a count;
//   • nothing about Hub 1 is special: the same world with the counts moved to
//     Hub 2 gives the mirrored answer.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  countCellKey, countRecordCounts, countedCellKeys, dispositionForCell, planMerge,
} = require("../lib/merge-disposition.cjs");

const L = "pLoser";
const S = "pSurvivor";

const keys = (...ks) => new Set(ks);

test("a cell counted under the SURVIVOR removes the loser's units there", () => {
  const d = dispositionForCell({
    loserId: L, survivorId: S, sizeKey: "9",
    countedKeys: keys(countCellKey(S, "9")),
  });
  assert.equal(d, "remove");
});

test("a cell nobody counted transfers — the merge's original behaviour", () => {
  assert.equal(dispositionForCell({ loserId: L, survivorId: S, sizeKey: "9", countedKeys: keys() }), "transfer");
});

test("a cell counted under the LOSER transfers — a verified count is never written off", () => {
  const d = dispositionForCell({
    loserId: L, survivorId: S, sizeKey: "9",
    countedKeys: keys(countCellKey(L, "9"), countCellKey(S, "9")),
  });
  assert.equal(d, "transfer");
});

test("the count is per SIZE, not per product: size 9 counted, size 10 not", () => {
  const countedKeys = keys(countCellKey(S, "9"));
  assert.equal(dispositionForCell({ loserId: L, survivorId: S, sizeKey: "9", countedKeys }), "remove");
  assert.equal(dispositionForCell({ loserId: L, survivorId: S, sizeKey: "10", countedKeys }), "transfer");
});

test("a FLAG record is a count — the shelf was physically counted, only the stock write is pending", () => {
  // flagCell writes { action: "flag", settled: true } when the counter typed a
  // shelf number that disagreed with the book and left the correction to an
  // admin. The shelf WAS counted; the loser's units under it are the double
  // count. Decision recorded in merge-disposition.cjs countRecordCounts.
  assert.equal(countRecordCounts({ action: "flag", actual: 11, expected: 17, settled: true }), true);
  assert.equal(dispositionForCell({ loserId: L, survivorId: S, sizeKey: "9",
    countedKeys: new Set([countCellKey(S, "9")]) }), "remove");
});

test("a staled record is not a count; an unsettled one is not either", () => {
  assert.equal(countRecordCounts({ actual: 3, settled: true }), true);
  assert.equal(countRecordCounts({ actual: 3, settled: true, staleAt: 123 }), false);
  assert.equal(countRecordCounts({ actual: 3, settled: false }), false);
  assert.equal(countRecordCounts(null), false);
  const node = {
    [countCellKey(S, "9")]: { settled: true },
    [countCellKey(S, "10")]: { settled: true, staleAt: 1 },
    [countCellKey(S, "11")]: { settled: false },
  };
  assert.deepEqual([...countedCellKeys(node)], [countCellKey(S, "9")]);
});

test("one merge, a counted location AND an uncounted one, handled together", () => {
  const plan = planMerge({
    loserId: L, survivorId: S,
    loserCells: {
      hub1: { "9": { qty: 6 }, "10": { qty: 2 } },
      central: { "9": { qty: 16 } },
    },
    countedByLoc: {
      hub1: keys(countCellKey(S, "9"), countCellKey(S, "10")),
      central: keys(),
    },
  });
  const byLoc = Object.fromEntries(plan.map((r) => [r.loc, r]));
  assert.equal(byLoc.hub1.removeQty, 8);
  assert.equal(byLoc.hub1.transferQty, 0);
  assert.equal(byLoc.central.transferQty, 16);
  assert.equal(byLoc.central.removeQty, 0);
});

test("no hub is hardcoded — move the counts to hub2 and the answer follows", () => {
  const loserCells = { hub1: { "9": { qty: 5 } }, hub2: { "9": { qty: 5 } } };
  const first = planMerge({
    loserId: L, survivorId: S, loserCells,
    countedByLoc: { hub1: keys(countCellKey(S, "9")), hub2: keys() },
  });
  const second = planMerge({
    loserId: L, survivorId: S, loserCells,
    countedByLoc: { hub1: keys(), hub2: keys(countCellKey(S, "9")) },
  });
  assert.equal(first.find((r) => r.loc === "hub1").removeQty, 5);
  assert.equal(first.find((r) => r.loc === "hub2").transferQty, 5);
  assert.equal(second.find((r) => r.loc === "hub1").transferQty, 5);
  assert.equal(second.find((r) => r.loc === "hub2").removeQty, 5);
});

test("a negative cell keeps its sign in the plan, on both dispositions", () => {
  const plan = planMerge({
    loserId: L, survivorId: S,
    loserCells: { hub3: { "9": { qty: -2 } }, hub1: { "9": { qty: -3 } } },
    countedByLoc: { hub1: keys(countCellKey(S, "9")), hub3: keys() },
  });
  assert.equal(plan.find((r) => r.loc === "hub3").transferQty, -2);
  assert.equal(plan.find((r) => r.loc === "hub1").removeQty, -3);
});

test("a zero cell is neither transferred nor removed — the node delete takes it", () => {
  const plan = planMerge({
    loserId: L, survivorId: S,
    loserCells: { hub1: { "9": { qty: 0 } } },
    countedByLoc: { hub1: keys(countCellKey(S, "9")) },
  });
  assert.deepEqual(plan, []);
});

test("an EMPTY count state can never remove anything — a failed read is safe", () => {
  const plan = planMerge({
    loserId: L, survivorId: S,
    loserCells: { hub1: { "9": { qty: 6 } }, central: { "9": { qty: 16 } } },
    countedByLoc: {},   // nothing readable
  });
  assert.equal(plan.reduce((n, r) => n + r.removeQty, 0), 0);
  assert.equal(plan.reduce((n, r) => n + r.transferQty, 0), 22);
});
