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
//   3. RECOVERY — for each suspected code, would the NEW full-token extractor
//      surface the stored code from a label that prints it in any of its
//      printed spellings (run-together / split / hyphenated)? The stored line
//      is still on the label, so recovery = the extractor captures the shape.
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

// RECOVERY: embed each suspected code, in each printed spelling, in a
// label-shaped text and ask the REAL extractor whether the code comes back.
const spellings = (code) => {
  const out = [code]; // run-together
  if (/^\d{9}$/.test(code)) out.push(`${code.slice(0, 5)} ${code.slice(5)}`, `${code.slice(0, 6)}-${code.slice(6)}`);
  if (/^\d{8}$/.test(code)) out.push(`${code.slice(0, 4)} ${code.slice(4)}`, `${code.slice(0, 6)}-${code.slice(6)}`);
  return out;
};
const recoveredBy = (code, printed) =>
  extractStyleCodeCandidates(`BRAND MODEL LINE\n${printed}\nUK 8 US 9 EUR 42.5\nMADE IN VIETNAM`)
    .some((c) => c.normalised === code);

let recoveredAll = 0, recoveredAny = 0;
for (const r of suspected) {
  const forms = spellings(r.code);
  const hits = forms.map((f) => recoveredBy(r.code, f));
  r.recoveredAny = hits.some(Boolean);
  r.recoveredAll = hits.every(Boolean);
  if (r.recoveredAny) recoveredAny++;
  if (r.recoveredAll) recoveredAll++;
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
console.log(`RECOVERED by a full-token read: any printed spelling ${recoveredAny}/${suspected.length}` +
  ` · every spelling ${recoveredAll}/${suspected.length}`);

console.log(`\nSAMPLE (30):`);
for (const r of suspected.slice(0, 30)) {
  console.log(`  ${r.id.padEnd(24)} ${r.code.padEnd(16)} ${r.shape.padEnd(13)} ${r.field.padEnd(9)} ` +
    `${r.recoveredAll ? "recovers" : r.recoveredAny ? "recovers(some spellings)" : "NOT recovered"}  ${r.name.slice(0, 48)}`);
}

process.exit(0);
