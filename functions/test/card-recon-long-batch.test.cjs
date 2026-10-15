// ─── A BATCH NOBODY CLOSED IS STILL A BATCH ──────────────────────────────────
// Trophy Till 1's terminal (TID 67325636) opened batch 69 at 10:01 on 5 Oct
// 2026, the morning it was swapped in, and it was never closed. FNB emailed a
// fuller report of it every afternoon; from 12 Oct each one was refused as
// "transactions span more than 7 days … one of the dates was misread". The
// dates are the PDF's own text — nothing was misread. These use the real files.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readSlipPdfLines, parseSlipPdf } = require("../lib/card-recon-pdf.cjs");
const { validateExtraction, comparePriorCapture, MAX_WINDOW_MS, MAX_LONG_BATCH_MS } = require("../lib/card-recon.cjs");
const { computeExpectedCard, cardLegsInWindow } = require("../lib/card-expected.cjs");

const real = (name) => require(`./fixtures/card-recon-real/${name}.lines.json`);
const DAY1 = "20261005-67325636-b69-accepted-batch69-day1-m414";
const SNAPSHOTS = [
  "20261012-67325636-b69-refused-long-batch-m515",
  "20261013-67325636-b69-refused-long-batch-m531",
  "20261013-67325636-b69-refused-long-batch-m533",
  "20261014-67325636-b69-refused-long-batch-m548",
  "20261015-67325636-b69-refused-long-batch-m560",
];
const DAY = 86400000;

test("Trophy Till 1 batch 69 (15 Oct report) is recorded, with the long-batch warning", () => {
  const out = readSlipPdfLines(real(SNAPSHOTS.at(-1)));
  assert.equal(out.ok, true, out.reason);
  const e = out.extraction;
  assert.equal(e.tid, "67325636");
  assert.equal(e.batchNo, "69");
  assert.equal(e.lines.length, 64);
  assert.equal(e.txnCount, 64);
  assert.equal(e.lines.reduce((s, l) => s + l.amountCents, 0), e.totalCents, "the lines still sum to the printed total");
  assert.ok(e.closedAt - e.openedAt > MAX_WINDOW_MS);
  assert.ok(out.warnings.includes("This batch ran 10 days — the terminal was not closed daily."), out.warnings.join(" | "));
});

test("every daily snapshot of batch 69 EXTENDS the one before — so it supersedes, never doubles", () => {
  // The recorded chain is 69 → 69-r3 (5–7 Oct). Each later report must be a
  // strictly fuller account of the earlier, which is the only thing the
  // automatic supersede lets through. A "conflict" or "shrinks" here would
  // mean the files disagree with each other, and would still refuse.
  let prev = parseSlipPdf(real(DAY1)).extraction.lines;
  for (const name of SNAPSHOTS) {
    const next = parseSlipPdf(real(name)).extraction.lines;
    const rel = comparePriorCapture(prev, next).relation;
    // m533 is the same afternoon as m531 plus one sale; both are extensions.
    assert.equal(rel, "extends", `${name} should extend the previous report`);
    prev = next;
  }
});

test("a PHOTO's window over 7 days is still refused as a misread date", () => {
  const e = { ...readSlipPdfLines(real(SNAPSHOTS.at(-1))).extraction };
  const conf = Object.fromEntries(["tid", "batchNo", "totalCents", "openedAt", "closedAt", "purchasesCents", "txnCount"].map((k) => [k, 0.99]));
  const v = validateExtraction({ ...e, confidence: conf, format: "printed", windowSource: "printed" }, { source: "photo" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /longer than 7 days — one of the dates was misread/);
  // …and an emailed report that did NOT come from a PDF gets no exemption either.
  const v2 = validateExtraction({ ...e, confidence: conf }, { source: "photo" });
  assert.equal(v2.ok, false);
  assert.match(v2.reason, /more than 7 days/);
});

test("past the long-batch ceiling, even an exact PDF is refused — to Junid, not to a photo", () => {
  const e = { ...readSlipPdfLines(real(SNAPSHOTS.at(-1))).extraction };
  const v = validateExtraction({ ...e, openedAt: e.closedAt - MAX_LONG_BATCH_MS - DAY }, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /span 32 days — longer than the 31 days/);
  assert.match(v.reason, /tell Junid/);
});

// The ledger read a long window becomes: the same indexed range on `at`,
// bounded to the window — never the whole node.
function recordingDb(calls) {
  return {
    ref(path) {
      return {
        orderByChild(field) {
          return { startAt(s) { return { endAt(e) { return { async once() { calls.push({ path, field, s, e }); return { val: () => ({}) }; } }; } }; } };
        },
      };
    },
  };
}

test("the expected-takings query for a 10-day batch is a bounded range on the `at` index", async () => {
  const e = readSlipPdfLines(real(SNAPSHOTS.at(-1))).extraction;
  const calls = [];
  await computeExpectedCard(recordingDb(calls), { storeId: "pe", tillId: "till-1", startMs: e.openedAt, endMs: e.closedAt });
  await cardLegsInWindow(recordingDb(calls), { startMs: e.openedAt, endMs: e.closedAt });
  assert.deepEqual(calls.map((c) => [c.path, c.field, c.s, c.e]), [
    ["pos/paymentEvents", "at", e.openedAt, e.closedAt],
    ["pos/paymentEvents", "at", e.openedAt, e.closedAt],
  ]);
});

test("the query still refuses a window past the ceiling, whatever validated it", async () => {
  const calls = [];
  await assert.rejects(computeExpectedCard(recordingDb(calls), { storeId: "pe", tillId: "till-1", startMs: 0, endMs: MAX_LONG_BATCH_MS + 1 }), /long-batch cap/);
  await assert.rejects(cardLegsInWindow(recordingDb(calls), { startMs: 0, endMs: MAX_LONG_BATCH_MS + 1 }), /long-batch cap/);
  assert.equal(calls.length, 0, "nothing was read");
});
