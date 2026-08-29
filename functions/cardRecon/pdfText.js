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

// A text layer's Y coordinates wobble by fractions of a point within one line.
// Rounding to the nearest point groups a line without merging adjacent ones —
// a batch report is 9pt on 12pt leading, so the gap between lines is an order
// of magnitude larger than the wobble.
const Y_TOLERANCE = 1;

// A terminal's batch report is one page, occasionally two for a long roll.
// More than this is not a batch report, and rendering it would be a way to
// spend a manager's time and the function's memory on nothing.
const MAX_PAGES = 10;

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
 * @returns {Promise<{ok:true, lines:string[], pages:number} | {ok:false, reason:string}>}
 *   Never throws for a bad file: an unreadable PDF is a REJECT with a sentence
 *   a manager can act on, not an exception that surfaces as "internal error".
 */
// Releasing the worker is best-effort and must never become the reason a
// capture fails: the slip may already have been read perfectly.
async function destroyTask(task) {
  try { await task?.destroy(); } catch (err) { console.warn("pdfToLines: worker cleanup failed:", err.message); }
}

async function pdfToLines(buffer) {
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
      // Text extraction needs no glyph outlines; supplying nothing here is what
      // the standardFontDataUrl warning is about and it does not affect `str`.
      standardFontDataUrl: undefined,
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
      return { ok: false, reason: `That PDF has ${pages} pages — a batch report is one or two. Check it is the right file.` };
    }
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Y → the fragments sitting on that line.
      const rows = new Map();
      for (const item of content.items) {
        if (typeof item.str !== "string" || !item.str.trim()) continue;
        if (++items > MAX_TEXT_ITEMS || (chars += item.str.length) > MAX_TEXT_CHARS) {
          return { ok: false, reason: "That PDF holds far more text than a batch report — check it is the right file, or photograph the slip." };
        }
        const x = item.transform?.[4] ?? 0;
        const y = item.transform?.[5] ?? 0;
        const key = Math.round(y / Y_TOLERANCE);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push({ x, str: item.str });
      }
      // Down the page (Y descends), then across it.
      for (const key of [...rows.keys()].sort((a, b) => b - a)) {
        const text = rows.get(key).sort((a, b) => a.x - b.x).map((i) => i.str).join(" ")
          .replace(/\s+/g, " ").trim();
        if (text) lines.push(text);
      }
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

module.exports = { pdfToLines, Y_TOLERANCE, MAX_PAGES };
