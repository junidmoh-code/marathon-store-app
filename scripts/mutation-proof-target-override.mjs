// ─── MUTATION PROOF — per-product targets, the one write path ────────────────
//
// For each guard: reintroduce the hole, prove the suite FAILS, restore the
// file, prove it PASSES. A green test proves nothing on its own; this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
//   M-BLANK        a blank field becomes 0 instead of inheriting
//   M-NO-REMOVE    a blank leaves the row where it is (inherit does nothing)
//   M-RESTAMP      an unchanged row is rewritten, re-stamping somebody else's
//   M-WRITABLE     a captured row the rule refuses is restored anyway
//   M-PREVIEW      Save fires without a preview of the numbers on screen
//   M-ZERO         the server refuses target 0 — the off switch stops working
//   M-DRIFT-ROW    the per-size drift check goes
//   M-DRIFT-LATE   the re-check immediately before the mutation goes
//   M-FOREIGN      a row this card did not write is removed with no confirm
//   M-NEST         the row a row replaced is nested instead of carried through
//   M-EXPECT       the drift expectation is sent empty
//   M-RP-ZERO      an "Ask at" rides on a target-0 row and the save is refused
//   M-EXPECT-STALE the expectation comes from a context a refresh replaced
//   M-MINQTY       a Minimum-only edit is dropped from the change list
//   M-REVERT-EXPECT a revert drift-checks against the live row, not the entry
//   M-CTX-KEY      the preview key ignores the context it was computed against
//   M-STUCK-CLEAR  a clear that cannot act claims nothing is overridden
//   M-EFF-RP       the no-change test compares the typed Ask at, not the landed one
//   M-PERSIZE      the arming flag is read back from what was saved last time
//   M-REGISTRY     the registry fallback stretches a GROUP's union
//
// Same discipline as scripts/mutation-proof-seating.mjs — ERROR is not FAIL,
// anchors must be unique, restore is signal-safe, and the tree must be clean.
//
// Run: node scripts/mutation-proof-target-override.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const OVERRIDE = "src/components/stock/targetOverride.js";
const STORE = "src/components/stock/seatingStore.js";
const EDITOR = "src/components/stock/ProductTargetEditor.jsx";
const CORE = "src/components/stock/enginePolicyCore.js";
const CARD = "src/components/stock/EnginePolicyCard.jsx";
const WRITE = "functions/lib/category-policy-write.cjs";
const GROUPS = "functions/lib/policy-groups.cjs";

const OVERRIDE_TESTS = ["src/components/stock/targetOverride.test.js"];
const EDITOR_TESTS = ["src/components/stock/productTargetEditor.render.test.jsx"];
const STORE_TESTS = ["src/components/stock/seatingStore.test.js"];
const CARD_TESTS = ["src/components/stock/enginePolicyPerSize.test.jsx"];
const SERVER_TESTS = ["test/product-targets.test.cjs"];
const RUN_TESTS = ["test/engine-policy-pass3.test.cjs"];

const MUTATIONS = [
  // ── BLANK MEANS INHERIT ───────────────────────────────────────────────────
  {
    id: "M-BLANK",
    guard: "a blank field INHERITS — it never becomes 0",
    file: OVERRIDE,
    from: `  if (t === "") return null;
  if (!/^\\d+$/.test(t)) return null;`,
    to: `  if (t === "") return 0;
  if (!/^\\d+$/.test(t)) return null;`,
    tests: [...OVERRIDE_TESTS, ...STORE_TESTS],
  },
  {
    id: "M-NO-REMOVE",
    guard: "a blank REMOVES the row — that is what inheriting means",
    file: OVERRIDE,
    from: `      if (prev === null) continue;                                   // already inheriting`,
    to: `      continue;`,
    tests: [...OVERRIDE_TESTS, ...STORE_TESTS],
  },
  {
    id: "M-RESTAMP",
    guard: "a row whose numbers did not move is not rewritten under this card's stamp",
    file: OVERRIDE,
    from: `    if (prev !== null && prevTarget === target && prevRp === effRp) continue;`,
    to: ``,
    tests: [...OVERRIDE_TESTS, ...STORE_TESTS],
  },
  {
    id: "M-WRITABLE",
    guard: "a captured row the live rule would refuse is reported, never restored",
    file: STORE,
    from: `    if (!writableRow(r.prevRow)) { stuck.push(sizeKey); continue; }`,
    to: ``,
    tests: STORE_TESTS,
  },
  // ── SAVE WAITS FOR A PREVIEW ──────────────────────────────────────────────
  {
    id: "M-PREVIEW",
    guard: "Save stays disabled until a preview has run against the numbers on screen",
    file: EDITOR,
    from: `  const saveable = canWrite && !busy && !Object.keys(errors).length && plan.dirty && preview && !stale;`,
    to: `  const saveable = canWrite && !busy && !Object.keys(errors).length && plan.dirty;`,
    tests: EDITOR_TESTS,
  },
  // ── THE SERVER ────────────────────────────────────────────────────────────
  {
    id: "M-ZERO",
    guard: "target 0 is legal on a product row — it is the off switch",
    file: WRITE,
    from: `      if (!isCount(r.target, MAX_TARGET)) {`,
    to: `      if (!isCount(r.target, MAX_TARGET) || r.target <= 0) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-DRIFT-ROW",
    guard: "a row that changed underneath is refused, per size",
    file: WRITE,
    from: `      if (!sameValue(was, want)) {
        throw httpsError("failed-precondition",
          \`\${loc} / \${pid} / \${k} changed while this was open. Close and re-open the product.\`,
          { drift: true, sizeKey: k, live: was });
      }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-DRIFT-LATE",
    guard: "and the check is re-run immediately before the mutation",
    file: WRITE,
    from: `      if (!sameValue(was, want)) {
        await historyRef.update({ status: "aborted_on_drift", driftedSize: k, liveAtAbort: nowLive ?? null });`,
    to: `      if (false) {
        await historyRef.update({ status: "aborted_on_drift", driftedSize: k, liveAtAbort: nowLive ?? null });`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-FOREIGN",
    guard: "a row this card did not write cannot be removed without a confirmation",
    file: WRITE,
    from: `    if (foreign.length && d.allowRemoveForeign !== true) {`,
    to: `    if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-NEST",
    guard: "the row a row replaced is carried through, never nested one level deeper",
    file: WRITE,
    from: `      if (prev && OUR_ROW_SOURCES.has(prev.source)) {
        if (isPlainObject(prev.prevRow)) row.prevRow = prev.prevRow;
        else row.prevAbsent = true;
      } else if (prev) row.prevRow = prev;`,
    to: `      if (prev) row.prevRow = prev;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-EXPECT",
    guard: "the expectation names every size the plan touches",
    file: OVERRIDE,
    from: `  for (const sizeKey of touched) {`,
    to: `  for (const sizeKey of []) {`,
    tests: OVERRIDE_TESTS,
    nodeTests: SERVER_TESTS,
  },
  // ── THE ARMING FLAG ───────────────────────────────────────────────────────
  {
    id: "M-RP-ZERO",
    guard: "an \"Ask at\" never rides on a switched-off size — the server refuses the pair",
    file: OVERRIDE,
    from: `    const effRp = rp !== null && target > 0 ? rp : null;`,
    to: `    const effRp = rp;`,
    tests: OVERRIDE_TESTS,
  },
  {
    id: "M-EXPECT-STALE",
    guard: "the expectation is the row the editor was OPENED on, not one a refresh replaced",
    file: OVERRIDE,
    from: `    const prev = draft?.sizes?.[sizeKey] && "prev" in draft.sizes[sizeKey]
      ? draft.sizes[sizeKey].prev
      : live[sizeKey];`,
    to: `    const prev = live[sizeKey];`,
    tests: OVERRIDE_TESTS,
  },
  // ── FIVE REVIEW FINDINGS, PR #497 ────────────────────────────────────────
  {
    id: "M-MINQTY",
    guard: "a Minimum-only edit is a real edit — an empty change list never applies the write",
    file: WRITE,
    from: `      if (fromM !== next.minQty) changes.push({ sizeKey, field: "minQty", from: fromM, to: next.minQty });`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-REVERT-EXPECT",
    guard: "a revert drift-checks against the entry's own after-state, never the live row",
    file: CARD,
    from: `      expected[k] = a.absent === true || !a.row ? null
        : { target: typeof a.row.target === "number" ? a.row.target : null,
            minQty: typeof a.row.minQty === "number" ? a.row.minQty : null,
            reorderPoint: typeof a.row.reorderPoint === "number" ? a.row.reorderPoint : null };`,
    to: `      expected[k] = null;`,
    tests: CARD_TESTS,
  },
  {
    id: "M-CTX-KEY",
    guard: "the preview key covers the CONTEXT it was computed against, not only the typed numbers",
    file: EDITOR,
    from: `  const keyNow = draftKey(draft, ctxSig(ctx, loc, pid));`,
    to: `  const keyNow = draftKey(draft);`,
    tests: EDITOR_TESTS,
  },
  {
    id: "M-STUCK-CLEAR",
    guard: "a clear that cannot act names the rows rather than claiming nothing is overridden",
    file: EDITOR,
    from: `      onFail(p.stuck.length`,
    to: `      onFail(false`,
    tests: EDITOR_TESTS,
  },
  {
    id: "M-EFF-RP",
    guard: "the no-change test compares the Ask at that would LAND, not the one that was typed",
    file: OVERRIDE,
    from: `    if (prev !== null && prevTarget === target && prevRp === effRp) continue;`,
    to: `    if (prev !== null && prevTarget === target && prevRp === rp) continue;`,
    tests: OVERRIDE_TESTS,
  },
  {
    id: "M-PERSIZE",
    guard: "per-size is the CATEGORY's run, not what was saved last time",
    file: CORE,
    from: `export const perSizeMode = (category) => ((category?.sizeRun || []).length > 0);`,
    to: `export const perSizeMode = (category) => (category?.perSize === true);`,
    tests: CARD_TESTS,
  },
  {
    id: "M-PERSIZE-GATE",
    guard: "the size-by-size control is offered on the run, not on the stored flag",
    file: CARD,
    from: `  const canPerSize = sizeRun.length > 0;`,
    to: `  const canPerSize = c.perSize && sizeRun.length > 0;`,
    tests: CARD_TESTS,
  },
  // ── THE REGISTRY FALLBACK ─────────────────────────────────────────────────
  {
    id: "M-REGISTRY",
    guard: "a product-less member does not stretch a GROUP's union with its registered sizes",
    file: GROUPS,
    from: `    const sizes = run.derivedSizes;`,
    to: `    const sizes = run.sizes;`,
    nodeTests: RUN_TESTS,
  },
];

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}

function runNodeTests(files) {
  try {
    // TAP is PINNED, not left to the default reporter: node 24 prints "ℹ fail 1"
    // where node 22 prints "# fail 1", and the parser below would read a real
    // failure as ERROR — silently crediting no guard at all.
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
  if (m.tests && m.tests.length) verdicts.push(runVitest(m.tests));
  if (m.nodeTests && m.nodeTests.length) verdicts.push(runNodeTests(m.nodeTests));
  const errored = verdicts.find((v) => String(v).startsWith("ERROR"));
  if (errored) return errored;
  if (verdicts.includes("FAIL")) return "FAIL";
  return "PASS";
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
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(14)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
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
  console.log(`${m.id.padEnd(14)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
