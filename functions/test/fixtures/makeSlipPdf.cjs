// Build a REAL PDF whose text layer holds the given lines. Hand-rolled so the
// fixture needs no dependency and its bytes are inspectable — and so the tests
// exercise pdfjs's actual fragment-and-position behaviour rather than a mock of
// it, which is the part that would silently break line reassembly.
//
// ── TWO WRITERS, AND WHY THE SECOND ONE HAD TO EXIST ─────────────────────────
// makeSlipPdf writes each logical line as ONE complete `Tj`, in reading order.
// That is a valid PDF, but it is not a representative one: pdfjs hands items
// back in content-stream order, so pdfToLines reproduced the right text from
// item order alone and its actual work — grouping fragments by Y, sorting them
// by X — was never exercised. Mutation proved it: deleting the left-to-right
// sort, and deleting the down-the-page ordering, both left every test green.
//
// makeSlipPdfFragmented writes what a real generator emits: each line broken
// into several separately-positioned fragments, and the whole page's fragments
// SHUFFLED so content-stream order carries no information at all. Under that
// fixture the reassembly is the only thing that can produce the right lines.
// (CodeRabbit raised this on PR #509; the mutation is what settled it.)
"use strict";
const zlib = require("node:zlib");

const escText = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function makeSlipPdf(lines, { fontSize = 9, leading = 12, top = 800 } = {}) {
  const esc = escText;
  const ops = ["BT", `/F1 ${fontSize} Tf`, `${leading} TL`, `1 0 0 1 40 ${top} Tm`]
    .concat(lines.map((l) => `(${esc(l)}) Tj T*`))
    .concat(["ET"]).join("\n");
  return assemble(ops);
}

// Wrap a content stream in the smallest valid one-page PDF. Shared by both
// writers so they differ ONLY in how the text is laid out.
function assemble(ops) {
  const stream = zlib.deflateSync(Buffer.from(ops, "latin1"));
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  ];
  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  const at = () => chunks.reduce((n, b) => n + b.length, 0);
  for (let i = 0; i < objs.length; i++) {
    offsets.push(at());
    if (i === 3) {
      chunks.push(Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"));
      chunks.push(stream);
      chunks.push(Buffer.from("\nendstream\nendobj\n", "latin1"));
    } else {
      chunks.push(Buffer.from(`${i + 1} 0 obj\n${objs[i]}\nendobj\n`, "latin1"));
    }
  }
  const xrefAt = at();
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

// The layout the OCR prompt was written from — a real FNB batch report's own
// wording, which is the closest thing to a specification available without a
// sample file in hand.
function slipLines({ tid = "0000HP1X", batchNo = 494, txns = null, purchases = "R50,355.00",
                     refunds = "R48.00", total = "R50,307.00", count = null } = {}) {
  const rows = txns ?? [
    "2026/08/26 19:02:11 UTI0000001 223344556677 K9Q2Z1 101 ************1111 R50,355.00",
    "2026/08/27 09:15:00 UTI0000002 223344556678 K9Q2Z2 102 ************2222 R48.00 REFUND",
  ];
  return [
    "THE MARATHON",
    "MERCHANT ID  000000004977890",
    `TERMINAL ID  ${tid}`,
    `Batch Report (#${batchNo})`,
    "Opened   2026/08/26 18:50:04",
    "Closed   2026/08/27 18:50:04",
    "Printed  2026/08/28 08:52:38",
    `Transactions  ${count ?? rows.length}`,
    "",
    "DETAIL",
    ...rows,
    "",
    "PAYMENT TYPE SUMMARY",
    `MasterCard/Visa Purchases   ${purchases}`,
    `Refunds   (${refunds})`,
    "",
    "CARD TOTALS",
    `TOTAL   ${total}`,
    "500 - Reconciled, in balance",
  ];
}

/**
 * The same slip, written the way a real PDF generator writes one.
 *
 * Every line is split at its spaces into separately-positioned fragments, and
 * every fragment on the page is emitted in a SHUFFLED order — deterministically,
 * so a failure replays. Courier is monospaced, so an X position of
 * `40 + column * fontSize * 0.6` puts each fragment where its text actually
 * starts, which is what the X-sort has to recover.
 *
 * `seed` shuffles differently; `fragment: false` keeps whole lines but still
 * shuffles them, which isolates the down-the-page ordering from the
 * left-to-right sort.
 */
function makeSlipPdfFragmented(lines, { fontSize = 9, leading = 12, top = 800, seed = 1, fragment = true } = {}) {
  const frags = [];
  lines.forEach((line, row) => {
    const y = top - row * leading;
    const text = String(line);
    if (!text.trim()) return;                       // a blank row carries no text
    if (!fragment) { frags.push({ x: 40, y, str: text }); return; }
    // Walk the line so each piece's column is its REAL offset, spaces included.
    let col = 0;
    for (const piece of text.split(/(\s+)/)) {
      if (piece.trim()) frags.push({ x: 40 + col * fontSize * 0.6, y, str: piece });
      col += piece.length;
    }
  });

  // Deterministic Fisher–Yates: content-stream order must carry no information.
  let st = seed >>> 0;
  const rand = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = frags.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [frags[i], frags[j]] = [frags[j], frags[i]];
  }

  const ops = ["BT", `/F1 ${fontSize} Tf`]
    .concat(frags.map((f) => `1 0 0 1 ${f.x.toFixed(2)} ${f.y.toFixed(2)} Tm (${escText(f.str)}) Tj`))
    .concat(["ET"]).join("\n");
  return assemble(ops);
}

module.exports = { makeSlipPdf, makeSlipPdfFragmented, slipLines };
