// ─── MUTATION PROOF HARNESS — the Decision Queue's carriage gate ─────────────
// Reintroduce the bug, prove the suite FAILS, restore, prove it PASSES.
//
// The bug here is a BUTTON THAT SHOULD NOT BE THERE. Nothing crashes; a card simply
// appears with an Exclude that writes an explicit `target: 0` over a shop the engine
// is actively managing. So the guards are about presence and absence of a rendered
// card, and every one has to be watched failing or the file proves nothing.
//
// Run:  node scripts/mutation-proof-exclude-carriage.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const QUEUE = "src/components/stock/NoTargetQueue.jsx";
const CARRIAGE = "src/components/stock/solveCarriage.js";
const T = ["src/components/stock/NoTargetQueue.carriage.test.jsx"];

const MUTATIONS = [
  {
    id: "X1",
    guard: "A CARRIED pair is skipped — the Exclude button never appears over live carriage",
    file: QUEUE,
    from: `        if (engineManages(pid, loc, sizes)) continue;`,
    to: ``,
    tests: T,
  },
  {
    id: "X2",
    guard: "An UNREADY index shows the card rather than hiding it",
    // Dropping the readiness check makes `carriedAt` trust a stale or absent index,
    // so a pair would be hidden on evidence nobody has built yet — the silent
    // direction, and the opposite of what this screen is for.
    file: QUEUE,
    from: `    const carriedAt = (pid, loc) => indexReadyAt(provMeta, loc)
      && carriesByEntry(provenance?.[loc]?.[pid]);`,
    to: `    const carriedAt = (pid, loc) => carriesByEntry(provenance?.[loc]?.[pid]);`,
    tests: T,
  },
  {
    id: "X3",
    guard: "Carriage is read for THIS location, not any location",
    file: QUEUE,
    from: `      && carriesByEntry(provenance?.[loc]?.[pid]);`,
    to: `      && Object.values(provenance || {}).some((byPid) => carriesByEntry(byPid?.[pid]));`,
    tests: T,
  },
  {
    id: "X4",
    guard: "net-zero carriage (k − u == 0) is NOT carriage, so the card still shows",
    file: CARRIAGE,
    from: `  return n(entry.k) - n(entry.u) > 0;`,
    to: `  return n(entry.k) > 0;`,
    // The predicate is SHARED with the solve suites — a mutation here must be
    // caught by every consumer, not just this queue's tests. (Review, PR #390.)
    tests: [...T, "src/components/stock/solveCarriage.test.js"],
  },
  {
    id: "X5",
    guard: "an all-zero save is refused as a delisting disguised as a size edit — nothing written",
    file: QUEUE,
    from: `    const zeroed = locs.filter((loc) => card.sizes.every((s) => targetFor(card, s.size, loc) === 0));`,
    to: `    const zeroed = [];`,
    tests: T,
  },
  {
    id: "X6",
    guard: "the kill switch is mirrored — with rules off, a carried card STAYS (it is the only lever left)",
    file: QUEUE,
    from: `      ruleTargetsEnabledFor(engineConfig?.ruleBasedTargets, loc)
      && carriedAt(pid, loc)`,
    to: `      carriedAt(pid, loc)`,
    tests: T,
  },
  {
    id: "X7",
    guard: "carriage without run resolution is NOT management — jeans stay visible",
    file: QUEUE,
    from: `      && sizes.length > 0
      && sizes.every((s) => runResolves(loc, s.size));`,
    to: `      && sizes.length > 0;`,
    tests: T,
  },
  {
    id: "X8",
    guard: "the size blind-spot loop is gated too — no Exclude over an engine-covered size",
    file: QUEUE,
    from: `          .filter((s) => !engineCoversSize(pid, loc, p, s.size));`,
    to: `          ;`,
    tests: T,
  },
  {
    id: "X9",
    guard: "the hub2-from-Central push is gated too — same predicate, third path",
    file: QUEUE,
    from: `            if (engineCoversSize(pid, loc, p, size)) continue;`,
    to: ``,
    tests: T,
  },
];

// THE REPOSITORY'S vitest, resolved explicitly — never `npx`.
// A mutation harness whose verdict comes from a DIFFERENT vitest than the suite
// normally runs under is not proof of anything: `npx` will fall back to a global
// (or a fetched) binary when local resolution misses, and the failure mode is a
// silent PASS on a mutation that a correct run would have killed. `process.execPath`
// plus the local entry point removes the choice. (CodeRabbit, PR #381.)
const VITEST = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

function runVitest(files) {
  try {
    execFileSync(process.execPath, [VITEST, "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    // A mutant that breaks the module at IMPORT time also prints "Tests N
    // failed" — crediting that as a kill would prove a guard nothing exercised.
    // (CodeRabbit, PR #390.)
    if (/SyntaxError|Failed to resolve import|Transform failed|ERR_MODULE_NOT_FOUND/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error|error/.test(l)) || "load crash").slice(0, 120)})`;
    }
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}


function runAll(m) {
  const verdicts = [];
  if (m.tests && m.tests.length) verdicts.push(runVitest(m.tests));
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
    // Trust nothing about the restore that the disk cannot confirm: a swallowed
    // write failure would leave the MUTANT in the working tree while the verdict
    // prints as if the original were back. (CodeRabbit, PR #381 — same check as
    // mutation-proof-headwear-collapse.mjs.)
    if (readFileSync(m.file, "utf8") !== original) {
      console.error(`\n*** ${m.file} DID NOT RESTORE — restore it from git before doing anything else. ***`);
      process.exit(2);
    }
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
