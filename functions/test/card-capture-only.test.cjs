// CAPTURE ONLY — the manager's phone must learn nothing about how the till did.
//
// The rule: a manager photographs the slip and that is the end of their
// involvement. No variance, no expected figure, no comparison, no verdict, no
// cashier list — and no card numbers. The owner reviews reconciliation on his
// own account (marathon-pos-app → Reports, super-admin only).
//
// This is enforced at the SERVER, not by hiding things in the UI: the callable
// simply never returns them, so no amount of poking at the phone client — or
// calling the callable directly — surfaces a figure. These tests read the
// response payloads out of the source, because that is where the guarantee
// actually lives; a UI test could only prove the current screen doesn't render
// something it was handed.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SRC = readFileSync(join(__dirname, "../cardRecon/cardRecon.js"), "utf8");

// These assertions are about CODE. The payloads carry comments explaining what
// is deliberately absent — prose that names the very things being checked for —
// so it is stripped before matching, or the explanation would fail the test.
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The object literals the callable hands back to the client. */
function responsePayloads() {
  const out = [];
  const re = /return\s*\{\s*\n\s*ok:\s*true,/g;
  let m;
  while ((m = re.exec(SRC))) {
    // Walk braces from the `{` of the return literal to its match.
    const start = SRC.indexOf("{", m.index);
    let depth = 0;
    for (let i = start; i < SRC.length; i++) {
      if (SRC[i] === "{") depth++;
      else if (SRC[i] === "}") {
        depth--;
        if (depth === 0) { out.push(stripComments(SRC.slice(start, i + 1))); break; }
      }
    }
  }
  return out;
}

// Anything that tells a manager how their till did, or identifies a card.
const FORBIDDEN = [
  ["varianceCents", /\bvarianceCents\s*:/],
  ["expectedCardCents", /\bexpectedCardCents\s*:/],
  ["expectedByKind", /\bexpectedByKind\s*:/],
  ["expectedChangedSinceReview", /\bexpectedChangedSinceReview\s*:/],
  ["cashiers", /\bcashiers\s*:/],
  ["lines (they carry a masked PAN each)", /\blines\s*:/],
];

test("every client response the callable makes is scanned (else these tests prove nothing)", () => {
  // THREE now: the photo extract, the PDF extract, and submit. This count is
  // the thing that makes the checks below meaningful — a new response path
  // that nobody added here would return whatever it liked, unscanned. It
  // caught exactly that when the PDF path was added.
  assert.equal(responsePayloads().length, 3,
    "a response path was added or removed — scan it, then update this count");
});

for (const [what, pattern] of FORBIDDEN) {
  test(`no client response carries ${what}`, () => {
    for (const payload of responsePayloads()) {
      assert.ok(!pattern.test(payload), `a client response still returns ${what}:\n${payload}`);
    }
  });
}

test("no client response carries a pan under any spelling", () => {
  for (const payload of responsePayloads()) {
    assert.ok(!/\bpan\b/i.test(payload), `a client response mentions a PAN:\n${payload}`);
  }
});

test("the manager still gets what they need to act: the slip total they can check, and whether lines landed", () => {
  const submit = responsePayloads().find((p) => /batchKey:/.test(p));
  assert.ok(submit, "no submit payload found");
  // The slip total is on the paper in their hand — echoing it is a read check,
  // not a disclosure — and linesCaptured is the one fact that changes what
  // they do next (reshoot the roll, or walk away).
  assert.match(submit, /slipTotalCents:/);
  assert.match(submit, /linesCaptured:/);
});

test("the figures are still COMPUTED and STORED — withheld from the phone, not discarded", () => {
  // The owner's review depends on every one of these being on the record.
  assert.match(SRC, /expected\s*=\s*await/, "expected card takings are no longer computed");
  assert.match(SRC, /buildBatchRecord\(/, "the record builder is gone");
  // buildBatchRecord is handed the expected figures and the cashier list.
  const call = SRC.slice(SRC.indexOf("buildBatchRecord("));
  const block = call.slice(0, call.indexOf("});") + 3);
  assert.match(block, /expected/, "the record no longer stores the expected figures");
  assert.match(block, /cashiers/, "the record no longer stores the cashier trail");
});

// ─── THE CONTIGUITY EXEMPTION IS SERVER-DECIDED ──────────────────────────────
// A banking report is exempt from TSN contiguity; a photographed slip is not.
// That exemption keys off `extraction.format`, so it must never be settable by
// a caller — otherwise a photographed roll with a missing line could claim to
// be a banking report and slip past the one check that catches it.
test("no client-supplied field can set the extraction's format", () => {
  const src = require("node:fs").readFileSync(require.resolve("../cardRecon/cardRecon.js"), "utf8");
  // Everything the callable reads off the request, in one place.
  const fromRequest = [...src.matchAll(/request\.data(?:\s*\|\|\s*\{\})?\s*\.?\s*([A-Za-z]+)?/g)]
    .map((m) => m[1]).filter(Boolean);
  assert.ok(!fromRequest.includes("format"),
    `the callable reads a "format" off the request: ${fromRequest.join(", ")}`);
  assert.ok(!fromRequest.includes("windowSource"), "…nor a windowSource");
  assert.ok(!fromRequest.includes("extraction"), "…nor a whole extraction");
  // And the two places format IS set are both parser output, not input.
  const assigned = [...src.matchAll(/format:\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(assigned, [], "the callable itself never literal-assigns a format; the parsers do");
});

// ─── THE MATCH NOTES MUST NOT FALL SILENT ON AN OFFSETTING PAIR ──────────────
// An unmatched refund and an unmatched purchase of the same size sum to zero
// cents. Deciding whether to warn on the SUM would then say nothing about two
// transactions nobody can account for — precisely the case the notes exist for.
test("the match notes are decided by counts, never by sums", () => {
  const src = require("node:fs").readFileSync(require.resolve("../cardRecon/cardRecon.js"), "utf8");
  const notes = src.slice(src.indexOf("function matchNotes("), src.indexOf("async function matchBatch("));
  assert.ok(notes.length > 200, "matchNotes must still be there to check");

  for (const sumTest of ["offTillCents !== 0", "unmatchedLegCents !== 0", "unmatchedTxnCents !== 0"]) {
    assert.ok(!notes.includes(`if (match.${sumTest})`),
      `matchNotes still gates a warning on a SUM (${sumTest}) — an offsetting refund silences it`);
  }
  for (const countTest of ["offTillMatches.length", "match.unmatchedLegsOnTill.length", "match.unmatchedTxns.length"]) {
    assert.ok(notes.includes(countTest), `matchNotes must gate on ${countTest}`);
  }
});
