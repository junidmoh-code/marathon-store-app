// ─── MUTATION PROOF — the five guards of the third Engine Policy pass ─────────
//
// Same discipline as scripts/mutation-proof-engine-policy.mjs: reintroduce each
// hole, prove the suite FAILS, restore, prove it PASSES. ERROR is never FAIL,
// anchors must be unique, restore is signal-safe, and the tree must be clean.
//
//   M3-DISARMED    a disarmed group enters the resolution order
//   M3-OWN-WINS    the group outranks a member's readable own entry
//   M3-OWN-WINS-2  a garbled own entry falls through to the group
//   M3-PER-SIZE    a per-size map answers every size with its FIRST row
//   M3-SCALAR      a uniform one-size entry resolves a different number
//   M3-SCALAR-2    a uniform per-size entry resolves a different number
//   M3-CLOTHING    the clothing rule resolves a different number
//   M3-UNION       the group's run becomes the INTERSECTION of its members'
//   M3-PARTIAL     sizes only some members carry stop being marked
//   M3W-GROUP-SIZES  a per-size group write trusts the client's sizes
//   M3W-RUN-EMPTY    a group with no derivable run is given a per-size policy
//   M3W-UNION-STOP   a union over the stop is accepted
//   M3W-MEMBER-OF    members are flagged only while the group is armed
//   M3W-GROUP-SUM    the group entry reports one member's count, not the sum
//   M3W-DRYRUN-MODEL a dry run on a disarmed group stops modelling
//   M3W-ROWS-GROUP   the group's rows list returns one category's rows
//
// The GOLDEN test catches the middle four by hash; the named property tests
// catch them by name. A guard is PROVEN only if the suite fails under the
// mutation AND passes once restored.
//
// Run: node scripts/mutation-proof-engine-policy-pass3.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RESOLVE = "functions/lib/policy-resolve.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";
const GROUPS = "functions/lib/policy-groups.cjs";
const WRITE = "functions/lib/category-policy-write.cjs";
const TESTS = ["test/engine-policy-pass3.test.cjs"];
const WRITE_TESTS = ["test/engine-policy-pass3-write.test.cjs"];

const MUTATIONS = [
  {
    id: "M3-DISARMED",
    guard: "A DISARMED GROUP IS NOT IN THE RESOLUTION ORDER — it produces zero intents",
    file: RESOLVE,
    from: `    if (g.armed !== true) return false;                  // DISARMED = NOT IN THE ORDER`,
    to: ``,
    nodeTests: TESTS,
  },
  {
    id: "M3-OWN-WINS",
    guard: "A MEMBER'S OWN NUMBERS BEAT THE GROUP'S — the group never outranks a readable own entry",
    file: RESOLVE,
    // Invert the precedence: an armed group that claims the category wins even
    // when the category has a readable entry of its own.
    from: `  if (isPlainObject(own)) return { entry: own, source: "category", groupKey: null };`,
    to: `  const g0 = armedGroupForCategory({ ...config, categoryPolicy: {} }, categoryKey);
  if (g0) return { entry: g0.group.policy, source: "group", groupKey: g0.groupKey };
  if (isPlainObject(own)) return { entry: own, source: "category", groupKey: null };`,
    nodeTests: TESTS,
  },
  {
    id: "M3-OWN-WINS-2",
    guard: "…and a GARBLED own entry arms nothing and consults no group",
    file: RESOLVE,
    from: `  if (own !== undefined && own !== null) return null;`,
    to: ``,
    nodeTests: TESTS,
  },
  {
    id: "M3-PER-SIZE",
    guard: "A PER-SIZE POLICY RESOLVES PER SIZE — not the first row for every size",
    file: ENGINE,
    from: `    const row = entry.sizes[encodeSizeKey(size)];`,
    to: `    const row = Object.values(entry.sizes)[0];`,
    nodeTests: TESTS,
  },
  {
    id: "M3-SCALAR",
    guard: "AN EXISTING SCALAR (one-size) POLICY RESOLVES IDENTICALLY",
    file: ENGINE,
    from: `    return encodeSizeKey(size) === "_" ? shaped(entry.target) : null;`,
    to: `    return encodeSizeKey(size) === "_" ? shaped(entry.target + 1) : null;`,
    nodeTests: TESTS,
  },
  {
    id: "M3-SCALAR-2",
    guard: "AN EXISTING SCALAR (uniform per-size) POLICY RESOLVES IDENTICALLY",
    file: ENGINE,
    from: `  return shaped(sizeUnitsAnywhere(stock, pid, size) > 0 ? entry.target : 0);`,
    to: `  return shaped(sizeUnitsAnywhere(stock, pid, size) > 0 ? entry.target + 1 : 0);`,
    nodeTests: TESTS,
  },
  {
    id: "M3-CLOTHING",
    guard: "CLOTHING RESOLUTION IS BYTE-IDENTICAL — the rule's number is pinned",
    file: ENGINE,
    from: `        return { target: t, minQty: Math.max(1, t - 1), reorderPoint: null, source: "default" };`,
    to: `        return { target: t + 1, minQty: Math.max(1, t - 1), reorderPoint: null, source: "default" };`,
    nodeTests: TESTS,
  },
  {
    id: "M3-UNION",
    guard: "THE GROUP'S SIZE RUN IS THE UNION of its members' runs, not the intersection",
    file: GROUPS,
    from: `  const sizes = Object.keys(carriedBy).sort(bySizeRank);`,
    to: `  const sizes = Object.keys(carriedBy).filter((s) => carriedBy[s].length === membersWithRun.length).sort(bySizeRank);`,
    nodeTests: TESTS,
  },
  {
    id: "M3-PARTIAL",
    guard: "SIZES ONLY SOME MEMBERS CARRY ARE MARKED, not silently folded in",
    file: GROUPS,
    from: `  const partial = sizes.filter((s) => carriedBy[s].length < membersWithRun.length);`,
    to: `  const partial = [];`,
    nodeTests: TESTS,
  },
  // ── THE CALLABLE ──────────────────────────────────────────────────────────
  {
    id: "M3W-GROUP-SIZES",
    guard: "A PER-SIZE GROUP WRITE IS VALIDATED AGAINST THE DERIVED UNION — never the client's list",
    file: WRITE,
    from: `      allowedSizes: groupAllowedSizes,`,
    to: `      allowedSizes: null,`,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M3W-RUN-EMPTY",
    guard: "A group whose members have no derivable run is REFUSED a per-size policy, not guessed one",
    file: WRITE,
    from: `      if (groupRun.empty) {`,
    to: `      if (false && groupRun.empty) {`,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M3W-UNION-STOP",
    guard: "A union over the stop REFUSES a per-size group policy",
    file: WRITE,
    from: `      if (groupRun.overStop) {`,
    to: `      if (false && groupRun.overStop) {`,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M3W-MEMBER-OF",
    guard: "Members are flagged memberOfGroup WHILE DISARMED — the list folds them whatever the armed state",
    file: WRITE,
    from: `      memberOfGroup: memberOf[key] || null,`,
    to: `      memberOfGroup: g ? g.groupKey : null,`,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M3W-GROUP-SUM",
    guard: "The group entry's counts are the SUM of its members', not one member's",
    file: WRITE,
    from: `      products: sum("products"),`,
    to: `      products: memberRows[0]?.products || 0,`,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M3W-DRYRUN-MODEL",
    guard: "A dry run MODELS a disarmed group — the preview has a number to show before arming",
    file: WRITE,
    from: `(after.armed === true || d.dryRun === true)) {`,
    to: `(after.armed === true)) {`,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M3W-ROWS-GROUP",
    guard: "The rows list for a GROUP returns every member's rows",
    file: WRITE,
    from: `    const pids = new Set(Object.keys(products).filter((pid) => rowKeys.has(products[pid]?.categoryKey)));`,
    to: `    const pids = new Set(Object.keys(products).filter((pid) => products[pid]?.categoryKey === categoryKey));`,
    nodeTests: WRITE_TESTS,
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
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(15)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
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
  console.log(`${m.id.padEnd(15)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
