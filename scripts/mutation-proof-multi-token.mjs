// ─── MUTATION PROOF HARNESS — multi-token label identity (owner spec 2026-08-13)
// For each guard: reintroduce the bug, prove the test suite FAILS, restore the
// file, prove it PASSES. A test that cannot fail proves nothing, so this runs
// the whole cycle and refuses to report a pass it did not watch break first.
// Same discipline as scripts/mutation-proof-perfume-ean.mjs (ERROR ≠ FAIL,
// unique anchors, signal-safe restore) — extended with a second runner because
// this feature spans BOTH suites: vitest (client) and node --test (functions).
//
// Run:  node scripts/mutation-proof-multi-token.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MUTATIONS = [
  {
    id: "M1",
    guard: "Tier 2 PREFERS — reintroducing the one-line erasure must fail",
    file: "functions/styleCode/readStyleCodeLabel.js",
    from: `        const rest = [...new Set([...(g.otherCodes || []), ...candidates])].filter((c) => c !== g.code);
        candidates = [g.code, ...rest].slice(0, MAX_CANDIDATES);`,
    to: `        candidates = [g.code];`,
    nodeTests: ["test/style-code-label-read.test.cjs", "test/multi-token-label.test.cjs"],
  },
  {
    id: "M2",
    guard: "The split-numeric production line (35289 0625) is extracted",
    file: "functions/lib/style-code-ocr.cjs",
    from: `  { format: null, re: /(?<![A-Z0-9])\\d{4,6}[-\\s]\\d{2,5}(?![A-Z0-9])(?![-\\s]?\\d)/g },`,
    to: ``,
    nodeTests: ["test/multi-token-label.test.cjs"],
    tests: ["src/utils/multiTokenLabel.test.js"],
  },
  {
    id: "M3",
    guard: "The label-serial interleaved run (A6CWNEN3) is extracted",
    file: "functions/lib/style-code-ocr.cjs",
    from: `  { format: "label-serial", re: /(?<![A-Z0-9])(?:[A-Z]+\\d+){2,}[A-Z]{0,8}(?![A-Z0-9])(?![-\\s]?\\d)/g },`,
    to: ``,
    nodeTests: ["test/multi-token-label.test.cjs"],
  },
  {
    id: "M4",
    guard: "The SERVER twin recognises label-serial as code-shaped",
    file: "functions/lib/style-code.cjs",
    from: `  { name: "label-serial", re: /^(?!(?:(?:US|UK|EU|EUR|FR|JP|JPN|CM|BR|MX|CN|KR|AU|SIZE)\\d+)+$)(?=[A-Z0-9]{6,16}$)(?:[A-Z]+\\d+){2,}[A-Z]{0,8}$/ },`,
    to: ``,
    nodeTests: ["test/multi-token-label.test.cjs"],
  },
  {
    id: "M5",
    guard: "The CLIENT twin recognises label-serial identically",
    file: "src/utils/styleCode.js",
    from: `  { name: "label-serial", re: /^(?!(?:(?:US|UK|EU|EUR|FR|JP|JPN|CM|BR|MX|CN|KR|AU|SIZE)\\d+)+$)(?=[A-Z0-9]{6,16}$)(?:[A-Z]+\\d+){2,}[A-Z]{0,8}$/ },`,
    to: ``,
    tests: ["src/utils/multiTokenLabel.test.js"],
  },
  {
    id: "M6",
    guard: "The token set rides EVERY read, not only code-less ones",
    file: "functions/styleCode/readStyleCodeLabel.js",
    from: `  const tokens = labelTokens(visionText);`,
    to: `  const tokens = candidates.length === 0 ? labelTokens(visionText) : [];`,
    nodeTests: ["test/style-code-label-read.test.cjs", "test/multi-token-label.test.cjs"],
  },
  {
    id: "M7",
    guard: "resolveAnyCode NEVER coin-flips between two owners",
    file: "functions/labelAlias/labelAlias.js",
    from: `    return { owners, resolved: owners.length === 1 ? owners[0].productId : null };`,
    to: `    return { owners, resolved: owners.length ? owners[0].productId : null };`,
    nodeTests: ["test/multi-token-label.test.cjs"],
  },
  {
    id: "M8",
    guard: "resolveAnyCode consults the code-alias store, not just the index",
    file: "functions/labelAlias/labelAlias.js",
    from: `      for (const o of codeAliasOwnersAll(c, aliases)) raw.push({ code: c, productId: o, via: "alias" });`,
    to: ``,
    nodeTests: ["test/multi-token-label.test.cjs"],
  },
  {
    id: "M9",
    guard: "A conflicting token still routes to the duplicate flow",
    file: "functions/labelAlias/labelAlias.js",
    from: `    for (const { code: c, ownerId } of conflicts) {`,
    to: `    for (const { code: c, ownerId } of []) {`,
    nodeTests: ["test/multi-token-label.test.cjs", "test/label-alias-codes.test.cjs"],
  },
  {
    id: "M10",
    guard: "Every token pools candidates into ONE merged suggestion list",
    file: "src/utils/linkSuggestions.js",
    from: `    for (const extra of pooled) {`,
    to: `    for (const extra of []) {`,
    tests: [
      "src/utils/multiTokenLabel.test.js",
      "src/components/admin/StyleCodeGate.multiToken.test.jsx",
      "src/components/stock/hubCleanupAnyToken.render.test.jsx",
    ],
  },
  {
    id: "M11",
    guard: "A pooled row's reason names WHICH token found it",
    file: "src/utils/linkSuggestions.js",
    from: `        hits.push({ ...h, reason: \`\${h.reason} (via the label's other token \${formatStyleCodeForDisplay(extra)})\` });`,
    to: `        hits.push({ ...h });`,
    tests: [
      "src/utils/multiTokenLabel.test.js",
      "src/components/admin/StyleCodeGate.multiToken.test.jsx",
    ],
  },
  {
    id: "M12",
    guard: "The reader's tier-2 preference resolves without erasing (client half)",
    file: "src/components/stock/hubCleanupCore.js",
    from: `    const j = preferred ? candidates.indexOf(preferred) : -1;`,
    to: `    const j = -1;`,
    tests: ["src/utils/multiTokenLabel.test.js"],
  },
  {
    id: "M13",
    guard: "The count flow tries the label's OTHER tokens before the link panel",
    file: "src/components/stock/HubCleanup.jsx",
    from: `      if (alternates.length) {`,
    to: `      if (false) {`,
    tests: ["src/components/stock/hubCleanupAnyToken.render.test.jsx"],
  },
  {
    id: "M14",
    guard: "Two any-token owners open the CHOOSE panel, never a silent pick",
    file: "src/components/stock/HubCleanup.jsx",
    from: `          if (claimants.length > 1) {`,
    to: `          if (false) {`,
    tests: ["src/components/stock/hubCleanupAnyToken.render.test.jsx"],
  },
  {
    id: "M15",
    guard: "The intake gate asks the duplicate question with EVERY token",
    file: "src/components/admin/StyleCodeGate.jsx",
    from: `        // EVERY token the label printed asks the duplicate question too (owner
        // spec 2026-08-13): the shoe may be registered under its production
        // line while the operator holds the article code. Photo-evidence-bound
        // like everything read off the label.
        allCodes: (photoMatchesCode && labelAllCodes) || null,`,
    to: `        allCodes: null,`,
    tests: ["src/components/admin/StyleCodeGate.multiToken.test.jsx"],
  },
  {
    id: "M16",
    guard: "Tier 2's otherCodes face the same shape gate as the code",
    file: "functions/styleCode/readStyleCodeLabel.js",
    from: `    .filter((c) => typeof c === "string" && isKnownStyleCodeFormat(c.trim()))`,
    to: `    .filter((c) => typeof c === "string")`,
    nodeTests: ["test/multi-token-label.test.cjs"],
  },
  {
    id: "M17",
    guard: "A size line (US10UK9) can never pass as a label-serial (client twin)",
    file: "src/utils/styleCode.js",
    from: `re: /^(?!(?:(?:US|UK|EU|EUR|FR|JP|JPN|CM|BR|MX|CN|KR|AU|SIZE)\\d+)+$)(?=[A-Z0-9]{6,16}$)(?:[A-Z]+\\d+){2,}[A-Z]{0,8}$/ },`,
    to: `re: /^(?=[A-Z0-9]{6,16}$)(?:[A-Z]+\\d+){2,}[A-Z]{0,8}$/ },`,
    tests: ["src/utils/multiTokenLabel.test.js", "src/utils/styleCode.test.js"],
  },
  {
    id: "M18",
    guard: "A size line can never pass as a label-serial (server twin)",
    file: "functions/lib/style-code.cjs",
    from: `re: /^(?!(?:(?:US|UK|EU|EUR|FR|JP|JPN|CM|BR|MX|CN|KR|AU|SIZE)\\d+)+$)(?=[A-Z0-9]{6,16}$)(?:[A-Z]+\\d+){2,}[A-Z]{0,8}$/ },`,
    to: `re: /^(?=[A-Z0-9]{6,16}$)(?:[A-Z]+\\d+){2,}[A-Z]{0,8}$/ },`,
    tests: ["src/utils/multiTokenLabel.test.js"],
  },
  {
    id: "M19",
    guard: "A learned layout rule is consulted BEFORE tier 2 is paid for",
    file: "functions/styleCode/readStyleCodeLabel.js",
    from: `  let layout = candidates.length > 1 ? await consultLayoutRule(db, candidates) : { autoPick: null, layoutKey: null };
  if (candidates.length !== 1 && !layout.autoPick) {`,
    to: `  let layout = { autoPick: null, layoutKey: null };
  if (candidates.length !== 1) {`,
    nodeTests: ["test/multi-token-label.test.cjs"],
  },
  {
    id: "M20",
    guard: "The existing QR composite-payload hunt survives the new format",
    file: "src/utils/labelScan.js",
    from: `  const rawFormat = styleCodeFormat(raw);
  if (rawFormat && rawFormat !== "label-serial") return { kind: "ignore", reason: "brand_form_varies", raw };`,
    to: `  if (styleCodeFormat(raw)) return { kind: "ignore", reason: "brand_form_varies", raw };`,
    tests: ["src/utils/labelScan.test.js"],
  },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Same rule as the perfume harness: only a runner that EXECUTED tests and saw
// them fail counts as FAIL. A syntax error, a missing file, a reworded summary
// — all report ERROR, loudly, and never credit the guard. (CodeRabbit #340.)
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
