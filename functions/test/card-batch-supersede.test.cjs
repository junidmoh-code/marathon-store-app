// ─── A FULLER REPORT OF THE SAME BATCH ───────────────────────────────────────
// The case is real and dated: Marathon Till 1 (TID 67325636) left batch 58 open
// overnight on 18 Sept 2026. The terminal emailed an interim report that
// evening — 11 approved, R7,620 — which was recorded. It settled the following
// afternoon and emailed the FINAL report for the same batch 58: 48 approved and
// one declined, R43,530, spanning 18 Sept 11:25 → 19 Sept 16:12.
//
// The dedup refused the final report as a duplicate, all day, invisibly, and
// left that till R35,910 short in every figure that reads /card_batches.
//
// These tests pin the narrow rule that lets it through — and, just as
// importantly, every neighbouring case that must still refuse. A rule that only
// ever said yes would pass the first test in this file and be a disaster.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { comparePriorCapture, resolveBatchWrite } = require("../lib/card-recon.cjs");
const { resolveWriteFor } = require("../cardRecon/cardRecon.js");

/** The first eleven approved lines of batch 58, as recorded on the 18th. */
const INTERIM = [
  { tsn: 2, amountCents: 60000, rrn: "04YUTM058002" },
  { tsn: 3, amountCents: 24000, rrn: "04YUTM058003" },
  { tsn: 4, amountCents: 15000, rrn: "04YUTM058004" },
  { tsn: 5, amountCents: 30000, rrn: "04YUTM058005" },
  { tsn: 6, amountCents: 45000, rrn: "04YUTM058006" },
  { tsn: 7, amountCents: 90000, rrn: "04YUTM058007" },
  { tsn: 8, amountCents: 12000, rrn: "04YUTM058008" },
  { tsn: 10, amountCents: 80000, rrn: "04YUTM058010" },
  { tsn: 11, amountCents: 55000, rrn: "04YUTM058011" },
  { tsn: 12, amountCents: 20000, rrn: "04YUTM058012" },
  { tsn: 13, amountCents: 31000, rrn: "04YUTM058013" },
];

/** The same eleven, plus everything the terminal went on to approve. */
const FINAL = [
  ...INTERIM,
  { tsn: 15, amountCents: 70000, rrn: "04YUTM058015" },
  { tsn: 16, amountCents: 25000, rrn: "04YUTM058016" },
  { tsn: 55, amountCents: 215000, rrn: "04YUTM058055" },
];

// ── comparePriorCapture ──────────────────────────────────────────────────────

test("the final report is an EXTENSION of the interim one", () => {
  const cmp = comparePriorCapture(INTERIM, FINAL);
  assert.equal(cmp.relation, "extends");
  assert.deepEqual(cmp.added, [15, 16, 55]);
  assert.equal(cmp.reason, null);
});

test("a re-send of the same report is IDENTICAL, not an extension", () => {
  // The case the dedup was built for and must keep refusing: Marathon Till 3
  // sent batch 79 four times on 19 Sept 2026.
  assert.equal(comparePriorCapture(INTERIM, INTERIM).relation, "identical");
  // Order is not identity — the lists are compared as sets of TSNs.
  assert.equal(comparePriorCapture(INTERIM, [...INTERIM].reverse()).relation, "identical");
});

test("a report MISSING a recorded line is not an extension", () => {
  // Fewer lines than the record, even though it also adds one. That is a
  // contradiction about what the terminal processed, not more information.
  const partial = [...INTERIM.slice(0, 5), { tsn: 99, amountCents: 100, rrn: "x" }];
  const cmp = comparePriorCapture(INTERIM, partial);
  assert.equal(cmp.relation, "shrinks");
  assert.match(cmp.reason, /6 transactions this report does not/);
});

test("a shared TSN with a DIFFERENT amount is a conflict", () => {
  const tampered = FINAL.map((l) => (l.tsn === 4 ? { ...l, amountCents: 15900 } : l));
  const cmp = comparePriorCapture(INTERIM, tampered);
  assert.equal(cmp.relation, "conflict");
  assert.match(cmp.reason, /number 4 reads differently/);
});

test("a shared TSN with a different RRN is a conflict", () => {
  const tampered = FINAL.map((l) => (l.tsn === 7 ? { ...l, rrn: "04YUTM999999" } : l));
  assert.equal(comparePriorCapture(INTERIM, tampered).relation, "conflict");
});

test("an RRN absent on one side is not a disagreement", () => {
  // The printed slip and the emailed report do not always read the same
  // fields, and a blank says nothing either way.
  const noRrn = FINAL.map((l) => ({ tsn: l.tsn, amountCents: l.amountCents }));
  assert.equal(comparePriorCapture(INTERIM, noRrn).relation, "extends");
});

test("a record with no lines is never treated as contained", () => {
  // A summary-only photo capture records a total and no lines. "More lines
  // than none" must not count as containment, or any report could displace it.
  const cmp = comparePriorCapture([], FINAL);
  assert.equal(cmp.relation, "unknown");
  assert.match(cmp.reason, /no transaction lines/);
});

test("a report with no lines cannot extend anything", () => {
  assert.equal(comparePriorCapture(INTERIM, []).relation, "unknown");
});

test("rows with no usable TSN are ignored, not counted", () => {
  const noisy = [...FINAL, { amountCents: 500 }, null, { tsn: "x", amountCents: 1 }];
  assert.equal(comparePriorCapture(INTERIM, noisy).relation, "extends");
});

// ── resolveBatchWrite ────────────────────────────────────────────────────────

test("a strictly fuller report writes 58-r2 and says it was automatic", () => {
  const w = resolveBatchWrite({ existingKeys: ["58"], batchNo: 58, correction: false, extends: true });
  assert.equal(w.ok, true);
  assert.equal(w.key, "58-r2");
  assert.equal(w.revision, 2);
  assert.equal(w.supersedes, "58");
  assert.equal(w.autoSuperseded, true);
});

test("a re-send is still refused", () => {
  const w = resolveBatchWrite({ existingKeys: ["58"], batchNo: 58, correction: false, extends: false });
  assert.equal(w.ok, false);
  assert.match(w.reason, /already captured/);
});

test("a deliberate correction is NOT marked auto-superseded", () => {
  // Both routes produce a revision; the record has to be able to tell which
  // one moved the figure.
  const w = resolveBatchWrite({ existingKeys: ["58"], batchNo: 58, correction: true, extends: false });
  assert.equal(w.ok, true);
  assert.equal(w.autoSuperseded, false);
});

test("a caller that passes no flag at all gets the OLD behaviour", () => {
  // Every caller opts in explicitly. A missing flag can only ever refuse, so a
  // path that has not been considered cannot start superseding by accident.
  assert.equal(resolveBatchWrite({ existingKeys: ["58"], batchNo: 58, correction: false }).ok, false);
});

test("a first capture is unaffected by the new flag", () => {
  const w = resolveBatchWrite({ existingKeys: [], batchNo: 58, correction: false, extends: true });
  assert.equal(w.key, "58");
  assert.equal(w.revision, 1);
  assert.equal(w.supersedes, null);
  assert.equal(w.autoSuperseded, false);
});

test("an auto-supersede still stops at the revision ceiling", () => {
  // MAX_REVISIONS is 20, so the chain has to be genuinely at the ceiling —
  // a short fixture would pass whatever the code did.
  const deep = ["58", ...Array.from({ length: 19 }, (_, i) => `58-r${i + 2}`)];
  assert.equal(deep.length, 20);
  const w = resolveBatchWrite({ existingKeys: deep, batchNo: 58, correction: false, extends: true });
  assert.equal(w.ok, false);
  assert.match(w.reason, /not a correction chain any more/);
});

test("it chains onto the highest revision, not the first key", () => {
  const w = resolveBatchWrite({ existingKeys: ["58", "58-r2"], batchNo: 58, correction: false, extends: true });
  assert.equal(w.key, "58-r3");
  assert.equal(w.supersedes, "58-r2");
});

// ── resolveWriteFor, against a database ──────────────────────────────────────
// The rule above is pure; what it is ASKED is not. These run the real server
// seam over a fake RTDB shaped like the live one.

/**
 * A database that answers from a map of paths. `lines` is stored the way the
 * live record stores it — keyed by TSN — and one fixture deliberately uses the
 * ARRAY-COERCED shape RTDB produces for dense integer keys, holes and all.
 */
function fakeDb(paths) {
  return {
    ref: (path) => ({
      once: async () => ({
        exists: () => paths[path] !== undefined,
        val: () => (paths[path] === undefined ? null : paths[path]),
      }),
      child: () => { throw new Error("not used"); },
    }),
  };
}

const linesByTsn = (rows) => Object.fromEntries(rows.map((l) => [String(l.tsn), l]));

test("the fuller report of batch 58 is accepted against a live-shaped record", async () => {
  const db = fakeDb({
    "card_batches/pe/67325636/58/batchKey": "58",
    "card_batches/pe/67325636/58/lines": linesByTsn(INTERIM),
  });
  const { write, comparison } = await resolveWriteFor(db, {
    storeId: "pe", tid: "67325636", batchNo: 58, correction: false, lines: FINAL,
  });
  assert.equal(comparison.relation, "extends");
  assert.equal(write.ok, true);
  assert.equal(write.key, "58-r2");
  assert.equal(write.autoSuperseded, true);
});

test("the same report arriving twice is refused against a live-shaped record", async () => {
  const db = fakeDb({
    "card_batches/pe/67365901/79/batchKey": "79",
    "card_batches/pe/67365901/79/lines": linesByTsn(INTERIM),
  });
  const { write } = await resolveWriteFor(db, {
    storeId: "pe", tid: "67365901", batchNo: 79, correction: false, lines: INTERIM,
  });
  assert.equal(write.ok, false);
  assert.match(write.reason, /already captured/);
});

test("a contradicting report is refused, and the refusal NAMES the contradiction", async () => {
  // "Batch #58 is already captured" is the right sentence for a re-send and
  // the wrong one for a report that disagrees with the record — that is a
  // thing somebody has to look at, and the message has to say so.
  const db = fakeDb({
    "card_batches/pe/67325636/58/batchKey": "58",
    "card_batches/pe/67325636/58/lines": linesByTsn(INTERIM),
  });
  const conflicting = FINAL.map((l) => (l.tsn === 4 ? { ...l, amountCents: 99900 } : l));
  const { write } = await resolveWriteFor(db, {
    storeId: "pe", tid: "67325636", batchNo: 58, correction: false, lines: conflicting,
  });
  assert.equal(write.ok, false);
  assert.match(write.reason, /does not agree with it/);
  assert.match(write.reason, /number 4 reads differently/);
  assert.doesNotMatch(write.reason, /resubmit as a correction/);
});

test("ARRAY-COERCED lines with null holes are read, and the holes skipped", async () => {
  // RTDB turns dense integer-like keys into a real array with null holes —
  // 560 of 5,793 /stock rows were in that shape on 15 Sept 2026. A loop that
  // reads a hole as a transaction would see a TSN of NaN and refuse a report
  // that is perfectly sound.
  const arrayShaped = [];
  for (const l of INTERIM) arrayShaped[l.tsn] = l;   // holes at 0, 1 and 9
  assert.equal(arrayShaped[9], undefined, "the fixture must actually contain a hole");
  const db = fakeDb({
    "card_batches/pe/67325636/58/batchKey": "58",
    "card_batches/pe/67325636/58/lines": arrayShaped,
  });
  const { write, comparison } = await resolveWriteFor(db, {
    storeId: "pe", tid: "67325636", batchNo: 58, correction: false, lines: FINAL,
  });
  assert.equal(comparison.relation, "extends");
  assert.equal(write.ok, true);
});

test("a first capture never reads the lines node at all", async () => {
  // Nothing is recorded, so there is nothing to compare — and a read that
  // cannot change the answer is bandwidth spent on every first capture.
  const asked = [];
  const db = {
    ref: (path) => { asked.push(path); return {
      once: async () => ({ exists: () => false, val: () => null }) }; },
  };
  const { write } = await resolveWriteFor(db, {
    storeId: "pe", tid: "67325636", batchNo: 58, correction: false, lines: FINAL,
  });
  assert.equal(write.ok, true);
  assert.equal(asked.some((p) => p.endsWith("/lines")), false);
});

test("a correction never reads the lines node either", async () => {
  // A correction is already a deliberate supersede; containment is not asked.
  const asked = [];
  const db = {
    ref: (path) => { asked.push(path); return {
      once: async () => ({ exists: () => path.endsWith("/58/batchKey"), val: () => "58" }) }; },
  };
  const { write } = await resolveWriteFor(db, {
    storeId: "pe", tid: "67325636", batchNo: 58, correction: true, lines: FINAL,
  });
  assert.equal(write.ok, true);
  assert.equal(write.autoSuperseded, false);
  assert.equal(asked.some((p) => p.endsWith("/lines")), false);
});
