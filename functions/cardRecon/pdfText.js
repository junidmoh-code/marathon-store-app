// ─── PDF → LINES OF TEXT ─────────────────────────────────────────────────────
// The only IO in the PDF path. pdfjs hands back text as POSITIONED FRAGMENTS,
// not lines — "MERCHANT", " ", "ID", " ", "000000004977890" arrive as five
// items — so joining them in item order would run one printed line into the
// next and make every label match meaningless. Lines are rebuilt from the
// glyph positions instead: group by Y, order by X.
//
// Kept out of lib/card-recon-pdf.cjs so that parser stays pure and testable
// without a PDF engine, the same split as card-recon.cjs and cardRecon.js.

"use strict";

const path = require("node:path");

// Where pdfjs-dist ships the 14 standard fonts, resolved from the installed
// package so a version bump or a different install layout (the poller on the
// mini, the deployed function) always points at ITS OWN copy.
//
// RESOLVED DEFENSIVELY: pdfjs-dist has genuinely been absent on the mini
// before, and this module is required at poller STARTUP — a throw here would
// kill the whole poller, card path included, where the contract is a graceful
// per-message "reader unavailable" refusal from the lazy import below.
// Missing package → undefined → pdfToLines fails exactly the way it always
// did. (Fable-vs-spec review, this PR.)
const STANDARD_FONT_DATA_URL = (() => {
  try {
    return path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
  } catch {
    return undefined;
  }
})();

// ─── WHICH FRAGMENTS SHARE A LINE ────────────────────────────────────────────
// A text layer's Y coordinates wobble by fractions of a point within one line,
// and the old rule — round Y to the nearest point and group by that — had a
// boundary inside every point: two fragments of ONE printed line at y=100.49
// and y=100.51 rounded to different keys and became two rows, and every
// row-anchored pattern in the parser ("Items: 40", "TSN:2 Batch:59", a block's
// timestamp) then failed on a line that was printed perfectly.
//
// So lines are CLUSTERED instead. Fragments are walked top to bottom, and a new
// line starts only when a fragment sits further below the current line's first
// fragment than LINE_SPLIT_RATIO of the SMALLER of the two font heights. The
// wobble inside a line is a fraction of a point; the step to the next line is a
// whole line height (11pt on the report body, 10pt in its 7.5pt address block),
// so a cut at 0.4 of a glyph's height sits well clear of both — and, unlike a
// fixed bucket, it scales with the type.
//
// WHY 0.4 AND NOT ONE HALF, AND WHY THE SMALLER HEIGHT. FNB's footer prints
// "Page 1 of 7" in 9pt at the right margin, centred between two 7.5pt legal
// lines on the left: 4.4pt from the lower one. Half of 9pt is 4.5, so the
// first cut of this merged the page number into the legal line on every
// report — harmless to the figures, but a change of extraction on files the
// parser already reads, which is the one thing this change must not do. The
// smaller height is the honest measure: a line is only as tall as its smallest
// type, and that is the one a neighbour can sit close to.
//
// Measured against every PDF in the shop mailbox (258 files, 15 Oct 2026):
// all 251 batch reports extract byte-identical lines under both rules — no slip
// layout on file has straddled a boundary yet, which is exactly why this must
// not wait for the first one that does.
//
// THE EFT READER KEEPS THE OLD GROUPING, BY NAME. The other seven files were
// bank payment notifications, and on four FNB ones the old bucket DID split a
// printed line ("Cur/Amount" and "ZAR30.00" a fraction of a point apart). The
// FNB EFT reader (scripts/cardrecon/eftBanks.mjs) was built against that split
// form — it looks for "a lone ZAR figure" — so clustering them correctly
// would have stopped four real payments reading. The poller therefore asks for
// `grouping: "bucket"` explicitly; moving it over is a change to that reader,
// with its own samples, not a side effect of this one.
const LINE_SPLIT_RATIO = 0.4;
// The height assumed for a fragment that states none (a zero-size text matrix
// is legal PDF). 9pt is the batch report's own body size.
const DEFAULT_FONT_HEIGHT = 9;

/** A fragment's font height in points: item.height, else the text matrix's. */
function fontHeightOf(item) {
  const h = Number(item?.height);
  if (Number.isFinite(h) && h > 0) return h;
  const t = Math.abs(Number(item?.transform?.[3]));
  if (Number.isFinite(t) && t > 0) return t;
  return DEFAULT_FONT_HEIGHT;
}

/**
 * THE OLD GROUPING, kept exactly for the one caller whose readers depend on it
 * (see above): round Y to the nearest point and group by that.
 */
const Y_TOLERANCE = 1;
function bucketLines(frags) {
  const rows = new Map();
  for (const f of frags) {
    const key = Math.round(f.y / Y_TOLERANCE);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(f);
  }
  const out = [];
  for (const key of [...rows.keys()].sort((a, b) => b - a)) {
    const text = rows.get(key).sort((a, b) => a.x - b.x).map((i) => i.str).join(" ")
      .replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Positioned fragments → visual lines, top of the page first, each line read
 * left to right. Pure, so the clustering is tested without a PDF engine.
 *
 * @param {{x:number, y:number, h:number, str:string}[]} frags
 * @returns {string[]}
 */
function clusterLines(frags) {
  // Down the page (PDF Y grows upwards), then across it. The secondary key
  // keeps the order stable for fragments on exactly the same baseline.
  const sorted = [...frags].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  let current = null;
  for (const f of sorted) {
    // Measured from the line's FIRST fragment, never the previous one: a
    // chain of small steps must not walk one line into the next.
    if (current && current.y - f.y <= LINE_SPLIT_RATIO * Math.min(f.h, current.h)) {
      current.frags.push(f);
      continue;
    }
    current = { y: f.y, h: f.h, frags: [f] };
    lines.push(current);
  }
  const out = [];
  for (const line of lines) {
    const text = line.frags.sort((a, b) => a.x - b.x).map((i) => i.str).join(" ")
      .replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

// A terminal's batch report is usually one or two pages — but NOT ALWAYS. A
// batch left open across busy days lists every transaction and runs long:
// Marathon Till 1's batch 66 (open from 30 Sept 2026) emailed a 16-page report
// on 1 Oct, and the old cap of 10 filed it as "not a batch report", so the
// till's card money never reached /card_batches and the screen showed nothing.
// This is a sanity bound, not a description of a normal slip; the real guard
// against a hostile file is the text ceiling below.
const MAX_PAGES = 60;

// A CEILING ON WHAT COMES OUT, not just on what goes in. readPdfPayload bounds
// the UPLOAD to 10MB, but a PDF's content streams are compressed: a small,
// highly repetitive file can decompress into an enormous amount of text. The
// page count is read from the trailer and cannot be trusted to bound the work
// either. This function runs in a 512MiB instance a manager is waiting on, so
// extraction stops and refuses rather than filling the heap. A real batch
// report is a few thousand characters; these are orders of magnitude above
// anything legitimate. (Raised as an unconfirmed availability risk in review of
// PR #509 — cheap enough to close rather than argue about.)
const MAX_TEXT_ITEMS = 200000;
const MAX_TEXT_CHARS = 2000000;

/**
 * @param {Buffer} buffer  the PDF's bytes
 * @param {{grouping?: "cluster"|"bucket"}} [opts]  how fragments become lines;
 *   "bucket" is the old rule, kept for the EFT readers only (see bucketLines)
 * @returns {Promise<{ok:true, lines:string[], pages:number} | {ok:false, reason:string}>}
 *   Never throws for a bad file: an unreadable PDF is a REJECT with a sentence
 *   a manager can act on, not an exception that surfaces as "internal error".
 */
// Releasing the worker is best-effort and must never become the reason a
// capture fails: the slip may already have been read perfectly.
async function destroyTask(task) {
  try { await task?.destroy(); } catch (err) { console.warn("pdfToLines: worker cleanup failed:", err.message); }
}

async function pdfToLines(buffer, { grouping = "cluster" } = {}) {
  const group = grouping === "bucket" ? bucketLines : clusterLines;
  let pdfjs;
  try {
    // Lazily imported, and the legacy build because this runs in Node. ESM from
    // CJS, which Node 22 handles natively.
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (err) {
    console.error("pdfToLines: pdfjs failed to load:", err.message);
    return { ok: false, reason: "The PDF reader is unavailable right now — photograph the slip instead." };
  }

  // THE LOADING TASK IS HELD, NOT DISCARDED. pdfjs spawns a worker per
  // document, and it is the LOADING TASK that owns it — destroying the document
  // proxy alone leaves the worker behind. Two paths used to leak one each, on a
  // long-lived function instance that handles every capture:
  //   • a file that fails to OPEN (corrupt, encrypted) — routine input here,
  //     and the old code returned before `doc` was ever assigned;
  //   • the page-limit refusal, which returned before the cleanup block.
  // One task, one finally, no early return outside it. (CodeRabbit, PR #509.)
  let task;
  let doc;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      // No network, no eval, no system fonts: this runs on a server against a
      // file a manager forwarded from an email.
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      // The 14 standard fonts, from pdfjs's own package — a PDF that names
      // /Helvetica or /Courier WITHOUT embedding it (Standard Bank's payment
      // confirmation does; FNB's slips embed theirs) otherwise makes pdfjs
      // print "Ensure that the standardFontDataUrl API parameter is provided"
      // on every parse. Extraction of `str` never depended on the glyph data
      // (verified: the same fixture extracts identical lines with and without
      // it) — this feeds the logger, not the text, so a REAL parse failure is
      // no longer buried under a warning that fires on every healthy run.
      // The legacy Node build reads a filesystem path; the trailing separator
      // is required (pdfjs appends the font filename to it).
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    });
    doc = await task.promise;
  } catch (err) {
    await destroyTask(task);
    const why = /password|encrypt/i.test(err?.message || "")
      ? "That PDF is password-protected."
      : "That file could not be opened as a PDF.";
    return { ok: false, reason: `${why} Photograph the slip instead.` };
  }

  const pages = doc.numPages;
  const lines = [];
  let items = 0;
  let chars = 0;
  try {
    if (pages > MAX_PAGES) {
      return { ok: false, reason: `That PDF has ${pages} pages — more than any batch report. Check it is the right file.` };
    }
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const frags = [];
      for (const item of content.items) {
        if (typeof item.str !== "string" || !item.str.trim()) continue;
        if (++items > MAX_TEXT_ITEMS || (chars += item.str.length) > MAX_TEXT_CHARS) {
          return { ok: false, reason: "That PDF holds far more text than a batch report — check it is the right file, or photograph the slip." };
        }
        frags.push({
          x: item.transform?.[4] ?? 0,
          y: item.transform?.[5] ?? 0,
          h: fontHeightOf(item),
          str: item.str,
        });
      }
      lines.push(...group(frags));
      page.cleanup();
    }
  } catch (err) {
    console.error("pdfToLines: text extraction failed:", err.message);
    return { ok: false, reason: "That PDF's text could not be read — it may be a scan. Photograph the slip instead." };
  } finally {
    await destroyTask(task);
  }

  if (!lines.length) {
    return { ok: false, reason: "That PDF holds no text — it is probably a scan or a photo saved as a PDF. Photograph the slip instead." };
  }
  return { ok: true, lines, pages };
}

module.exports = { pdfToLines, clusterLines, bucketLines, fontHeightOf, LINE_SPLIT_RATIO, Y_TOLERANCE, MAX_PAGES };
