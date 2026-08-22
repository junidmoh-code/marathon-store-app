// ─── ENGINE POLICY, THIRD PASS — READ-ONLY CENSUS ─────────────────────────────
//
// WRITES NOTHING. Not a config key, not a group, not a /stock_targets row, not
// an audit entry. Output is JSON under var/ and text on stdout.
//
// ── WHAT IT ANSWERS, AND WHY EACH ONE IS NEEDED BEFORE ANY CODE CHANGES ──────
//
//   1. THE SIZE RUN OF EVERY CATEGORY, derived from live data — what the
//      products declare, what /stock cells exist, what /stock_targets rows
//      exist — through the SAME sizeRunForCategory the card and the server use.
//      A category whose run cannot be derived is a STOP for the per-size
//      editor, and the only way to know is to ask the live data.
//
//   2. THE SNEAKERS GROUP'S MEMBERS AND THEIR SIZE RUNS, plus the UNION the
//      group's per-size editor would offer and which members carry each size.
//      The brief's stop condition is a union above 20 sizes; that number is
//      measured here rather than assumed.
//
//   3. A CLOTHING RESOLUTION SNAPSHOT. Every clothing cell at every destination,
//      resolved through the engine's own resolveTarget, hashed. This branch must
//      not move ONE of them. The snapshot is written in full to var/ and its
//      hash is printed; re-running the script on the branch and comparing the
//      hash is the proof, and functions/test/clothing-resolution-frozen.test.cjs
//      replays a fixture cut from it on every test run.
//
//   4. OLD-ROW COUNTS — the explicit /stock_targets rows per category, which
//      the screen surfaces as an "N old rows" chip. Nothing here deletes one.
//
// Usage:
//   node scripts/census-engine-policy-sizes.mjs
//   OUT=var/x.json FIXTURE=functions/test/fixtures/clothing-resolution.json \
//     node scripts/census-engine-policy-sizes.mjs

import { createRequire } from "module";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { sizeRunForCategory, bySizeRank } = require("../functions/lib/policy-groups.cjs");
const { resolveTarget, encodeSizeKey, isClothing } = require("../functions/lib/refill-engine.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = process.env.OUT || join(ROOT, "var", `engine-policy-sizes-census-${STAMP}.json`);
const FIXTURE = process.env.FIXTURE || "";

const GROUP_KEY = process.env.GROUP_KEY || "footwear-all";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const small = (p) => db.ref(p).once("value").then((s) => s.val() || {});
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

// Stable stringify — key order must not decide whether two snapshots match.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

(async () => {
  console.log(`\n${"═".repeat(96)}`);
  console.log("  ENGINE POLICY, THIRD PASS — CENSUS                       WRITES NOTHING TO RTDB");
  console.log(`${"═".repeat(96)}`);

  const [config, taxonomy, locationsNode] = await Promise.all([
    small("config/refillEngine"), small("settings/productTaxonomy"), small("locations"),
  ]);
  const cats = taxonomy.cats && typeof taxonomy.cats === "object" ? taxonomy.cats : {};
  const groups = config.policyGroups && typeof config.policyGroups === "object" ? config.policyGroups : {};
  const destLocs = Object.keys(config.mode || {});
  const allLocs = Object.keys(locationsNode);

  console.log(`  cats ${Object.keys(cats).length}   destinations ${destLocs.join(", ")}   cap ${config.maxIntentsPerRun}`);
  console.log(`  categoryPolicy : ${Object.keys(config.categoryPolicy || {}).sort().join(", ") || "(none)"}`);
  console.log(`  policyGroups   : ${Object.keys(groups).sort().join(", ") || "(none)"}`);
  console.log(`  footwear switch: ${JSON.stringify(config.footwearTargets ?? null)} ${config.footwearTargets ? "" : "(absent = OFF)"}`);

  console.log("\n  reading (paged)…");
  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const stock = {}, targets = {};
  for (const loc of allLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 500 });
  for (const loc of allLocs) targets[loc] = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
  console.log(`  products ${Object.keys(products).length}   locations ${allLocs.length}`);

  // ── 1. SIZE RUN PER CATEGORY ───────────────────────────────────────────────
  const catKeys = [...new Set([...Object.keys(cats), ...Object.keys(config.categoryPolicy || {})])].sort();
  const runs = {};
  for (const key of catKeys) {
    runs[key] = sizeRunForCategory({ products, stock, targets, taxonomy, categoryKey: key, locations: allLocs });
  }

  // ── 4. OLD ROWS PER CATEGORY ───────────────────────────────────────────────
  const rowsByCategory = {};
  for (const loc of allLocs) {
    for (const [pid, bySize] of Object.entries(targets[loc] || {})) {
      const key = products[pid]?.categoryKey;
      if (!key) continue;
      const r = rowsByCategory[key] || (rowsByCategory[key] = { cells: 0, products: new Set() });
      r.cells += Object.keys(bySize || {}).length;
      r.products.add(pid);
    }
  }

  console.log(`\n  ── SIZE RUNS, DERIVED FROM LIVE DATA ${"─".repeat(57)}`);
  console.log(`  ${pad("category", 20)}${rpad("prods", 6)}  ${pad("run", 40)}${rpad("extra", 6)}${rpad("rows", 7)}`);
  for (const key of catKeys) {
    const r = runs[key];
    if (!r.products && !rowsByCategory[key]) continue;
    console.log(`  ${pad(key, 20)}${rpad(r.products, 6)}  ${pad(r.oneSize ? "(one size)" : (r.sizes.join(" ") || "(none derivable)"), 40)}${rpad(r.extra.length, 6)}${rpad(rowsByCategory[key]?.cells || 0, 7)}`);
  }

  // ── 2. THE GROUP ───────────────────────────────────────────────────────────
  const group = groups[GROUP_KEY] || null;
  const members = group?.memberCategoryKeys || [];
  const carriedBy = {};
  for (const m of members) for (const s of (runs[m]?.sizes || [])) (carriedBy[s] || (carriedBy[s] = [])).push(m);
  // Sorted by SIZE RANK, the same order the editor draws them in — letters
  // first, then numerics ascending. Alphabetical would print 10 11 12 13 3 4,
  // which reads as a fault in the data rather than in the sort.
  const union = Object.keys(carriedBy).sort(bySizeRank);
  const partial = union.filter((s) => carriedBy[s].length < members.length);
  console.log(`\n  ── GROUP "${GROUP_KEY}" ${"─".repeat(70)}`);
  console.log(`  label "${group?.label ?? "(absent)"}"   armed ${group?.armed}   members ${members.length}`);
  for (const m of members) {
    const r = runs[m] || { sizes: [], products: 0 };
    console.log(`    ${pad(m, 18)}${rpad(r.products, 5)} products   ${r.sizes.join(" ") || "(none)"}`);
  }
  console.log(`  UNION (${union.length} sizes): ${union.join(" ")}`);
  console.log(`  carried by only SOME members (${partial.length}): ${partial.map((s) => `${s}[${carriedBy[s].length}/${members.length}]`).join(" ") || "(none)"}`);
  if (union.length > 20) console.log(`  *** STOP CONDITION: the union exceeds 20 sizes ***`);

  // ── 3. CLOTHING RESOLUTION SNAPSHOT ────────────────────────────────────────
  // Every cell of every clothing product at every DESTINATION, resolved through
  // the engine's own resolveTarget. Destinations only: those are the only places
  // a refill can land, so a cell anywhere else has no resolution to freeze.
  const ctx = { targets, config, products, stock };
  const clothingPids = Object.keys(products).filter((pid) => isClothing(products[pid]));
  const resolution = {};
  let cells = 0;
  for (const dest of destLocs) {
    for (const pid of clothingPids) {
      const sizes = Array.isArray(products[pid]?.sizes) ? products[pid].sizes : [];
      const cellKeys = Object.keys(stock[dest]?.[pid] || {});
      const seen = new Set();
      for (const raw of [...sizes, ...cellKeys]) {
        const k = encodeSizeKey(raw);
        if (seen.has(k)) continue;
        seen.add(k);
        // resolveTarget takes the DISPLAY size (it encodes internally), so the
        // cell keys are decoded back the one way that is reversible.
        const size = String(raw);
        const t = resolveTarget(ctx, dest, pid, size);
        if (!t) continue;
        resolution[`${dest}|${pid}|${k}`] = { target: t.target, minQty: t.minQty, reorderPoint: t.reorderPoint, source: t.source };
        cells += 1;
      }
    }
  }
  const resolutionHash = sha(canonical(resolution));
  console.log(`\n  ── CLOTHING RESOLUTION SNAPSHOT ${"─".repeat(62)}`);
  console.log(`  clothing products ${clothingPids.length}   resolved cells ${cells}`);
  console.log(`  SHA-256 ${resolutionHash}`);
  const bySource = {};
  for (const v of Object.values(resolution)) bySource[v.source] = (bySource[v.source] || 0) + 1;
  console.log(`  by source: ${Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join("   ")}`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(),
    config: { mode: config.mode, routes: config.routes, cap: config.maxIntentsPerRun,
      categoryPolicy: config.categoryPolicy ?? null, policyGroups: groups, footwearTargets: config.footwearTargets ?? null },
    sizeRuns: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, {
      sizes: r.sizes, extra: r.extra, oneSize: r.oneSize, empty: r.empty, products: r.products, sources: r.sources }])),
    group: { key: GROUP_KEY, label: group?.label ?? null, armed: group?.armed ?? null, members,
      union, partial, carriedBy },
    oldRows: Object.fromEntries(Object.entries(rowsByCategory).map(([k, v]) => [k, { cells: v.cells, products: v.products.size }])),
    clothing: { products: clothingPids.length, cells, hash: resolutionHash, bySource, resolution },
  }, null, 1));
  console.log(`\n  written: ${OUT}`);

  // ── THE REPLAYABLE FIXTURE ─────────────────────────────────────────────────
  // The full snapshot is too large to sit in the test suite, and a test that
  // needs the live database is not a test. FIXTURE writes a self-contained slice
  // — the config, and the products / stock / targets for a bounded sample of
  // clothing products — WITH the resolution those inputs produced. The test
  // replays the inputs through the engine and asserts the same answers.
  if (FIXTURE) {
    const sample = [];
    const perCategory = {};
    for (const pid of clothingPids.sort()) {
      const key = products[pid]?.categoryKey || "(none)";
      perCategory[key] = (perCategory[key] || 0) + 1;
      if (perCategory[key] <= 6) sample.push(pid);
    }
    const fx = { at: new Date().toISOString(), note: "cut by scripts/census-engine-policy-sizes.mjs — inputs and the resolution they produced",
      // EVERY CONFIG KEY resolveTarget READS, named from the engine rather than
      // from memory. A key left out here does not fail loudly — it silently
      // changes the answer, which is how the first cut of this fixture recorded
      // "subcategory_default" and replayed as "default".
      config: {
        mode: config.mode, routes: config.routes,
        categoryPolicy: config.categoryPolicy ?? null, policyGroups: groups,
        footwearTargets: config.footwearTargets ?? null,
        footwearRunByLocation: config.footwearRunByLocation ?? null,
        footwearReorderPoint: config.footwearReorderPoint ?? null,
        ruleBasedTargets: config.ruleBasedTargets ?? null,
        defaultRunByStore: config.defaultRunByStore ?? null,
        subcategoryRunByLocation: config.subcategoryRunByLocation ?? null,
        maxIntentsPerRun: config.maxIntentsPerRun ?? null,
        maxUnitsPerIntent: config.maxUnitsPerIntent ?? null,
      },
      products: {}, stock: {}, targets: {}, expected: {} };
    for (const pid of sample) fx.products[pid] = products[pid];
    for (const dest of destLocs) {
      fx.stock[dest] = {}; fx.targets[dest] = {};
      for (const pid of sample) {
        if (stock[dest]?.[pid]) fx.stock[dest][pid] = stock[dest][pid];
        if (targets[dest]?.[pid]) fx.targets[dest][pid] = targets[dest][pid];
      }
    }
    // sizeUnitsAnywhere reads every location, so the fixture carries them all.
    for (const loc of allLocs) {
      if (fx.stock[loc]) continue;
      fx.stock[loc] = {};
      for (const pid of sample) if (stock[loc]?.[pid]) fx.stock[loc][pid] = stock[loc][pid];
    }
    for (const [k, v] of Object.entries(resolution)) {
      const pid = k.split("|")[1];
      if (sample.includes(pid)) fx.expected[k] = v;
    }
    mkdirSync(dirname(join(ROOT, FIXTURE)), { recursive: true });
    writeFileSync(join(ROOT, FIXTURE), JSON.stringify(fx, null, 1));
    console.log(`  fixture: ${FIXTURE}   ${sample.length} products   ${Object.keys(fx.expected).length} resolved cells`);
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
