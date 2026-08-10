// ─── MUTATION PROOF HARNESS — perfume printed-barcode capture ────────────────
// For each guard: reintroduce the bug, prove the test suite FAILS, restore the
// file, prove it PASSES. A test that cannot fail proves nothing, so this runs
// the whole cycle and refuses to report a pass it did not watch break first.
//
// Run:  node scripts/mutation-proof-perfume-ean.mjs
// Safe: every mutation is applied to a file whose original bytes are held in
// memory and written back in a finally block, including on a crash.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const MUTATIONS = [
  {
    id: "M1",
    guard: "A valid EAN-13 saves against the \"_\" sentinel",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `export const ONE_SIZE = "_";`,
    to: `export const ONE_SIZE = "Free Size";`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M2",
    guard: "A code failing its check digit is refused and never written",
    file: "src/utils/eanBarcode.js",
    from: `  if (!hasValidCheckDigit(digits)) {`,
    to: `  if (false && !hasValidCheckDigit(digits)) {`,
    tests: [
      "src/utils/eanBarcode.test.js",
      "src/components/admin/PrintedBarcodeCapture.test.jsx",
      "src/utils/printedBarcodeRecord.test.js",
    ],
  },
  {
    id: "M3",
    guard: "The check digit maths itself (weights run right-to-left)",
    file: "src/utils/eanBarcode.js",
    from: `    sum += Number(digits[i]) * (fromRight % 2 === 0 ? 3 : 1);`,
    to: `    sum += Number(digits[i]) * (i % 2 === 0 ? 3 : 1);`,
    tests: ["src/utils/eanBarcode.test.js"],
  },
  {
    id: "M4",
    guard: "An existing code on the SAME product reports already-registered",
    file: "src/utils/eanBarcode.js",
    from: `  if (!free.length && rows.length) return { kind: PRINTED_ALREADY };`,
    to: `  if (false) return { kind: PRINTED_ALREADY };`,
    tests: [
      "src/utils/eanBarcode.test.js",
      "src/components/stock/printedBarcodeStore.test.js",
    ],
  },
  {
    id: "M5",
    guard: "An existing code on a DIFFERENT product blocks and routes to duplicates",
    file: "src/utils/eanBarcode.js",
    from: `  const clash = rows.find((r) => r && r.productId && r.productId !== productId);`,
    to: `  const clash = null;`,
    tests: [
      "src/utils/eanBarcode.test.js",
      "src/components/stock/printedBarcodeStore.test.js",
      "src/components/admin/PrintedBarcodeCapture.test.jsx",
    ],
  },
  {
    id: "M6",
    guard: "Read-before-write: an existing entry is never overwritten",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  if (verdict.kind !== PRINTED_FREE) {`,
    to: `  if (false) {`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M7",
    guard: "Registering an EAN leaves an existing auto-generated code resolving",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  for (const c of verdict.codes) {`,
    to: `  for (const c of verdict.indexCodes) {`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M8",
    guard: "A decoded frame that fails its check digit is discarded, not used",
    file: "src/utils/barcodeDecode.js",
    from: `    const result = normalisePrintedBarcode(list[i]);
    if (result.ok) return { ok: true, code: result.code, frameIndex: i };`,
    to: `    const result = { ok: true, code: String(list[i]) };
    if (result.ok) return { ok: true, code: result.code, frameIndex: i };`,
    tests: ["src/utils/barcodeDecode.test.js"],
  },
  {
    id: "M9",
    guard: "The OCR digit fallback faces the same check-digit gate",
    file: "src/utils/barcodeDecode.js",
    from: `    const result = normalisePrintedBarcode(data.upc);
    if (result.ok) return { ok: true, code: result.code, fromDigits: true };`,
    to: `    const result = { ok: true, code: data.upc };
    if (result.ok) return { ok: true, code: result.code, fromDigits: true };`,
    tests: ["src/utils/barcodeDecode.test.js"],
  },
  {
    id: "M10",
    guard: "A UPC-A registers under BOTH its forms",
    file: "src/utils/eanBarcode.js",
    from: `  if (s.length === 12) return [s, \`0\${s}\`];`,
    to: `  if (s.length === 12) return [s];`,
    tests: [
      "src/utils/eanBarcode.test.js",
      "src/components/stock/printedBarcodeStore.test.js",
    ],
  },
  {
    id: "M11",
    guard: "Only the printed code the record was given may reach /products",
    file: "src/utils/newProductRecord.js",
    from: `  if (typeof extras.printedBarcode === "string" && isPrintedBarcode(extras.printedBarcode)) {`,
    to: `  if (typeof extras.printedBarcode === "string") {`,
    tests: ["src/utils/printedBarcodeRecord.test.js"],
  },
  {
    id: "M12",
    guard: "Perfume is decided by the classifier, not by one-size-ness or a label",
    file: "src/utils/productCategory.js",
    from: `  return !!record && record.category === PERFUME_CATEGORY;`,
    to: `  return !!record && String(record.label || record.category || "").toLowerCase().includes("perfume");`,
    tests: ["src/utils/printedBarcodeRecord.test.js"],
  },
  {
    id: "M13",
    guard: "A non-perfume product still auto-generates (the step never renders)",
    file: "src/components/admin/NewProductForm.jsx",
    from: `      {isPerfume && (`,
    to: `      {true && (`,
    tests: ["src/components/admin/NewProductForm.perfume.test.jsx"],
  },
  {
    id: "M14",
    guard: "Perfume cannot be saved with the barcode question unanswered",
    file: "src/components/admin/NewProductForm.jsx",
    from: `  const barcodeOk = !isPerfume || !!form.printedBarcode || !!form.printedBarcodeAuto;`,
    to: `  const barcodeOk = true;`,
    tests: ["src/components/admin/NewProductForm.perfume.test.jsx"],
  },
  {
    id: "M15",
    guard: "The deliberate fallback to auto-generation unblocks the save",
    file: "src/components/admin/NewProductForm.jsx",
    from: `  const barcodeOk = !isPerfume || !!form.printedBarcode || !!form.printedBarcodeAuto;`,
    to: `  const barcodeOk = !isPerfume || !!form.printedBarcode;`,
    tests: ["src/components/admin/NewProductForm.perfume.test.jsx"],
  },
  {
    id: "M16",
    guard: "A failed index READ never passes as a free slot",
    file: "src/components/admin/PrintedBarcodeCapture.jsx",
    from: `      setNote({ tone: "red", text: \`Could not check \${code} against the barcode index (\${err?.message || err}). Try again in a moment.\` });`,
    to: `      onCapture(code);`,
    tests: ["src/components/admin/PrintedBarcodeCapture.test.jsx"],
  },
  {
    id: "M17",
    guard: "The captured code is searchable in the app that wrote it",
    file: "src/utils/productSearch.js",
    from: `  if (p.printedBarcode != null) codes.push(String(p.printedBarcode));`,
    to: ``,
    tests: ["src/utils/productSearch.printedBarcode.test.js"],
  },
];

function runTests(files) {
  try {
    execSync(`npx vitest run ${files.join(" ")} --silent`, { stdio: "pipe" });
    return "PASS";
  } catch {
    return "FAIL";
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    results.push({ ...m, mutated: "ANCHOR-MISSING", restored: "-" });
    console.log(`${m.id}  ANCHOR NOT FOUND in ${m.file}`);
    continue;
  }
  let mutated = "?";
  let restored = "?";
  try {
    writeFileSync(m.file, original.replace(m.from, m.to));
    mutated = runTests(m.tests);
  } finally {
    writeFileSync(m.file, original);
  }
  restored = runTests(m.tests);
  results.push({ ...m, mutated, restored });
  const verdict = mutated === "FAIL" && restored === "PASS" ? "PROVEN" : "*** NOT PROVEN ***";
  console.log(`${m.id}  mutated=${mutated}  restored=${restored}  ${verdict}  — ${m.guard}`);
}

console.log("\n| # | Guard | Mutation | Mutated | Restored |");
console.log("|---|---|---|---|---|");
for (const r of results) {
  console.log(`| ${r.id} | ${r.guard} | \`${r.from.split("\n")[0].trim().slice(0, 60)}\` → \`${(r.to.split("\n")[0].trim() || "(deleted)").slice(0, 60)}\` | ${r.mutated} | ${r.restored} |`);
}
const unproven = results.filter((r) => !(r.mutated === "FAIL" && r.restored === "PASS"));
console.log(unproven.length ? `\n${unproven.length} NOT PROVEN` : "\nALL PROVEN");
process.exit(unproven.length ? 1 : 0);
