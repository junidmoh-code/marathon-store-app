// ─── MUTATION PROOF — policy groups and per-size policy ──────────────────────
//
// For each guard: reintroduce the hole, prove the suite FAILS, restore the
// file, prove it PASSES. A green test proves nothing on its own — it has to be
// watched breaking when the property it claims to hold is broken on purpose.
//
// And the MUTATION SHAPE is varied deliberately, not only the location. Several
// guards below are attacked twice in different ways, because a test can be
// sensitive to a deletion and blind to a weakening — "armed !== true" turned
// into "!armed" deletes nothing and still lets the string "true" arm a group.
//
//   M-DISARMED      delete the armed check outright
//   M-DISARMED-2    weaken it to truthiness ("true" the string arms)
//   M-DISARMED-3    let a group with no policy resolve (armed by an empty switch)
//   M-OWN-WINS      delete "a category's own policy beats its group's"
//   M-OWN-WINS-2    weaken it to a per-location merge (the rejected design)
//   M-OWN-WINS-3    weaken it to isPlainObject, so a GARBLED own entry falls
//                   through to the group and arms MORE than a correct one
//   M-GROUP-MODEL   make the MODEL read categoryPolicy directly again
//   M-BOTH-SHAPES   allow target and a sizes map at one location
//   M-PERSIZE-MODE  allow a per-size map outside per-size mode
//   M-DEADSIZE      drop the dead-size 0 rule from the per-size map branch
//   M-SIZEKEY       look the size up unencoded (5.5 would never be found)
//   M-ARM-EMPTY     let a group be armed with no numbers behind it
//   M-OVERLAP       let a category belong to two groups
//   M-SIZE-RUN      let the size run be the raw union again (registry ignored,
//                   and a one-size category handed a run of legacy letter cells)
//
// ── THE THIRD PASS ───────────────────────────────────────────────────────────
//   M-GROUP-UNION   intersect the members' runs instead of uniting them — the
//                   design that arms nothing at either end of the run
//   M-GROUP-UNION-2 drop the `partial` marking, so a size only one member
//                   carries reads as one every member carries
//   M-GROUP-SIZES   stop validating a group's per-size write against its
//                   derived run (any size at all becomes writable)
//   M-MEMBER-HIDDEN stop marking a member category, so it lists twice — once
//                   beside its group and once inside it
//   M-CLOTHING      change the clothing default run by one, and watch the
//                   frozen live snapshot catch it
//
// Same discipline as scripts/mutation-proof-engine-policy.mjs: ERROR is not
// FAIL, anchors must be unique, restore is signal-safe, and the tree must be
// clean before anything is touched.
//
// Run: node scripts/mutation-proof-policy-groups.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RESOLVE = "functions/lib/policy-resolve.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";
const MODEL = "functions/lib/category-policy.cjs";
const GROUPS = "functions/lib/policy-groups.cjs";

const WRITE = "functions/lib/category-policy-write.cjs";

const CORE_TESTS = ["test/policy-groups.test.cjs"];
// The third pass: the Sneakers entry, the group's derived run, and the freeze
// on clothing resolution.
const PASS3_TESTS = ["test/sneakers-group-sizes.test.cjs"];
const WRITE_TESTS = ["test/sneakers-entry-write.test.cjs"];
const FROZEN_TESTS = ["test/clothing-resolution-frozen.test.cjs"];
const ENGINE_TESTS = ["test/policy-groups-engine.test.cjs"];
const DIFF_TESTS = ["test/policy-groups-differential.test.cjs"];
const ALL_TESTS = [...CORE_TESTS, ...ENGINE_TESTS, ...DIFF_TESTS];

const MUTATIONS = [
  // ── THE PROPERTY THE FOOTWEAR GROUP IS SEEDED ON ──────────────────────────
  {
    id: "M-DISARMED",
    guard: "A DISARMED GROUP IS NOT IN THE RESOLUTION ORDER AT ALL",
    file: RESOLVE,
    from: `    if (g.armed !== true) return false;                  // DISARMED = NOT IN THE ORDER`,
    to: ``,
    nodeTests: ALL_TESTS,
  },
  {
    id: "M-DISARMED-2",
    guard: "armed is a BOOLEAN — the string \"true\", 1, or {} must not arm a group",
    file: RESOLVE,
    from: `    if (g.armed !== true) return false;                  // DISARMED = NOT IN THE ORDER`,
    to: `    if (!g.armed) return false;`,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-DISARMED-3",
    guard: "A group with no numbers resolves nothing — an armed switch with no wire behind it",
    file: RESOLVE,
    from: `    if (!isPlainObject(g.policy)) return false;          // no numbers = nothing to resolve`,
    to: ``,
    nodeTests: CORE_TESTS,
  },
  // ── OWN BEATS GROUP ───────────────────────────────────────────────────────
  {
    id: "M-OWN-WINS",
    guard: "A CATEGORY'S OWN POLICY BEATS ITS GROUP'S",
    file: RESOLVE,
    from: `  const own = config?.categoryPolicy?.[categoryKey];
  if (own !== undefined && own !== null) return null;`,
    to: ``,
    nodeTests: ALL_TESTS,
  },
  {
    id: "M-OWN-WINS-2",
    guard: "…entirely, not per location — the rejected per-location merge arms shops the owner left out",
    file: RESOLVE,
    from: `  const own = config?.categoryPolicy?.[categoryKey];
  if (isPlainObject(own)) return { entry: own, source: "category", groupKey: null };
  const g = armedGroupForCategory(config, categoryKey);
  if (!g) return null;
  return { entry: g.group.policy, source: "group", groupKey: g.groupKey };`,
    to: `  const own = config?.categoryPolicy?.[categoryKey];
  const groups = config?.policyGroups;
  let g = null;
  if (isPlainObject(groups)) {
    for (const gk of Object.keys(groups).sort()) {
      const c = groups[gk];
      if (isPlainObject(c) && c.armed === true && isPlainObject(c.policy)
        && Array.isArray(c.memberCategoryKeys) && c.memberCategoryKeys.includes(categoryKey)) { g = { groupKey: gk, group: c }; break; }
    }
  }
  if (isPlainObject(own)) {
    if (!g) return { entry: own, source: "category", groupKey: null };
    return { entry: { ...g.group.policy, ...own }, source: "category", groupKey: g.groupKey };
  }
  if (!g) return null;
  return { entry: g.group.policy, source: "group", groupKey: g.groupKey };`,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-OWN-WINS-3",
    guard: "A GARBLED own entry arms nothing and consults no group — present is present, readable or not",
    file: RESOLVE,
    from: `  const own = config?.categoryPolicy?.[categoryKey];
  if (own !== undefined && own !== null) return null;`,
    to: `  if (isPlainObject(config?.categoryPolicy?.[categoryKey])) return null;`,
    nodeTests: CORE_TESTS,
  },
  // ── THE MODEL MUST SEE WHAT THE ENGINE SEES ───────────────────────────────
  {
    id: "M-GROUP-MODEL",
    guard: "The preview model resolves groups too — reading categoryPolicy directly under-reports a grouped category to zero",
    file: MODEL,
    from: `  const eff = effectivePolicyFor(config, categoryKey);`,
    to: `  const eff = isPlainObject(config?.categoryPolicy?.[categoryKey])
    ? { entry: config.categoryPolicy[categoryKey], source: "category", groupKey: null } : null;`,
    nodeTests: DIFF_TESTS,
  },
  // ── THE TWO SHAPES ────────────────────────────────────────────────────────
  {
    id: "M-BOTH-SHAPES",
    guard: "A location holds ONE shape — a target and a sizes map together arm nothing",
    file: RESOLVE,
    from: `  if (hasSizes && hasTarget) return "invalid";`,
    to: `  if (hasSizes && hasTarget) return "per-size";`,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-PERSIZE-MODE",
    guard: "A per-size map outside per-size mode arms nothing — it describes cells the engine never asks about",
    file: RESOLVE,
    from: `    if (!perSize) return null;`,
    to: ``,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-DEADSIZE",
    guard: "A named size with no units anywhere resolves an explicit 0 — a stop, not a fall-through",
    file: ENGINE,
    from: `    return shape(sizeUnitsAnywhere(stock, pid, size) > 0 ? row.target : 0, row.minQty, row.reorderPoint);`,
    to: `    return shape(row.target, row.minQty, row.reorderPoint);`,
    nodeTests: ENGINE_TESTS,
  },
  {
    id: "M-SIZEKEY",
    guard: "The per-size map is keyed by the STORED size — an unencoded lookup misses every half size",
    file: ENGINE,
    from: `    const row = entry.sizes[encodeSizeKey(size)];`,
    to: `    const row = entry.sizes[size];`,
    // NOT the differential fuzz: an unencoded lookup breaks the model and the
    // engine IDENTICALLY, so the two still agree and the fuzz stays green. The
    // guard has to be a direct assertion that a half size resolves at all.
    nodeTests: ENGINE_TESTS,
  },
  // ── VALIDATION ────────────────────────────────────────────────────────────
  {
    id: "M-ARM-EMPTY",
    guard: "A group cannot be armed before it has numbers",
    file: GROUPS,
    from: `  if (group.armed === true && (group.policy === undefined || group.policy === null)) {
    return "this group has no numbers yet — give it a policy before arming it";
  }`,
    to: ``,
    nodeTests: CORE_TESTS,
  },
  {
    id: "M-OVERLAP",
    guard: "A category belongs to at most one group",
    file: GROUPS,
    from: `      if (Array.isArray(other?.memberCategoryKeys) && other.memberCategoryKeys.includes(m)) {
        return \`\${m} is already in the "\${otherKey}" group — a category belongs to at most one group\`;
      }`,
    to: ``,
    nodeTests: CORE_TESTS,
  },
  {
    id: "M-SIZE-RUN",
    guard: "The offered size run is registry ∩ live data — the raw union puts garment letters on sneakers",
    file: GROUPS,
    from: `  const offered = oneSize ? [] : (taxSizes.length ? union.filter((s) => taxSizes.includes(s)) : union);`,
    to: `  const offered = union;`,
    nodeTests: CORE_TESTS,
  },

  // ── THE THIRD PASS ─────────────────────────────────────────────────────────
  {
    id: "M-GROUP-UNION",
    guard: "A group's run is the UNION of its members' — an intersection arms nothing at either end",
    file: GROUPS,
    from: `  const sizes = Object.keys(carriedBy).sort(bySizeRank);`,
    to: `  const sizes = Object.keys(carriedBy).filter((s) => carriedBy[s].length === members.length).sort(bySizeRank);`,
    nodeTests: PASS3_TESTS,
  },
  {
    id: "M-GROUP-UNION-2",
    guard: "Sizes only SOME members carry are marked — an unmarked one reads as universal",
    file: GROUPS,
    from: `  const partial = sizes.filter((s) => carriedBy[s].length < members.length);`,
    to: `  const partial = [];`,
    nodeTests: PASS3_TESTS,
  },
  {
    id: "M-GROUP-SIZES",
    guard: "A group's per-size write is checked against its derived run, not against nothing",
    file: GROUPS,
    from: `        allowedSizes: Array.isArray(allowedSizes) ? allowedSizes : null });`,
    to: `        allowedSizes: null });`,
    nodeTests: [...PASS3_TESTS, ...WRITE_TESTS],
  },
  {
    id: "M-MEMBER-HIDDEN",
    guard: "A group's members are marked so they are not listed a second time beside it",
    file: WRITE,
    from: `  for (const c of categories) if (memberKeys.has(c.key)) c.memberOfGroup = groupEntries.find((g) => g.memberCategoryKeys.includes(c.key)).groupKey;`,
    to: ``,
    nodeTests: WRITE_TESTS,
  },
  {
    id: "M-CLOTHING",
    guard: "CLOTHING RESOLUTION IS FROZEN — the live snapshot replays cell for cell",
    file: ENGINE,
    from: `function resolveTarget({ targets, config, products, stock }, dest, pid, size) {`,
    to: `function resolveTarget({ targets, config, products, stock }, dest, pid, size) {
  if (String(size) === "M" && dest === "hub2") return { target: 99, minQty: 1, reorderPoint: null, source: "explicit" };`,
    nodeTests: FROZEN_TESTS,
  },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Only a runner that EXECUTED tests and saw them fail counts as FAIL. A syntax
// error, a missing file, a reworded summary — all report ERROR, loudly, and
// never credit the guard.
function runNodeTests(files) {
  try {
    // TAP is PINNED, not left to the default reporter: node 24 prints "ℹ fail 1"
    // where node 22 prints "# fail 1", and the parser below would read a real
    // failure as ERROR — silently crediting no guard at all.
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

const runAll = (m) => runNodeTests(m.nodeTests);

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
  console.log(`${m.id.padEnd(15)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
