// ─── MUTATION PROOF HARNESS — headwear one-size collapse ─────────────────────
// For each guard: reintroduce the bug, prove the test suite FAILS, restore the
// file, prove it PASSES. A test that cannot fail proves nothing, so this runs
// the whole cycle and refuses to report a pass it did not watch break first.
//
// Run:  node scripts/mutation-proof-headwear-collapse.mjs
// Safe: every mutation is applied to a file whose original bytes are held in
// memory and written back in a finally block, including on a crash and on a
// signal, and the restore is verified byte-for-byte before the run continues.
//
// ── WHAT IS BEING PROVEN ─────────────────────────────────────────────────────
// The cap half of this migration turned three things from "insurance that never
// fired" into "load-bearing arithmetic", and each one is mutated here:
//   • the PER-SIZE movement id (M1/M2) — on a per-location id, a product holding
//     three sizes at one location silently loses two of them while every leg
//     reports ok. Beanies never held two sizes, so this bug was invisible.
//   • the MIRRORED pair for a negative cell (M3) — 9 live cells are negative.
//   • the KEEP-CODE rule (M6–M8) — 87 caps carry several barcodes.
// Plus the scope predicate (M9–M11), the fail-open size gate caps exposed (M4),
// Step 2's identity write (M12), the size-key chokepoint (M13), the drain
// precondition (M5) and the promise that nothing here ever arms a target (M14).
//
// M15–M20 cover the movement contract and the gates around it: the v+1 bump
// (M15), the overdraw floor (M16), the concurrent-write re-check that replaces
// the security rule the Admin SDK bypasses (M17), resuming an interrupted pair
// from the ledger (M18), movement-id idempotency (M19), and the transfer gate's
// refusal to name a size it could not parse (M20). M21–M24 cover what the
// review round added: orphan index records, the ledger's recorded size, and the
// two policy-row decisions, and M25-M27 the resume path that both independent
// reviews of #345 broke: a pair left half-applied by an interrupted run, whose
// source cell then moved before the resume.
//
// M28-M32 came out of the second review round: the resume/stranded
// de-duplication (M28), the mirrored pair's closing leg being owed on
// conservation grounds rather than on the cell's current value (M29), deferring
// a positive balance while a mirror resume is pending (M30), the orphan-index
// guard keying on the RECORD rather than the map key (M31), and the totals
// check expecting the credit a resumed pair owes instead of calling it minted
// stock (M32).

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CORE = "scripts/lib/headwearCollapseCore.mjs";
const SUITE = ["scripts/lib/headwearCollapseCore.test.mjs"];

const MUTATIONS = [
  {
    id: "M1",
    guard: "The IN leg's id is PER SIZE, so a second size at one location is not swallowed as idempotent",
    file: CORE,
    from: `  in: \`onesize_\${pid}_\${loc}_in_us_\${sizeKey}\`,`,
    to: `  in: \`onesize_\${pid}_\${loc}_in_us\`,`,
    tests: SUITE,
  },
  {
    id: "M2",
    guard: "The OUT leg's id is PER SIZE too",
    file: CORE,
    from: `  out: \`onesize_\${pid}_\${loc}_out_\${sizeKey}\`,`,
    to: `  out: \`onesize_\${pid}_\${loc}_out\`,`,
    tests: SUITE,
  },
  {
    id: "M3",
    guard: "A negative cell takes the MIRRORED pair instead of an overdrawing OUT",
    file: CORE,
    from: `      } else if (q < 0 && !negOut && !negIn) {`,
    to: `      } else if (false) {`,
    tests: SUITE,
  },
  {
    id: "M4",
    guard: "Every non-sentinel size is retired — the letter-only enumeration was fail-open on caps",
    file: CORE,
    from: `  return stockSizeKey(size) !== "_";`,
    to: `  return /^(XS|S|M|L|XL|XXL|XXXL)$/.test(String(size));`,
    tests: SUITE,
  },
  {
    id: "M5",
    guard: "Step 2's drain precondition reads the DATABASE, not Step 1's report",
    file: CORE,
    from: `      if (q !== 0) residue.push(\`\${loc}/\${sizeKey}=\${q}\`);`,
    to: `      if (false) residue.push(\`\${loc}/\${sizeKey}=\${q}\`);`,
    tests: SUITE,
  },
  {
    id: "M6",
    guard: "The keep-code rule ranks by UNITS, so the most-labelled size wins the slot",
    file: CORE,
    from: `      .sort((a, b) => (Number(b[1]) - Number(a[1]))`,
    to: `      .sort((a, b) => (Number(a[1]) - Number(b[1]))`,
    tests: SUITE,
  },
  {
    id: "M7",
    guard: "An existing \"_\" slot keeps the slot rather than being re-pointed at an older code",
    file: CORE,
    from: `  if (bySlot["_"]) {`,
    to: `  if (false) {`,
    tests: SUITE,
  },
  {
    id: "M8",
    guard: "EVERY code of a multi-barcode product is rewritten, so none goes dead",
    file: CORE,
    from: `    updates[\`barcodes/\${assertSafeSegment(code, "barcode")}/size\`] = "_";`,
    to: `    if (code === keepCode) updates[\`barcodes/\${assertSafeSegment(code, "barcode")}/size\`] = "_";`,
    tests: SUITE,
  },
  {
    id: "M9",
    guard: "Caps are IN scope — the shelf admits them, not the name",
    file: CORE,
    from: `  if (BUCKET_NAME.test(name)) return "bucket";
  return "cap";`,
    to: `  if (BUCKET_NAME.test(name)) return "bucket";
  return null;`,
    tests: SUITE,
  },
  {
    id: "M10",
    guard: "Visors are OUT of scope even though they share the shelf",
    file: CORE,
    from: `const VISOR_NAME = /\\bvisors?\\b/i;`,
    to: `const VISOR_NAME = /\\bnothingmatchesthis\\b/i;`,
    tests: SUITE,
  },
  {
    id: "M11",
    guard: "A mergedInto redirect stub is never collapsed in place",
    file: CORE,
    from: `  if (!product || product.mergedInto) return null;`,
    to: `  if (!product) return null;`,
    tests: SUITE,
  },
  {
    id: "M12",
    // NOT an atomicity proof. planStep2 returns an updates object; it does not
    // perform the write, so no mutation of it can split one io.update into two.
    // Atomicity is covered behaviourally instead — "sizes, the barcodes map and
    // every index record land in a SINGLE update call" counts db.stats.updates,
    // and "a partial application is impossible" fails the update and asserts the
    // old identity is intact. This mutation proves the sizes write is required
    // and that its absence is detected. (CodeRabbit, PR #345.)
    guard: "Step 2's identity update must carry the sizes write, and its absence is caught",
    file: CORE,
    from: `  updates[\`products/\${pid}/barcodes\`] = { [stockSizeKey(null)]: keepCode };   // {"_": code} via the chokepoint`,
    to: `  updates[\`products/\${pid}/barcodes\`] = { [stockSizeKey(null)]: keepCode };
  delete updates[\`products/\${assertSafeSegment(pid, "productId")}/sizes\`];`,
    tests: SUITE,
  },
  {
    id: "M13",
    guard: "A display label can never reach a storage key — the cell path goes through the chokepoint",
    file: CORE,
    from: `  const path = stockCellPath(loc, movement.productId, movement.size);`,
    to: `  const path = \`stock/\${loc}/\${movement.productId}/\${movement.size}\`;`,
    tests: SUITE,
  },
  {
    id: "M14",
    guard: "Step 3 only ever RETIRES a row to 0 — the collapse never arms a product",
    file: CORE,
    from: `      if (sizeKey === "_") continue;
      if (row && row.target === 0 && row.source === "excluded") continue;`,
    to: `      if (row && row.target === 0 && row.source === "excluded") continue;`,
    tests: SUITE,
  },
  {
    id: "M15",
    guard: "A cell write bumps v by exactly 1 and a NEW cell starts at 0",
    file: CORE,
    from: `    const newV = cell && typeof cell.v === "number" ? cell.v + 1 : 0;`,
    to: `    const newV = cell && typeof cell.v === "number" ? cell.v : 0;`,
    tests: SUITE,
  },
  {
    id: "M16",
    guard: "A positive OUT leg can never overdraw a cell",
    file: CORE,
    from: `    if (delta < 0 && newQty < 0 && !movement.allowNegative) {`,
    to: `    if (false) {`,
    tests: SUITE,
  },
  {
    id: "M17",
    guard: "A concurrent till sale is not silently overwritten (the version re-check)",
    file: CORE,
    from: `    if (!sameCell(cell, recheck)) continue;              // someone else wrote — recompute`,
    to: `    if (false) continue;`,
    tests: SUITE,
  },
  {
    id: "M18",
    guard: "An interrupted Step 1 resumes the IN leg at the LEDGER's quantity, not the cell's",
    file: CORE,
    from: `        const n = Number(out.qty);`,
    to: `        const n = 1;`,
    tests: SUITE,
  },
  {
    id: "M19",
    guard: "A movement id already in the ledger no-ops instead of double-applying",
    file: CORE,
    from: `    if (existing) return { ok: true, movementId: mvId, idempotent: true };`,
    to: `    if (false) return { ok: true, movementId: mvId, idempotent: true };`,
    tests: SUITE,
  },
  {
    id: "M20",
    guard: "A transfer node that cannot be parsed is not credited with a size it never showed",
    file: CORE,
    from: `    if (!(values.length && values.every((v) => typeof v === "number"))) { malformed = true; continue; }`,
    to: `    if (!(values.length && values.every((v) => typeof v === "number"))) { malformed = true; }`,
    tests: SUITE,
  },
  {
    id: "M21",
    guard: "An index record is never CREATED for a code the index does not have",
    file: CORE,
    from: `    if (!indexed.has(code)) continue;`,
    to: `    if (false) continue;`,
    tests: SUITE,
  },
  {
    id: "M22",
    guard: "The movement records the CATALOGUE size, not the encoded cell key",
    file: CORE,
    from: `      const size = declaredMatch ?? sizeKey;`,
    to: `      const size = sizeKey;`,
    tests: SUITE,
  },
  {
    id: "M23",
    guard: "Removing a policy row never depends on the product still being in scope",
    file: CORE,
    from: `  if (remove) {
    return isInScope(product)
      ? { ok: true }
      : { ok: true, note: "no longer in headwear scope (merged or renamed) — removing its row anyway" };
  }`,
    to: `  if (remove && isInScope(product)) return { ok: true };`,
    tests: SUITE,
  },
  {
    id: "M24",
    // Narrowly what the mutation removes: the minQty requirement. reorderPoint
    // handling is asserted by its own test but has no mutation of its own, so
    // this guard must not claim it. (CodeRabbit, PR #345.)
    guard: "A policy row must carry minQty (the live rule requires it)",
    file: CORE,
    from: `  if (typeof row.minQty !== "number" || !Number.isFinite(row.minQty)) return "minQty is not a finite number (the live rule REQUIRES it)";`,
    to: ``,
    tests: SUITE,
  },
  {
    id: "M25",
    guard: "A half-applied pair is completed from the LEDGER even when the cell has since moved",
    file: CORE,
    from: `      if (out && !inMv) {`,
    to: `      if (out && !inMv && q === 0) {`,
    tests: SUITE,
  },
  {
    id: "M26",
    guard: "A cell whose pair is already spent is STRANDED, never re-planned under the spent ids",
    file: CORE,
    from: `      if (q > 0 && !out && !inMv && !(negOut && !negIn)) {`,
    to: `      if (q > 0 && !(negOut && !negIn)) {`,
    tests: SUITE,
  },
  {
    id: "M27",
    guard: "The mirrored pair is not re-planned once its own ids are spent",
    file: CORE,
    from: `      } else if (q < 0 && !negOut && !negIn) {`,
    to: `      } else if (q < 0) {`,
    tests: SUITE,
  },
  {
    id: "M28",
    guard: "A cell the resume leg is about to close is NOT reported stranded (which would fail the very run this allows to finish)",
    file: CORE,
    from: `      } else if (q !== 0 && !resolvedByResume) {`,
    to: `      } else if (q !== 0) {`,
    tests: SUITE,
  },
  {
    id: "M29",
    guard: "A half-applied MIRRORED pair is always owed its closing leg — conservation, not the cell's value",
    file: CORE,
    from: `      if (negOut && !negIn) {`,
    to: `      if (negOut && !negIn && q === -Number(negOut.qty)) {`,
    tests: SUITE,
  },
  {
    id: "M30",
    guard: "A pending mirror resume defers this cell's positive balance instead of planning against a stale quantity",
    file: CORE,
    from: `      if (q > 0 && !out && !inMv && !(negOut && !negIn)) {`,
    to: `      if (q > 0 && !out && !inMv) {`,
    tests: SUITE,
  },
  {
    id: "M31",
    guard: "The orphan-index guard keys on the RECORD, so a present-but-null entry is not read as indexed",
    file: CORE,
    from: `  const indexed = new Set(Object.entries(indexCodes || {}).filter(([, rec]) => !!rec).map(([code]) => String(code)));`,
    to: `  const indexed = new Set(Object.keys(indexCodes || {}).map(String));`,
    tests: SUITE,
  },
  {
    id: "M32",
    guard: "A resumed pair's owed credit is EXPECTED by the totals check, not reported as minted stock",
    file: CORE,
    from: `    const b = (totalsBefore?.[loc] || 0) + (expectedDelta?.[loc] || 0), a = totalsAfter[loc] || 0;`,
    to: `    const b = (totalsBefore?.[loc] || 0), a = totalsAfter[loc] || 0;`,
    tests: SUITE,
  },

  // ── M33–M41: THE BUCKET-HAT WIDENING (2026-08-11) ──────────────────────────
  // Bucket hats moved from "rejected shelf-mate" to "in scope, own kind". Each
  // half of that sentence gets a mutation, and so does the structural promise
  // that the four consumer scripts cannot answer the scope question differently
  // from the core — the failure mode this widening would otherwise have created.
  {
    id: "M33",
    guard: "A bucket hat on the Caps & Hats shelf is IN scope",
    file: CORE,
    from: `  if (BUCKET_NAME.test(name)) return "bucket";`,
    to: `  if (BUCKET_NAME.test(name)) return null;`,
    tests: SUITE,
  },
  {
    id: "M34",
    guard: "A bucket hat is admitted ONLY from the shelf — never by its name alone, wherever it is filed",
    file: CORE,
    from: `  if (product.subcategory !== HEADWEAR_SUBCATEGORY) return null;`,
    to: `  if (product.subcategory !== HEADWEAR_SUBCATEGORY) return BUCKET_NAME.test(name) ? "bucket" : null;`,
    tests: SUITE,
  },
  {
    id: "M35",
    // The anchor spans all four lines on purpose. Appending a SECOND visor
    // check after the bucket test proves nothing — the one at the top has
    // already returned — so the mutation has to MOVE the check, not duplicate
    // it. The first attempt at this mutation was exactly that no-op, and the
    // harness correctly reported NOT PROVEN rather than crediting it.
    guard: "The visor test runs BEFORE the bucket-hat test, so a name carrying both words stays out",
    file: CORE,
    from: `  if (VISOR_NAME.test(name)) return null;
  if (BEANIE_NAME.test(name)) return "beanie";
  if (product.subcategory !== HEADWEAR_SUBCATEGORY) return null;
  if (BUCKET_NAME.test(name)) return "bucket";`,
    to: `  if (BEANIE_NAME.test(name)) return "beanie";
  if (product.subcategory !== HEADWEAR_SUBCATEGORY) return null;
  if (BUCKET_NAME.test(name)) return "bucket";
  if (VISOR_NAME.test(name)) return null;`,
    tests: SUITE,
  },
  {
    id: "M42",
    guard: "The visor test runs BEFORE the BEANIE test — the beanie rule is shelf-independent, so a later visor check is bypassable everywhere",
    file: CORE,
    from: `  if (VISOR_NAME.test(name)) return null;
  if (BEANIE_NAME.test(name)) return "beanie";`,
    to: `  if (BEANIE_NAME.test(name)) return "beanie";
  if (VISOR_NAME.test(name)) return null;`,
    tests: SUITE,
  },
  {
    id: "M43",
    guard: "The excluded report's grouping breaks the visor/bucket tie the same way the scope rule does",
    file: CORE,
    from: `  if (isVisorNamed(product)) return "visor";
  if (isBucketHatNamed(product)) return "bucket";`,
    to: `  if (isBucketHatNamed(product)) return "bucket";
  if (isVisorNamed(product)) return "visor";`,
    tests: SUITE,
  },
  {
    id: "M36",
    guard: "Exclusion is the COMPLEMENT of scope — no record can be in both lists, and none in neither",
    file: CORE,
    from: `  if (isInScope(product)) return false;
  return isVisorNamed(product) || isBucketHatNamed(product);`,
    to: `  return isVisorNamed(product) || isBucketHatNamed(product);`,
    tests: SUITE,
  },
  {
    id: "M37",
    guard: "Every kind the scope rule can return is in the shared kind list the counters are built from",
    file: CORE,
    from: `export const HEADWEAR_KINDS = ["beanie", "cap", "bucket"];`,
    to: `export const HEADWEAR_KINDS = ["beanie", "cap"];`,
    tests: SUITE,
  },
  {
    id: "M38",
    guard: "The census takes its name test from the core instead of restating it locally",
    file: "scripts/headwear-census.mjs",
    from: `    if (p?.mergedInto && (onShelf || isBeanieNamed(p))) {`,
    to: `    if (p?.mergedInto && (onShelf || /beanie/i.test(p?.name || ""))) {`,
    tests: SUITE,
  },
  {
    id: "M39",
    guard: "The CLI validates --kind against the shared kind list, so a newly admitted kind is runnable",
    file: "scripts/collapse-one-size-headwear.mjs",
    from: `if (KIND && !HEADWEAR_KINDS.includes(KIND)) {`,
    to: `if (KIND && KIND !== "beanie" && KIND !== "cap") {`,
    tests: SUITE,
  },
  {
    id: "M40",
    guard: "No consumer counts kinds from a hardcoded literal (which reads NaN for a kind it omits)",
    file: "scripts/headwear-preflight-probe.mjs",
    from: `  const kinds = emptyKindCount();`,
    to: `  const kinds = { beanie: 0, cap: 0 };`,
    tests: SUITE,
  },
  {
    id: "M41",
    guard: "Step 2 writes ONLY identity and index — a widening can leak no stock cell into it",
    file: CORE,
    from: `  updates[\`products/\${assertSafeSegment(pid, "productId")}/sizes\`] = ["_"];`,
    to: `  updates[\`products/\${assertSafeSegment(pid, "productId")}/sizes\`] = ["_"];
  updates[\`stock/hub2/\${pid}/_/qty\`] = 0;`,
    tests: SUITE,
  },
];

function runTests(files) {
  try {
    // maxBuffer: a failing suite can print a great deal; the default 1MB
    // truncates the summary line the verdict is read from, and the run then
    // reports ERROR for a mutation that failed exactly as intended.
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    // ONLY the executed-test tally counts. "Test Files N failed" is also
    // printed when a file fails to COLLECT or TRANSFORM — a mutation that
    // introduces a syntax error would otherwise be credited with proving a
    // guard no assertion ever ran. (CodeRabbit, PR #340.)
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

// ── PREFLIGHT: NEVER MUTATE AN ALREADY-DIRTY FILE ────────────────────────────
// If a previous run was killed mid-mutation, its file is still broken on disk —
// and this run would capture that broken text as `original` and faithfully
// "restore" it afterwards, cementing the damage while reporting green.
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
  // An anchor that matches zero or several places silently mutates nothing (or
  // the wrong line), the suite still passes, and the harness reports NOT PROVEN
  // for a guard that is in fact covered. Ambiguity is a harness fault, not a
  // result. (CodeRabbit, PR #340.)
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
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    // A FUNCTION replacement is inserted verbatim: `$&`, `$'` and `$n` inside
    // m.to keep no special meaning.
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runTests(m.tests);
  } finally {
    restore();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
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
