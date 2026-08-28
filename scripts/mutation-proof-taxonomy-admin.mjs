// ─── MUTATION PROOF — the taxonomy-admin guard rails ─────────────────────────
// For each guard: reintroduce the hole, prove the suite FAILS, restore the
// file, prove it PASSES. Same discipline as mutation-proof-deactivate.mjs:
// ERROR is not FAIL, anchors must be unique, restore is signal-safe, files
// must be clean before anything is touched.
//
//   M-DUP-INRUN     delete the near-duplicate check inside the target run
//   M-DUP-CROSS     delete the cross-run spelling check
//   M-RESERVED      let the "_" one-size sentinel be typed as a size
//   M-GATE          delete the component's OWN permission gate (layer 2)
//   M-ROUTE-GATE    unhook guard(ROLES.ADMIN) from the Admin view (layer 1)
//   M-FALLBACK      make a missing/unknown run BLANK the size grid
//   M-REMOVE-GUARD  add a removal path — the append's own invariant must trip
//   M-REMOVE-OPEN   add a removal path AND delete the invariant — tests must
//                   still catch the loss
//
// Run: node scripts/mutation-proof-taxonomy-admin.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RUNS = "src/utils/sizeRuns.js";
const TAB = "src/components/admin/TaxonomyTab.jsx";
const APP = "src/App.jsx";

const RUNS_TESTS = ["src/utils/sizeRuns.test.js", "src/utils/taxonomyCategoryCreate.test.js"];
const GATE_TESTS = ["src/components/admin/TaxonomyTab.gate.test.jsx"];

const MUTATIONS = [
  {
    id: "M-DUP-INRUN",
    guard: "a near-identical spelling in the SAME run is blocked",
    file: RUNS,
    from: `    if (canonicalSizeKey(existing) === canon) {
      return { ok: false, reason: "near-duplicate", message: \`"\${size}" is the same size as the existing "\${existing}" — sizes are stock keys, so a second spelling would split stock into two cells. Use "\${existing}".\`, existing, existingRunKey: runKey };
    }`,
    to: ``,
    tests: RUNS_TESTS,
  },
  {
    id: "M-DUP-CROSS",
    guard: "a different spelling of a size that exists in ANOTHER run is blocked",
    file: RUNS,
    from: `      if (existing !== size && canonicalSizeKey(existing) === canon) {`,
    to: `      if (false) {`,
    tests: RUNS_TESTS,
  },
  {
    id: "M-RESERVED",
    guard: 'the "_" one-size sentinel cannot be typed or created',
    file: RUNS,
    from: `  if (String(rawInput ?? "").trim() === ONE_SIZE_SENTINEL) {
    return { ok: false, reason: "reserved", message: \`"\${ONE_SIZE_SENTINEL}" is the reserved one-size marker — it cannot be created as a size.\` };
  }`,
    to: ``,
    tests: RUNS_TESTS,
  },
  {
    id: "M-GATE",
    guard: "the tab re-checks the permission ITSELF (layer 2, independent of the route)",
    file: TAB,
    from: `  const allowed = isSuperAdmin || hasPermission("product_admin");`,
    to: `  const allowed = true || isSuperAdmin || hasPermission("product_admin");`,
    tests: GATE_TESTS,
  },
  {
    id: "M-ROUTE-GATE",
    guard: "the Admin view (which hosts the tab) is mounted through guard(ROLES.ADMIN) (layer 1)",
    file: APP,
    from: `view = guard(ROLES.ADMIN,            <AdminView`,
    to: `view = (            <AdminView`,
    tests: GATE_TESTS,
  },
  {
    id: "M-FALLBACK",
    guard: "a partial registry can never blank a size grid (literal-sizes fallback)",
    file: RUNS,
    from: `    const sizes = runSizes(run);
    if (sizes.length) return sizes;
  }
  return sizesOf(cat);`,
    to: `    const sizes = runSizes(run);
    return sizes;
  }
  return sizesOf(cat);`,
    tests: RUNS_TESTS,
  },
  {
    id: "M-REMOVE-GUARD",
    guard: "a removal path trips the append's own add-only invariant",
    file: RUNS,
    from: `  const next = [...cur.slice(0, at), size, ...cur.slice(at)];`,
    to: `  const next = [...cur.slice(1, at), size, ...cur.slice(at)];`,
    tests: RUNS_TESTS,
  },
  {
    id: "M-REMOVE-OPEN",
    guard: "even with the invariant ALSO deleted, the tests still catch a removal",
    file: RUNS,
    from: `  const next = [...cur.slice(0, at), size, ...cur.slice(at)];
  // Add-only proof: removing the inserted element must give back the original,
  // byte for byte, in the original order.
  const check = [...next.slice(0, at), ...next.slice(at + 1)];
  if (check.length !== cur.length || check.some((s, i) => s !== cur[i])) {
    throw new Error("appendSizeToRun: add-only invariant violated");
  }
  return next;`,
    to: `  const next = [...cur.slice(1, at), size, ...cur.slice(at)];
  return next;`,
    tests: RUNS_TESTS,
  },
];

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    // The add-only invariant firing at module load (SIZE_RUN_SEED is itself
    // built through the append) is the guard tripping BY NAME — count it as
    // the failure it is. Every other load error stays an ERROR, not a proof.
    if (out.includes("add-only invariant violated")) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}

// ── PREFLIGHT: NEVER MUTATE AN ALREADY-DIRTY FILE ────────────────────────────
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
    results.push({ id: m.id, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(15)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, m.to));
    mutated = runVitest(m.tests);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  restored = runVitest(m.tests);
  results.push({ id: m.id, mutated, restored });
  const ok = mutated === "FAIL" && restored === "PASS";
  console.log(`${m.id.padEnd(15)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${ok ? "✓ guard proven" : "✗ NOT PROVEN"} — ${m.guard}`);
}

const bad = results.filter((r) => !(r.mutated === "FAIL" && r.restored === "PASS"));
if (bad.length) {
  console.error(`\n${bad.length} guard(s) NOT proven: ${bad.map((r) => r.id).join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} guards proven: every mutation fails the suite, every restore passes it.`);
