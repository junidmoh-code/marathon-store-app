// ─── MUTATION PROOF — the group / per-size / row-edit write paths ────────────
//
// Same discipline as scripts/mutation-proof-engine-policy.mjs: reintroduce each
// hole, prove the suite FAILS, restore, prove it PASSES. ERROR is never FAIL,
// anchors must be unique, restore is signal-safe, and the tree must be clean.
//
// The guards here are the ones that decide whether a bad call is recoverable,
// plus the two constraints this build is not allowed to break:
//
//   M-ADMIN         delete the owner check (the CALL, leaving it defined)
//   M-ADMIN-2       weaken it to "any signed-in caller with an email"
//   M-ROW-CREATE    let setRows create a row that does not exist
//   M-ROW-DELETE    let a row be removed by writing null to it
//   M-ROW-DRIFT     delete the per-row drift check
//   M-ROW-ATOMIC    apply row edits one at a time instead of in one update
//   M-ROW-PRESERVE  drop the fields a row carries that this screen does not own
//   M-ROW-BLANK     turn a blank "Ask at" into 0 on a row edit
//   M-CAP           let a group be armed over the per-scan cap
//   M-CAP-2         model arming AFTER the write instead of before
//   M-CAP-3         gate on the TRANSITION into arming, not the resulting state
//   M-ROW-EXPECT    make `expected` optional again on a row edit
//   M-ROW-REVERIFY  drop the re-read immediately before the multi-path write
//   M-GROUP-ABSENT  let an omitted `group` field delete a live group
//   M-GROUP-DRIFT   delete the group's pre-write drift check
//   M-SIZES-SERVER  trust the client's sizes instead of the derived run
//
// M-ROW-DELETE and M-ROW-CREATE are the two that matter most. Junid armed 7,797
// rows by hand over months; a build that can delete one by accident is a build
// that should not ship.
//
// Run: node scripts/mutation-proof-policy-groups-write.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WRITE = "functions/lib/category-policy-write.cjs";
const TESTS = ["test/policy-groups-write.test.cjs"];
const BOTH = ["test/policy-groups-write.test.cjs", "test/category-policy-write.test.cjs"];

const MUTATIONS = [
  {
    id: "M-ADMIN",
    guard: "GATE 3 — the server-side caller check runs on every action, including the new ones",
    file: WRITE,
    from: `  await assertEnginePolicyCaller({ db, callerEmail, callerUid, adminEmail });`,
    to: ``,
    nodeTests: BOTH,
  },
  {
    id: "M-ADMIN-2",
    guard: "…and it is an EQUALITY on the owner's email, not \"any caller who has one\"",
    file: WRITE,
    from: `  if (typeof callerEmail === "string" && callerEmail === adminEmail) return;`,
    to: `  if (typeof callerEmail === "string" && callerEmail) return;`,
    nodeTests: BOTH,
  },
  // ── THE TWO ROW CONSTRAINTS ───────────────────────────────────────────────
  {
    id: "M-ROW-CREATE",
    guard: "A ROW IS NEVER CREATED — an absent row is refused, not written",
    file: WRITE,
    from: `      if (!isPlainObject(live)) {
        throw httpsError("failed-precondition",
          \`\${loc} / \${pid} / \${sizeKey} has no row today. This screen edits rows that already exist; it does not create them.\`,
          { missing: { loc, pid, sizeKey } });
      }`,
    to: ``,
    nodeTests: TESTS,
  },
  {
    id: "M-ROW-DELETE",
    guard: "A ROW IS NEVER DELETED — no argument, no flag, no path removes one",
    file: WRITE,
    from: `      const next = { target: e.target, minQty: e.minQty };`,
    to: `      if (e.target === null) { update[\`\${TARGETS_PATH}/\${e.loc}/\${e.pid}/\${e.sizeKey}\`] = null; continue; }
      const next = { target: e.target, minQty: e.minQty };`,
    nodeTests: TESTS,
  },
  {
    id: "M-ROW-DRIFT",
    guard: "A row whose numbers moved under the editor is refused, not overwritten",
    file: WRITE,
    from: `      if (!sameValue(shapeOf(live), wantShape)) {
        throw httpsError("failed-precondition",
          \`\${loc} / \${pid} / \${sizeKey} changed while this was open. Close and re-open the list.\`,
          { drift: true, live: shapeOf(live) });
      }`,
    to: ``,
    nodeTests: TESTS,
  },
  {
    id: "M-ROW-ATOMIC",
    guard: "Row edits land as ONE update — a refused batch leaves nothing half-applied",
    file: WRITE,
    from: `      update[path] = { ...preserved, ...next };`,
    to: `      await db.ref(path).set({ ...preserved, ...next });
      update[path] = { ...preserved, ...next };`,
    nodeTests: TESTS,
  },
  {
    id: "M-ROW-PRESERVE",
    guard: "A row edit keeps the fields it does not own — provenance the scan wrote is not this screen's to drop",
    file: WRITE,
    from: `      const preserved = { ...live };
      delete preserved.target; delete preserved.minQty; delete preserved.reorderPoint;`,
    to: `      const preserved = {};`,
    nodeTests: TESTS,
  },
  {
    id: "M-ROW-BLANK",
    guard: 'A blank "Ask at" on a row edit removes the field — it does not become 0',
    file: WRITE,
    from: `      if (e.reorderPoint !== undefined && e.reorderPoint !== null) next.reorderPoint = e.reorderPoint;`,
    to: `      next.reorderPoint = e.reorderPoint === undefined || e.reorderPoint === null ? 0 : e.reorderPoint;`,
    nodeTests: TESTS,
  },
  // ── ARMING ────────────────────────────────────────────────────────────────
  {
    id: "M-CAP",
    guard: "A group over the per-scan cap cannot be armed from this screen",
    file: WRITE,
    from: `      if (armModel && armModel.exceedsCap) {`,
    to: `      if (false && armModel && armModel.exceedsCap) {`,
    nodeTests: TESTS,
  },
  {
    id: "M-CAP-2",
    guard: "…and it is modelled BEFORE the write, not reported after it",
    file: WRITE,
    // The model now also runs on a dry run (pass 3), so the anchor is the
    // condition that decides WHEN it runs; switching it off leaves the refusal
    // below reading a null model — nothing is modelled before the write.
    from: `    if (after && isPlainObject(after.policy) && (after.armed === true || d.dryRun === true)) {`,
    to: `    if (false) {`,
    nodeTests: TESTS,
  },
  {
    id: "M-CAP-3",
    guard: "The cap gate is on the RESULTING state — editing an already-armed group must not skip it",
    file: WRITE,
    from: `    if (after && after.armed === true) {`,
    to: `    if (after && after.armed === true && before?.armed !== true) {`,
    nodeTests: TESTS,
  },
  {
    id: "M-ROW-EXPECT",
    guard: "`expected` is required on every row edit — optional drift protection is none",
    file: WRITE,
    from: `      if (!isPlainObject(e.expected)) {`,
    to: `      if (false && !isPlainObject(e.expected)) {`,
    nodeTests: TESTS,
  },
  {
    id: "M-ROW-REVERIFY",
    guard: "Rows are re-read immediately before the write — a concurrent change is not silently reverted",
    file: WRITE,
    from: `    for (const { path, wantShape } of expectations) {
      const nowLive = await val(db, path);`,
    to: `    for (const { path, wantShape } of []) {
      const nowLive = await val(db, path);`,
    nodeTests: TESTS,
  },
  // ── GROUPS ────────────────────────────────────────────────────────────────
  {
    id: "M-GROUP-ABSENT",
    guard: "An omitted `group` field is refused — a dropped field must not delete a live group",
    file: WRITE,
    from: `    if (!("group" in d)) {
      throw httpsError("invalid-argument",
        "group is required — send \`group: null\` to delete it. Omitting it is refused, because a dropped field must not delete a live group.");
    }`,
    to: ``,
    nodeTests: TESTS,
  },
  {
    id: "M-GROUP-DRIFT",
    guard: "A group changed under the editor is refused, not silently overwritten",
    file: WRITE,
    from: `    if (d.expectedBefore !== undefined && !sameValue(before, d.expectedBefore === null ? null : d.expectedBefore)) {
      throw httpsError("failed-precondition",
        "The group changed while this was open. Close and re-open it to see the current numbers.",
        { drift: true, live: before });
    }`,
    to: ``,
    nodeTests: TESTS,
  },
  // ── THE SIZE RUN IS THE SERVER'S ──────────────────────────────────────────
  {
    id: "M-SIZES-SERVER",
    guard: "The per-size run is DERIVED server-side — the client's list is never the authority",
    file: WRITE,
    from: `    allowedSizes = run.sizes;`,
    to: `    allowedSizes = null;`,
    nodeTests: TESTS,
  },
];

function runNodeTests(files) {
  try {
    // TAP is PINNED: node 24 prints "ℹ fail 1" where node 22 prints "# fail 1",
    // and the parser below would read a real failure as ERROR.
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
