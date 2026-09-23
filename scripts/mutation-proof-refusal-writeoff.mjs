// ─── MUTATION PROOF — write-off after four refused days ──────────────────────
// Each guard in functions/lib/refusal-writeoff.cjs (and the engine / writer
// hooks it relies on) is broken on purpose, one at a time; the test that pins
// it must go RED, and GREEN again once the bytes are restored. Refuses a dirty
// tree (commit first) and restores from the bytes it read, never git checkout.
//
// Run: node scripts/mutation-proof-refusal-writeoff.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "./lib/mutationPreflight.mjs";

const WO = "functions/lib/refusal-writeoff.cjs";
const ADMIN = "functions/lib/admin-movement.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";
const T = ["test/refusal-writeoff.test.cjs"];
const SALE = ["src/components/stock/refusalWriteoffThenSale.test.js"];

const MUTATIONS = [
  { id: "M-FOUR-DAYS", guard: "four DIFFERENT days, not four refusals", file: WO,
    from: "    if (days.length < MIN_DISTINCT_DAYS) continue;", to: "    if (run.length < MIN_DISTINCT_DAYS) continue;", nodeTests: T },
  { id: "M-FULFIL-RESETS", guard: "a fulfilment in between restarts the count", file: WO,
    from: "    for (const e of evs) { if (e.fulfilled) run = []; else run.push(e); }", to: "    for (const e of evs) { if (!e.fulfilled) run.push(e); }", nodeTests: T },
  { id: "M-PARTIAL-IS-FULFIL", guard: "a partial send (sentQty) counts as a fulfilment", file: WO,
    from: 'const isFulfilment = (rr) => rr.status === "fulfilled" || num(Number(rr.sentQty)) > 0;', to: 'const isFulfilment = (rr) => rr.status === "fulfilled";', nodeTests: T },
  { id: "M-ARRIVALS-PROTECTED", guard: "stock that arrived after the first refusal is never erased", file: WO,
    from: "        if (m.to === loc && ARRIVAL_TYPES.has(m.type) && num(Number(m.qty)) > 0) protectedQty += num(Number(m.qty));", to: "", nodeTests: T },
  { id: "M-PRE-REFUSAL-BOUND", guard: "never more than was on paper when the refusals began", file: WO,
    from: "      if (first && b != null) preRefusalQty = Math.max(b, 0);", to: "      if (first && b != null) preRefusalQty = paperQty;", nodeTests: T },
  { id: "M-CURSOR", guard: "one run is written off once (cursor)", file: WO,
    from: "    const evs = g.events.filter((e) => e.ts > through)", to: "    const evs = g.events.filter((e) => e.ts > -1)", nodeTests: T },
  { id: "M-FULFILLEDBY", guard: "a request actually sent (fulfilledBy) is a fulfilment", file: WO,
    from: '  || !!(rr.fulfilledBy && typeof rr.fulfilledBy === "object");', to: "  || false;", nodeTests: T },
  { id: "M-LEDGER-SEND", guard: "a transfer out of the cell restarts the count", file: WO,
    from: "    if (g && ts) g.events.push(", to: "    if (false) g.events.push(", nodeTests: T },
  { id: "M-REPAIR-LIVE", guard: "a repair patches the live count", file: WO,
    from: "    if (r.idempotent) {\n      try {", to: "    if (false) {\n      try {", nodeTests: T },
  { id: "M-OPEN-DEFERS", guard: "an open request to the location defers it", file: WO,
    from: "    if (openAt.has(key)) {", to: "    if (false) {", nodeTests: T },
  { id: "M-WINDOW", guard: "a run older than the ledger window waits unless the cell is untouched", file: WO,
    from: "    if (run[0].ts < windowStartMs && !untouchedSince) {", to: "    if (false) {", nodeTests: T },
  { id: "M-PINE", guard: "Marathon Pine is excluded", file: WO,
    from: "    if (!fulfilled && EXCLUDED_LOCATIONS.includes(rr.requestingLocation)) continue;", to: "", nodeTests: T },
  { id: "M-PINE-FULFIL-COUNTS", guard: "a fulfilment to Pine still restarts the count", file: WO,
    from: "    if (!fulfilled && EXCLUDED_LOCATIONS.includes(rr.requestingLocation)) continue;", to: "    if (EXCLUDED_LOCATIONS.includes(rr.requestingLocation)) continue;", nodeTests: T },
  { id: "M-KILL-SWITCH", guard: "the kill switch stops it", file: WO,
    from: "  if (config?.refusalWriteoff?.enabled === false) return out;   // live kill switch", to: "", nodeTests: T },
  { id: "M-REPAIR", guard: "a half-applied write-off is repaired, not lost", file: WO,
    from: "    if (cell && (cell.mv === id || cell.lastRelMv === id || cell.relMv === id)) {", to: "    if (false) {", nodeTests: T },
  { id: "M-STREAK-CLEAR", guard: "the streaks the refusals built are cleared (Recount Needed)", file: WO,
    from: "      patch[`refill_engine/rejectStreak/${dest}/${w.pid}/${sk}`] = null;", to: "", nodeTests: T },
  { id: "M-SNAPSHOT-PATCH", guard: "the same scan plans from the empty cell", file: WO,
    from: "      stockRow[w.cellKey] = { ...(c && typeof c === \"object\" ? c : {}), qty: after, mv: w.id, lastType: \"adjustment\" };", to: "", nodeTests: T },
  { id: "M-EXPECT", guard: "a cell that moved since the plan is not erased", file: ADMIN,
    from: "      if (movement.expectQty != null && curQty !== Number(movement.expectQty)) return undefined;   // moved since the plan — reported below", to: "", nodeTests: T },
  { id: "M-LASTTYPE", guard: "the cell's lastType stays inside the live /stock rule enum", file: ADMIN,
    from: 'const cellLastType = (type) => (type === "refusal_writeoff" ? "adjustment" : type);', to: "const cellLastType = (type) => type;", nodeTests: T, tests: SALE },
  { id: "M-ONE-CELL", guard: "a write-off debits exactly one cell", file: ADMIN,
    from: '    case "refusal_writeoff": return m.from && !m.to ? [{ loc: m.from, delta: -qty }] : null;', to: '    case "refusal_writeoff": return m.from && !m.to ? [{ loc: m.from, delta: -qty }, { loc: "central", delta: -qty }] : null;', nodeTests: T },
  { id: "M-ENGINE-LIFT", guard: "a write-off lifts the shop's retry behind the refusals", file: ENGINE,
    from: "            && !writtenOffAfter(rt.source || denier, pid, sizeKey, Date.parse(rt.lastRejectedAt || 0) || 0)) {", to: ") {", nodeTests: T },
  { id: "M-ENGINE-DISPUTE", guard: "a write-off clears #641's count-disputed row", file: ENGINE,
    from: '(m.type === "adjustment" || m.type === "refusal_writeoff")', to: '(m.type === "adjustment")', nodeTests: T },
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
