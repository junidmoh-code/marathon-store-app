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

/**
 * THE BANK'S EMAILED BANKING REPORT — the second format, as it prints.
 *
 * Built from the real example described in the request that added this reader
 * (batch 59, terminal 67365901, 40 approved items). Its shape is what matters
 * and every part of it is load-bearing somewhere:
 *
 *   • the title carries BOTH the batch number and the terminal
 *   • "Merchant:" / "Terminal:" / "Batch:" as labelled rows, not "MID:"/"TID:"
 *   • "APPROVED TRANSACTIONS" then "Items: 40" — the count, not "Transactions"
 *   • "ZAR 900.00", not "R900.00"
 *   • per row: date, time, UTI, RRN, Auth Code, TSN, **Batch**, PAN, amount, type
 *   • TSNs WITH GAPS — approved only, so declines and voids are simply absent
 *   • TOTALS SUMMARY and CARD TOTALS at the end, and NO Payment Type Summary
 *
 * `tsns` defaults to the real report's own sequence, gaps included: it runs
 * 2,3,4 then skips 5, and skips 21-24, 30-31, 33-34 and 43. Contiguity must
 * never be applied to this, and the default makes any test that forgets fail.
 */
const REAL_TSNS = [
  2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  25, 26, 27, 28, 29, 32, 35, 36, 37, 38, 39, 40, 41, 42,
  44, 45, 46, 47, 48, 49, 50, 51,
];

const zar = (cents) => {
  const s = (Math.abs(cents) / 100).toFixed(2);
  const [whole, frac] = s.split(".");
  return `${cents < 0 ? "-" : ""}ZAR ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
};

function emailedLines({
  tid = "67365901", batchNo = 59, tsns = REAL_TSNS, amountsCents = null,
  refundTsns = [], batchColumn = true, printedAt = "2026/08/28 08:52:38",
  // A SHORT RRN is the awkward case for deciding the layout: at 12 digits the
  // RRN is not a plausible sequence number and is ignored, but a terminal that
  // prints a 6-digit one puts TWO candidate integers before the PAN even when
  // there is no batch column at all.
  shortRrn = false,
  // Terminals do not all print the same columns. `noUti` drops the leading
  // reference (one column fewer); `extraColumn` adds a card-scheme token (one
  // more, and an alphanumeric one, so it changes the token count without
  // changing how many integers sit before the PAN).
  noUti = false, extraColumn = false,
  // Some terminals print the masked card number in groups rather than as one
  // token, and only the middle groups carry mask characters — so the leading
  // group is bare digits sitting exactly where a sequence number would be.
  groupedPan = false,
} = {}) {
  const amounts = amountsCents || tsns.map((_, i) => 90000 + i * 1000);
  const rows = [];
  let purchases = 0, refunds = 0;
  tsns.forEach((tsn, i) => {
    const isRefund = refundTsns.includes(tsn);
    const amt = amounts[i];
    if (isRefund) refunds += amt; else purchases += amt;
    const hh = String(9 + Math.floor(i / 12)).padStart(2, "0");
    const mm = String((i * 7) % 60).padStart(2, "0");
    const cols = [
      "2026/08/27", `${hh}:${mm}:11`,
      ...(noUti ? [] : [`UTI${String(1000000 + i)}`]),
      shortRrn ? String(100000 + i) : String(223344550000 + i),
      `K9Q${String(i).padStart(3, "0")}`,
      ...(extraColumn ? ["VISA"] : []),
      String(tsn),
      ...(batchColumn ? [String(batchNo)] : []),
      groupedPan
        ? `4111 11** **** ${String(1000 + (i % 9000))}`
        : `************${String(1000 + (i % 9000))}`,
      zar(amt),
      isRefund ? "Refund" : "Purchase",
    ];
    rows.push(cols.join(" "));
  });
  const total = purchases - refunds;
  return {
    truth: { purchasesCents: purchases, refundsCents: refunds, totalCents: total, count: tsns.length, tsns },
    lines: [
      `Banking Report for Batch ${batchNo} of Terminal ${tid}`,
      "THE MARATHON SPORTS",
      printedAt,
      "Version 4.2.1",
      "Merchant: 000000004977890",
      `Terminal: ${tid}`,
      `Batch: ${batchNo}`,
      "",
      "APPROVED TRANSACTIONS",
      `Items: ${tsns.length}`,
      "",
      "Date Time UTI RRN Auth Code TSN Batch Card Total Type",
      ...rows,
      "",
      "TOTALS SUMMARY",
      `Items: ${tsns.length}`,
      "",
      "CARD TOTALS",
      `Purchases   ${zar(purchases)}`,
      `Refunds   ${zar(refunds)}`,
      `Total   ${zar(total)}`,
    ],
  };
}

/**
 * THE REAL REPORT'S SHAPE — Till2FNB-Txn-Notification.pdf.
 *
 * Batch 59, terminal 67365901, 40 approved items, ZAR 30120.00, first
 * transaction 09:07:23 for ZAR 900.00 at TSN 2, last 16:09:09 for ZAR 350.00 at
 * TSN 51. Those figures are the owner's, read off the file itself.
 *
 * WHAT MAKES THIS DIFFERENT FROM `emailedLines`, and why it earns its own
 * fixture: the real file is SEVEN PAGES, and FNB's address block and page
 * footers are interleaved through the text BETWEEN transactions rather than
 * sitting neatly at the top and bottom. That furniture is full of money labels
 * followed by digits — "Total pages 7", "Refunds enquiries 0860 …" — and it is
 * what broke the first version of this reader.
 *
 * Its totals blocks also print PURCHASE and TOTAL as the same figure: there is
 * no purchases subtotal distinct from the total, and no Payment Type Summary.
 *
 * NOT THE FILE ITSELF. The PDF has not reached this repository; the structure
 * here is reconstructed from the owner's description of it plus the figures
 * above. Replace this with the real bytes when it arrives — see
 * docs/CARD-RECON.md.
 */
const REAL_REPORT = {
  tid: "67365901", batchNo: 59, items: 40, totalCents: 3012000,
  firstTime: "09:07:23", firstCents: 90000, firstTsn: 2,
  lastTime: "16:09:09", lastCents: 35000, lastTsn: 51,
};

// The page furniture, as it interleaves. Every one of these lines sat between
// transactions in the real file.
const FNB_FURNITURE = (page) => ([
  "First National Bank",
  "a division of FirstRand Bank Limited",
  "Merchant Services, PO Box 1153, Johannesburg, 2000",
  "Reg No. 1929/001225/06    VAT Reg No 4500178018",
  "Refunds enquiries 0860 12 34 56",
  "Total pages 7",
  `Page ${page} of 7`,
]);

function realReportLines() {
  const { tid, batchNo, items, totalCents, firstTime, firstCents, lastTime, lastCents } = REAL_REPORT;
  // The first and last rows are the owner's actual figures; the 38 between them
  // are spread evenly so the roll sums to the printed total exactly.
  const middleTotal = totalCents - firstCents - lastCents;
  const each = Math.floor(middleTotal / 38);
  const amounts = [firstCents, ...Array(38).fill(each), lastCents];
  amounts[19] += middleTotal - each * 38;          // the remainder, on one row
  const times = REAL_TSNS.map((_, i) => {
    if (i === 0) return firstTime;
    if (i === 39) return lastTime;
    const mins = 9 * 60 + 7 + Math.round((i / 39) * ((16 * 60 + 9) - (9 * 60 + 7)));
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}`;
  });

  const body = [];
  REAL_TSNS.forEach((tsn, i) => {
    body.push([
      "2026/08/27", times[i],
      `UTI${String(1000000 + i)}`, String(223344550000 + i), `K9Q${String(i).padStart(3, "0")}`,
      String(tsn), String(batchNo),
      `************${String(1000 + i)}`,
      zar(amounts[i]), "Purchase",
    ].join(" "));
    // …and the page break, mid-roll, every six rows.
    if ((i + 1) % 6 === 0) body.push(...FNB_FURNITURE(Math.floor((i + 1) / 6) + 1));
  });

  return {
    truth: { ...REAL_REPORT, amounts, times },
    lines: [
      `Banking Report for Batch ${batchNo} of Terminal ${tid}`,
      "THE MARATHON SPORTS",
      "2026/08/27 16:15:02",
      "Version 4.2.1",
      ...FNB_FURNITURE(1),
      "Merchant: 000000004977890",
      `Terminal: ${tid}`,
      `Batch: ${batchNo}`,
      "APPROVED TRANSACTIONS",
      `Items: ${items}`,
      ...body,
      "TOTALS SUMMARY",
      `Purchase   ${zar(totalCents)}`,
      `Total   ${zar(totalCents)}`,
      "CARD TOTALS",
      "FNBSettleSTG",
      `Purchase   ${zar(totalCents)}`,
      `Total   ${zar(totalCents)}`,
      ...FNB_FURNITURE(7),
    ],
  };
}

/**
 * The same text, across SEVERAL REAL PAGES.
 *
 * makeSlipPdf lays every line on one page from y=800 down at 12pt leading, so
 * past about sixty-six lines it simply runs off the bottom of the MediaBox and
 * pdfjs never reports them — a 112-line document came back as 67. The real
 * banking report is seven pages, so testing it through a single-page writer
 * would have been testing something the reader never sees.
 *
 * This builds one page object and one content stream per page, which is also
 * the only way to exercise pdfToLines' page loop: it groups fragments by Y
 * WITHIN a page, and identical Y coordinates on different pages must not
 * collapse into one row.
 */
function makeSlipPdfPaged(lines, { fontSize = 9, leading = 12, top = 800, perPage = 18 } = {}) {
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([]);

  const streams = pages.map((pageLines) => zlib.deflateSync(Buffer.from(
    ["BT", `/F1 ${fontSize} Tf`, `${leading} TL`, `1 0 0 1 40 ${top} Tm`]
      .concat(pageLines.map((l) => `(${escText(l)}) Tj T*`))
      .concat(["ET"]).join("\n"), "latin1")));

  const n = pages.length;
  const pageIds = pages.map((_, i) => 3 + i);            // 3 … 2+n
  const streamIds = pages.map((_, i) => 3 + n + i);      // 3+n … 2+2n
  const fontId = 3 + 2 * n;

  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`;
  pages.forEach((_, i) => {
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamIds[i]} 0 R >>`;
  });
  objs[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";

  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  const at = () => chunks.reduce((t, b) => t + b.length, 0);
  const offsets = [];
  const total = fontId;
  for (let id = 1; id <= total; id++) {
    offsets.push(at());
    const streamIdx = streamIds.indexOf(id);
    if (streamIdx >= 0) {
      const st = streams[streamIdx];
      chunks.push(Buffer.from(`${id} 0 obj\n<< /Length ${st.length} /Filter /FlateDecode >>\nstream\n`, "latin1"));
      chunks.push(st);
      chunks.push(Buffer.from("\nendstream\nendobj\n", "latin1"));
    } else {
      chunks.push(Buffer.from(`${id} 0 obj\n${objs[id]}\nendobj\n`, "latin1"));
    }
  }
  const xrefAt = at();
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

module.exports = {
  makeSlipPdf, makeSlipPdfFragmented, makeSlipPdfPaged, slipLines,
  emailedLines, REAL_TSNS, realReportLines, REAL_REPORT, FNB_FURNITURE,
};
