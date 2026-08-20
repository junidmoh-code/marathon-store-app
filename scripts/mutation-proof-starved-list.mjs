// ─── MUTATION PROOF HARNESS — the starved list (silent-miss detector) ────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore, prove it
// PASSES. Same discipline as mutation-proof-solve-carriage.mjs.
//
// WHY THIS FEATURE NEEDS IT MORE THAN MOST. The card exists to detect a silence, and
// a detector that is itself silently broken is worse than none — it converts "we do
// not know" into "we checked and it was fine". Every guard below has to be watched
// failing.
//
// Run:  node scripts/mutation-proof-starved-list.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CORE = "functions/lib/starved-list.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";
const CARD = "src/components/stock/StarvedList.jsx";
const HEALTH = "src/components/stock/HealthView.jsx";
const CORE_T = ["test/starved-list.test.cjs"];
const CARD_T = ["src/components/stock/StarvedList.test.jsx"];

const MUTATIONS = [
  {
    id: "S1",
    guard: "Sales are read from the LEDGER, not the index — the POS blind spot",
    // If sales came from the index, `s > 0` would mean carried and the query would
    // be circular: the card could never report a sold-but-refused pair, which is the
    // single most important row it produces.
    file: CORE,
    from: `    if (!m || m.type !== "sold") continue;`,
    to: `    if (!m || m.type !== "sold" || true) continue;`,
    nodeTests: CORE_T,
  },
  {
    id: "S2",
    guard: "A CARRIED pair is never listed",
    file: CORE,
    from: `      if (carries(dest, pid)) continue;              // the engine is happy — nothing to see`,
    to: ``,
    nodeTests: CORE_T,
  },
  {
    id: "S3",
    guard: "A refused pair with NO evidence is not listed — the card must not cry wolf",
    file: CORE,
    from: `      if (!why.length) continue;                     // refused, but nothing contradicts it`,
    to: ``,
    nodeTests: CORE_T,
  },
  {
    id: "S4",
    guard: "An UNREADY destination is skipped, not listed thousands of times",
    file: CORE,
    from: `    if (!indexReady(provenanceMeta, dest)) continue;`,
    to: ``,
    nodeTests: CORE_T,
  },
  {
    id: "S5",
    guard: "Negative cells are not evidence of stock on the shelf",
    file: CORE,
    from: `const avail = (q) => Math.max(0, num(q));`,
    to: `const avail = (q) => num(q);`,
    nodeTests: CORE_T,
  },
  {
    id: "S6",
    guard: "An explicit target:0 row is FLAGGED rather than silently dropped",
    file: CORE,
    from: `      const excluded = numericRows.length > 0;`,
    to: `      const excluded = false;`,
    nodeTests: CORE_T,
  },
  {
    id: "S7",
    guard: "A sale at ANOTHER shop does not implicate this one",
    file: CORE,
    from: "    const key = `${loc}|${pid}`;",
    to: "    const key = `ANY|${pid}`;",
    nodeTests: CORE_T,
  },
  {
    id: "S8",
    guard: "The engine actually EMITS the list in its exceptions",
    file: ENGINE,
    from: `      starved: { ...cap(starved), active: starved.filter((r) => !r.excluded).length },`,
    to: ``,
    nodeTests: CORE_T,
  },
  {
    id: "S9",
    guard: "The card uses the engine's own carriage answer, not a second copy",
    file: ENGINE,
    from: `    carries: (dest, pid) => storeCarries(ctx, dest, pid),`,
    to: `    carries: () => false,`,
    nodeTests: CORE_T,
  },
  {
    id: "S10",
    guard: "stocked-then-undone does not read as 'never heard of it'",
    file: CARD,
    from: `  const record = !r.rec
    ? "no stock history at all for this shop"`,
    to: `  const record = true
    ? "no stock history at all for this shop"`,
    tests: CARD_T,
  },
  {
    id: "S11",
    guard: "Introduce RE-READS before writing, so it cannot claim someone else's decision",
    file: CARD,
    from: `      if (Object.keys(live).some((k) => live[k]?.introduce === true)) {`,
    to: `      if (false) {`,
    tests: CARD_T,
  },
  {
    id: "S12",
    guard: "Introduce writes NO numeric target",
    file: CARD,
    from: `      await update(ref(database), updates);`,
    to: `      updates[\`stock_targets/\${r.loc}/\${r.pid}/S/target\`] = 2;
      await update(ref(database), updates);`,
    tests: CARD_T,
  },
  {
    id: "S13",
    guard: "A failed write reads as a refusal, never as success",
    file: CARD,
    from: `      const denied = /permission|denied/i.test(String(e?.message || e));`,
    to: `      const denied = false; setDone((d) => ({ ...d, [key]: { ok: true, msg: "Introduced at last." } })); if (denied) return; return setBusy(null) ||`,
    tests: CARD_T,
  },
  {
    id: "S14",
    guard: "The card is REACHABLE from the Health grid — a standing card, not orphaned code",
    file: HEALTH,
    from: `              <StatCard label="Starved" value={ex.starved?.active ?? count("starved")}`,
    to: `              <StatCard label="Starved-nope" value={0}`,
    tests: CARD_T,
  },
];

// THE REPOSITORY'S vitest, resolved explicitly — never `npx`.
// A mutation harness whose verdict comes from a DIFFERENT vitest than the suite
// normally runs under is not proof of anything: `npx` will fall back to a global
// (or a fetched) binary when local resolution misses, and the failure mode is a
// silent PASS on a mutation that a correct run would have killed. `process.execPath`
// plus the local entry point removes the choice. (CodeRabbit, PR #381.)
const VITEST = new URL("../node_modules/vitest/vitest.mjs", import.meta.url).pathname;

function runVitest(files) {
  try {
    execFileSync(process.execPath, [VITEST, "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

// node --test prints a TAP tally; "# fail N" with N>0 only when suites ran and
// assertions failed. A file that fails to LOAD surfaces as "# fail 1" too —
// so require() each test file's SUBJECT first? No: the load failure of the
// subject IS an executed failure for node:test (the test file imports it at
// top level and the runner reports it as a failing test). That would credit a
// syntax-error mutation. Guard: a run whose stderr shows a module-load crash
// (ERR_MODULE, SyntaxError) reports ERROR, never FAIL.
function runNodeTests(files) {
  try {
    execFileSync("node", ["--test", ...files], { stdio: "pipe", cwd: "functions", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 120)})`;
    }
    if (/^# fail [1-9]/m.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

function runAll(m) {
  const verdicts = [];
  if (m.tests && m.tests.length) verdicts.push(runVitest(m.tests));
  if (m.nodeTests && m.nodeTests.length) verdicts.push(runNodeTests(m.nodeTests));
  if (verdicts.some((v) => String(v).startsWith("ERROR"))) return verdicts.find((v) => String(v).startsWith("ERROR"));
  // A mutation is KILLED if ANY suite fails; the restored run must have EVERY
  // suite pass.
  if (verdicts.includes("FAIL")) return "FAIL";
  return "PASS";
}

// ── PREFLIGHT: NEVER MUTATE AN ALREADY-DIRTY FILE ────────────────────────────
{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(MUTATIONS.map((m) => m.file))])
    .toString().trim();
  if (dirty) {
    console.error("Working tree is not clean for the files this harness mutates:\n" + dirty);
    console.error("Commit or stash first — a dirty file would be captured as the baseline.");
    process.exit(2);
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
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
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
