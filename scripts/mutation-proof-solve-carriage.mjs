// ─── MUTATION PROOF HARNESS — Solve's carriage gate ──────────────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the whole
// cycle and refuses to report a pass it did not watch break first. Same discipline
// as scripts/mutation-proof-multi-token.mjs (ERROR ≠ FAIL, unique anchors,
// signal-safe restore, clean-tree preflight).
//
// WHY THIS FEATURE IN PARTICULAR. The bug being guarded against is a LIE, not a
// crash: Solve seeds a cell, says "the engine will refill on its next scan", and the
// engine refuses the line. Nothing throws and nothing logs. A silent-failure guard
// that is itself silently broken protects nothing, so every one of these has to be
// watched breaking.
//
// Run:  node scripts/mutation-proof-solve-carriage.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CARRIAGE = "src/components/stock/solveCarriage.js";
const NETWORK = "src/components/stock/NetworkTransfer.jsx";
const CORE_T = "src/components/stock/solveCarriage.test.js";
const RENDER_T = "src/components/stock/NetworkTransfer.render.test.jsx";
const GATE_T = "src/components/stock/solveUndo.gate.test.js";

const MUTATIONS = [
  {
    id: "M1",
    guard: "An UNREADY index must BLOCK — not fall through to 'not carried'",
    // The single most dangerous line in the feature. Treating unready as
    // not-carried would make Solve INTRODUCE every product during the whole
    // cutover window, arming shops against an index nobody has built.
    file: CARRIAGE,
    from: `  if (!indexReadyAt(provenanceMeta, loc)) {
    return { loc, state: BLOCKED, via: null, reason: "index-unready" };
  }`,
    to: ``,
    tests: [CORE_T, RENDER_T],
  },
  {
    id: "M2",
    guard: "The opt-in is checked BEFORE readiness, so it survives the cutover window",
    file: CARRIAGE,
    from: `  if (introducedAt(targets, categoryPolicy, categoryKey, loc, pid)) {
    return { loc, state: CARRIED, via: "introduce" };
  }
  if (!indexReadyAt(provenanceMeta, loc)) {`,
    to: `  if (!indexReadyAt(provenanceMeta, loc)) {`,
    tests: [CORE_T, RENDER_T],
  },
  {
    id: "M3",
    guard: "ONE blocked location refuses the WHOLE solve, not just its own leg",
    file: CARRIAGE,
    from: `  if (blocked.length) {`,
    to: `  if (false) {`,
    tests: [CORE_T, RENDER_T],
  },
  {
    id: "M4",
    guard: "carriesByEntry nets undos — k alone is not carriage",
    file: CARRIAGE,
    from: `  return n(entry.k) - n(entry.u) > 0;`,
    to: `  return n(entry.k) > 0;`,
    tests: [CORE_T],
  },
  {
    id: "M5",
    guard: "The introduce row NEVER carries a numeric target",
    // A target here pins the quantities and outranks the size run forever.
    file: CARRIAGE,
    from: `      updates[\`\${base}/introduce\`] = true;`,
    to: `      updates[\`\${base}/introduce\`] = true;
      updates[\`\${base}/target\`] = 2;
      updates[\`\${base}/minQty\`] = 1;`,
    tests: [CORE_T, RENDER_T],
  },
  {
    id: "M6",
    guard: "indexReadyAt demands the CURRENT version — a stale index is not ready",
    file: CARRIAGE,
    from: `  if (m.version !== INDEX_VERSION) return false;`,
    to: ``,
    tests: [CORE_T],
  },
  {
    id: "M7",
    guard: "introducedAt is strictly === true — a truthy value is not an opt-in",
    file: CARRIAGE,
    from: `      && Object.keys(rows).some((k) => rows[k]?.introduce === true)) return true;`,
    to: `      && Object.keys(rows).some((k) => rows[k]?.introduce)) return true;`,
    tests: [CORE_T],
  },
  {
    id: "M8",
    guard: "solve() RE-READS the index instead of trusting the render's copy",
    file: NETWORK,
    from: `      const [meta, ...entries] = await Promise.all([
        get(ref(database, "stock_provenance/_meta")).then((s) => s.val() || {}),`,
    to: `      const [meta, ...entries] = await Promise.all([
        Promise.resolve(provMeta || {}),`,
    tests: [RENDER_T],
  },
  {
    id: "M9",
    guard: "A BLOCKED plan writes NOTHING — the refusal is a return, not a warning",
    file: NETWORK,
    from: `    if (!carriage.ok) {`,
    to: `    if (false) {`,
    tests: [RENDER_T],
  },
  {
    id: "M10",
    guard: "A FAILED READ is not a licence to seed",
    file: NETWORK,
    from: `      setSolveBusy(null);
      return;
    }
    if (!carriage.ok) {`,
    to: `      carriage = { ok: true, introduce: [], carried: [], blocked: [] };
    }
    if (!carriage.ok) {`,
    tests: [RENDER_T],
  },
  {
    id: "M11",
    guard: "The introduce rows ride in the SAME atomic update as the cells",
    file: NETWORK,
    from: `      Object.assign(updates, introPaths);`,
    to: ``,
    tests: [RENDER_T, GATE_T],
  },
  {
    id: "M12",
    guard: "Undo records the CELL paths only — a target row must never reach undoCellTxn",
    file: NETWORK,
    from: `          paths: cellPaths, introPaths: Object.keys(introPaths).filter((p) => p.endsWith("/introduce")), priorOpen,`,
    to: `          paths: Object.keys(updates), introPaths: Object.keys(introPaths).filter((p) => p.endsWith("/introduce")), priorOpen,`,
    tests: [GATE_T],
  },
  {
    id: "M13",
    guard: "The row cleanup yields to a row that has since acquired a real target",
    file: NETWORK,
    from: `  rowPaths.forEach((p, i) => { if (rows[i] && typeof rows[i].target !== "number") del[p] = null; });`,
    to: `  rowPaths.forEach((p, i) => { if (rows[i]) del[p] = null; });`,
    tests: [GATE_T],
  },
  {
    id: "M14",
    guard: "The panel SAYS a never-stocked shop is being introduced",
    file: CARRIAGE,
    from: `  if (!plan.introduce.length) return null;`,
    to: `  return null;`,
    tests: [CORE_T, RENDER_T],
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
