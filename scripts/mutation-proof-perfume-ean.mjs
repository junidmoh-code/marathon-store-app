// ─── MUTATION PROOF HARNESS — perfume printed-barcode capture ────────────────
// For each guard: reintroduce the bug, prove the test suite FAILS, restore the
// file, prove it PASSES. A test that cannot fail proves nothing, so this runs
// the whole cycle and refuses to report a pass it did not watch break first.
//
// Run:  node scripts/mutation-proof-perfume-ean.mjs
// Safe: every mutation is applied to a file whose original bytes are held in
// memory and written back in a finally block, including on a crash.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
    from: `  for (const c of verdict.codes) updates[\`barcodes/\${c}\`] = record;`,
    to: `  for (const c of verdict.indexCodes) updates[\`barcodes/\${c}\`] = record;`,
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
    from: `      && isPrintedBarcode(extras.printedBarcode)) {`,
    to: `      && true) {`,
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
  // ── Round 2: the guards the Kimi + Codex review round added ───────────────
  {
    id: "M18",
    guard: "A perfume EAN cannot survive a switch to a SIZED category",
    file: "src/utils/newProductRecord.js",
    from: `  if (isPerfume(legacy)
      && typeof extras.printedBarcode === "string"`,
    to: `  if (true
      && typeof extras.printedBarcode === "string"`,
    tests: ["src/utils/printedBarcodeRecord.test.js"],
  },
  {
    id: "M19",
    guard: "The form clears the barcode answer on a category change",
    file: "src/App.jsx",
    from: `        printedBarcode: null,
        printedBarcodeAuto: false,`,
    to: ``,
    tests: ["src/components/stock/displayRegisterRemoved.test.js"],
  },
  {
    id: "M20",
    guard: "The product field rides the SAME commit as the index rows",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  Object.assign(updates, extraUpdates || {});`,
    to: ``,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M21",
    guard: "An ALREADY-registered code still backfills a missing product field",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  if (reg.kind === PRINTED_ALREADY) {`,
    to: `  if (false) {`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M28",
    guard: "A refused registration never lets the record claim the code",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  const extraUpdates = { [\`products/\${productId}/printedBarcode\`]: code };`,
    to: `  const extraUpdates = {};
  await update(ref(database), { [\`products/\${productId}/printedBarcode\`]: code });`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M29",
    guard: "A 13-digit code beginning with 0 also registers its UPC-A spelling",
    file: "src/utils/eanBarcode.js",
    from: `  if (s.length === 13 && s.startsWith("0")) return [s, s.slice(1)];`,
    to: ``,
    tests: [
      "src/utils/eanBarcode.test.js",
      "src/utils/productSearch.printedBarcode.test.js",
    ],
  },
  {
    id: "M30",
    guard: "Search finds EVERY spelling of a captured code, not just the stored one",
    file: "src/utils/productSearch.js",
    from: `  if (p.printedBarcode != null) codes.push(...indexCodesFor(String(p.printedBarcode)));`,
    to: `  if (p.printedBarcode != null) codes.push(String(p.printedBarcode));`,
    tests: ["src/utils/productSearch.printedBarcode.test.js"],
  },
  {
    id: "M22",
    guard: "A row pointing at the WRONG SIZE is not \"already registered\"",
    file: "src/utils/eanBarcode.js",
    from: `  if (wrongSize) {`,
    to: `  if (false) {`,
    tests: [
      "src/components/stock/printedBarcodeStore.test.js",
      "src/components/admin/PrintedBarcodeCapture.test.jsx",
    ],
  },
  {
    id: "M23",
    guard: "An OMITTED index size reads as one-size, matching the POS resolver",
    file: "src/utils/eanBarcode.js",
    from: `  return size == null || size === "" ? "_" : String(size);`,
    to: `  return String(size);`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M24",
    guard: "A code that is not a barcode is refused, not a silent no-op success",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  if (!parsed.ok) {
    return { kind: PRINTED_INVALID, code: String(code ?? ""), codes: [], indexCodes: [] };
  }`,
    to: `  if (false) {
    return { kind: PRINTED_INVALID, code: String(code ?? ""), codes: [], indexCodes: [] };
  }`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M25",
    guard: "Both forms of a UPC-A commit ATOMICALLY — never one without the other",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `    await update(ref(database), updates);`,
    to: `    for (const [p, v] of Object.entries(updates)) await update(ref(database), { [p]: v });`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M26",
    guard: "A lost race is diagnosed as a CONFLICT, not as a permission denial",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `    if (after && after.kind === PRINTED_CONFLICT) {`,
    to: `    if (false) {`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M32",
    guard: "The no-label rule follows the code that REGISTERED, not the one attempted",
    file: "src/App.jsx",
    from: `            const usesPrintedBarcode = printedBarcodeActive;`,
    to: `            const usesPrintedBarcode = !!printedCode;`,
    tests: ["src/components/stock/displayRegisterRemoved.test.js"],
  },
  {
    id: "M27",
    guard: "A superseded capture never reports against the new product",
    file: "src/components/admin/PrintedBarcodeCapture.jsx",
    from: `      if (!isCurrent(token)) return;
      if (verdict.kind === PRINTED_CONFLICT) {`,
    to: `      if (false) return;
      if (verdict.kind === PRINTED_CONFLICT) {`,
    tests: ["src/components/admin/PrintedBarcodeCapture.test.jsx"],
  },
  {
    id: "M33",
    guard: "The capture REMOUNTS on a perfume→perfume category change",
    file: "src/components/admin/NewProductForm.jsx",
    from: `              key={form.categoryKey}\n`,
    to: ``,
    tests: ["src/components/admin/NewProductForm.perfume.test.jsx"],
  },
  {
    id: "M34",
    guard: "Only a CONFIRMED index check earns the no-label path (not a failed read)",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  if (!indexCheck || indexCheck.status !== "confirmed") return false;`,
    to: `  if (!indexCheck || indexCheck.status === "impossible") return false;`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M35",
    guard: "A confirmation for a DIFFERENT code never suppresses the label",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  return indexCheck.code === printedCode;`,
    to: `  return true;`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M36",
    guard: "BOTH receive gates route through the one label decision",
    file: "src/App.jsx",
    from: `            if (!labelIsRedundant(printedCode, indexCheck)) setPrintOpen(true);`,
    to: `            setPrintOpen(true);`,
    tests: ["src/components/stock/displayRegisterRemoved.test.js"],
  },
  {
    id: "M37",
    guard: "The NORMALISED code is what gets indexed and stored, not the raw input",
    file: "src/components/stock/printedBarcodeStore.js",
    from: `  const codes = indexCodesFor(parsed.code);`,
    to: `  const codes = indexCodesFor(code);`,
    tests: ["src/components/stock/printedBarcodeStore.test.js"],
  },
  {
    id: "M17",
    guard: "The captured code is searchable in the app that wrote it",
    file: "src/utils/productSearch.js",
    from: `  if (p.printedBarcode != null) codes.push(...indexCodesFor(String(p.printedBarcode)));`,
    to: ``,
    tests: ["src/utils/productSearch.printedBarcode.test.js"],
  },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Treating every failure as "FAIL" is how a mutation gets credited for a guard
// it never exercised: a syntax error the mutation introduced, a missing test
// file, a bad path — all exit non-zero, and the harness would report the guard
// PROVEN without a single assertion having run. So the runner distinguishes
// "Vitest ran and tests failed" from "Vitest could not run", and only the
// former counts. (CodeRabbit, PR #340.)
function runTests(files) {
  try {
    // maxBuffer: a source-pinning test that fails prints the ENTIRE file it
    // asserts on as the "received" value. App.jsx is 17k lines, which blows the
    // 1MB default, truncates the captured output, and loses the summary line
    // the verdict is read from — the run then reports ERROR for a mutation that
    // failed exactly as intended. Found by the ERROR detection above, which is
    // the point of having it.
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    // Vitest prints a "Tests  N failed" / "Test Files  N failed" tally only
    // when it actually executed a suite.
    //
    // CAVEAT, accepted for a dev script: this classifies on Vitest's English
    // summary. A suite that dies via an unhandled rejection outside any test,
    // or a future Vitest that rewords the tally, reports ERROR for a genuine
    // guard failure — the same misclassification this replaced, one layer
    // down. ERROR is loud and stops the run, so it fails safe rather than
    // silently crediting a mutation. (Kimi review, PR #340.)
    // ONLY the executed-test tally counts. "Test Files N failed" is also
    // printed when a file fails to COLLECT or TRANSFORM — a mutation that
    // introduces a syntax error would otherwise be credited with proving a
    // guard no assertion ever ran. (CodeRabbit, PR #340.)
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

// The restored run re-executes the same suites against byte-identical source,
// so within one harness run its result is deterministic per test-set. Several
// mutations share a test list; caching halves the wall time. (CodeRabbit.)
// ── PREFLIGHT: NEVER MUTATE AN ALREADY-DIRTY FILE ─────────────────────────────
// If a previous run was killed mid-mutation, its file is still broken on disk —
// and this run would capture that broken text as `original` and faithfully
// "restore" it afterwards, cementing the damage while reporting green.
// (CodeRabbit, PR #340.)
{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(MUTATIONS.map((m) => m.file))])
    .toString().trim();
  if (dirty) {
    console.error("Working tree is not clean for the files this harness mutates:\n" + dirty);
    console.error("Commit or stash first — a dirty file would be captured as the baseline.");
    process.exit(2);
  }
}

const restoredCache = new Map();
const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  // ── THE ANCHOR MUST BE UNIQUE ─────────────────────────────────────────────
  // String.replace with a string pattern edits only the FIRST occurrence. If an
  // anchor matches twice, the other site keeps the guard intact — the suite can
  // still pass, and the harness reports NOT PROVEN for a guard that is in fact
  // covered, or quietly proves the wrong line. Ambiguity is a harness fault,
  // not a result. (CodeRabbit, PR #340.)
  const hits = original.split(m.from).length - 1;
  if (hits === 0) {
    results.push({ ...m, mutated: "ANCHOR-MISSING", restored: "-" });
    console.log(`${m.id}  ANCHOR NOT FOUND in ${m.file}`);
    continue;
  }
  if (hits > 1) {
    results.push({ ...m, mutated: "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id}  ANCHOR FOUND ${hits}× in ${m.file} — widen it`);
    continue;
  }
  let mutated = "?";
  let restored = "?";
  // `finally` does not run when the process is KILLED, and a mutated source
  // file left in the working tree is a deliberately broken product waiting to
  // be committed. Restore on the signals too. (CodeRabbit, PR #340.)
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    // A FUNCTION replacement is inserted verbatim: `$&`, `$'` and `$n` inside
    // m.to keep no special meaning. No mutation uses them today, but one that
    // did would silently write different bytes than intended, the suite would
    // still fail, and the guard would be reported PROVEN against source that
    // was never produced. (CodeRabbit, PR #340.)
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runTests(m.tests);
  } finally {
    restore();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  // PROVE THE RESTORE. A `finally` does not survive a process kill, and a
  // half-restored source file left in the working tree is a deliberately broken
  // product waiting to be committed. Verified byte-for-byte, and the run stops
  // dead rather than continuing to mutate more files. (Codex review, PR #340.)
  if (readFileSync(m.file, "utf8") !== original) {
    console.error(`\n*** ${m.file} DID NOT RESTORE — restore it from git before doing anything else. ***`);
    process.exit(2);
  }
  const cacheKey = [...m.tests].sort().join("|");
  if (!restoredCache.has(cacheKey)) restoredCache.set(cacheKey, runTests(m.tests));
  restored = restoredCache.get(cacheKey);
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
