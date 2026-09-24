// ─── MUTATION PROOF — one footwear policy ─────────────────────────────────────
//
// For each guard: reintroduce the hole, prove the suite FAILS, restore the
// file, prove it PASSES. A green test proves nothing until it has been watched
// breaking when the property it claims is broken on purpose.
//
//   M-ENGINE-CARRIED  delete the engine's carriedOnly gate — the footwear
//                     policy would arm pairs with no stock cell (WHERE, not
//                     HOW MANY)
//   M-MIRROR-CARRIED  delete the SAME gate in the browser mirror — the Seating
//                     tab would show a target the engine never uses
//   M-MIRROR-GROUP    the mirror stops resolving groups — every footwear
//                     category reads "Not carried" in the browser
//   M-MIRROR-SIZE     the mirror reads one size's row for every size
//   M-DRIFT-OWN       the drift check stops reporting an own entry
//   M-WRITE-OWN       the write path stops refusing a footwear own entry
//   M-WRITE-REVERT    the revert exemption accepts any id
//   M-WRITE-STALE     an old history entry for the same key counts as a revert
//
// ERROR is not FAIL, anchors must be unique, restore is signal-safe, and the
// tree must be clean for the mutated files (commit first).
//
// Run: node scripts/mutation-proof-footwear-one-policy.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ENGINE = "functions/lib/refill-engine.cjs";
const RESOLVE = "functions/lib/policy-resolve.cjs";
const WRITE = "functions/lib/category-policy-write.cjs";
const MIRROR = "src/components/stock/seatingCore.js";

const NODE = ["test/footwear-one-policy.test.cjs"];
const PARITY = ["src/components/stock/footwearOnePolicy.parity.test.js"];

const MUTATIONS = [
  { id: "M-ENGINE-CARRIED", guard: "the engine never arms a footwear pair with no stock cell", file: ENGINE,
    from: `  if (r.carriedOnly && !storeCarries(stock, dest, pid)) return null;`, to: ``, node: NODE },
  { id: "M-MIRROR-CARRIED", guard: "the mirror applies the same carried-only gate as the engine", file: MIRROR,
    from: `  if (r.carriedOnly && !storeCarries(stock, dest, pid)) return null;`, to: ``, vitest: PARITY },
  { id: "M-MIRROR-GROUP", guard: "the mirror resolves an armed group like the engine", file: MIRROR,
    from: `    if (g.armed !== true) return false;\n    if (!isObj(g.policy)) return false;`,
    to: `    if (g.armed !== true || true) return false;\n    if (!isObj(g.policy)) return false;`, vitest: PARITY },
  { id: "M-MIRROR-SIZE", guard: "the mirror reads each size's own row", file: MIRROR,
    from: `    const row = entry.sizes[engineSizeKey(size)];`, to: `    const row = entry.sizes["6"];`, vitest: PARITY },
  { id: "M-DRIFT-OWN", guard: "drift reports a footwear category with its own entry", file: RESOLVE,
    from: `      issues.push({ kind: "own_entry", key, detail: \`\${key} has its own numbers, which override the footwear policy\` });`,
    to: ``, node: NODE },
  { id: "M-WRITE-OWN", guard: "the write path refuses a footwear own entry while the policy is armed", file: WRITE,
    from: `  if (FOOTWEAR_CATEGORY_KEYS.includes(categoryKey) && d.policy !== null && footwearGroupArmed(cfg)`,
    to: `  if (false && FOOTWEAR_CATEGORY_KEYS.includes(categoryKey) && d.policy !== null && footwearGroupArmed(cfg)`, node: NODE },
  { id: "M-WRITE-REVERT", guard: "a revert must match its history entry", file: WRITE,
    from: `  return sameValue(h.before ?? null, value ?? null);`, to: `  return true;`, node: NODE },
  { id: "M-WRITE-STALE", guard: "only the newest change to a key can be reverted past the rule", file: WRITE,
    from: `  if (!recent.length || recent[0].id !== id) return false;`, to: ``, node: NODE },
];

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}
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
const run = (m) => (m.vitest ? runVitest(m.vitest) : runNodeTests(m.node));

{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(MUTATIONS.map((m) => m.file))]).toString().trim();
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
    console.log(`${m.id.padEnd(18)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = run(m);
    restore();
    restored = run(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id.padEnd(18)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) process.exit(1);
