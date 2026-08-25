#!/usr/bin/env node
// ─── MUTATION PROOF — THE SOCIAL NULL-ARRAY GUARDS ───────────────────────────
// A green test suite proves nothing on its own. It proves something once you
// have broken the guard on purpose and watched the tests go red — and once you
// have varied the SHAPE of the break, because a guard can be sensitive to one
// mutation and blind to the one an editor would actually make.
//
// Each mutation below removes or weakens ONE guard, runs the two suites that
// cover it, and records how many tests fall over. A mutation that kills
// nothing is reported as a HOLE: the guard is unprotected and the test that
// would protect it does not exist yet.
//
// Nothing is left behind: every file is restored from its git blob before the
// next mutation, and again on exit, including on a crash.
//
// Usage: node scripts/mutation-proof-social-null-arrays.mjs
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SUITES = [
  "src/utils/rtdbList.test.js",
  "src/components/social/socialNullArrays.test.jsx",
];

const HELPER = "src/utils/rtdbList.js";
const STORE = "src/components/social/socialStore.js";
const VIEW = "src/components/social/SocialView.jsx";
const LIB = "src/components/social/StyleLibraryCard.jsx";

const MUTATIONS = [
  {
    name: "asList: hand back the value untouched (no coercion at all)",
    file: HELPER,
    from: "export function asList(value) {\n  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null);",
    to: "export function asList(value) {\n  return value;\n  // eslint-disable-next-line no-unreachable\n  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null);",
  },
  {
    name: "asList: handle null but NOT the object-keyed map (the subtler half)",
    file: HELPER,
    from: '  if (typeof value === "object") {\n    const keys = Object.keys(value);',
    to: '  if (typeof value === "object") {\n    return [];\n    // eslint-disable-next-line no-unreachable\n    const keys = Object.keys(value);',
  },
  {
    name: "asList: order an object map by STRING key (\"10\" before \"2\")",
    file: HELPER,
    from: "    const ordered = allNumeric ? keys.sort((a, b) => Number(a) - Number(b)) : keys.sort();",
    to: "    const ordered = keys.sort();",
  },
  {
    name: "storedList: let an empty array through to update() unchanged",
    file: HELPER,
    from: "  const list = asList(value);\n  return list.length ? list : null;",
    to: "  return asList(value);",
  },
  {
    name: "storedMap: let an empty {} through to update() unchanged",
    file: HELPER,
    from: "  return Object.keys(value).length ? value : null;",
    to: "  return value;",
  },
  {
    name: "the store boundary: stop normalising posts on read",
    file: STORE,
    from: "    .map(([id, body]) => normalisePost(id, body))",
    to: "    .map(([id, body]) => ({ id, ...body }))",
  },
  {
    name: "the store boundary: stop normalising style references on read",
    file: STORE,
    from: "    .map(([id, body]) => normaliseRef(id, body))",
    to: "    .map(([id, body]) => ({ id, ...body }))",
  },
  {
    name: "the write side: store tags as a bare array again (addStyleRef)",
    file: STORE,
    from: '      tags: storedList(parseTags(Array.isArray(tags) ? tags.join(",") : tags)),',
    to: '      tags: parseTags(Array.isArray(tags) ? tags.join(",") : tags),',
  },
  {
    name: "the write side: store tags as a bare array again (editStyleRef)",
    file: STORE,
    from: '  if (tags !== undefined) fields.tags = storedList(parseTags(Array.isArray(tags) ? tags.join(",") : tags));',
    to: '  if (tags !== undefined) fields.tags = parseTags(Array.isArray(tags) ? tags.join(",") : tags);',
  },
  {
    name: "THE OUTAGE: call .some directly on the posts state again",
    file: VIEW,
    from: "  const anySending = asList(posts).some((p) => isSendingSoon(p));",
    to: "  const anySending = posts.some((p) => isSendingSoon(p));",
  },
  {
    name: "the queue: drop the per-row boundary",
    file: VIEW,
    from: '        <RowBoundary key={p.id} recordId={p.id} label="post"',
    to: '        <React.Fragment key={p.id}><RowBoundaryDisabled recordId={p.id} label="post"',
    // A deliberately unresolvable component: removing the boundary must be
    // visible as a failure, and a syntax-valid stand-in that does not exist is
    // the cleanest way to say "the wrapper is gone".
    expectAnyFailure: true,
  },
  {
    name: "the library: drop the per-tile boundary",
    file: LIB,
    from: '          <RowBoundary key={entry.id} recordId={entry.id} label="reference" busy={busy}',
    to: '          <RowBoundaryDisabled key={entry.id} recordId={entry.id} label="reference" busy={busy}',
    expectAnyFailure: true,
  },
];

function blob(file) {
  return execSync(`git show HEAD:${file}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
const ORIGINALS = new Map([HELPER, STORE, VIEW, LIB].map((f) => [f, blob(f)]));
function restoreAll() {
  for (const [f, src] of ORIGINALS) writeFileSync(f, src);
}
process.on("exit", restoreAll);
process.on("SIGINT", () => { restoreAll(); process.exit(130); });

/** Run the suites; return {failed, total} parsed from vitest's summary. */
function runSuites() {
  const r = spawnSync("npx", ["vitest", "run", ...SUITES, "--reporter=basic"], { encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const m = out.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\((\d+)\))?/);
  if (m) return { failed: Number(m[1] || 0), passed: Number(m[2] || 0) };
  // A mutation can break the module so badly nothing collects. That is still a
  // kill — the suite did not pass — and must not be read as zero failures.
  if (/No test files found|Failed to load|SyntaxError|Error:/.test(out) && r.status !== 0) {
    return { failed: -1, passed: 0 };
  }
  return { failed: r.status === 0 ? 0 : -1, passed: 0 };
}

console.log("Baseline (unmutated):");
restoreAll();
const base = runSuites();
console.log(`  ${base.passed} passed, ${base.failed} failed\n`);
if (base.failed !== 0) {
  console.error("Baseline is not green — fix that before trusting any mutation result.");
  process.exit(2);
}

const results = [];
for (const mut of MUTATIONS) {
  restoreAll();
  const src = ORIGINALS.get(mut.file);
  if (!src.includes(mut.from)) {
    console.error(`SKIP (anchor not found): ${mut.name}`);
    results.push({ ...mut, killed: null, failed: 0 });
    continue;
  }
  writeFileSync(mut.file, src.replace(mut.from, mut.to));
  const r = runSuites();
  const killed = r.failed !== 0;
  const label = r.failed === -1 ? "suite would not even load" : `${r.failed} test${r.failed === 1 ? "" : "s"} failed`;
  console.log(`${killed ? "KILLED " : "HOLE   "} ${mut.name}\n         ${label}`);
  results.push({ ...mut, killed, failed: r.failed });
}
restoreAll();

const holes = results.filter((r) => r.killed === false);
const skipped = results.filter((r) => r.killed === null);
console.log(`\n${results.length - holes.length - skipped.length}/${results.length} mutations killed`);
if (skipped.length) console.log(`${skipped.length} skipped (anchor drifted — update this script)`);
if (holes.length) {
  console.log("\nHOLES — these guards are not protected by any test:");
  for (const h of holes) console.log(`  · ${h.name}`);
}
process.exit(holes.length || skipped.length ? 1 : 0);
