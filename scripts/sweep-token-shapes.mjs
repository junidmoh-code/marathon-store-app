// ─── SWEEP — which stored style codes are PRODUCTION/DATE lines? READ ONLY. ──
// (Owner spec 2026-08-13, the multi-token root cause.) The OCR captured ONE
// line off each label and WHICH line varied — so some products carry a
// production line (352890-625 on "Lacoster white") or an interleaved serial
// instead of the manufacturer article code. This script REPORTS:
//
//   1. Shape census of every stored code (confirmed + pending, marked).
//   2. SUSPECTED production/date lines — all-numeric codes (the only shapes a
//      run-together production line produces) on products whose name/brand
//      does NOT look Nike/Jordan (9-digit legacy) or Puma (8-digit): those two
//      are the only brands that PRINT all-numeric article codes. Plus any
//      stored code that is label-serial-shaped (interleaved run — a serial by
//      construction). HEURISTIC, stated openly: brand words are read from the
//      product's own name/brand fields, which are messy; the list is a report
//      for a human, never an input to a write.
//   3. SHAPE COVERAGE — for each suspected code, does the NEW full-token
//      extractor capture the stored line's SHAPE when a SYNTHETIC label
//      prints it in each plausible spelling (run-together / split /
//      hyphenated)? This is a shape-recognition check, not a claim about any
//      real photo: actual recovery additionally depends on the physical label
//      still printing that line legibly (the owner's floor proofs say it
//      does — the stored line came OFF the label) and on OCR reading it.
//
// ZERO writes. Run: node scripts/sweep-token-shapes.mjs

import { createRequire } from "module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { extractStyleCodeCandidates } = require("../functions/lib/style-code-ocr.cjs");
const { normaliseStyleCode, styleCodeFormat } = require("../functions/lib/style-code.cjs");

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });

const products = await admin.database().ref("products").once("value").then((s) => s.val() || {});

// One row per (product, code): confirmed and pending both count, marked.
const rows = [];
for (const [id, p] of Object.entries(products)) {
  if (!p || p.mergedInto) continue;
  const seen = new Set();
  for (const [field, raw] of [["confirmed", p.styleCodeNormalised], ["pending", p.pendingStyleCode]]) {
    const code = normaliseStyleCode(typeof raw === "string" ? raw : (raw && raw.styleCodeNormalised) || "");
    if (!code || seen.has(code)) continue;
    seen.add(code);
    rows.push({ id, code, field, name: p.name || "(unnamed)", brand: p.brand || "" });
  }
}

const shapeCounts = {};
for (const r of rows) {
  r.shape = styleCodeFormat(r.code) || "unrecognised";
  shapeCounts[r.shape] = (shapeCounts[r.shape] || 0) + 1;
}

// Brand-word heuristic for the two all-numeric article-code brands.
const looksNike = (r) => /\b(nike|jordan|dunk|air\s*max|air\s*force|af1|blazer|cortez|vapou?r|pegasus)\b/i.test(`${r.brand} ${r.name}`);
const looksPuma = (r) => /\bpuma\b/i.test(`${r.brand} ${r.name}`);

const suspected = rows.filter((r) => {
  if (r.shape === "numeric-6-3") return !looksNike(r);
  if (r.shape === "puma-6-2") return !looksPuma(r);
  if (r.shape === "label-serial") return true; // interleaved run = serial by construction
  return false;
});

// SHAPE COVERAGE: embed each suspected code, in each plausible printed
// spelling, in a SYNTHETIC label text and ask the REAL extractor whether the
// code comes back. Recognising the shape on a synthetic print is the
// necessary half of recovery; the sufficient half (the physical label, the
// OCR pass) can only be proven at the shelf.
const spellings = (code) => {
  const out = [code]; // run-together
  if (/^\d{9}$/.test(code)) out.push(`${code.slice(0, 5)} ${code.slice(5)}`, `${code.slice(0, 6)}-${code.slice(6)}`);
  if (/^\d{8}$/.test(code)) out.push(`${code.slice(0, 4)} ${code.slice(4)}`, `${code.slice(0, 6)}-${code.slice(6)}`);
  return out;
};
const shapeCapturedBy = (code, printed) =>
  extractStyleCodeCandidates(`BRAND MODEL LINE\n${printed}\nUK 8 US 9 EUR 42.5\nMADE IN VIETNAM`)
    .some((c) => c.normalised === code);

let capturedAll = 0, capturedAny = 0;
for (const r of suspected) {
  const forms = spellings(r.code);
  const hits = forms.map((f) => shapeCapturedBy(r.code, f));
  r.capturedAny = hits.some(Boolean);
  r.capturedAll = hits.every(Boolean);
  if (r.capturedAny) capturedAny++;
  if (r.capturedAll) capturedAll++;
}

const distinctProducts = new Set(rows.map((r) => r.id)).size;
console.log(`live products: ${Object.keys(products).length} · products with a code: ${distinctProducts} · code rows: ${rows.length}`);
console.log(`\nSHAPE CENSUS (rows):`);
for (const [shape, n] of Object.entries(shapeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${shape.padEnd(16)} ${n}`);
}
console.log(`\nSUSPECTED production/date/serial lines: ${suspected.length} rows ` +
  `(${new Set(suspected.map((r) => r.id)).size} products)`);
console.log(`  numeric-6-3 non-Nike: ${suspected.filter((r) => r.shape === "numeric-6-3").length}` +
  ` · puma-6-2 non-Puma: ${suspected.filter((r) => r.shape === "puma-6-2").length}` +
  ` · label-serial: ${suspected.filter((r) => r.shape === "label-serial").length}`);
console.log(`SHAPE CAPTURED by the new extractor (synthetic prints): any spelling ${capturedAny}/${suspected.length}` +
  ` · every spelling ${capturedAll}/${suspected.length}`);

console.log(`\nSAMPLE (30):`);
for (const r of suspected.slice(0, 30)) {
  console.log(`  ${r.id.padEnd(24)} ${r.code.padEnd(16)} ${r.shape.padEnd(13)} ${r.field.padEnd(9)} ` +
    `${r.capturedAll ? "shape captured" : r.capturedAny ? "shape captured(some spellings)" : "shape NOT captured"}  ${r.name.slice(0, 48)}`);
}

process.exit(0);
