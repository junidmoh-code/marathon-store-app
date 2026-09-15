// ─── MUTATION PROOF — the policy category key + the footwear coverage buckets ─
//
// For each guard: reintroduce the hole, prove the suite FAILS, restore the
// file, prove it PASSES. A green test proves nothing on its own — it has to
// be watched breaking when the property it claims to hold is broken on
// purpose. Shapes are varied (deletion, weakening, widening, rename), because
// a test can be sensitive to one and blind to another.
//
//   M-KEY      the legacy-sneaker rule deleted from policyCategoryKey — the
//              2026-09-15 defect put back: keyless Footwear+Sneakers arms nothing
//   M-LEAF     the rule WIDENED to the whole Footwear top — keyless boots and
//              soccer boots would silently arm as sneakers
//   M-RAW      categoryPolicyEntry reads the raw field again (the helper exists
//              but is not used) — the engine drifts from the browser mirror
//   M-MIRROR   the browser mirror (seatingCore) reads the raw field — the
//              differential fuzz must catch a mirror that lags the engine
//   M-COVER    unarmedFootwear never lists anything — the silent state again
//   M-ROW      an explicit row on a size no longer counts as "a human ruled"
//              — every switched-off size is reported as a hole
//   M-SIZE     the per-size judgement collapsed back to per-product: one
//              governed size vouches for every stocked size (the gap the
//              architect review found)
//   M-SCOPE    the footwear-destination scope dropped — shops are scanned
//   M-ORDER    unorderableFootwear ignores hub cells — every shoe with units
//              anywhere is "seated nowhere"
//   M-DEAD     unorderableFootwear lists deactivated lines
//   M-HEALTH   the Health card reads a key the scan does not write — a green 0
//              forever, the exact failure the wiring test exists to catch
//
// Same discipline as scripts/mutation-proof-hub1-scope-gate.mjs: ERROR is not
// FAIL, anchors must be unique, restore is signal-safe, tree must be clean
// (requireCleanTree — restore is from bytes, never through git).
//
// Run: node scripts/mutation-proof-policy-coverage.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "./lib/mutationPreflight.mjs";

const ENGINE = "functions/lib/refill-engine.cjs";
const MIRROR = "src/components/stock/seatingCore.js";
const HEALTH = "src/components/stock/HealthView.jsx";
const KEY_TESTS = ["test/policy-category-key.test.cjs"];
const FUZZ = ["src/components/stock/seatingCore.test.js"];
const WIRING = ["src/components/stock/healthFootwearCoverage.test.js"];

const MUTATIONS = [
  {
    id: "M-KEY", file: ENGINE,
    guard: "a keyless Footwear+Sneakers record resolves the sneakers policy",
    from: `  if (product && product.category === "Footwear" && product.subcategory === "Sneakers") return "sneakers";`,
    to: ``,
    nodeTests: KEY_TESTS,
  },
  {
    id: "M-LEAF", file: ENGINE,
    guard: "the rule is the Sneakers LEAF only — the whole Footwear top must not fold in",
    from: `  if (product && product.category === "Footwear" && product.subcategory === "Sneakers") return "sneakers";`,
    to: `  if (product && product.category === "Footwear") return "sneakers";`,
    nodeTests: KEY_TESTS,
  },
  {
    id: "M-RAW", file: ENGINE,
    guard: "categoryPolicyEntry resolves through the helper, not the raw field",
    from: `  const key = policyCategoryKey(products?.[pid]);
  if (typeof key !== "string" || !key) return null;`,
    to: `  const key = products?.[pid]?.categoryKey;
  if (typeof key !== "string" || !key) return null;`,
    nodeTests: KEY_TESTS, vitest: FUZZ,
  },
  {
    id: "M-MIRROR", file: MIRROR,
    guard: "the browser mirror applies the same rule — the differential fuzz holds the two together",
    from: `  const key = effectiveCategoryKey(products?.[pid]);`,
    to: `  const key = products?.[pid]?.categoryKey;`,
    vitest: FUZZ,
  },
  {
    id: "M-COVER", file: ENGINE,
    guard: "unarmedFootwear actually lists a stocked, ungoverned shoe",
    from: `      if (!holes.length) continue;
      holes.sort((x, y) => y.units - x.units);`,
    to: `      if (!holes.length || holes.length) continue;
      holes.sort((x, y) => y.units - x.units);`,
    nodeTests: KEY_TESTS, vitest: WIRING,
  },
  {
    id: "M-ROW", file: ENGINE,
    guard: "an explicit row (0 included) is a human decision, not a blind spot",
    from: `        if (row && typeof row.target === "number") continue;      // a human ruled on this size — 0 included`,
    to: ``,
    nodeTests: KEY_TESTS,
  },
  {
    id: "M-SIZE", file: ENGINE,
    guard: "judged per stocked size — a governed size never vouches for an unarmed one",
    from: `        if (t && (t.target > 0 || t.source === "category_policy")) continue;
        const reason = !key ? "no_category_key"`,
    to: `        if (t && (t.target > 0 || t.source === "category_policy")) continue;
        if (productSizes(products, pid).some((s) => { const g = resolveTarget(ctx, loc, pid, s); return !!g && (g.target > 0 || g.source === "category_policy"); })) continue;
        const reason = !key ? "no_category_key"`,
    nodeTests: KEY_TESTS,
  },
  {
    id: "M-SCOPE", file: ENGINE,
    guard: "scope is config-driven: only destinations with a footwear leg are scanned",
    from: `  const footwearDests = dests.filter((d) => !!config?.footwearRunByLocation?.[d]
    || [...FOOTWEAR_GROUP_KEYS].some((k) => !!locationPolicyFor(config, k, d)));`,
    to: `  const footwearDests = dests;`,
    nodeTests: KEY_TESTS,
  },
  {
    id: "M-ORDER", file: ENGINE,
    guard: "a hub cell — even at zero — means the grid can see the product; it is not 'seated nowhere'",
    from: `    if (GATED_HUBS.some((h) => storeCarries(stock, h, pid))) continue;   // a hub cell exists — the grid can see it`,
    to: ``,
    nodeTests: KEY_TESTS,
  },
  {
    id: "M-DEAD", file: ENGINE,
    guard: "a deactivated line is not listed as unorderable",
    from: `    if (!isFootwear(p) || (p.productType || "sneaker") === "clothing" || isDeactivated(p)) continue;`,
    to: `    if (!isFootwear(p) || (p.productType || "sneaker") === "clothing") continue;`,
    nodeTests: KEY_TESTS,
  },
  {
    id: "M-HEALTH", file: HEALTH,
    guard: "the Health card reads exactly the key the scan writes",
    from: `<StatCard label="Unarmed Footwear" value={count("unarmedFootwear")}`,
    to: `<StatCard label="Unarmed Footwear" value={count("unarmedShoes")}`,
    vitest: WIRING,
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
function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/SyntaxError|Failed to resolve import|Cannot find module/.test(out) && !/Tests\s+\d+ failed/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 140)})`;
    }
    if (/Tests\s+\d+ failed|Test Files\s+\d+ failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}
// Both runners, combined: FAIL if either fails, PASS only if every one passes.
function run(m) {
  const parts = [];
  if (m.nodeTests) parts.push(runNodeTests(m.nodeTests));
  if (m.vitest) parts.push(runVitest(m.vitest));
  if (parts.some((p) => p.startsWith("ERROR"))) return parts.find((p) => p.startsWith("ERROR"));
  return parts.includes("FAIL") ? "FAIL" : "PASS";
}

requireCleanTree([...new Set(MUTATIONS.map((m) => m.file))]);

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-", proven: false });
    console.log(`${m.id.padEnd(10)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = run(m);
    restore();
    restored = run(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id.padEnd(10)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}
