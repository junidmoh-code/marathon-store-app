// ─── MUTATION PROOF — the live alternatives pool (2026-10-09) ────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore, prove it
// PASSES. Driver copied unchanged from scripts/mutation-proof-alternatives.mjs
// (ERROR ≠ FAIL, unique anchors, signal-safe restore, clean-tree preflight);
// the one addition is a node --test runner for the functions-side guards.
//
// AT STAKE:
//   L1–L8   the sheet is never empty while something is sellable in the size,
//           and the tiers keep their order (Junid's Ducks of a Feather report);
//   L9–L12  model families group the spellings; profiles cannot carry an
//           illegal value; a product with no stored profile is still ranked;
//   L13–L14 telemetry records the tier; the empty sheet tells the truth;
//   E1–E5   the trigger never re-bills, respects the cap, the claim and the
//           switch, and ignores its own write.
//
// Run IN A SEPARATE WORKTREE (a reviewer reading a mutated file reports a fake
// bug), with the tree committed:  node scripts/mutation-proof-alternatives-live-pool.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Nothing a test does may reach the live database.
process.env.FIREBASE_DATABASE_EMULATOR_HOST = "127.0.0.1:9";

const ALT = "src/components/stock/alternativesCore.js";
const FAM = "src/utils/modelFamily.js";
const PROF = "src/utils/altProfile.js";
const TELE = "src/components/stock/alternativesTelemetry.js";
const STRIP = "src/components/stock/AlternativesStrip.jsx";
const ENRICH = "functions/lib/alt-enrich.mjs";

const SUITE = [
  "src/components/stock/alternativesLivePool.test.js",
  "src/components/stock/alternativesDucks.test.js",
  "src/utils/modelFamily.test.js",
  "src/components/stock/alternativesCore.test.js",
  "src/components/stock/alternativesFuzz.test.js",
  "src/components/stock/alternativesTelemetry.test.js",
  "src/components/stock/AlternativesStrip.render.test.jsx",
];
const NODE_SUITE = ["test/alt-enrich.test.mjs"];

const B = "behavioural";
const MUTATIONS = [
  { id: "L1", kind: B, file: ALT, guard: "THE NEVER-EMPTY GUARD: the pool is every candidate, not the twelve stored neighbours",
    from: "const list = Array.isArray(candidates) ? candidates : parsed.map((n) => resolveProduct(n.pid));",
    to: "const list = parsed.map((n) => resolveProduct(n.pid));" },
  { id: "L2", kind: B, file: ALT, guard: "every row is sellable in the requested size",
    from: "    if (!sizeAvailable(product, matchedSize)) continue;\n", to: "" },
  { id: "L3", kind: B, file: ALT, guard: "tiers fill in order a → b → c → d",
    from: "scored.sort((x, y) => (TIER_ORDER[x.tier] - TIER_ORDER[y.tier])", to: "scored.sort((x, y) => (0)" },
  { id: "L4", kind: B, file: ALT, guard: "tier a = same model family",
    from: '  if (src.fam && src.fam === c.fam) return "a";\n', to: "" },
  { id: "L5", kind: B, file: ALT, guard: "inside the family the closest colourway leads",
    from: "(x.tier === \"a\" ? (y.cw - x.cw) || (y.sim - x.sim) :", to: "(x.tier === \"a\" ? (y.sim - x.sim) :" },
  { id: "L6", kind: B, file: ALT, guard: "the refused shoe is never offered as its own alternative",
    from: "const seen = new Set(sourceId ? [sourceId] : []);", to: "const seen = new Set();" },
  { id: "L7", kind: B, file: ALT, guard: "fills to eight when eight exist",
    from: "rows = scored.slice(0, limit)", to: "rows = scored.slice(0, 1)" },
  { id: "L8", kind: B, file: ALT, guard: "sizes compared by shoeSize key, never raw label",
    from: "  const i = keys.indexOf(wantKey);", to: "  const i = labels.map(String).indexOf(String(wantKey));" },
  { id: "L9", kind: B, file: FAM, guard: "every Air Force 1 spelling is one family",
    from: 'R("nike-air-force-1", "Air Force 1",', to: 'R("nike-air-force-x", "Air Force 1",' },
  { id: "L10", kind: B, file: FAM, guard: "the specific model wins over the one it contains (Court Vision named 'Airforce')",
    from: "/ court vision /", to: "/ court visionXX /" },
  { id: "L11", kind: B, file: PROF, guard: "a profile slot outside its vocabulary is dropped, never stored as-is",
    from: '    out[k] = vocab.includes(v) ? v : "";', to: "    out[k] = v;" },
  { id: "L12", kind: B, file: PROF, guard: "a product with no stored profile is ranked from its name",
    from: "const base = stored || deriveAltProfile(product, { family: deriveFamilyHook(product) });",
    to: "const base = stored || deriveAltProfile(product, {});" },
  { id: "L13", kind: B, file: TELE, guard: "telemetry records the tier each row came from",
    from: '    shownTiers: result.rows.map((r) => r.tier || ""),\n', to: "" },
  { id: "L14", kind: B, file: STRIP, guard: "the empty sheet says nothing in the size is available — not 'no similar styles'",
    from: "Nothing in size {formatSize(requestedSize)} is available anywhere right now",
    to: "No similar styles in size {formatSize(requestedSize)}" },
  { id: "L15", kind: B, file: ALT, guard: "a fallback family (brand + first word) never claims 'Same model'",
    from: 'const isModelFamily = (p) => !!p.fam && p.famSrc !== "fallback";', to: "const isModelFamily = (p) => !!p.fam;" },
  { id: "E6", kind: B, file: ENRICH, guard: "a product deleted between the check and the write is not resurrected",
    from: "    await db.ref(`products/${pid}/${ALT_PROFILE_FIELD}`).remove();\n", to: "" },
  { id: "E7", kind: B, file: ENRICH, guard: "a rotated download token does not re-bill vision",
    from: '  return String(url || "").trim().split("?")[0];', to: '  return String(url || "").trim();' },
  { id: "E8", kind: B, file: ENRICH, guard: "the refused-answer retry takes its own unit of the daily cap",
    from: "        if (!parsed.ok && (await takeBudget(db, t, cap))) {", to: "        if (!parsed.ok) {" },
  { id: "E9", kind: B, file: ENRICH, guard: "failures count their attempts (the sweep gives up at the cap)",
    from: "        const n = (prev && prev.photo === photo ? Number(prev.n) || 1 : 0) + 1;", to: "        const n = 1;" },
  { id: "E10", kind: B, file: ENRICH, guard: "a failure no longer needed is cleared (the sweep does not starve)",
    from: '  if (visionOutcome === "not-needed" && allowVision) {', to: "  if (false) {" },
  { id: "E1", kind: B, file: ENRICH, guard: "a current record is never re-read (no re-billing)",
    from: "  return !!node.photo && photoIdentity(node.photo) !== photoIdentity(photo);", to: "  return true;" },
  { id: "E2", kind: B, file: ENRICH, guard: "the daily vision cap holds",
    from: "    return n >= cap ? undefined : n + 1;", to: "    return n + 1;" },
  { id: "E3", kind: B, file: ENRICH, guard: "a fresh claim stops a second paid read",
    from: "    if (cur && Number(cur.at) > now - CLAIM_MS && cur.photo === photo) return undefined;\n", to: "" },
  { id: "E4", kind: B, file: ENRICH, guard: "the autoEnrich switch stops vision",
    from: '    if (!on) visionOutcome = "switched-off";', to: '    if (false) visionOutcome = "switched-off";' },
  { id: "E5", kind: B, file: ENRICH, guard: "the trigger's own altProfile write is a no-op (no loop)",
    from: '"styleCodeNormalised", "labelModelName", "mergedInto", "altRefreshAt",',
    to: '"styleCodeNormalised", "labelModelName", "mergedInto", "altRefreshAt", "altProfile",' },
];

function runNode(files) {
  try {
    execFileSync("node", ["--test", ...files], { cwd: "functions", stdio: "pipe", env: process.env, maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/^# fail [1-9]/m.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}
const run = (m) => (m.file === ENRICH ? runNode(NODE_SUITE) : runVitest(SUITE));

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|Failed to (load|parse)/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 120)})`;
    }
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
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
  // An uncaught throw outside the try would otherwise leave the MUTATED file on
  // disk: the next run fails its clean-tree preflight, and a careless commit
  // ships the bug.
  const onCrash = (e) => { restore(); console.error("restored after crash:", e); process.exit(3); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = run(m);
    restore();
    restored = run(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("uncaughtException", onCrash);
    process.removeListener("unhandledRejection", onCrash);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  const tag = m.kind === "behavioural" ? "behavioural" : "source-pin";
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  [${tag}]  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
const beh = results.filter((r) => r.kind === "behavioural");
const pin = results.filter((r) => r.kind === "source-pin");
console.log(`\n${results.length - bad.length}/${results.length} guards proven — ` +
  `${beh.filter((r) => r.proven).length} BEHAVIOURAL (a unit test ran the mutated code and got a wrong answer) ` +
  `+ ${pin.filter((r) => r.proven).length} SOURCE PINS (the mutation edits a pinned line, so it fails its own pin — ` +
  `this proves the wiring has not moved, NOT that the screen behaves).`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
