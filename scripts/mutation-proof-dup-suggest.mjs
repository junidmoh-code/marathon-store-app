// ─── MUTATION PROOF HARNESS — the product duplicate suggester ─────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the whole
// cycle and refuses to report a pass it did not watch break first.
//
// Same discipline as scripts/mutation-proof-stock-audit.mjs — ERROR is not FAIL,
// unique anchors, signal-safe restore, clean-tree preflight (feedback memory:
// mutation harnesses refuse a dirty tree, enforced in every harness since #584).
//
// EVERY BRANCH OF scoreCandidate IS MUTATED HERE, plus the tokenisation each
// branch depends on, because each one is a different way this feature fails
// QUIETLY:
//   S1–S4  the exact_code branch and its three evidence sources. A dropped
//          source is a duplicate this panel silently stops catching.
//   S5–S7  the partial_code branches. Both directions plus the sibling case.
//   S8–S12 the fuzzy tier's floors. Loosening any of them turns the panel into
//          noise, which trains the operator to dismiss it unread — and a panel
//          nobody reads is worse than no panel, because it looks like a guard.
//   T1–T5  tokenisation: the digit floor, the shape delegation, and — the one
//          that matters most — the segment rule that keeps 447120 from
//          impersonating 44712 with a suffix.
//   R1–R4  ranking: tier order, the cap, the dedupe, the deterministic tie.
//
// Run:  node scripts/mutation-proof-dup-suggest.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MATCH = "src/utils/productDupMatch.js";
const TESTS = ["src/utils/productDupMatch.test.js"];

const MUTATIONS = [
  // ── exact_code: identity, and the three places identity is recorded ────────
  { id: "S1", file: MATCH, tests: TESTS,
    guard: "THE EXACT-CODE BRANCH FIRES — without it every duplicate falls to a weaker tier or to nothing",
    from: `      return { tier: TIER_EXACT_CODE, score: 1, reason: \`\${code} matches this product's \${why}\` };`,
    to: `      void why;` },
  { id: "S2", file: MATCH, tests: TESTS,
    guard: "the product's NAME is a source of codes — for clothing it is the ONLY one",
    from: `  for (const c of nameTokens.codes) add(c, "name");`,
    to: `  void nameTokens;` },
  { id: "S3", file: MATCH, tests: TESTS,
    guard: "styleCodeNormalised counts — a sneaker claimed by the style-code gate must be found by its code",
    from: `  if (product && typeof product.styleCodeNormalised === "string") add(product.styleCodeNormalised, "style code");\n`,
    to: `` },
  { id: "S4", file: MATCH, tests: TESTS,
    guard: "…and so does every barcode, because a code the POS resolves must be a code this panel sees",
    from: `  for (const c of productBarcodes(product)) add(c, "barcode");\n`,
    to: `` },
  { id: "S4b", file: MATCH, tests: TESTS,
    guard: "the per-size barcode map is read, not just the top-level one",
    from: `    for (const c of Object.values(p.barcodes)) if (c != null) out.push(String(c));`,
    to: `    void p.barcodes;` },
  { id: "S4c", file: MATCH, tests: TESTS,
    guard: "the printed EAN a perfume carries is read too",
    from: `  if (p.printedBarcode != null) out.push(String(p.printedBarcode));\n`,
    to: `` },

  // ── partial_code: both directions, and the sibling case ───────────────────
  { id: "S5", file: MATCH, tests: TESTS,
    guard: "a typed stem finds a stored SEGMENTED code — 44712 against 44712-01",
    from: `    if (p.codeStems.includes(code)) {\n      return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: \`\${code} is the first part of this product's code\` };\n    }\n`,
    to: `` },
  { id: "S6", file: MATCH, tests: TESTS,
    guard: "…and the reverse — a typed segmented code finds a stored stem",
    from: `    if (p.byCode.has(stem)) {\n      return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: \`this product's code \${stem} is the first part of what you typed\` };\n    }`,
    to: `    if (false) {}` },
  { id: "S7", file: MATCH, tests: TESTS,
    guard: "two sibling colourways rank BELOW either — a colour suffix makes a different product",
    from: `      return { tier: TIER_PARTIAL_CODE, score: 0.75, reason: \`\${stem} is the first part of both codes — this may be another colourway\` };`,
    to: `      return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: \`\${stem} is the first part of both codes — this may be another colourway\` };` },
  { id: "S7b", file: MATCH, tests: TESTS,
    guard: "partial NEVER outranks exact on the same product — the exact branch returns first",
    from: `  // ── TIER 2: the same ARTICLE, a different printed suffix. ──`,
    to: `  // moved below\n  {\n    for (const code of t.codes) if (p.codeStems.includes(code)) return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: "x" };\n  }\n  // ── TIER 2: the same ARTICLE, a different printed suffix. ──` },

  // ── fuzzy_name: every floor ───────────────────────────────────────────────
  { id: "S8", file: MATCH, tests: TESTS,
    guard: `at least ${"FUZZY_MIN_SHARED"} shared words — one shared word is a brand name, and matches the whole shop`,
    from: `  if (shared.length < FUZZY_MIN_SHARED) return null;\n`, to: `` },
  { id: "S9", file: MATCH, tests: TESTS,
    guard: "the overlap ratio is floored — an unfloored overlap is noise wearing a score",
    from: `  if (ratio < FUZZY_FLOOR) return null;\n`, to: `` },
  { id: "S10", file: MATCH, tests: TESTS,
    guard: "the ratio divides by the LARGER set — dividing by the smaller one IS substring matching, done with arithmetic",
    from: `  const ratio = shared.length / Math.max(tw.length, pw.length);`,
    to: `  const ratio = shared.length / Math.min(tw.length, pw.length);` },
  { id: "S11", file: MATCH, tests: TESTS,
    guard: "short words carry no signal — counting \"XL\" and \"1\" would match half the catalogue",
    from: `    if (w.length < WORD_MIN) continue;\n`, to: `` },
  { id: "S12", file: MATCH, tests: TESTS,
    guard: "A CODE IS NEVER ALSO A WORD — otherwise the fuzzy tier re-admits near-code matches through the back door",
    from: `    if (codeSet.has(w)) continue;\n`, to: `` },
  { id: "S14", file: MATCH, tests: TESTS,
    guard: "a product with no id is refused rather than ranked into a panel that cannot route to it",
    from: `  if (!product || typeof product !== "object" || !product.id) return null;`,
    to: `  if (!product || typeof product !== "object") return null;` },

  // ── tokenisation: where the no-substring rule actually lives ──────────────
  { id: "T1", file: MATCH, tests: TESTS,
    guard: "ONLY A SEGMENTED RUN YIELDS A STEM — this is what stops 447120 impersonating 44712 with a suffix",
    from: `    if (segments.length >= 2) {`, to: `    if (segments.length >= 1) {` },
  { id: "T2", file: MATCH, tests: TESTS,
    guard: "…and the stem must be code-shaped itself, so \"T-SHIRT\" donates no \"T\"",
    from: `      if (isCodeToken(stem) && !codeStems.includes(stem)) codeStems.push(stem);`,
    to: `      if (!codeStems.includes(stem)) codeStems.push(stem);` },
  { id: "T3", file: MATCH, tests: TESTS,
    guard: `a digit run must be ${"CODE_DIGIT_MIN"}+ to be an identity claim — three digits is a model number`,
    from: `  if (/^\\d+$/.test(bare)) return bare.length >= CODE_DIGIT_MIN;`,
    to: `  if (/^\\d+$/.test(bare)) return bare.length >= 3;` },
  { id: "T4", file: MATCH, tests: TESTS,
    guard: "brand shapes come from styleCode.js — this file never grows a second shape list",
    from: `  return isKnownStyleCodeFormat(bare);`, to: `  return false;` },
  { id: "T5", file: MATCH, tests: TESTS,
    guard: "a code's IDENTITY spelling drops separators, so 44712-01 and 44712/01 are one code",
    from: `    const bare = normaliseStyleCode(run);`, to: `    const bare = run;` },
  { id: "T6", file: MATCH, tests: TESTS,
    guard: "normaliseForMatch turns punctuation into a BOUNDARY, never deletes it",
    from: `  return s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();`,
    to: `  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "").trim();` },

  // ── ranking ───────────────────────────────────────────────────────────────
  { id: "R1", file: MATCH, tests: TESTS,
    guard: "TIER BEFORE SCORE — a weak exact-code match must outrank a strong fuzzy one",
    from: `    (TIER_RANK[b.tier] - TIER_RANK[a.tier]) ||\n`, to: `` },
  { id: "R2", file: MATCH, tests: TESTS,
    guard: `the panel is capped at ${"MAX_CANDIDATES"} however large a limit is asked for`,
    from: `  const cap = Math.max(0, Math.min(Number.isFinite(limit) ? limit : MAX_CANDIDATES, MAX_CANDIDATES));`,
    to: `  const cap = Math.max(0, Number.isFinite(limit) ? limit : MAX_CANDIDATES);` },
  { id: "R3", file: MATCH, tests: TESTS,
    guard: "deduped by product id — one product is one row",
    from: `    if (!product || !product.id || seen.has(product.id)) continue;`,
    to: `    if (!product || !product.id) continue;` },
  { id: "R4", file: MATCH, tests: TESTS,
    guard: "ties break on NAME, so the order does not shuffle between renders",
    from: `    String(a.product.name ?? "").localeCompare(String(b.product.name ?? "")));`,
    to: `    0);` },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Only a runner that EXECUTED tests and saw them fail counts as FAIL. A syntax
// error, a missing file, a reworded summary — all report ERROR, loudly, and
// never credit the guard.
function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
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
  let mutated = "?", restored = "?";
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

const unproven = results.filter((r) => !r.proven);
console.log(`\n${results.length - unproven.length}/${results.length} guards proven`);
if (unproven.length) {
  console.log("NOT PROVEN:");
  for (const r of unproven) console.log(`  ${r.id}  mutated:${r.mutated} restored:${r.restored}  ${r.guard}`);
  process.exit(1);
}
