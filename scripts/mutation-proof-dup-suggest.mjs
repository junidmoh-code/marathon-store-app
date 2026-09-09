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
//   G1–G7  the gate: the consistency rule (one code must not mean two
//          products), the create-anyway sentence, and the size handoff — where
//          a silent drop becomes a shortfall nobody can explain weeks later.
//   P1–P9  the panel: the debounce, the minimum, the photo, the unknown-not-
//          zero unit count, and the ways it refuses to block.
//   F1–F5  the three review findings, so none of them can come back: the
//          drop-last stem rule (Lacoste), the re-entrancy guard on Save, and
//          the create-new action that cannot be switched off. F2 runs against
//          the PROPERTY FUZZ rather than the hand-written cases — the fuzz is
//          what catches a prefix rule dressed up as a boundary one.
//
// Run:  node scripts/mutation-proof-dup-suggest.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MATCH = "src/utils/productDupMatch.js";
const TESTS = ["src/utils/productDupMatch.test.js"];
const GATE = "src/components/admin/duplicateGate.js";
const GATE_TESTS = ["src/components/admin/duplicateGate.test.js"];
const PANEL = "src/components/admin/DuplicateSuggestPanel.jsx";
const PANEL_TESTS = ["src/components/admin/DuplicateSuggestPanel.render.test.jsx"];
const COST_TESTS = ["src/components/admin/DuplicateSuggestPanel.cost.test.jsx"];
const FUZZ_TESTS = ["src/utils/productDupMatchFuzz.test.js"];
const FUZZ = "src/utils/productDupMatchFuzz.test.js";
const ONCE = "src/utils/onceAtATime.js";
const ONCE_TESTS = ["src/utils/onceAtATime.test.js"];

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
    from: `    if (p.codeStems.includes(code)) {\n      return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: \`\${code} is this product's code without its last block\` };\n    }\n`,
    to: `` },
  { id: "S6", file: MATCH, tests: TESTS,
    guard: "…and the reverse — a typed segmented code finds a stored stem",
    from: `    if (p.byCode.has(stem)) {\n      return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: \`this product's code \${stem} is what you typed without its last block\` };\n    }`,
    to: `    if (false) {}` },
  { id: "S7", file: MATCH, tests: TESTS,
    guard: "two sibling colourways rank BELOW either — a colour suffix makes a different product",
    from: `      return { tier: TIER_PARTIAL_CODE, score: 0.75, reason: \`\${stem} is what both codes start from — this may be another colourway\` };`,
    to: `      return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: \`\${stem} is what both codes start from — this may be another colourway\` };` },
  { id: "S7b", file: MATCH, tests: TESTS,
    guard: "partial NEVER outranks exact on the same product — the exact branch is asked FIRST",
    from: `  // ── TIER 1: the same code. Identity, not similarity. ──`,
    to: `  for (const code of t.codes) {\n    if (p.codeStems.includes(code)) return { tier: TIER_PARTIAL_CODE, score: 0.9, reason: "stem" };\n  }\n  // ── TIER 1: the same code. Identity, not similarity. ──` },

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
  { id: "T2", file: MATCH, tests: TESTS,
    guard: "…and the stem must be code-shaped itself, so \"T-SHIRT\" donates no \"T\"",
    from: `      const stem = normaliseStyleCode(segments[0]);\n      if (isCodeToken(stem) && !codeStems.includes(stem)) codeStems.push(stem);`,
    to: `      const stem = normaliseStyleCode(segments[0]);\n      if (stem && !codeStems.includes(stem)) codeStems.push(stem);` },
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

  // ── the gate: one code must not mean two products ─────────────────────────
  { id: "G1", file: GATE, tests: GATE_TESTS,
    guard: "A SOLE EXACT MATCH IS RESOLVED, never offered as a choice — a choice with one right answer can be got wrong",
    from: `  if (exact.length === 1) return { kind: DUP_RESOLVED, row: exact[0] };`,
    to: `  if (exact.length === 1) return { kind: DUP_CHOOSE, rows: exact };` },
  { id: "G2", file: GATE, tests: GATE_TESTS,
    guard: "…and a GENUINE TIE is not resolved for the operator — the catalogue is already inconsistent there",
    from: `  if (exact.length > 1) return { kind: DUP_CHOOSE, rows: exact };`,
    to: `  if (exact.length > 1) return { kind: DUP_RESOLVED, row: exact[0] };` },
  { id: "G3", file: GATE, tests: GATE_TESTS,
    guard: "ONLY THE EXACT TIER decides any of this — a fuzzy guess must never resolve or confirm",
    from: `  const exact = (Array.isArray(rows) ? rows : []).filter((r) => r && r.tier === TIER_EXACT_CODE);`,
    to: `  const exact = (Array.isArray(rows) ? rows : []).filter((r) => r);` },
  { id: "G4", file: GATE, tests: GATE_TESTS,
    guard: "the confirm NAMES the product — \"this may be a duplicate\" is a sentence nobody can act on",
    from: `    return \`\${r.product.name || "an unnamed product"} with \${units}\`;`,
    to: `    return \`another product with \${units}\`;` },
  { id: "G5", file: GATE, tests: GATE_TESTS,
    guard: "AN UNREADABLE UNIT COUNT IS UNKNOWN, NEVER 0 — \"0 units\" reads as \"dead record, safe to replace\"",
    from: `      : "an unknown number of units";`, to: `      : "0 units";` },
  { id: "G6", file: GATE, tests: GATE_TESTS,
    guard: "a fuzzy-only match gets NO confirm — a dialog over a guess trains people to dismiss dialogs",
    from: `  if (!rows.length) return null;\n  const name = String(typed || "").trim();`,
    to: `  const name = String(typed || "").trim();` },
  { id: "G7", file: GATE, tests: GATE_TESTS,
    guard: "A SIZE THE PRODUCT CANNOT HOLD IS REPORTED, not dropped — a silent drop is a shortfall weeks later",
    from: `    if (have.has(String(size))) carried[size] = String(n);\n    else dropped.push(String(size));`,
    to: `    if (have.has(String(size))) carried[size] = String(n);` },
  { id: "G8", file: GATE, tests: GATE_TESTS,
    guard: "a blank or zero quantity is not a loss — it carries nothing and is not reported as dropped",
    from: `    if (!Number.isFinite(n) || n <= 0) continue;\n`, to: `` },
  { id: "G9", file: GATE, tests: GATE_TESTS,
    guard: "sizes compare as STRINGS, so a numeric shoe size still matches its own cell",
    from: `  const have = new Set((Array.isArray(productSizes) ? productSizes : []).map(String));`,
    to: `  const have = new Set(Array.isArray(productSizes) ? productSizes : []);` },

  // ── the panel ─────────────────────────────────────────────────────────────
  { id: "P1b", file: PANEL, tests: COST_TESTS,
    guard: "…and a code typed fast is matched ONCE, not once per keystroke",
    from: `  const held = useDebounced(typed, debounceMs);`, to: `  const held = typed;` },
  { id: "P1", file: PANEL, tests: PANEL_TESTS,
    guard: "THE DEBOUNCE — a typed article code is matched once, not once per keystroke",
    from: `    const t = setTimeout(() => setHeld(value), ms);`, to: `    const t = setTimeout(() => {}, ms); setHeld(value);` },
  { id: "P2", file: PANEL, tests: COST_TESTS,
    guard: "the catalogue is not scanned below MIN_CHARS — 4,700 products per keystroke, for an answer that cannot exist yet",
    from: `  const enough = query.length >= MIN_CHARS;`, to: `  const enough = query.length >= 1;` },
  { id: "P3", file: PANEL, tests: PANEL_TESTS,
    guard: "IT READS TOTALS ONLY FOR THE ROWS ON SCREEN — never for the catalogue",
    from: `    loadTotals(rows.map((r) => r.product.id), locationIds, () => setTick((n) => n + 1));`,
    to: `    loadTotals(products.map((r) => r.id), locationIds, () => setTick((n) => n + 1));` },
  { id: "P4", file: PANEL, tests: PANEL_TESTS,
    guard: "…and issues no read at all when it has nothing to show",
    from: `    if (!rows.length || !locationIds.length) return;\n`, to: `` },
  { id: "P5", file: PANEL, tests: PANEL_TESTS,
    guard: "A FAILED STOCK READ SAYS UNKNOWN, NEVER 0 — the panel holds the same rule as the confirm",
    from: `    : failed ? "units unknown — could not read stock"`, to: `    : failed ? "0 units on hand"` },
  { id: "P6", file: PANEL, tests: PANEL_TESTS,
    guard: "THE RESOLVED BANNER SHOWS NO ALTERNATIVES — showing them alongside it would make it a choice again",
    from: `  if (choice.kind === DUP_RESOLVED && !overridden) {`, to: `  if (false) {` },
  { id: "P7", file: PANEL, tests: PANEL_TESTS,
    guard: "…and its override is a real escape that re-renders the full panel",
    from: `<button type="button" onClick={() => setOverrideFor(query)}`, to: `<button type="button" onClick={() => {}}` },
  { id: "P8", file: PANEL, tests: PANEL_TESTS,
    guard: "A DISMISSAL IS KEYED TO THE NAME IT WAS TAPPED FOR — one that outlived it would silently disarm the guard",
    from: `  const dismissed = dismissedFor !== null && dismissedFor === query;`,
    to: `  const dismissed = dismissedFor !== null;` },
  { id: "P9", file: PANEL, tests: PANEL_TESTS,
    guard: "the row carries the PRODUCT'S OWN PHOTO — this is a visual confirmation, not a text list",
    from: `        product: r.product,`, to: `        product: { ...r.product, photoUrl: null },` },

  // ── the review findings, pinned so they cannot come back ──────────────────
  { id: "F1", file: MATCH, tests: TESTS,
    guard: "THE STEM IS THE RUN MINUS ITS LAST SEGMENT — segments[0] is \"7\" on a Lacoste label, and recorded no stem at all",
    from: `      const stem = normaliseStyleCode(segments.slice(0, -1).join(""));\n      if (isKnownStyleCodeFormat(stem) && !codeStems.includes(stem)) codeStems.push(stem);`,
    to: `      const stem = segments[0];\n      if (isCodeToken(stem) && !codeStems.includes(stem)) codeStems.push(stem);` },
  { id: "F2", file: MATCH, tests: FUZZ_TESTS,
    guard: "PROPERTY FUZZ BITES: a prefix rule dressed as a boundary rule is caught over generated codes",
    from: `    if (p.codeStems.includes(code)) {`,
    to: `    if (p.codeStems.includes(code) || p.codes.some((c) => c !== code && c.startsWith(code))) {` },
  { id: "F4", file: ONCE, tests: ONCE_TESTS,
    guard: "ONE TAP IS ONE PRODUCT — the second tap during the gate's stock read is DROPPED, not run",
    from: `    if (busy) return undefined;\n`, to: `` },
  { id: "F5", file: ONCE, tests: ONCE_TESTS,
    guard: "…and a throw RELEASES the lock, so a failed save does not wedge the button forever",
    from: `    } finally {\n      busy = false;\n    }`, to: `    } finally {\n    }\n    busy = false;` },
  { id: "F6", file: ONCE, tests: ONCE_TESTS,
    guard: "…and the error still surfaces — a swallowed rejection is a save that failed silently",
    from: `      return await fn(...args);`, to: `      try { return await fn(...args); } catch { return undefined; }` },
  { id: "F8", file: GATE, tests: GATE_TESTS,
    guard: "NO LOCATIONS IS UNKNOWN, NOT ZERO — summing over an empty set returns a confident { total: 0 }",
    from: `  return Array.isArray(locationIds) && locationIds.length > 0;`,
    to: `  return true;` },
  { id: "F9", file: PANEL, tests: PANEL_TESTS,
    guard: "…and the panel says so rather than sitting on \"counting…\" for a read it never issued",
    from: `    : !knowable ? "units unknown — no locations to count"`, to: `    : false ? ""` },
  { id: "F10", file: MATCH, tests: TESTS,
    guard: "A THREE-BLOCK JOIN IS FENCED BY SHAPE — otherwise it mints a code out of unrelated blocks (2024-05-01 → 202405)",
    from: `      if (isKnownStyleCodeFormat(stem) && !codeStems.includes(stem)) codeStems.push(stem);`,
    to: `      if (isCodeToken(stem) && !codeStems.includes(stem)) codeStems.push(stem);` },
  { id: "F11", file: MATCH, tests: FUZZ_TESTS,
    guard: "A STEM STANDS ON ITS OWN SHAPE — sharing the code's gate threw away every stem whose joined form was not code-shaped",
    from: `    if (isCodeToken(bare) && !codes.includes(bare)) codes.push(bare);`,
    to: `    if (!isCodeToken(bare)) continue;\n    if (!codes.includes(bare)) codes.push(bare);` },
  { id: "F12", file: GATE, tests: GATE_TESTS,
    guard: "THE CALLER'S EMPTY-SET GUARD IS PROVEN — it used to live inline in a save handler no test rendered",
    from: `  if (!totalsKnowable(locationIds) || typeof readTotals !== "function") return out;`,
    to: `  if (typeof readTotals !== "function") return out;` },
  { id: "F13", file: GATE, tests: GATE_TESTS,
    guard: "…and a failed read is null, not a thrown save",
    from: `    try { out[r.product.id] = await readTotals(r.product.id, locationIds); }\n    catch { out[r.product.id] = null; }`,
    to: `    out[r.product.id] = await readTotals(r.product.id, locationIds);` },
  { id: "F14", file: FUZZ, tests: FUZZ_TESTS,
    guard: "THE FUZZ ASSERTS ITS OWN COVERAGE — a generator that drifts until it exercises nothing is CAUGHT, not passed",
    from: `  const sep = pick(r, "-/_.");`, to: `  const sep = "";` },
  { id: "F16", file: GATE, tests: GATE_TESTS,
    guard: "THE TOTALS READ IS BOUNDED — unbounded, a dead network is a Save button that looks live and does nothing, forever",
    from: `  await Promise.race([reads, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);`,
    to: `  await reads;` },
  { id: "F17", file: GATE, tests: GATE_TESTS,
    guard: "…and whatever DID land before the bound is still used — a slow location does not blank the others",
    from: `  await Promise.race([reads, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);`,
    to: `  await Promise.race([reads, new Promise((resolve) => setTimeout(() => { for (const k of Object.keys(out)) delete out[k]; resolve(); }, timeoutMs))]);` },
  { id: "F18", file: GATE, tests: GATE_TESTS,
    guard: "A HANDOFF GOES STALE — an abandoned one must not spring a filled receive form on someone hours later",
    from: `  return age <= PREFILL_MAX_AGE_MS;`, to: `  return true;` },
  { id: "F19", file: GATE, tests: GATE_TESTS,
    guard: "…and a backwards clock keeps the operator's work rather than discarding it",
    from: `  const age = nowMs - prefill.at;`, to: `  const age = Math.abs(nowMs - prefill.at);` },
  { id: "F15", file: PANEL, tests: PANEL_TESTS,
    guard: "AN ARRIVING TOTAL REACHES THE SCREEN — the re-render is what turns \"counting…\" into a number",
    from: `    loadTotals(rows.map((r) => r.product.id), locationIds, () => setTick((n) => n + 1));`,
    to: `    loadTotals(rows.map((r) => r.product.id), locationIds, () => {});` },
  { id: "F7", file: PANEL, tests: PANEL_TESTS,
    guard: "CREATE-NEW CANNOT BE SWITCHED OFF — it renders in the resolved banner as well as the picker",
    from: `        {createNew}\n      </div>\n    );\n  }`, to: `      </div>\n    );\n  }` },
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
try {
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
  // ── A FAILED RESTORE IS A HARNESS FAILURE, NOT A SHRUG ────────────────────
  // Swallowing it leaves the file mutated, and the NEXT mutation then captures
  // that mutated file as its baseline — so every guard after it is measured
  // against broken code while the run still prints a confident number.
  //
  // IT THROWS, IT DOES NOT process.exit. Two reasons, both learned the hard way:
  //   • restore() is called TWICE per mutation — once inline, once in the
  //     `finally`. Exiting from the inline call skips the `finally`, and with it
  //     the second attempt that a TRANSIENT failure (EAGAIN, an editor holding
  //     the file) would almost certainly have survived. That made the "fix"
  //     strictly worse than the swallow it replaced.
  //   • process.exit does not flush a piped stderr, so in CI or under `> log`
  //     the three lines naming the file — the entire value of the change — can
  //     be the thing that gets lost.
  // A throw keeps the retry, and Node prints and flushes it on the way out.
  //
  // "Still mutated" is deliberately not claimed: writeFileSync truncates before
  // it writes, so a mid-write failure can leave the file EMPTY rather than
  // mutated, and someone hunting for a diff in a zero-byte file wastes the time
  // this message exists to save. (Adversarial delta review, PR #594.)
  const restore = () => {
    try {
      writeFileSync(m.file, original);
    } catch (err) {
      console.error(`\n  ✗ RESTORE FAILED for ${m.file} after mutation ${m.id}`);
      console.error(`    ${String((err && err.message) || err)}`);
      console.error(`    That file is NOT the committed version — it may be mutated or truncated.`);
      console.error(`    Restore it from git (git checkout -- ${m.file}) before running anything else.`);
      // Tagged so the top-level handler can exit 3 — "the harness broke and a
      // file may be damaged" must stay distinguishable from exit 1, "a guard is
      // not proven". An uncaught throw exits 1 and the two become the same
      // number to CI. (Adversarial delta review, PR #594.)
      err.__restoreFailed = true;
      throw err;
    }
  };
  // A restore failure during Ctrl-C must still exit 130 — the message is already
  // on stderr, and throwing out of a signal handler would replace the exit code
  // with an unhandled-rejection crash.
  const onSignal = () => { try { restore(); } catch { /* already reported */ } process.exit(130); };
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

} catch (err) {
  if (err && err.__restoreFailed) process.exit(3);
  throw err;
}

const unproven = results.filter((r) => !r.proven);
console.log(`\n${results.length - unproven.length}/${results.length} guards proven`);
if (unproven.length) {
  console.log("NOT PROVEN:");
  for (const r of unproven) console.log(`  ${r.id}  mutated:${r.mutated} restored:${r.restored}  ${r.guard}`);
  process.exit(1);
}
