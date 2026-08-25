// ─── MUTATION PROOF — Hub 1 single path (owner order 2026-08-25) ─────────────
// Reintroduce each hole, prove FAIL, restore, prove PASS. Shapes varied:
// list-widening, bypass, filter-drop, predicate-revert, and the hub2-freeze
// inversion (proving hub2's lanes are pinned, not merely untouched).
//
// Run: node scripts/mutation-proof-hub1-single-path.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LIST = "src/components/stock/reactiveRefillHubs.js";
const ONHOLD = "src/components/stock/onHoldRefill.js";
const MISSING = "src/components/stock/MissingFootwear.jsx";
const APP = "src/App.jsx";
const CORE = "src/components/stock/refillQueueCore.js";
const SCAN = "functions/refill-scan.cjs";

const SP_TESTS = ["src/components/stock/hub1SinglePath.test.js", "src/components/stock/onHoldRefill.test.js"];
const SHADOW_TESTS = ["test/shadow-hub-legs.test.cjs"];

const MUTATIONS = [
  {
    id: "M-LIST-WIDEN",
    guard: "hub1 is not a reactive hub — the one list holds",
    file: LIST,
    from: `export const REACTIVE_REFILL_HUBS = Object.freeze(["hub2"]);`,
    to: `export const REACTIVE_REFILL_HUBS = Object.freeze(["hub1", "hub2"]);`,
    tests: SP_TESTS,
  },
  {
    id: "M-ONHOLD-BYPASS",
    guard: "the on-hold planner reads the list, not its own literal",
    file: ONHOLD,
    from: `const VALID_HUBS = new Set(REACTIVE_REFILL_HUBS);`,
    to: `const VALID_HUBS = new Set(["hub1", "hub2"]);`,
    tests: SP_TESTS,
  },
  {
    id: "M-MISSING-DEST",
    guard: "Missing Sneakers cannot default a request into hub1",
    file: MISSING,
    from: `    const dest = dests[card.pid] || REQUESTABLE_HUBS[0];
    if (busyPid || !canAct || !dest) return;`,
    to: `    const dest = dests[card.pid] || "hub1";
    if (busyPid || !canAct || !dest) return;`,
    tests: SP_TESTS,
  },
  {
    id: "M-SALEROWS",
    guard: "hub1's sale-driven rows stay off",
    file: APP,
    from: `    () => activeHub && isReactiveRefillHub(activeHub) ? saleRowsFor(activeHub, activeCellFilter) : [],`,
    to: `    () => activeHub ? saleRowsFor(activeHub, activeCellFilter) : [],`,
    tests: SP_TESTS,
  },
  {
    id: "M-PARKED-EMPTY",
    guard: "parked needs reach the queue rows",
    file: CORE,
    from: `  for (const item of exceptions?.awaitingSupplier?.items || []) push(item, "supplier");
  for (const item of exceptions?.awaitingUpstream?.items || []) push(item, "upstream");`,
    to: ``,
    tests: SP_TESTS,
  },
  {
    id: "M-PARKED-DEST",
    guard: "a queue shows ITS OWN parked needs, never another hub's",
    file: CORE,
    from: `    if (!item || item.loc !== dest) return;`,
    to: `    if (!item) return;`,
    tests: SP_TESTS,
  },
  {
    id: "M-SHADOW-PREDICATE",
    guard: "any non-store dest shadows as a refill row in its own queue",
    file: SCAN,
    from: `            if (!UNIVERSE_BY_SHOP[dest]) {`,
    to: `            if (dest === "hub2") {`,
    nodeTests: SHADOW_TESTS,
  },
  {
    id: "M-HUB2-FREEZE",
    guard: "hub2's reactive lanes are PINNED on, not merely untouched",
    file: LIST,
    from: `export const REACTIVE_REFILL_HUBS = Object.freeze(["hub2"]);`,
    to: `export const REACTIVE_REFILL_HUBS = Object.freeze([]);`,
    tests: SP_TESTS,
  },
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
function runAll(m) {
  const verdicts = [];
  if (m.tests?.length) verdicts.push(runVitest(m.tests));
  if (m.nodeTests?.length) verdicts.push(runNodeTests(m.nodeTests));
  const errored = verdicts.find((v) => String(v).startsWith("ERROR"));
  if (errored) return errored;
  return verdicts.includes("FAIL") ? "FAIL" : "PASS";
}

{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(MUTATIONS.map((m) => m.file))]).toString().trim();
  if (dirty) { console.error("Tree not clean for mutated files:\n" + dirty); process.exit(2); }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(19)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* keep going */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runAll(m);
    restore();
    restored = runAll(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id.padEnd(19)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}
const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
process.exit(bad.length ? 1 : 0);
