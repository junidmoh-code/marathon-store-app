// ─── MUTATION PROOF — the Hub 1 carriedOnly scope gate ───────────────────────
//
// For each guard: reintroduce the hole, prove the suite FAILS, restore the
// file, prove it PASSES. A green test proves nothing on its own — it has to be
// watched breaking when the property it claims to hold is broken on purpose.
// Mutation SHAPES are varied, not only locations (a test can be sensitive to a
// deletion and blind to a weakening):
//
//   M-GATE          delete the storeCarries gate in categoryPolicyEntry — the
//                   flood: every sneaker in the category arms at Hub 1
//   M-GATE-2        weaken carriedOnlyOf to always-false — same flood, reached
//                   through the leaf module instead of the engine
//   M-GATE-3        drop the carriedOnly pass-through from ONE of the two
//                   locationPolicyFor return shapes (per-size — the shape the
//                   live policy uses), so a per-size entry silently unscopes
//   M-OTHERS        make the gate leak sideways: gate EVERY entry on carriage
//                   (carriedOnlyOf ignored, always gate) — hub2/PE/Trophy
//                   clothing policies would silently stop governing uncarried
//                   products, which the deep-equal "others unchanged" test and
//                   the frozen clothing snapshot must catch
//
// Same discipline as scripts/mutation-proof-policy-groups.mjs: ERROR is not
// FAIL, anchors must be unique, restore is signal-safe, tree must be clean.
//
// Run: node scripts/mutation-proof-hub1-scope-gate.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RESOLVE = "functions/lib/policy-resolve.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";

const HUB1_TESTS = ["test/hub1-sneaker-policy.test.cjs"];
const FROZEN_TESTS = ["test/clothing-resolution-frozen.test.cjs", "test/category-policy-differential.test.cjs"];

const MUTATIONS = [
  {
    id: "M-GATE",
    guard: "carriedOnly gates on storeCarries at the engine's one choke point",
    file: ENGINE,
    from: `  if (r.carriedOnly && !storeCarries(stock, dest, pid)) return null;`,
    to: ``,
    nodeTests: HUB1_TESTS,
  },
  {
    id: "M-GATE-2",
    guard: "carriedOnlyOf actually reads the flag — always-false unscopes every entry",
    file: RESOLVE,
    from: `function carriedOnlyOf(locEntry) {
  return isPlainObject(locEntry)
    && locEntry.carriedOnly !== undefined && locEntry.carriedOnly !== false;
}`,
    to: `function carriedOnlyOf(locEntry) {
  return false;
}`,
    nodeTests: HUB1_TESTS,
  },
  {
    id: "M-GATE-3",
    guard: "the per-size return shape carries the flag — dropping it silently unscopes the live policy shape",
    file: RESOLVE,
    from: `    return { perSize: true, mode, target: null, minQty: null, reorderPoint: null,
      sizes: loc.sizes, carriedOnly: carriedOnlyOf(loc), source: eff.source, groupKey: eff.groupKey };`,
    to: `    return { perSize: true, mode, target: null, minQty: null, reorderPoint: null,
      sizes: loc.sizes, source: eff.source, groupKey: eff.groupKey };`,
    nodeTests: HUB1_TESTS,
  },
  {
    id: "M-OTHERS",
    guard: "the gate must not leak to unflagged entries — always-gating breaks standing clothing policies",
    file: ENGINE,
    from: `  if (r.carriedOnly && !storeCarries(stock, dest, pid)) return null;`,
    to: `  if (!storeCarries(stock, dest, pid)) return null;`,
    nodeTests: FROZEN_TESTS,
  },
];

function runNodeTests(files) {
  try {
    execFileSync("node", ["--test", "--test-reporter=tap", ...files],
      { stdio: "pipe", cwd: "functions", maxBuffer: 64 * 1024 * 1024 });
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
    console.error("Commit first — a dirty file would be captured as the baseline.");
    process.exit(2);
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-", proven: false });
    console.log(`${m.id.padEnd(12)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
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
  console.log(`${m.id.padEnd(12)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
