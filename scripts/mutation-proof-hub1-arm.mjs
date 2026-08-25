// ─── MUTATION PROOF — the PR #448 arming guards ──────────────────────────────
//
// Same discipline as mutation-proof-deactivate.mjs: reintroduce each hole,
// prove FAIL, restore, prove PASS. The scope-gate harness this replaces was
// deleted with the gate it proved (owner order); these are the guards the
// UNSCOPED arming stands on:
//
//   M-DIFF-SIZES   blind the diff to per-size maps again (a card edit or a
//                  tranche would silently discard as "no change")
//   M-NOCHANGE     no-change on diff-empty instead of byte-same (the
//                  carriedOnly scrub would never write)
//   M-STALE-FLAG   make the removed carriedOnly flag load-bearing again in
//                  the engine (transition window regression)
//   M-DEAD-SIZE    break the dead-size dormancy for zero-everywhere lines
//
// Run: node scripts/mutation-proof-hub1-arm.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const POLICY = "functions/lib/category-policy.cjs";
const WRITE = "functions/lib/category-policy-write.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";

const WRITE_TESTS = ["test/category-policy-write.test.cjs"];
const HUB1_TESTS = ["test/hub1-sneaker-policy.test.cjs"];

const MUTATIONS = [
  {
    id: "M-DIFF-SIZES",
    guard: "a per-size edit / tranche addition produces a named diff leg",
    file: POLICY,
    from: `    const bs = isPlainObject(bl?.sizes) ? bl.sizes : null;
    const as_ = isPlainObject(al?.sizes) ? al.sizes : null;
    if (bs || as_) {`,
    to: `    const bs = null;
    const as_ = null;
    if (bs || as_) {`,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M-NOCHANGE",
    guard: "no-change means BYTE-SAME — a shape-only scrub still writes",
    file: WRITE,
    from: `  if (!changes.length && sameValue(before ?? null, policyAfter)) {
    return { ok: true, noChange: true, categoryKey, before, after: policyAfter, changes: [], preview };
  }
  if (!changes.length) changes.push({ loc: null, field: "shape", from: "legacy", to: "cleaned" });`,
    to: `  if (!changes.length) {
    return { ok: true, noChange: true, categoryKey, before, after: policyAfter, changes: [], preview };
  }`,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M-STALE-FLAG",
    guard: "a stray carriedOnly on the live entry stays inert in the engine",
    file: ENGINE,
    from: `  const r = locationPolicyFor(config, key, dest);
  if (!r) return null;
  return { target: r.target, reorderPoint: r.reorderPoint, minQty: r.minQty,
    perSize: r.perSize, sizes: r.sizes,
    policySource: r.source, groupKey: r.groupKey };`,
    to: `  const r = locationPolicyFor(config, key, dest);
  if (!r) return null;
  if (config?.categoryPolicy?.[key]?.[dest]?.carriedOnly && !storeCarries(stock, dest, pid)) return null;
  return { target: r.target, reorderPoint: r.reorderPoint, minQty: r.minQty,
    perSize: r.perSize, sizes: r.sizes,
    policySource: r.source, groupKey: r.groupKey };`,
    nodeTests: HUB1_TESTS,
  },
  {
    id: "M-DEAD-SIZE",
    guard: "zero-everywhere sizes stay dormant at target 0",
    file: ENGINE,
    from: `    return shape(sizeUnitsAnywhere(stock, pid, size) > 0 ? row.target : 0, row.minQty, row.reorderPoint);`,
    to: `    return shape(row.target, row.minQty, row.reorderPoint);`,
    nodeTests: HUB1_TESTS,
  },
];

function runNodeTests(files) {
  try {
    execFileSync("node", ["--test", "--test-reporter=tap", ...files], { stdio: "pipe", cwd: "functions", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 140)})`;
    }
    if (/^# fail [1-9]/m.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}

{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(MUTATIONS.map((m) => m.file))])
    .toString().trim();
  if (dirty) {
    console.error("Working tree is not clean for the files this harness mutates:\n" + dirty);
    process.exit(2);
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(14)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runNodeTests(m.nodeTests);
    restore();
    restored = runNodeTests(m.nodeTests);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id.padEnd(14)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}
const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
process.exit(bad.length ? 1 : 0);
