// Reading a batch report out of the terminal's own PDF.
//
// The rule the whole path is built on: THE TEXT IS READ EXACTLY OR THIS
// REFUSES. There is no fuzzy match and no second, looser attempt — a wrong
// figure here becomes a recorded variance against a named person's till, and
// no figure is strictly better than a wrong one. Every test below is either
// "this is read exactly" or "this refuses, by name".
//
// The PDFs are REAL PDFs built by the fixture, not mocks, so pdfjs's actual
// fragment-and-position behaviour is exercised — text arrives as
// "MERCHANT", " ", "ID", " ", "000..." and the line reassembly is what turns it
// back into something a label can match. Mocking that away would test nothing.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeSlipPdf, makeSlipPdfFragmented, slipLines } = require("./fixtures/makeSlipPdf.cjs");
const { pdfToLines } = require("../cardRecon/pdfText.js");
const { parseSlipPdf, moneyField } = require("../lib/card-recon-pdf.cjs");
const { validateExtraction, dedupeLines } = require("../lib/card-recon.cjs");

const read = async (lines, opts) => pdfToLines(makeSlipPdf(lines, opts));
const parseOf = async (lines) => {
  const t = await read(lines);
  assert.equal(t.ok, true, t.reason);
  return parseSlipPdf(t.lines);
};

test("lines are rebuilt from glyph POSITIONS, not from item order", async () => {
  // pdfjs splits a line into many items. Joining them in item order would run
  // one printed line into the next and make every label match meaningless.
  const t = await read(["MERCHANT ID  000000004977890", "TERMINAL ID  0000HP1X"]);
  assert.equal(t.ok, true);
  assert.deepEqual(t.lines, ["MERCHANT ID 000000004977890", "TERMINAL ID 0000HP1X"]);
});

test("a whole slip reads exactly", async () => {
  const p = await parseOf(slipLines());
  assert.equal(p.ok, true, p.reason);
  const e = p.extraction;
  assert.equal(e.tid, "0000HP1X");
  assert.equal(e.mid, "000000004977890");
  assert.equal(e.batchNo, "494");
  assert.equal(e.txnCount, 2);
  assert.equal(e.purchasesCents, 5035500);
  assert.equal(e.refundsCents, 4800);          // magnitude by contract
  assert.equal(e.cashCents, 0);                // absent means zero, as on the roll
  assert.equal(e.totalCents, 5030700);
  assert.equal(e.reconLine, "500 - Reconciled, in balance");
  assert.equal(e.confidence, null, "a PDF has no confidence to record, and must not invent one");
  assert.equal(e.lines.length, 2);
});

test("the slip's own arithmetic holds, so validation passes", async () => {
  const p = await parseOf(slipLines());
  const v = validateExtraction(p.extraction, { source: "pdf" });
  assert.equal(v.ok, true, v.reason);
});

test("every transaction field comes off the line, and a refund is signed", async () => {
  const p = await parseOf(slipLines());
  const [purchase, refund] = p.extraction.lines;
  assert.deepEqual(
    { tsn: purchase.tsn, uti: purchase.uti, rrn: purchase.rrn, authCode: purchase.authCode, pan: purchase.pan, type: purchase.type, amountCents: purchase.amountCents },
    { tsn: 101, uti: "UTI0000001", rrn: "223344556677", authCode: "K9Q2Z1", pan: "************1111", type: "purchase", amountCents: 5035500 },
  );
  assert.equal(refund.type, "refund");
  assert.equal(refund.amountCents, -4800, "a refund is negative so it sums like the ledger does");
  assert.ok(Number.isInteger(purchase.at), "the printed date+time becomes an epoch");
});

test("a trailing REFUND marker after the amount does not lose the line", async () => {
  // Found the hard way: anchoring the amount to end-of-line dropped the refund
  // silently. The line-count check would have caught it as a refusal — but a
  // parser that drops lines and relies on a later check to notice is one
  // layout change away from being wrong.
  const p = await parseOf(slipLines());
  assert.equal(p.extraction.lines.length, 2);
  assert.equal(p.extraction.lines.length, p.extraction.txnCount);
});

// ── REFUSALS, each by name ──────────────────────────────────────────────────
const refuses = (name, mutate, expected) => test(`REFUSES: ${name}`, async () => {
  const p = await parseOf(mutate(slipLines()));
  assert.equal(p.ok, false, "this must not be read at all");
  assert.match(p.reason, expected);
});

refuses("no terminal ID anywhere",
  (l) => l.filter((x) => !/TERMINAL ID/.test(x)), /terminal ID/i);
refuses("no batch number",
  (l) => l.filter((x) => !/Batch Report/.test(x)), /batch number/i);
refuses("no Opened time",
  (l) => l.filter((x) => !/^Opened/.test(x)), /Opened time/i);
refuses("no Closed time",
  (l) => l.filter((x) => !/^Closed/.test(x)), /Closed time/i);
refuses("no Transactions count",
  (l) => l.filter((x) => !/^Transactions/.test(x)), /Transactions count/i);
refuses("no purchases figure",
  (l) => l.filter((x) => !/Purchases/.test(x)), /purchases figure/i);
refuses("no TOTAL",
  (l) => l.filter((x) => !/^TOTAL/.test(x)), /TOTAL/);
refuses("a TOTAL that is not an amount",
  (l) => l.map((x) => (/^TOTAL/.test(x) ? "TOTAL   R5O,307.00" : x)), /not an amount/i);
refuses("an Opened time that is not a date",
  (l) => l.map((x) => (/^Opened/.test(x) ? "Opened   2026/13/45 99:99:99" : x)), /not a date/i);
refuses("a transaction line with no sequence number",
  (l) => l.map((x) => x.replace(" K9Q2Z1 101 ", " K9Q2Z1 ")), /no sequence number/i);

test("REFUSES a PDF with no text at all — a scan, not the terminal's file", async () => {
  const t = await read([]);
  assert.equal(t.ok, false);
  assert.match(t.reason, /no text|scan/i);
  assert.match(t.reason, /[Pp]hotograph the slip/, "a refusal must name the way forward");
});

test("REFUSES something that is not a PDF at all", async () => {
  const t = await pdfToLines(Buffer.from("this is a photograph, renamed", "utf8"));
  assert.equal(t.ok, false);
  assert.match(t.reason, /could not be opened as a PDF/i);
});

test("a MANGLED figure is refused, never truncated to a smaller one", async () => {
  // The bug this test exists for. Capturing "the digits after the label"
  // matched `R5O,307.00` up to the letter O and yielded R5.00 — a wrong figure,
  // recorded, as a variance against a named person's till. Found by this
  // suite before the path ever ran. The whole remainder must parse or refuse.
  for (const bad of ["R5O,307.00", "R50,307.OO", "R50,307.00 CR", "R50,307,00.5", "R50,3070.00"]) {
    const p = await parseOf(slipLines().map((x) => (/^TOTAL/.test(x) ? `TOTAL   ${bad}` : x)));
    assert.equal(p.ok, false, `"${bad}" must be refused, not read`);
    assert.match(p.reason, /not an amount/i);
    assert.match(p.reason, /Nothing was recorded/, "the refusal must say nothing was taken from it");
  }
});

test("a section HEADING that repeats a money word is skipped, not mistaken for a figure", async () => {
  // "CARD TOTALS" sits above the figures and matches /total/. Treating its
  // empty remainder as a broken amount would refuse every valid slip.
  const p = await parseOf(slipLines());
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.extraction.totalCents, 5030700, "the figure came from the row, not the heading");
});

test("moneyField reports missing, broken and found as three different things", () => {
  const re = /\btotals?\b\s*[:.]?\s*(.*)$/i;
  assert.deepEqual(moneyField(["nothing here"], re, "a TOTAL"), { missing: true });
  assert.deepEqual(moneyField(["CARD TOTALS", "TOTAL R1.00"], re, "a TOTAL"), { cents: 100 });
  assert.ok(moneyField(["TOTAL R1.OO"], re, "a TOTAL").err, "a broken figure is an error, not a miss");
});

// ── the checks that must apply to BOTH sources ──────────────────────────────
test("arithmetic that does not hold is refused, exactly as for photos", async () => {
  const p = await parseOf(slipLines({ total: "R99,999.00" }));
  assert.equal(p.ok, true, "the figures PARSE — it is the sum that is wrong");
  const v = validateExtraction(p.extraction, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /don't add up/i);
});

test("a line count short of the printed Transactions figure is refused", async () => {
  const p = await parseOf(slipLines({ count: 5 }));
  const v = validateExtraction(p.extraction, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /says 5 transactions but 2 lines were read/);
});

test("a TSN gap is refused", async () => {
  const p = await parseOf(slipLines({ txns: [
    "2026/08/26 19:02:11 UTI0000001 223344556677 K9Q2Z1 101 ************1111 R30,000.00",
    "2026/08/26 19:30:00 UTI0000003 223344556679 K9Q2Z3 103 ************3333 R20,355.00",
  ], purchases: "R50,355.00", refunds: "R48.00", total: "R50,307.00" }) );
  const v = validateExtraction(p.extraction, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not contiguous/);
});

test("a window longer than 7 days is refused", async () => {
  const p = await parseOf(slipLines().map((x) => (/^Closed/.test(x) ? "Closed   2026/09/26 18:50:04" : x)));
  const v = validateExtraction(p.extraction, { source: "pdf" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /longer than 7 days/);
});

test("the confidence gate is skipped for a PDF, and ONLY the confidence gate", async () => {
  const p = await parseOf(slipLines());
  // No confidence object at all — under the photo rules this is an instant
  // refusal, which is exactly why the source has to be passed through.
  assert.equal(p.extraction.confidence, null);
  assert.equal(validateExtraction(p.extraction, { source: "photo" }).ok, false);
  assert.equal(validateExtraction(p.extraction, { source: "pdf" }).ok, true);
});

test("a PDF with lines is never summary-only", async () => {
  const p = await parseOf(slipLines());
  assert.ok(p.extraction.lines.length > 0);
  const v = validateExtraction(p.extraction, { summaryOnly: false, source: "pdf" });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.warnings.some((w) => /Summary only/i.test(w)), false);
});

test("a duplicated printed line collapses rather than double-counting", async () => {
  const p = await parseOf(slipLines());
  const doubled = [...p.extraction.lines, { ...p.extraction.lines[0] }];
  const d = dedupeLines(doubled);
  assert.equal(d.ok, true);
  assert.equal(d.lines.length, 2);
});

// ─── THE LINE-SUM MISMATCH IS JUDGED BY SOURCE ───────────────────────────────
// The photo path warns; the PDF path refuses. Same figures, different verdict,
// and deliberately so: a camera misses a line, an exact text read does not.
test("lines that do not sum to the printed total REFUSE on the PDF path", () => {
  const out = parseSlipPdf(slipLines({
    // Two lines summing to R100.00 under a slip whose own totals say R150.00.
    txns: [
      "2026/08/26 19:02:11 UTI0000001 223344556677 K9Q2Z1 101 ************1111 R60.00",
      "2026/08/26 19:03:11 UTI0000002 223344556678 K9Q2Z2 102 ************2222 R40.00",
    ],
    count: 2, purchases: "R150.00", refunds: "R0.00", total: "R150.00",
  }));
  assert.equal(out.ok, true, "the read itself succeeds — the slip's own arithmetic holds");

  const pdf = validateExtraction(out.extraction, { source: "pdf" });
  assert.equal(pdf.ok, false, "a PDF whose lines disagree with its total must be refused");
  assert.match(pdf.reason, /read exactly/);
  assert.match(pdf.reason, /Photograph the slip instead/);

  // The SAME figures on the photo path are a warning, not a refusal — a camera
  // really does miss a line, and refusing would send a manager back to re-shoot
  // a roll that is already correct. (Confidence is supplied here because the
  // PDF parser records none: exact text has nothing to be confident about, and
  // the photo path's gate would otherwise refuse first, for another reason.)
  const asPhoto = { ...out.extraction, confidence: {
    tid: 0.99, batchNo: 0.98, totalCents: 0.97, openedAt: 0.96,
    closedAt: 0.96, purchasesCents: 0.95, txnCount: 0.95,
  } };
  const photo = validateExtraction(asPhoto, { source: "photo" });
  assert.equal(photo.ok, true, "the photo path must keep warning rather than refusing");
  assert.ok(photo.warnings.some((w) => /sum to/.test(w)), "…and it must still say so");
});

// ─── SECTION HEADINGS ARE WALKED PAST, BROKEN FIGURES ARE NOT ────────────────
// FNB prints the totals under a heading, and the heading contains the word the
// money regex looks for. "TOTALS SUMMARY" refused every such slip until this
// was caught on PR #509 — a false refusal, safe but useless. The rule is
// digits: a remainder with none is a label, one with digits is the figure row.
test("a TOTALS SUMMARY heading is walked past to the real total", () => {
  const lines = slipLines();
  const i = lines.findIndex((l) => /^TOTAL\s/.test(l));
  assert.ok(i > 0, "fixture no longer has a TOTAL row — update this test");
  lines.splice(i, 0, "TOTALS SUMMARY");     // the heading FNB prints above it

  const out = parseSlipPdf(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.totalCents, 5030700, "the heading must not shadow the figure");
});

test("…but a heading is not a licence to skip a figure it cannot read", () => {
  // The same walk-past must NOT swallow a mangled amount: this row carries
  // digits, so it is the figure row, and an unreadable figure is a refusal.
  const lines = slipLines({ total: "R5O,307.00" });   // letter O
  lines.splice(lines.findIndex((l) => /^TOTAL\s/.test(l)), 0, "TOTALS SUMMARY");
  const out = parseSlipPdf(lines);
  assert.equal(out.ok, false, "a mangled total must still refuse, heading or not");
  assert.match(out.reason, /R5O,307\.00/);
});

// ─── A LABEL IS THE START OF ITS ROW, NOT A WORD FOUND ANYWHERE ──────────────
test("boilerplate that merely mentions a label does not become the field", () => {
  // Real slips carry printed prose, terms and footers. Every decoy below sits
  // AHEAD of the row it would shadow — `field()` takes the first match, so a
  // decoy placed after the real row proves nothing.
  //
  // Two shapes, because two rules are being tested. A decoy that STARTS with
  // the label ("Transactions are settled…") is stopped only by the separator
  // rule; one carrying the label MID-line with its value right after ("Batch
  // opened 2020/01/01…") is stopped only by the start-of-row anchor. Every
  // header field gets both — an anchor no test discriminates is an anchor the
  // next refactor deletes.
  const decoys = [
    "Transactions are settled within 7 working days",
    "Opened accounts are closed on 2020/01/01 00:00:00",
    "This terminal handles up to 9999 transactions per batch",
    "Batch transactions 9999 lifetime on this device",
    "Batch opened 2020/01/01 00:00:00 at this device",
    "Batch closed 2020/01/02 00:00:00 at this device",
    "Batch printed 2020/01/03 00:00:00 by staff",
    "Your merchant number 999999999999 is on file",
    "Reprint of batch #999 available on request",
    "Terminal replacement 8888ZZZZ pending",
    "Replaced terminal 7777YYYY under warranty",
    // One unbroken token LONGER than the capture, with its digit past the 16th
    // character: an unbounded digit lookahead is satisfied by that digit but
    // the group takes only the letters ahead of it, yielding a TID of
    // "REPLACEMENTLETTE".
    "Terminal REPLACEMENTLETTERZZ8888 pending",
  ];
  const lines = slipLines();
  lines.splice(1, 0, ...decoys);          // above EVERY real row

  const out = parseSlipPdf(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.tid, "0000HP1X", "the TID must come from the TERMINAL ID row");
  assert.equal(out.extraction.mid, "000000004977890", "the merchant ID likewise");
  assert.equal(out.extraction.batchNo, "494", "the batch number likewise");
  assert.equal(out.extraction.txnCount, 2, "the transaction count likewise");
  assert.equal(out.extraction.openedAt, Date.UTC(2026, 7, 26, 16, 50, 4), "the Opened time likewise");
  assert.equal(out.extraction.closedAt, Date.UTC(2026, 7, 27, 16, 50, 4), "the Closed time likewise");
  assert.equal(out.extraction.printedAt, Date.UTC(2026, 7, 28, 6, 52, 38), "the Printed time likewise");
});

test("a figure printed twice with different values refuses rather than picking", () => {
  const lines = slipLines();
  // A decoy ahead of the real row. Taking the first match would read R45.00.
  lines.splice(lines.findIndex((l) => /Purchases/.test(l)), 0, "Purchases   R45.00");

  const out = parseSlipPdf(lines);
  assert.equal(out.ok, false, "two different purchases figures must not be chosen between");
  assert.match(out.reason, /appears twice/);
  assert.match(out.reason, /R45\.00/);
  assert.match(out.reason, /R50,355\.00/);
});

test("…but the SAME figure printed twice is not an ambiguity", () => {
  const lines = slipLines();
  const i = lines.findIndex((l) => /Purchases/.test(l));
  lines.splice(i, 0, "Purchases   R50,355.00");   // a repeat, not a conflict
  const out = parseSlipPdf(lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.purchasesCents, 5035500);
});

// ─── THE LINE REASSEMBLY, ACTUALLY EXERCISED ─────────────────────────────────
// A real PDF does not hand its text over in reading order. It emits separately
// positioned fragments, in whatever order its generator happened to write them,
// and pdfToLines rebuilds rows by grouping on Y and sorting on X.
//
// The plain fixture writes each line as one complete Tj in reading order, so
// pdfjs returned the right text from item order alone and this logic was never
// tested: deleting the X sort, and deleting the down-the-page ordering, both
// left every test green. These use the fragmenting writer, where content-stream
// order carries no information whatsoever.
test("a slip whose fragments arrive shuffled rebuilds into the right rows", async () => {
  const t = await pdfToLines(makeSlipPdfFragmented(slipLines()));
  assert.equal(t.ok, true, t.reason);
  // Left-to-right within a row: a lost X sort scrambles the words in the line.
  assert.ok(t.lines.includes("TERMINAL ID 0000HP1X"), `TERMINAL row rebuilt wrong: ${JSON.stringify(t.lines.slice(0, 5))}`);
  assert.ok(t.lines.includes("MERCHANT ID 000000004977890"), "MERCHANT row rebuilt wrong");
  assert.ok(t.lines.some((l) => /^TOTAL\s+R50,307\.00$/.test(l)), "the TOTAL row rebuilt wrong");
  // Down the page: a lost Y ordering puts the rows in the wrong sequence, and
  // the header must still precede the detail roll.
  const tid = t.lines.findIndex((l) => /^TERMINAL ID/.test(l));
  const first = t.lines.findIndex((l) => /^2026\/08\/26 19:02/.test(l));
  const total = t.lines.findIndex((l) => /^TOTAL /.test(l));
  assert.ok(tid >= 0 && first > tid, `the detail roll must follow the header (tid=${tid}, first line=${first})`);
  assert.ok(total > first, `the TOTAL must follow the detail roll (total=${total}, first line=${first})`);
});

test("…and the whole parse holds on that same shuffled slip", async () => {
  // Not just the rows: the figures the record is built from must come out
  // identical to the un-fragmented read.
  const t = await pdfToLines(makeSlipPdfFragmented(slipLines(), { seed: 99 }));
  assert.equal(t.ok, true, t.reason);
  const out = parseSlipPdf(t.lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.tid, "0000HP1X");
  assert.equal(out.extraction.batchNo, "494");
  assert.equal(out.extraction.totalCents, 5030700);
  assert.equal(out.extraction.purchasesCents, 5035500);
  assert.equal(out.extraction.lines.length, 2);
  assert.equal(out.extraction.lines[1].amountCents, -4800, "the refund line keeps its sign");
});

test("whole lines shuffled — the down-the-page ordering alone", async () => {
  // fragment:false keeps each row intact but still shuffles the rows, which
  // isolates the Y ordering from the X sort.
  const t = await pdfToLines(makeSlipPdfFragmented(slipLines(), { fragment: false, seed: 7 }));
  assert.equal(t.ok, true, t.reason);
  const out = parseSlipPdf(t.lines);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.extraction.totalCents, 5030700);
});

// ─── THE OTHER HALF OF STRICTNESS: NOT REFUSING REAL SLIPS ───────────────────
// Every rule that stops a decoy can also stop a legitimate row, and a parser
// that refuses everything satisfies "never a wrong figure" perfectly while
// being useless. There is exactly one slip layout on file, so these are the
// variations a real terminal plausibly prints — different label wording,
// punctuation, spacing and case. All must still read EXACTLY.
//
// This is the test that fails when the anchoring is tightened too far.
const LAYOUTS = {
  "leading indent":        (l) => l.map((x) => "   " + x),
  "lowercase labels":      (l) => l.map((x) => x.replace(/^(MERCHANT ID|TERMINAL ID|Opened|Closed|Printed|Transactions)/i, (m) => m.toLowerCase())),
  "a colon after labels":  (l) => l.map((x) => x.replace(/^(MERCHANT ID|TERMINAL ID|Opened|Closed|Printed|Transactions)(\s)/i, "$1:$2")),
  "tab separated":         (l) => l.map((x) => x.replace(/^(MERCHANT ID|TERMINAL ID|Opened|Closed|Printed|Transactions)\s+/i, "$1\t")),
  "dotted leaders":        (l) => l.map((x) => x.replace(/^(Opened|Closed|Printed|Transactions)\s+/i, "$1 ....... ")),
  "dashed leaders":        (l) => l.map((x) => x.replace(/^(Transactions)\s+/i, "$1 --- ")),
  '"TERMINAL NO" wording': (l) => l.map((x) => x.replace(/^TERMINAL ID/, "TERMINAL NO")),
  "no ID word at all":     (l) => l.map((x) => x.replace(/^TERMINAL ID/, "TERMINAL").replace(/^MERCHANT ID/, "MERCHANT")),
  "batch without parens":  (l) => l.map((x) => x.replace(/^Batch Report \(#(\d+)\)/, "Batch #$1")),
  "TOTAL with a colon":    (l) => l.map((x) => x.replace(/^TOTAL {3}/, "TOTAL: ")),
  "bare Purchases label":  (l) => l.map((x) => x.replace(/^MasterCard\/Visa Purchases/, "Purchases")),
};

for (const [name, layout] of Object.entries(LAYOUTS)) {
  test(`a legitimate slip printed with ${name} still reads exactly`, () => {
    const out = parseSlipPdf(layout(slipLines()));
    assert.equal(out.ok, true, `a real slip was REFUSED: ${out.reason}`);
    assert.equal(out.extraction.tid, "0000HP1X");
    assert.equal(out.extraction.batchNo, "494");
    assert.equal(out.extraction.txnCount, 2);
    assert.equal(out.extraction.totalCents, 5030700);
    assert.equal(out.extraction.purchasesCents, 5035500);
    assert.equal(out.extraction.refundsCents, 4800);
  });
}
