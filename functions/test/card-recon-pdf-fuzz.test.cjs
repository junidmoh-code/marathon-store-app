// ─── THE PROPERTY THAT MATTERS: NEVER SILENTLY WRONG ─────────────────────────
// A card-recon figure becomes a cash variance against a named person's till.
// The owner's rule is that a wrong figure is worse than no figure, so the
// parser has exactly two acceptable outcomes for any slip:
//
//     the EXACT figures that were printed,   or   a refusal with a reason.
//
// "Close enough" is the failure. That is a property, not an example, so this
// file fuzzes it: thousands of randomised slips are fed through the real
// parser, and each result is checked against the figures the generator KNOWS
// it printed. A parse that returns numbers must return the right ones; a parse
// that cannot is required to say so.
//
// Randomised, but SEEDED — a failure prints its seed and replays exactly.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSlipPdf } = require("../lib/card-recon-pdf.cjs");
const { validateExtraction } = require("../lib/card-recon.cjs");
const { slipLines, emailedLines, realReportLines, REAL_REPORT, FNB_FURNITURE } = require("./fixtures/makeSlipPdf.cjs");

// THE PIPELINE AS THE CALLABLE RUNS IT. parseSlipPdf only READS; the slip's own
// arithmetic is validateExtraction's job. Fuzzing the reader alone would call a
// corrupted-but-well-formed figure a silent error when the very next check
// refuses it — so the property is asserted over both, exactly as
// handleExtractPdf composes them.
function readSlip(lines) {
  const out = parseSlipPdf(lines);
  if (!out.ok) return out;
  const v = validateExtraction(out.extraction, { summaryOnly: false, source: "pdf" });
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, extraction: out.extraction, warnings: v.warnings };
}

// Deterministic PRNG (mulberry32) — a seed reproduces a run exactly.
function rng(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, max) => Math.floor(r() * max);
const rands = (c) => {
  const neg = c < 0;
  const s = (Math.abs(c) / 100).toFixed(2);
  const [whole, frac] = s.split(".");
  return `${neg ? "-" : ""}R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

// Build a slip whose true figures we hold, so any returned number is checkable.
function randomSlip(r) {
  const n = 1 + pick(r, 6);
  const rows = [];
  let purchases = 0, refunds = 0;
  for (let i = 0; i < n; i++) {
    const isRefund = r() < 0.25;
    const amt = 100 + pick(r, 5000000);
    if (isRefund) refunds += amt; else purchases += amt;
    rows.push(`2026/08/26 1${i}:0${i}:11 UTI000000${i} 22334455667${i} K9Q2Z${i} ${100 + i} ************111${i} ${rands(amt)}${isRefund ? " REFUND" : ""}`);
  }
  const total = purchases - refunds;
  return {
    truth: { purchasesCents: purchases, refundsCents: refunds, totalCents: total, count: n },
    lines: slipLines({ txns: rows, count: n, purchases: rands(purchases), refunds: rands(refunds), total: rands(total) }),
  };
}

test("2000 well-formed slips: the parser returns the printed figures EXACTLY, or refuses", () => {
  const r = rng(20260829);
  let parsed = 0, refused = 0;
  for (let i = 0; i < 2000; i++) {
    const { truth, lines } = randomSlip(r);
    const out = readSlip(lines);
    if (!out.ok) { refused++; assert.ok(out.reason && out.reason.length > 10, `refusal ${i} carries no reason`); continue; }
    parsed++;
    const ex = out.extraction;
    assert.equal(ex.purchasesCents, truth.purchasesCents, `slip ${i}: purchases`);
    assert.equal(ex.refundsCents, truth.refundsCents, `slip ${i}: refunds`);
    assert.equal(ex.totalCents, truth.totalCents, `slip ${i}: total`);
    assert.equal(ex.lines.length, truth.count, `slip ${i}: line count`);
    const sum = ex.lines.reduce((a, l) => a + l.amountCents, 0);
    assert.equal(sum, truth.totalCents, `slip ${i}: detail lines do not sum to the printed total`);
  }
  // A parser that refused everything would satisfy every assertion above.
  assert.ok(parsed > 1900, `only ${parsed}/2000 well-formed slips parsed — the parser has become useless`);
  assert.equal(refused, 2000 - parsed);
});

// ── CORRUPTION FUZZ: the half that actually guards the owner's rule ──────────
// A well-formed slip is mutated the way a real file goes wrong — a character
// swapped for a lookalike, a column collision, a digit doubled, a stray token.
// The parser may refuse (right) or parse (fine) — but if it parses, the figure
// must still be the one printed. A DIFFERENT number is the bug.
const CORRUPTIONS = [
  (s) => s.replace(/0/, "O"),                  // letter O for zero
  (s) => s.replace(/1/, "l"),                  // letter l for one
  (s) => s.replace(/,/, ""),                   // a separator lost
  (s) => s.replace(/,/, "."),                  // separator becomes a point
  (s) => s.replace(/\./, ","),                 // point becomes a separator
  (s) => s.replace(/R/, ""),                   // currency mark lost
  (s) => s.replace(/(\d)/, "$1$1"),            // a digit doubled
  (s) => s.replace(/\s+/, "  "),               // a column collision
  (s) => s.replace(/-/, "−"),             // unicode minus
  (s) => s + " 0.00",                          // a trailing stray figure
  (s) => "  " + s,                             // leading indent
  (s) => s.replace(/(\d)\.(\d\d)/, "($1.$2)"), // parenthesised negative
];

test("6000 corrupted slips: a figure is EXACT or refused — never quietly different", () => {
  const r = rng(778899);
  let parsed = 0, refused = 0;
  for (let i = 0; i < 6000; i++) {
    const { truth, lines } = randomSlip(r);
    const idx = pick(r, lines.length);
    const corrupt = CORRUPTIONS[pick(r, CORRUPTIONS.length)];
    const mangled = lines.slice();
    mangled[idx] = corrupt(String(mangled[idx]));
    if (mangled[idx] === lines[idx]) continue;   // corruption did not apply

    const out = readSlip(mangled);
    if (!out.ok) {
      refused++;
      assert.ok(out.reason && /\S/.test(out.reason), `corrupt slip ${i} refused with no reason`);
      continue;
    }
    parsed++;
    const ex = out.extraction;
    // It parsed a corrupted slip. Acceptable only if the corruption missed the
    // figures — so every figure must STILL be exact.
    for (const f of ["purchasesCents", "refundsCents", "totalCents"]) {
      assert.equal(ex[f], truth[f],
        `SILENTLY WRONG FIGURE — seed 778899, iteration ${i}\n` +
        `  corrupted line: ${JSON.stringify(mangled[idx])}\n` +
        `  was:            ${JSON.stringify(lines[idx])}\n` +
        `  ${f}: parser said ${ex[f]}, slip printed ${truth[f]}`);
    }
    const sum = ex.lines.reduce((a, l) => a + l.amountCents, 0);
    assert.equal(sum, truth.totalCents,
      `iteration ${i}: detail lines sum to ${sum}, slip printed ${truth.totalCents}\n  line: ${JSON.stringify(mangled[idx])}`);
  }
  assert.ok(refused > 0, "no corruption was refused — the fuzz is not reaching the guards");
  assert.ok(parsed > 0, "every corruption was refused — the fuzz produces no benign cases");
});

// ═══ THE SAME PROPERTY, ON THE EMAILED BANKING REPORT ════════════════════════
// Exactly right, or refused — the format makes no difference to the rule. What
// DOES differ is the shape being fuzzed: gapped TSNs, a Batch column between
// the TSN and the PAN, ZAR amounts, and a window derived from the transactions
// rather than printed. Each of those is somewhere a reader can go quietly wrong.

// A report whose figures we hold: random gapped TSNs, random amounts, some
// refunds, with or without the batch column.
function randomReport(r) {
  const n = 1 + pick(r, 12);
  const tsns = [];
  let next = 1 + pick(r, 5);
  for (let i = 0; i < n; i++) { tsns.push(next); next += 1 + pick(r, 4); }   // GAPS by construction
  const amounts = tsns.map(() => 100 + pick(r, 500000));
  const refundTsns = tsns.filter(() => r() < 0.2);
  return emailedLines({
    tsns, amountsCents: amounts, refundTsns,
    batchColumn: r() < 0.5,
    batchNo: 1 + pick(r, 999),
    tid: String(60000000 + pick(r, 9999999)),
  });
}

test("2000 well-formed banking reports read EXACTLY, gaps and all", () => {
  const r = rng(590059);
  let parsed = 0, gappy = 0;
  for (let i = 0; i < 2000; i++) {
    const { truth, lines } = randomReport(r);
    const out = readSlip(lines);
    if (!out.ok) { assert.ok(out.reason && out.reason.length > 10); continue; }
    parsed++;
    const ex = out.extraction;
    assert.equal(ex.format, "emailed", `report ${i}: read as the wrong format`);
    assert.equal(ex.purchasesCents, truth.purchasesCents, `report ${i}: purchases`);
    assert.equal(ex.refundsCents, truth.refundsCents, `report ${i}: refunds`);
    assert.equal(ex.totalCents, truth.totalCents, `report ${i}: total`);
    assert.equal(ex.lines.length, truth.count, `report ${i}: line count`);
    // The TSNs are the report's own, gaps preserved — never renumbered, and
    // never the batch column read forty times over.
    assert.deepEqual(ex.lines.map((l) => l.tsn), truth.tsns, `report ${i}: TSNs`);
    assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), truth.totalCents, `report ${i}: line sum`);
    // The derived window must contain every transaction it was derived from.
    const times = ex.lines.map((l) => l.at);
    assert.equal(ex.windowSource, "transactions");
    assert.ok(Math.min(...times) >= ex.openedAt && Math.max(...times) < ex.closedAt,
      `report ${i}: a transaction falls outside its own derived window`);
    if (truth.tsns.some((t, k) => k > 0 && t !== truth.tsns[k - 1] + 1)) gappy++;
  }
  assert.ok(parsed > 1900, `only ${parsed}/2000 well-formed reports parsed — the reader has become useless`);
  assert.ok(gappy > 1500, `only ${gappy} reports had TSN gaps — the fuzz is not exercising the exemption`);
});

test("6000 corrupted banking reports: EXACT or refused, never quietly different", () => {
  const r = rng(660066);
  let parsed = 0, refused = 0;
  for (let i = 0; i < 6000; i++) {
    const { truth, lines } = randomReport(r);
    const idx = pick(r, lines.length);
    const corrupt = CORRUPTIONS[pick(r, CORRUPTIONS.length)];
    const mangled = lines.slice();
    mangled[idx] = corrupt(String(mangled[idx]));
    if (mangled[idx] === lines[idx]) continue;

    const out = readSlip(mangled);
    if (!out.ok) { refused++; assert.ok(out.reason && /\S/.test(out.reason)); continue; }
    parsed++;
    const ex = out.extraction;
    for (const f of ["purchasesCents", "refundsCents", "totalCents"]) {
      assert.equal(ex[f], truth[f],
        `SILENTLY WRONG FIGURE — seed 660066, iteration ${i}\n` +
        `  corrupted line: ${JSON.stringify(mangled[idx])}\n` +
        `  was:            ${JSON.stringify(lines[idx])}\n` +
        `  ${f}: reader said ${ex[f]}, report printed ${truth[f]}`);
    }
    assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), truth.totalCents,
      `iteration ${i}: rows sum wrong — line ${JSON.stringify(mangled[idx])}`);
  }
  assert.ok(refused > 0, "no corruption was refused — the fuzz is not reaching the guards");
  assert.ok(parsed > 0, "every corruption was refused — the fuzz produces no benign cases");
});

test("a report is never read as a slip, nor a slip as a report", () => {
  // The dispatcher is fuzzed too: whichever format goes in must come out, or
  // the wrong reader's rules get applied to the wrong document.
  const r = rng(4242);
  for (let i = 0; i < 300; i++) {
    const emailed = readSlip(randomReport(r).lines);
    if (emailed.ok) assert.equal(emailed.extraction.format, "emailed");
    const printed = readSlip(slipLines());
    if (printed.ok) assert.equal(printed.extraction.format, "printed");
  }
});

// ═══ THE REAL REPORT, WITH ITS FURNITURE SCATTERED ═══════════════════════════
// The clean fuzz above proves the reader exact on a tidy document. The real one
// is seven pages with FNB's address block and page footers interleaved between
// the transactions — money labels followed by digits, sitting wherever the page
// happened to break. Scattering that furniture at random is the property test
// for "page furniture is never a figure".
test("4000 real-shaped reports with furniture scattered through them", () => {
  const r = rng(590712);
  const { lines: clean } = realReportLines();
  // Every distinct furniture line the real document carries, plus the shapes
  // that actually broke the first reader.
  const JUNK = [
    ...FNB_FURNITURE(3),
    "Total pages 7", "Refunds enquiries 0860 12 34 56", "Cash enquiries 0860 12 34 56",
    "Purchase queries 0860 12 34 56", "This is not a tax invoice",
    "Settlement reference 998877", "Items dispatched 0",
  ];
  let parsed = 0;
  for (let i = 0; i < 4000; i++) {
    const lines = clean.slice();
    const howMany = 1 + pick(r, 5);
    for (let k = 0; k < howMany; k++) {
      lines.splice(pick(r, lines.length + 1), 0, JUNK[pick(r, JUNK.length)]);
    }
    const out = readSlip(lines);
    assert.equal(out.ok, true,
      `furniture refused a good report (seed 590712, iteration ${i}): ${out.reason}`);
    parsed++;
    const ex = out.extraction;
    // Not merely "it parsed" — every figure must be the report's own.
    assert.equal(ex.tid, REAL_REPORT.tid, `iteration ${i}: terminal`);
    assert.equal(ex.batchNo, String(REAL_REPORT.batchNo), `iteration ${i}: batch`);
    assert.equal(ex.txnCount, REAL_REPORT.items, `iteration ${i}: items`);
    assert.equal(ex.lines.length, REAL_REPORT.items, `iteration ${i}: rows read`);
    assert.equal(ex.totalCents, REAL_REPORT.totalCents, `iteration ${i}: total`);
    assert.equal(ex.refundsCents, 0, `iteration ${i}: furniture invented a refund`);
    assert.equal(ex.cashCents, 0, `iteration ${i}: furniture invented a cash figure`);
    assert.equal(ex.lines.reduce((a, l) => a + l.amountCents, 0), REAL_REPORT.totalCents,
      `iteration ${i}: rows no longer sum to the total`);
  }
  assert.equal(parsed, 4000);
});
