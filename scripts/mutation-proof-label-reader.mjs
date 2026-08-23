// ─── MUTATION PROOF HARNESS — the label reader repair (owner spec 2026-08-23)
// For each guard: reintroduce the bug, prove the test suite FAILS, restore the
// file, prove it PASSES. A test that cannot fail proves nothing, so this runs
// the whole cycle and refuses to report a pass it did not watch break first.
// Same discipline as scripts/mutation-proof-multi-token.mjs (ERROR ≠ FAIL,
// unique anchors, signal-safe restore, never mutates a dirty file).
//
// The mutations vary in SHAPE on purpose (feedback: a guard that only ever
// sees one kind of break is a guard against one kind of break): a flipped
// table, a dropped tie-break, a resurrected branch, a dropped field, a
// loosened threshold, a removed guard, a zeroed pad, a resurrected auto-pick,
// a dropped write, a swapped renderer.
//
// Run:  node scripts/mutation-proof-label-reader.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const READER_TESTS = ["src/components/stock/TongueLabelReader.render.test.jsx"];
const SURFACES = ["src/components/stock/labelReaderSurfaces.render.test.jsx"];

const MUTATIONS = [
  {
    id: "M1",
    guard: "The primary-code rank table: a flipped rank (numeric over article) must fail",
    file: "src/utils/labelPrimary.js",
    from: `  "numeric-6-3": 1,`,
    to: `  "numeric-6-3": -1,`,
    tests: ["src/utils/labelPrimary.test.js", ...READER_TESTS],
  },
  {
    id: "M2",
    guard: "Ties keep READING order — a last-wins tie-break must fail",
    file: "src/utils/labelPrimary.js",
    from: `    if (r < bestRank) { bestRank = r; best = i; }`,
    to: `    if (r <= bestRank) { bestRank = r; best = i; }`,
    tests: ["src/utils/labelPrimary.test.js"],
  },
  {
    id: "M3",
    guard: "chooseFromLabelRead never returns a QUESTION — resurrecting the options branch must fail",
    file: "src/components/stock/hubCleanupCore.js",
    from: `    const k = choosePrimaryCodeIndex(candidates);
    return { kind: "chosen", code: display[k], auto: true, autoSource: "rule", allCandidates: candidates };`,
    to: `    return { kind: "options", options: display, candidates };`,
    tests: ["src/utils/labelPrimary.test.js", "src/components/stock/hubCleanupCore.test.js", ...READER_TESTS, ...SURFACES],
  },
  {
    id: "M4",
    guard: "The reader hands the FULL token set to its consumer — dropping allCodes must fail",
    file: "src/components/stock/TongueLabelReader.jsx",
    from: `            allCodes: out.allCandidates || null, auto: !!out.auto,`,
    to: `            allCodes: null, auto: !!out.auto,`,
    tests: [...READER_TESTS, ...SURFACES],
  },
  {
    id: "M5",
    guard: "Multi-frame agreement: tokens must be seen in ≥2 of 3 frames — loosening to 1 must fail",
    file: "src/utils/labelFrames.js",
    from: `  return [...counts.entries()].filter(([, n]) => n >= 2).map(([t]) => t).sort();`,
    to: `  return [...counts.entries()].filter(([, n]) => n >= 1).map(([t]) => t).sort();`,
    tests: [...READER_TESTS, "src/utils/labelFrames.test.js"],
  },
  {
    id: "M6",
    guard: "No getUserMedia → the file input, never a dead overlay — removing the guard must fail",
    file: "src/components/stock/TongueLabelReader.jsx",
    from: `                 onClick={() => { if (cameraStreamAvailable()) setCameraOpen(true); else if (fileRef.current) fileRef.current.click(); }}`,
    to: `                 onClick={() => setCameraOpen(true)}`,
    tests: READER_TESTS,
  },
  {
    id: "M7",
    guard: "The merge picker is NEVER EMPTY — zeroing the pad must fail",
    file: "src/components/stock/MergeProducts.jsx",
    from: `      fillToMin: Math.max(0, MIN_ROWS - exactRows.length),`,
    to: `      fillToMin: 0,`,
    tests: ["src/components/stock/mergePickerNeverEmpty.render.test.jsx"],
  },
  {
    id: "M8",
    guard: "The assistant finder is NEVER EMPTY — zeroing the pad must fail",
    file: "src/components/assistant/AssistantLabelFinder.jsx",
    from: `      fillToMin: Math.max(0, MIN_ROWS - exactRows.length),`,
    to: `      fillToMin: 0,`,
    tests: ["src/components/assistant/assistantLabelFinder.render.test.jsx"],
  },
  {
    id: "M9",
    guard: "The finder never auto-picks when several own the label — resurrecting first-wins must fail",
    file: "src/components/assistant/AssistantLabelFinder.jsx",
    from: `      if (exact.length === 1 && !merged.unloadedIds.length && !sweepFailed) { finish(exact[0].product); return; }`,
    to: `      if (exact.length >= 1) { finish(exact[0].product); return; }`,
    tests: ["src/components/assistant/assistantLabelFinder.render.test.jsx", ...SURFACES],
  },
  {
    id: "M10",
    guard: "Registration files the label's WORDING beside the codes — dropping it must fail",
    file: "src/components/stock/HubCleanup.jsx",
    from: `    setAliasTokens(source === "label" && Array.isArray(tokens) && tokens.length >= 2 ? tokens : null);`,
    to: `    setAliasTokens(null);`,
    tests: SURFACES,
  },
  {
    id: "M11",
    guard: "The count's link panel renders the SHARED cards — a private list must fail",
    file: "src/components/stock/HubCleanup.jsx",
    from: `            <CandidateCards suggestions={suggestions} limit={suggestShown} photoSize={110} cta="Link →"`,
    to: `            <CandidateCards suggestions={suggestions} limit={suggestShown} photoSize={72} cta="Link →"`,
    tests: SURFACES,
  },
  {
    id: "M12",
    guard: "The intake gate keeps EVERY other token for the save — dropping the set must fail",
    file: "src/components/admin/StyleCodeGate.jsx",
    from: `    const all = Array.isArray(meta.allCodes) && meta.allCodes.length > 1 ? meta.allCodes : null;`,
    to: `    const all = null;`,
    tests: ["src/components/admin/StyleCodeGate.neverAsks.test.jsx", "src/components/admin/StyleCodeGate.multiToken.test.jsx"],
  },
  {
    id: "M13",
    guard: "The reader never blocks on a question — a blocking 'tap the style number' note must fail",
    file: "src/components/stock/TongueLabelReader.jsx",
    from: `                  : \`Read \${formattedChosen} as the style number — every number on this label is saved with it. Wrong? Tap the right one:\`,`,
    to: `                  : \`The label shows more than one code-looking number — tap the style number:\`,`,
    tests: [...READER_TESTS],
  },
];

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
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
    console.log(`${m.id}  ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
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
    mutated = runVitest(m.tests);
    restore();
    restored = runVitest(m.tests);
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
