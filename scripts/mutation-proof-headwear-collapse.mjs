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
    from: `      } else if (q < 0) {`,
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
    from: `  if (NOT_A_CAP.test(name)) return null;
  return "cap";`,
    to: `  if (NOT_A_CAP.test(name)) return null;
  return null;`,
    tests: SUITE,
  },
  {
    id: "M10",
    guard: "Visors and bucket hats are OUT of scope even though they share the shelf",
    file: CORE,
    from: `const NOT_A_CAP = /\\bvisors?\\b|\\bbucket\\s*hats?\\b/i;`,
    to: `const NOT_A_CAP = /\\bnothingmatchesthis\\b/i;`,
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
    guard: "An interrupted Step 1 resumes the IN leg from the LEDGER, not the emptied cell",
    file: CORE,
    from: `        if (out && !inMv) {`,
    to: `        if (false) {`,
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
    guard: "A policy row must carry minQty, and reorderPoint null is refused rather than written",
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
    from: `      if (q > 0 && !out && !inMv) {`,
    to: `      if (q > 0) {`,
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
