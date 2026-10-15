// ─── THE REAL-REPORT CORPUS: WHAT EACH FILE READS AS ─────────────────────────
// Every PDF in fixtures/card-recon-real/ is a real file from the shop mailbox.
// Beside each one sits `<name>.expected.json`: what the whole PDF path made of
// it — the extracted lines (as a hash), the parse, and the verdict — at the
// moment it was last deliberately accepted.
//
// The test (card-recon-corpus.test.cjs) re-reads every file and compares. A
// change anywhere in the path — pdfText.js's line grouping, the parser, the
// validator — that moves an ACCEPTED file's figures, line count or lines fails
// it, by name. That is the guard the history of this feature asked for: each
// past fix patched one layout variant and quietly risked the next.
//
// Regenerating is a deliberate act (`node test/card-recon-corpus.lib.cjs
// --write`), and the diff it produces is the review: a refused file turning
// accepted is a fix; an accepted file whose figures move is a regression.
//
// NO FULL CARD NUMBERS: FNB prints PANs masked (first six, last four) and the
// files are committed as printed. Files from a terminal that is not the shop's
// own go in private/ (gitignored) and are checked locally when present.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pdfToLines } = require("../cardRecon/pdfText.js");
const { readSlipPdfLines } = require("../lib/card-recon-pdf.cjs");

const DIR = path.join(__dirname, "fixtures", "card-recon-real");
const sha = (v) => createHash("sha256").update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest("hex").slice(0, 16);

// The two real reports that were on file before this corpus existed. They
// stay where their own tests expect them and are checked here too.
const LEGACY = [
  path.join(__dirname, "fixtures", "Till2FNB-Txn-Notification.pdf"),
  path.join(__dirname, "fixtures", "Till3-Batch81-Empty-FNB-Txn-Notification.pdf"),
];

/** Every corpus PDF: the committed ones, then private/ when it exists. */
function corpusFiles() {
  const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.endsWith(".pdf")).sort().map((f) => path.join(dir, f));
  return [...LEGACY, ...list(DIR), ...list(path.join(DIR, "private"))];
}

/**
 * What the PDF path makes of one file, reduced to the facts that matter and
 * nothing that changes run to run.
 */
async function summarise(file) {
  const bytes = fs.readFileSync(file);
  const text = await pdfToLines(bytes);
  if (!text.ok) return { pdf: sha(bytes), lines: null, reason: text.reason };
  const read = readSlipPdfLines(text.lines);
  const out = { pdf: sha(bytes), lines: { count: text.lines.length, sha: sha(text.lines) } };
  if (!read.ok) return { ...out, ok: false, reason: read.reason, unrelated: read.unrelated === true };
  const e = read.extraction;
  return {
    ...out,
    ok: true,
    summaryOnly: read.summaryOnly === true,
    warnings: read.warnings,
    extraction: {
      format: e.format, tid: e.tid, batchNo: e.batchNo, mids: e.mids,
      txnCount: e.txnCount, totalCents: e.totalCents, purchasesCents: e.purchasesCents,
      cashCents: e.cashCents, refundsCents: e.refundsCents,
      openedAt: e.openedAt, closedAt: e.closedAt, printedAt: e.printedAt,
      windowSource: e.windowSource, emptyBatch: e.emptyBatch === true,
      lineCount: (e.lines || []).length, linesSha: sha(e.lines || []),
      declinedCount: e.declinedCount ?? null, declinedUnread: e.declinedUnread ?? null,
      declinedSha: sha(e.declined || []),
    },
  };
}

const expectedPath = (file) => file.replace(/\.pdf$/, ".expected.json");
const linesPath = (file) => file.replace(/\.pdf$/, ".lines.json");

module.exports = { DIR, corpusFiles, summarise, expectedPath, linesPath };

// `node test/card-recon-corpus.lib.cjs --write` — regenerate every expected
// file (and the extracted lines beside it, for a human reading a refusal).
if (require.main === module && process.argv.includes("--write")) {
  (async () => {
    for (const file of corpusFiles()) {
      const s = await summarise(file);
      fs.writeFileSync(expectedPath(file), JSON.stringify(s, null, 1) + "\n");
      const t = await pdfToLines(fs.readFileSync(file));
      if (t.ok) fs.writeFileSync(linesPath(file), JSON.stringify(t.lines, null, 1) + "\n");
      console.log(`${s.ok ? "ok      " : s.unrelated ? "unrelated" : "REFUSED "} ${path.basename(file)}${s.ok ? "" : ` — ${s.reason.slice(0, 90)}`}`);
    }
  })();
}
