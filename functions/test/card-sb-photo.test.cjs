// lib/card-sb-photo.cjs — where a read Standard Bank report is filed (7 Nov 2026).
// Built against Marathon PE Till 2's REAL paper: no settlement on 4 Nov, so
// #561 = 3 Nov, #562 = 3 Nov 17:08 → 5 Nov 16:53, #563 = 5 Nov → 6 Nov — while
// the portal had numbered 3, 4 and 5 Nov as 561, 562 and 563.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planSbFiling, isSyntheticRecord, typedCheck } = require("../lib/card-sb-photo.cjs");

const SAST = (s) => Date.parse(`${s}+02:00`);
const rec = (batchNo, closed, over = {}) => ({ batchNo, revision: 1, capturedVia: "photo", slip: { closedAt: SAST(closed) }, ...over });
const portal = (batchNo, day, over = {}) => rec(batchNo, `${day}T23:59:59`, { capturedVia: "simplyblu-portal", ...over });
const staffTyped = (batchNo, closed) => rec(batchNo, closed, { capturedVia: "typed", declaredTotal: { via: "staff-slip", cents: 1 } });
const R = (key, record) => ({ key, record });

const P561 = R("561", portal(561, "2026-11-03"));
const P562 = R("562", portal(562, "2026-11-04"));
const P563 = R("563", portal(563, "2026-11-05"));
const B561 = { printedBatchNo: 561, openedAt: SAST("2026-11-02T17:01:40"), closedAt: SAST("2026-11-03T17:08:38") };
const B562 = { printedBatchNo: 562, openedAt: SAST("2026-11-03T17:08:35"), closedAt: SAST("2026-11-05T16:53:43") };
const B563 = { printedBatchNo: 563, openedAt: SAST("2026-11-05T16:53:40"), closedAt: SAST("2026-11-06T17:05:58") };
// The records a plan sees: the window's, and the printed number's chain.
const view = (all, b) => {
  const from = new Date(b.openedAt + 2 * 3600e3).toISOString().slice(0, 10);
  const to = new Date(b.closedAt + 2 * 3600e3).toISOString().slice(0, 10);
  const day = (r) => new Date(r.record.slip.closedAt + 2 * 3600e3).toISOString().slice(0, 10);
  const windowRecords = all.filter((r) => day(r) >= from && day(r) <= to);
  const chain = all.filter((r) => Number(r.record.batchNo) === b.printedBatchNo).sort((x, y) => (x.record.revision || 1) - (y.record.revision || 1));
  const highestOnFile = Math.max(...all.map((r) => Number(r.record.batchNo)));
  return { ...b, windowRecords, printedInForce: chain.at(-1) || null, highestOnFile };
};
// Apply a plan the way handleSubmit does: the record, then the displaced marks.
function file(all, b) {
  const plan = planSbFiling(view(all, b));
  const chain = all.filter((r) => Number(r.record.batchNo) === plan.batchNo);
  const revision = plan.mode === "over" || chain.length ? chain.length + 1 : 1;
  const key = revision === 1 ? String(plan.batchNo) : `${plan.batchNo}-r${revision}`;
  const out = all.map((r) => (plan.displace.includes(r.key) ? R(r.key, { ...r.record, displacedBy: key }) : r));
  out.push(R(key, rec(plan.batchNo, new Date(b.closedAt + 2 * 3600e3).toISOString().slice(0, 19), {
    revision, ...(plan.batchNo !== b.printedBatchNo ? { printedBatchNo: b.printedBatchNo } : {}) })));
  return { plan, all: out, key };
}
// What Junid's report draws: every chain's latest, minus displaced records.
const drawn = (all) => {
  const latest = new Map();
  for (const r of all) { const b = Number(r.record.batchNo); if (!latest.has(b) || r.record.revision > latest.get(b).record.revision) latest.set(b, r); }
  return [...latest.values()].filter((r) => !r.record.displacedBy).map((r) => r.key).sort();
};

test("synthetic: the portal's day and a staff-typed total; never a photo, an email or Junid's manual entry", () => {
  assert.equal(isSyntheticRecord(portal(1, "2026-11-03").valueOf()), true);
  assert.equal(isSyntheticRecord(staffTyped(1, "2026-11-03T18:50:00")), true);
  assert.equal(isSyntheticRecord(rec(1, "2026-11-03T17:00:00")), false);
  assert.equal(isSyntheticRecord(rec(1, "2026-11-03T17:00:00", { capturedVia: "pdf" })), false);
  assert.equal(isSyntheticRecord(rec(1, "2026-11-03T17:00:00", { capturedVia: "manual" })), false);
  assert.equal(isSyntheticRecord(rec(1, "2026-11-03T17:00:00", { capturedVia: "typed", declaredTotal: { byEmail: "gunidmoh@gmail.com" } })), false);
});

test("nothing on file: the printed number, as every report", () => {
  assert.deepEqual(planSbFiling({ printedBatchNo: 564, openedAt: SAST("2026-11-06T17:06:00"), closedAt: SAST("2026-11-07T17:05:00") }),
    { batchNo: 564, correction: false, mode: "normal", displace: [] });
});

for (const order of [["561", "562", "563"], ["563", "562", "561"], ["562", "563", "561"]]) {
  test(`PE Till 2's real 3–6 Nov, read in the order ${order.join(", ")}: each under its printed number, one card per day, nothing renumbered`, () => {
    let all = [R("560", rec(560, "2026-11-02T17:01:42")), P561, P562, P563];
    const papers = { 561: B561, 562: B562, 563: B563 };
    const keys = {};
    for (const n of order) {
      const r = file(all, papers[n]);
      assert.notEqual(r.plan.mode, "renumbered", `#${n}: ${r.plan.note}`);
      assert.equal(r.plan.batchNo, Number(n), `#${n} keeps its printed number`);
      all = r.all; keys[n] = r.key;
    }
    // 560 + one card per real report; every portal day is superseded or displaced.
    assert.deepEqual(drawn(all), ["560", keys[561], keys[562], keys[563]].sort());
    assert.ok(all.filter((r) => r.record.capturedVia === "simplyblu-portal").every((r) => r.record.displacedBy || all.some((x) => x.record.batchNo === r.record.batchNo && x.record.revision > r.record.revision)));
    // …and the next real batch, #564 on 7 Nov, is plain.
    assert.deepEqual(planSbFiling(view(all, { printedBatchNo: 564, openedAt: SAST("2026-11-06T17:06:00"), closedAt: SAST("2026-11-07T17:05:00") })),
      { batchNo: 564, correction: false, mode: "normal", displace: [] });
  });
}

test("#562 (3→5 Nov) takes over the portal's 4 Nov (its number, inside its window) and displaces 5 Nov", () => {
  const p = planSbFiling(view([P561, P562, P563], B562));
  assert.equal(p.mode, "over");
  assert.equal(p.supersedes, "562");
  assert.deepEqual(p.displace, ["563"]);
  assert.match(p.note, /covers 2026-11-05 \(563\)/);
});

test("a second photo of the same report is the ordinary duplicate rule's, never a second card", () => {
  let all = [P561, P562, P563];
  all = file(all, B562).all;
  const again = planSbFiling(view(all, B562));
  assert.deepEqual(again, { batchNo: 562, correction: false, mode: "normal", displace: [] });
});

test("the same day's staff-typed record is taken over too (the photo outranks staff)", () => {
  const p = planSbFiling(view([R("564", staffTyped(564, "2026-11-07T18:50:00"))], { printedBatchNo: 564, openedAt: SAST("2026-11-06T17:06:00"), closedAt: SAST("2026-11-07T17:05:00") }));
  assert.equal(p.mode, "over");
  assert.equal(p.batchNo, 564);
  assert.match(p.note, /typed on the Card Slip/);
});

test("a staff-typed record of the same day under ANOTHER number is displaced, the report keeps its own", () => {
  const p = planSbFiling(view([R("570", staffTyped(570, "2026-11-07T18:50:00"))], { printedBatchNo: 564, openedAt: SAST("2026-11-06T17:06:00"), closedAt: SAST("2026-11-07T17:05:00") }));
  assert.equal(p.mode, "normal");
  assert.equal(p.batchNo, 564);
  assert.deepEqual(p.displace, ["570"]);
});

test("the printed number belongs to a portal day OUTSIDE the report's window → the next free number; that day untouched", () => {
  // Concrete: the portal numbered 30 Oct–6 Nov as 1–8; a real #3 printed for 8 Nov.
  const all = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => R(String(n), portal(n, `2026-${n <= 2 ? "10" : "11"}-${String(n <= 2 ? 29 + n : n - 2).padStart(2, "0")}`)));
  const p = planSbFiling(view(all, { printedBatchNo: 3, openedAt: SAST("2026-11-07T17:00:00"), closedAt: SAST("2026-11-08T17:00:00") }));
  assert.equal(p.mode, "renumbered");
  assert.equal(p.batchNo, 9);
  assert.deepEqual(p.displace, []);
  assert.match(p.note, /prints batch #3; that number is already used by the SimplyBLU portal's record for 2026-11-01, so this report is filed as #9/);
});

test("a real report of another day holding the number → normal (the duplicate / re-print rules decide)", () => {
  const p = planSbFiling(view([R("3", rec(3, "2026-11-01T17:00:00"))], { printedBatchNo: 3, openedAt: SAST("2026-11-07T17:00:00"), closedAt: SAST("2026-11-08T17:00:00") }));
  assert.equal(p.mode, "normal");
  assert.equal(p.batchNo, 3);
});

test("typed check: the read figure is the record; a difference is flagged, a match is not", () => {
  assert.equal(typedCheck(null, 100), null);
  assert.deepEqual(typedCheck(100, 100), { typedCents: 100, readCents: 100, differs: false });
  assert.deepEqual(typedCheck(100, 150), { typedCents: 100, readCents: 150, differs: true });
  assert.deepEqual(typedCheck(100, null), { typedCents: 100, readCents: null, differs: false });
});
