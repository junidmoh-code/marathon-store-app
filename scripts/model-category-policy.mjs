// ─── ENGINE CATEGORY POLICY — READ-ONLY CENSUS AND DAY-ONE MODEL ─────────────
//
// WRITES NOTHING TO RTDB. Ever. Not a config key, not a target row, not an
// audit entry. The only thing it puts anywhere is JSON under var/, which is
// inert: arming is done by the owner through the Engine Policy card (which
// calls setCategoryPolicy), never by this file.
//
// ── WHAT IT ANSWERS ──────────────────────────────────────────────────────────
// For EVERY category key — the live map's keys plus every categoryKey in
// /settings/productTaxonomy, so an unarmed category is as visible as an armed
// one:
//   • how many products carry it
//   • units by location, and which locations actually CARRY it (cell presence)
//   • how many of its cells resolve the MAP
//   • how many are OVERRIDDEN by an explicit /stock_targets row, listed
//   • whether it is armed at all
//
// Then it models a proposed change and reports day-one requests and units per
// leg against Central's on hand and the 75-intent cap.
//
// ── WHY THERE ARE TWO DAY-ONE NUMBERS ────────────────────────────────────────
// The model comes from functions/lib/category-policy.cjs — the SAME function
// the card's preview panel calls, so what the owner sees before saving and what
// this script prints are one implementation. It is a deliberate UPPER BOUND: it
// walks the deficit arithmetic and the three gates that decide most outcomes
// (in flight, nothing anywhere, source empty) but not the scan's remaining
// suppression passes — confirmed-out, reject streaks, retry cooldown, the
// recount park, the global throttle — every one of which can only remove a
// request.
//
// So this script ALSO runs the real computeRefillPlan — the same function the
// 15-minute scan calls — over a copy of the live snapshot with the proposed
// config injected, and prints both numbers side by side. The gap between them
// is measured here rather than assumed anywhere, and it is the check that
// keeps the card's preview honest. (ENGINE=0 skips it; the heavy nodes it
// needs are then never read.)
//
// ── READS ARE PAGED ──────────────────────────────────────────────────────────
// Live bandwidth is billed. Nothing here issues a single whole-node read of a
// large map: /products, /stock/<loc>, /stock_targets/<loc>, /refill_engine/open
// and friends all go through readMapPaged, and /stock_movements is a windowed
// orderByChild("ts") query matching the scan's own 45-day slice.
//
// Usage:
//   node scripts/model-category-policy.mjs
//   CATEGORY=caps-beanies REORDER_POINT=2 node scripts/model-category-policy.mjs
//   CATEGORY=caps-beanies LOCS=marathon-pe,hub2 TARGETS=5,10 \
//     REORDER_POINT=2 node scripts/model-category-policy.mjs
//   ENGINE=0 node scripts/model-category-policy.mjs        # census only, cheap
//   OUT=var/my-model.json node scripts/model-category-policy.mjs

import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { computeRefillPlan } = require("../functions/lib/refill-engine.cjs");
const { modelCategoryPolicy, carriageForCategory, diffCategoryPolicy, defaultMinQty } =
  require("../functions/lib/category-policy.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || join(ROOT, "var", `category-policy-model-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const RUN_ENGINE = process.env.ENGINE !== "0";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const small = (p) => db.ref(p).once("value").then((s) => s.val() || {});

// ── THE PROPOSED CHANGE ──────────────────────────────────────────────────────
// Defaults to the change this build was commissioned for: caps-beanies gets a
// reorderPoint of 2 on both legs, targets untouched at 5 and 10. Every part of
// it is overridable so a different question can be answered by running it
// rather than by editing it.
const CATEGORY = process.env.CATEGORY || "caps-beanies";
const LOCS = (process.env.LOCS || "marathon-pe,hub2").split(",").map((s) => s.trim()).filter(Boolean);
const TARGET_OVERRIDES = process.env.TARGETS ? process.env.TARGETS.split(",").map((s) => Number(s.trim())) : null;
const REORDER_POINT = process.env.REORDER_POINT === undefined ? 2
  : process.env.REORDER_POINT === "" ? null : Number(process.env.REORDER_POINT);
if (TARGET_OVERRIDES && TARGET_OVERRIDES.length !== LOCS.length) {
  console.error(`TARGETS must have one entry per LOCS entry (${LOCS.length}).`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const line = (n = 92) => "─".repeat(n);

(async () => {
  console.log(`\n${"═".repeat(92)}`);
  console.log(`  ENGINE CATEGORY POLICY — CENSUS + DAY-ONE MODEL      WRITES NOTHING TO RTDB`);
  console.log(`${"═".repeat(92)}`);

  const [config, taxonomy, locationsNode] = await Promise.all([
    small("config/refillEngine"), small("settings/productTaxonomy"), small("locations"),
  ]);
  const policy = config.categoryPolicy && typeof config.categoryPolicy === "object" ? config.categoryPolicy : {};
  const cats = taxonomy.cats && typeof taxonomy.cats === "object" ? taxonomy.cats : {};
  // Stock locations only. `in_transit`, `base` and `studio` are real nodes but
  // are not destinations the engine refills to; they are still counted for
  // units so the census total reconciles against the catalogue.
  const allLocs = Object.keys(locationsNode);
  const destLocs = Object.keys(config.mode || {});

  console.log(`  live map keys : ${Object.keys(policy).sort().join(", ") || "(none)"}`);
  console.log(`  taxonomy cats : ${Object.keys(cats).length}`);
  console.log(`  destinations  : ${destLocs.map((d) => `${d}=${config.mode[d]}`).join("  ")}`);
  console.log(`  cap           : maxIntentsPerRun ${config.maxIntentsPerRun}   maxUnitsPerIntent ${config.maxUnitsPerIntent}`);

  // ── PAGED READS ────────────────────────────────────────────────────────────
  console.log(`\n  reading (paged)…`);
  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const stock = {};
  for (const loc of allLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 500 });
  const targets = {};
  for (const loc of allLocs) targets[loc] = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
  const openIndex = {};
  for (const loc of destLocs) openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`, { pageSize: 500 });
  console.log(`  products ${Object.keys(products).length}   stock locations ${allLocs.length}   target locations ${allLocs.length}`);

  // ── THE CENSUS ─────────────────────────────────────────────────────────────
  // Every key in the map ∪ every key in the taxonomy. The union is the point:
  // a category armed in the map but missing from the taxonomy is a data fault
  // worth seeing, and an unarmed taxonomy category is what the card offers a
  // "Set policy" button for.
  const keys = [...new Set([...Object.keys(policy), ...Object.keys(cats)])].sort();
  const census = [];
  for (const key of keys) {
    const cat = policy[key];
    const armedLocs = cat && typeof cat === "object" && !Array.isArray(cat)
      ? Object.keys(cat).filter((k) => k !== "perSize" && cat[k] && typeof cat[k] === "object").sort()
      : [];
    const { pids, byLocation } = carriageForCategory({ products, stock, categoryKey: key, locations: allLocs });
    // Only run the resolver where the map is actually armed — an unarmed
    // category resolves nothing through it by definition, and walking every
    // product × every location for 40 categories would be minutes of nothing.
    const model = armedLocs.length
      ? modelCategoryPolicy({
          config, products, stock, targets, openIndex, categoryKey: key,
          locations: allLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
        })
      : null;
    census.push({
      key,
      label: cats[key]?.label || key,
      inTaxonomy: !!cats[key],
      active: cats[key]?.active !== false,
      sizeMode: cats[key]?.sizeMode || (cat?.perSize ? "list" : "one"),
      perSize: cat?.perSize === true,
      armed: armedLocs.length > 0,
      armedLocations: armedLocs,
      entry: cat && typeof cat === "object" ? cat : null,
      products: pids.length,
      unitsByLocation: Object.fromEntries(Object.entries(byLocation).filter(([, v]) => v.units || v.carries)
        .map(([loc, v]) => [loc, v.units])),
      carriedAt: Object.entries(byLocation).filter(([, v]) => v.carries).map(([loc]) => loc).sort(),
      resolvesMap: model ? model.legs.reduce((n, l) => n + (l.cells - l.overrides), 0) : 0,
      overriddenCells: model ? model.legs.reduce((n, l) => n + l.overrides, 0) : 0,
      overriddenProducts: model ? model.overriddenProducts : 0,
      overrideRows: model ? model.legs.flatMap((l) => l.overrideRows.map((r) => ({ loc: l.loc, ...r }))) : [],
    });
  }

  console.log(`\n── CENSUS — every category key, armed or not ${line(48)}`);
  console.log(`  ${pad("key", 22)} ${pad("size", 5)} ${rpad("prods", 6)} ${rpad("units", 7)} ${pad("carried at", 34)} ${pad("armed", 22)} ${rpad("map", 5)} ${rpad("ovr", 4)}`);
  for (const c of census) {
    if (!c.products && !c.armed) continue;   // an empty unarmed category has nothing to say
    const units = Object.values(c.unitsByLocation).reduce((a, b) => a + b, 0);
    console.log(`  ${pad(c.key, 22)} ${pad(c.perSize ? "size" : "one", 5)} ${rpad(c.products, 6)} ${rpad(units, 7)} ${pad(c.carriedAt.join(",") || "—", 34)} ${pad(c.armed ? c.armedLocations.join(",") : "—", 22)} ${rpad(c.resolvesMap, 5)} ${rpad(c.overriddenCells, 4)}`);
  }
  const skipped = census.filter((c) => !c.products && !c.armed).length;
  if (skipped) console.log(`  (${skipped} taxonomy categories hold no products and are not armed — omitted)`);

  const armedCensus = census.filter((c) => c.armed);
  console.log(`\n  ARMED: ${armedCensus.length} of ${census.length} categories — ${armedCensus.map((c) => c.key).join(", ")}`);
  for (const c of armedCensus) {
    if (!c.overriddenCells) continue;
    console.log(`\n  ⚠ ${c.key}: ${c.overriddenCells} cells on ${c.overriddenProducts} products are OVERRIDDEN by explicit /stock_targets rows.`);
    console.log(`    An explicit row outranks the map, so editing the map does NOT reach these cells.`);
    for (const r of c.overrideRows.slice(0, 25)) {
      console.log(`      ${pad(r.loc, 13)} ${pad(r.pid, 16)} ${pad(r.size, 6)} target ${rpad(r.target, 3)} minQty ${rpad(r.minQty ?? "—", 3)} rp ${rpad(r.reorderPoint ?? "—", 3)}  ${String(r.name).slice(0, 34)}`);
    }
    if (c.overrideRows.length > 25) console.log(`      … and ${c.overrideRows.length - 25} more (full list in the JSON)`);
  }

  // ── THE PROPOSED CHANGE ────────────────────────────────────────────────────
  const before = policy[CATEGORY] && typeof policy[CATEGORY] === "object" ? policy[CATEGORY] : null;
  if (!before) {
    console.log(`\n  NOTE — "${CATEGORY}" is not armed today; the model below is for arming it from scratch.`);
  }
  const after = { ...(before || {}) };
  if (before?.perSize) after.perSize = true;
  LOCS.forEach((loc, i) => {
    const prev = before?.[loc] && typeof before[loc] === "object" ? before[loc] : null;
    const target = TARGET_OVERRIDES ? TARGET_OVERRIDES[i] : (prev?.target ?? null);
    if (target == null) {
      console.error(`\n  ${loc} has no existing target and TARGETS was not supplied — nothing to model.`);
      process.exit(1);
    }
    after[loc] = {
      target,
      minQty: prev?.minQty ?? defaultMinQty(target),
      ...(REORDER_POINT == null ? {} : { reorderPoint: REORDER_POINT }),
    };
  });

  const changes = diffCategoryPolicy(before, after);
  console.log(`\n── PROPOSED CHANGE — ${CATEGORY} ${line(92 - 22 - CATEGORY.length)}`);
  if (!changes.length) console.log(`  (no change — the proposal matches what is live)`);
  for (const ch of changes) {
    console.log(`  ${pad(ch.loc || "(category)", 16)} ${pad(ch.field, 14)} ${rpad(ch.from === null ? "absent" : String(ch.from), 8)}  ->  ${ch.to === null ? "absent" : ch.to}`);
  }

  const configAfter = { ...config, categoryPolicy: { ...policy, [CATEGORY]: after } };
  const modelBefore = modelCategoryPolicy({
    config, products, stock, targets, openIndex, categoryKey: CATEGORY,
    locations: allLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
  });
  const modelAfter = modelCategoryPolicy({
    config: configAfter, products, stock, targets, openIndex, categoryKey: CATEGORY,
    locations: allLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
  });

  const table = (m, title) => {
    console.log(`\n  ${title}`);
    console.log(`  ${pad("location", 14)} ${pad("src", 10)} ${rpad("keep", 5)} ${rpad("min", 4)} ${rpad("askAt", 6)} ${rpad("cells", 6)} ${rpad("REQ", 5)} ${rpad("units", 6)} ${rpad("silent", 7)} ${rpad("atTgt", 6)} ${rpad("flight", 7)} ${rpad("parked", 7)} ${rpad("onHand", 7)} ${rpad("ovr", 4)}`);
    for (const l of m.legs) {
      console.log(`  ${pad(l.loc, 14)} ${pad(l.source || "—", 10)} ${rpad(l.target ?? "—", 5)} ${rpad(l.minQty ?? "—", 4)} ${rpad(l.reorderPoint ?? "absent", 6)} ${rpad(l.cells, 6)} ${rpad(l.wouldRequest, 5)} ${rpad(l.unitsWanted, 6)} ${rpad(l.silent, 7)} ${rpad(l.atTarget, 6)} ${rpad(l.inFlight, 7)} ${rpad(l.parked, 7)} ${rpad(l.onHand, 7)} ${rpad(l.overrides, 4)}`);
    }
    console.log(`  ${pad("TOTAL", 14)} ${pad("", 10)} ${rpad("", 5)} ${rpad("", 4)} ${rpad("", 6)} ${rpad(m.legs.reduce((n, l) => n + l.cells, 0), 6)} ${rpad(m.totalRequests, 5)} ${rpad(m.totalUnits, 6)} ${rpad("", 7)} ${rpad("", 6)} ${rpad(m.legs.reduce((n, l) => n + l.inFlight, 0), 7)} ${rpad(m.legs.reduce((n, l) => n + l.parked, 0), 7)}`);
  };
  table(modelBefore, `DAY ONE AS IT STANDS TODAY (ceiling — the scan can only ask for less)`);
  table(modelAfter, `DAY ONE AFTER THE CHANGE (ceiling — the scan can only ask for less)`);

  console.log(`\n  products in ${CATEGORY}: ${modelAfter.products}   still on their own explicit rows: ${modelAfter.overriddenProducts}`);
  console.log(`  Central on hand for ${CATEGORY}: ${modelAfter.centralOnHand} units`);
  console.log(`  requests ${modelBefore.totalRequests} -> ${modelAfter.totalRequests} against the ${modelAfter.cap}-intent cap (GLOBAL, shared with every other clothing category)`);
  console.log(`  units    ${modelBefore.totalUnits} -> ${modelAfter.totalUnits} against Central's ${modelAfter.centralOnHand}`);

  const flags = [];
  if (modelAfter.exceedsCap) flags.push(`OVER THE CAP — ${modelAfter.totalRequests} requests vs a cap of ${modelAfter.cap}; day one would land over several scans`);
  if (modelAfter.exceedsCentral) flags.push(`OVER CENTRAL — wants ${modelAfter.totalUnits} units, Central holds ${modelAfter.centralOnHand}; the remainder parks against a purchase order`);
  if (modelAfter.overriddenProducts > 20) flags.push(`${modelAfter.overriddenProducts} products are overridden by explicit rows — the map edit does not reach them`);
  if (flags.length) { console.log(`\n  ⚠ FLAGS`); for (const f of flags) console.log(`    • ${f}`); }
  else console.log(`\n  ✓ within the cap, within Central's stock, and fewer than 20 products overridden.`);

  // ── THE REAL ENGINE, FOR THE GAP ───────────────────────────────────────────
  let engine = null;
  if (RUN_ENGINE) {
    console.log(`\n── CROSS-CHECK AGAINST THE REAL ENGINE ${line(54)}`);
    console.log(`  reading the scan's own inputs (paged / windowed)…`);
    const [refillRequests, orders, targetDecisions, rejectStreak, retryState] = await Promise.all([
      readMapPaged(db, "refill_requests", { pageSize: 500 }),
      readMapPaged(db, "orders", { pageSize: 500 }),
      readMapPaged(db, "stock_targets_decisions", { pageSize: 500 }),
      small("refill_engine/rejectStreak"),
      small("refill_engine/retryState"),
    ]);
    // The scan reads a 45-day ledger slice (refill-scan.cjs MOVEMENTS_WINDOW_DAYS).
    // Handing the engine the whole ledger would model a scan that never happens.
    const nowMs = Date.now();
    const windowStart = new Date(nowMs - 45 * 86400000).toISOString();
    const mvSnap = await db.ref("stock_movements").orderByChild("ts").startAt(windowStart).once("value");
    const movements = [];
    mvSnap.forEach((c) => { movements.push({ id: c.key, ...c.val() }); });
    console.log(`  ledger slice: ${movements.length} movements in the 45-day window`);

    const run = (cfg) => computeRefillPlan({
      nowMs, config: cfg, targets, stock, products,
      openIndex, refillRequests, orders, movements, targetDecisions, rejectStreak, retryState,
    });
    const planBefore = run(config);
    const planAfter = run(configAfter);
    const pidsInCat = new Set(Object.keys(products).filter((p) => products[p]?.categoryKey === CATEGORY));
    const mine = (plan) => plan.intents.filter((i) => pidsInCat.has(i.productId));
    const mb = mine(planBefore), ma = mine(planAfter);
    engine = {
      before: { categoryIntents: mb.length, categoryUnits: mb.reduce((n, i) => n + i.qty, 0),
        totalIntents: planBefore.policy.intentsComputed, cap: planBefore.policy.maxIntentsPerRun, throttled: !!planBefore.policy.throttled },
      after: { categoryIntents: ma.length, categoryUnits: ma.reduce((n, i) => n + i.qty, 0),
        totalIntents: planAfter.policy.intentsComputed, cap: planAfter.policy.maxIntentsPerRun, throttled: !!planAfter.policy.throttled },
    };
    console.log(`  ${pad("", 10)} ${rpad("model REQ", 10)} ${rpad("engine", 8)} ${rpad("model units", 12)} ${rpad("engine", 8)} ${rpad("scan total", 11)} ${rpad("cap", 5)}`);
    console.log(`  ${pad("before", 10)} ${rpad(modelBefore.totalRequests, 10)} ${rpad(engine.before.categoryIntents, 8)} ${rpad(modelBefore.totalUnits, 12)} ${rpad(engine.before.categoryUnits, 8)} ${rpad(engine.before.totalIntents, 11)} ${rpad(engine.before.cap, 5)}`);
    console.log(`  ${pad("after", 10)} ${rpad(modelAfter.totalRequests, 10)} ${rpad(engine.after.categoryIntents, 8)} ${rpad(modelAfter.totalUnits, 12)} ${rpad(engine.after.categoryUnits, 8)} ${rpad(engine.after.totalIntents, 11)} ${rpad(engine.after.cap, 5)}`);
    console.log(`  the model sits at or above the engine by construction — the gap is the scan's`);
    console.log(`  suppression passes (confirmed-out, reject streak, retry cooldown, in-flight, throttle).`);
    if (engine.after.categoryIntents > modelAfter.totalRequests) {
      console.log(`  ⚠ the ENGINE asked for MORE than the model. That breaks the upper-bound claim — investigate before arming.`);
    }
    if (engine.after.throttled) console.log(`  ⚠ the scan is THROTTLED at the cap — day one lands over several scans.`);
  } else {
    console.log(`\n  (ENGINE=0 — the real-engine cross-check was skipped and its inputs never read.)`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    writesNothing: true,
    live: {
      categoryPolicyKeys: Object.keys(policy).sort(),
      maxIntentsPerRun: config.maxIntentsPerRun ?? null,
      maxUnitsPerIntent: config.maxUnitsPerIntent ?? null,
      mode: config.mode || {},
      ruleBasedTargets: config.ruleBasedTargets ?? null,
    },
    census,
    proposal: { categoryKey: CATEGORY, locations: LOCS, before, after, changes },
    model: { before: modelBefore, after: modelAfter },
    engine,
    flags,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n  JSON → ${OUT}`);
  console.log(`${"═".repeat(92)}\n`);
  process.exit(0);
})().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
