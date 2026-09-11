// ─── MUTATION PROOF — the fulfil-credit gap (FULFIL-CREDIT-GAP.md, Phase F) ──
// Reintroduce each hole, prove FAIL, restore, prove PASS. One mutation per
// guard the fix relies on:
//   • the negative base in the client writer (arrival onto −1 lands 1);
//   • the adjustment exemption (a count's delta must still net);
//   • the in_transit exemption (a negative transit cell keeps its signal);
//   • the release archive refusing to write without a ledger row;
//   • the sweep's automatic release when holding is off;
//   • the sweep's timer release past the window;
//   • the sweep refusing a deleted product;
//   • the sweep's server writer clamping the negative base;
//   • the engine capping the ask by Central's on-hand (qty = min(need, src)).
//
// Refuses a dirty tree for the files it mutates (restore is from bytes, never
// git). Run: node scripts/mutation-proof-fulfil-credit-gap.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "./lib/mutationPreflight.mjs";

const APPLY = "src/components/stock/applyMovement.js";
const HOLD = "src/components/stock/stockHoldStore.js";
const SWEEP = "functions/lib/transit-sweep.cjs";
const ADMIN = "functions/lib/admin-movement.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";

const NEG_TESTS = ["src/components/stock/applyMovementNegativeBase.test.js"];
const HOLD_TESTS = ["src/components/stock/stockHoldReleaseVerify.test.js"];
const SWEEP_TESTS = ["test/transit-sweep.test.cjs"];
const QTY_TESTS = ["test/fulfil-credit-gap-qty.test.cjs"];

const MUTATIONS = [
  {
    id: "M-NEG-BASE",
    guard: "an arrival onto a negative shelf credits from zero",
    file: APPLY,
    from: `      const clearedDebt = curQty < 0 && clampsNegativeBase(movement, d.delta, d.loc) ? curQty : 0;`,
    to: `      const clearedDebt = 0;`,
    tests: NEG_TESTS,
  },
  {
    id: "M-ADJ-EXEMPT",
    guard: "an adjustment still nets against the negative",
    file: APPLY,
    from: `  return delta > 0 && movement.type !== "adjustment" && loc !== "in_transit";`,
    to: `  return delta > 0 && loc !== "in_transit";`,
    tests: NEG_TESTS,
  },
  {
    id: "M-TRANSIT-EXEMPT",
    guard: "a +leg into in_transit is not clamped",
    file: APPLY,
    from: `  return delta > 0 && movement.type !== "adjustment" && loc !== "in_transit";`,
    to: `  return delta > 0 && movement.type !== "adjustment";`,
    tests: NEG_TESTS,
  },
  {
    id: "M-RELEASE-VERIFY",
    guard: "the release archive is refused without a ledger row",
    file: HOLD,
    from: `    if (!recorded || recorded.to !== dest) {`,
    to: `    if (false) {`,
    tests: HOLD_TESTS,
  },
  {
    id: "M-SWEEP-HOLD-OFF",
    guard: "holding off → every held line is released without a tap",
    file: SWEEP,
    from: `    const dueMs = releaseMs + (holdOn ? RELEASE_GRACE_MS : 0);`,
    to: `    const dueMs = releaseMs + RELEASE_GRACE_MS;`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-SWEEP-TIMER",
    guard: "a window 24h past is released on the timer",
    file: SWEEP,
    from: `    if (nowMs >= dueMs) {`,
    to: `    if (false) {`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-SWEEP-FLOOR",
    guard: "a held line is never released before its window",
    file: SWEEP,
    from: `    const dueMs = releaseMs + (holdOn ? RELEASE_GRACE_MS : 0);`,
    to: `    const dueMs = holdOn ? releaseMs + RELEASE_GRACE_MS : 0;`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-SWEEP-RETIRE",
    guard: "a held line whose movement already landed is retired, not left held forever",
    file: SWEEP,
    from: `      if (cand.source === "held" || !(line.releaseMovementId)) retirements.push(`,
    to: `      if (false) retirements.push(`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-SWEEP-APPORTION",
    guard: "one cell is never promised to two lines",
    file: SWEEP,
    from: `      remaining.set(ck, left - base.qty);
      releases.push({ ...base, why: holdOn`,
    to: `      releases.push({ ...base, why: holdOn`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-ADMIN-SIZEKEY",
    guard: "the server writer folds 'Free Size' to the '_' cell like the client",
    file: ADMIN,
    from: `  if (!s || s === "Free Size") return "_";`,
    to: `  if (!s) return "_";`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-ADMIN-COLDNULL",
    guard: "a cold transaction callback (null) is judged against the pre-read, never aborted as empty",
    file: ADMIN,
    from: `      const cur = raw === null ? preRead : raw;`,
    to: `      const cur = raw;`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-ADMIN-RESUME",
    guard: "a leg already stamped by this movement is never applied twice",
    file: ADMIN,
    from: `      if (cur && (cur.relMv === mvId || cur.lastRelMv === mvId)) return undefined;`,
    to: `      if (false) return undefined;`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-CLIENT-RELMV",
    guard: "a device retrying an id the server already applied moves nothing",
    file: APPLY,
    from: `      if (cell && cell.relMv === mvId) return { ok: false, reason: "in_flight_elsewhere", location: d.loc };`,
    to: ``,
    tests: NEG_TESTS,
  },
  {
    id: "M-SWEEP-DELETED",
    guard: "a deleted product is refused, never credited",
    file: SWEEP,
    from: `    if (productExists[line.productId] === false) { refusals.push({ ...base, why: "product record missing — nothing to credit; owner must place these units" }); continue; }`,
    to: ``,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-ADMIN-NEG-BASE",
    guard: "the server writer credits from zero on a negative hub cell",
    file: ADMIN,
    from: `      const clearedDebt = curQty < 0 && clampsNegativeBase(movement, d.delta, d.loc) ? curQty : 0;`,
    to: `      const clearedDebt = 0;`,
    nodeTests: SWEEP_TESTS,
  },
  {
    id: "M-SOLD-FLOOR",
    guard: "a sale never drives a cell below zero — the uncovered part is the ledger's shortfall",
    file: APPLY,
    from: `        newQty = booked - deducted;`,
    to: `        newQty = curQty - Number(movement.qty);`,
    tests: NEG_TESTS,
  },
  {
    id: "M-QTY-SOURCE-CAP",
    guard: "the ask is min(need, Central on-hand) — never more than Central holds",
    file: ENGINE,
    from: `        const qty = Math.min(deficit, srcAvail, maxUnits);`,
    to: `        const qty = Math.min(deficit, maxUnits);`,
    nodeTests: QTY_TESTS,
  },
  {
    id: "M-QTY-NEG-DEST",
    guard: "a negative destination cell reads as zero in the need",
    file: ENGINE,
    from: `const avail = (q) => Math.max(q, 0);`,
    to: `const avail = (q) => q;`,
    nodeTests: QTY_TESTS,
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

requireCleanTree([...new Set(MUTATIONS.map((m) => m.file))]);

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
