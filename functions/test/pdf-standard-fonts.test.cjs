// ─── STANDARD FONTS — the parse log must not cry wolf ────────────────────────
// A PDF that names /Helvetica or /Courier without embedding it (Standard
// Bank's payment confirmation does) used to make pdfjs print
//   Warning: UnknownErrorException: Ensure that the `standardFontDataUrl`
//   API parameter is provided.
// twice on every poller parse — noise that would bury a REAL parse failure.
// pdfText.js now hands pdfjs its own standard_fonts directory. These tests pin
// three things: the directory actually exists in the installed package (a
// pdfjs upgrade that moves it must fail HERE, loudly, not revive the warning
// silently), a standard-font PDF parses without the warning, and the text
// itself never depended on the font data in the first place.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { pdfToLines } = require("../cardRecon/pdfText.js");
const { makeSlipPdf } = require("./fixtures/makeSlipPdf.cjs");

test("pdfjs-dist still ships standard_fonts where pdfText.js points", () => {
  const dir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
  assert.ok(fs.existsSync(dir), `missing: ${dir} — pdfjs moved its fonts; update pdfText.js`);
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith(".pfb")), "no font files in standard_fonts");
});

test("a non-embedded standard-font PDF parses with no standardFontDataUrl warning", async () => {
  // pdfjs prints its warnings through console.log; capture everything the
  // parse writes there. makeSlipPdf's fixture names /Courier unembedded —
  // exactly the shape that used to warn twice per parse.
  const logged = [];
  const orig = console.log;
  console.log = (...args) => { logged.push(args.join(" ")); };
  let out;
  try {
    out = await pdfToLines(makeSlipPdf(["Amount R100.00", "Beneficiary reference OM82"]));
  } finally {
    console.log = orig;
  }
  assert.equal(out.ok, true);
  // The text never depended on the font data — same lines as ever.
  assert.deepEqual(out.lines, ["Amount R100.00", "Beneficiary reference OM82"]);
  const wolf = logged.filter((l) => /standardFontDataUrl/i.test(l));
  assert.deepEqual(wolf, [], `the parse still cries wolf: ${wolf.join(" | ")}`);
});
