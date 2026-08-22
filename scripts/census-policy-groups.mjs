// ─── POLICY GROUPS + PER-SIZE — READ-ONLY CENSUS ──────────────────────────────
//
// WRITES NOTHING TO RTDB. Not a config key, not a group, not a target row, not
// an audit entry. The only output is JSON under var/, which is inert, and text
// on stdout. Arming anything is a separate, deliberate act through the Engine
// Policy card.
//
// ── WHAT IT ANSWERS ──────────────────────────────────────────────────────────
//
//   1. THE FOOTWEAR GROUP'S MEMBER LIST, derived from /settings/productTaxonomy
//      — every categoryKey whose `top` is "footwear", minus soccer-boots. Read,
//      never guessed: the taxonomy is the registry and a hardcoded list here
//      would go stale the first time a category is added.
//
//   2. WHAT THAT GROUP WOULD DO IF IT WERE ARMED. Modelled against the live
//      snapshot, per member, against the per-scan cap. It is armed nowhere and
//      this script cannot arm it; the number exists so the decision to arm is
//      taken against evidence instead of a hunch.
//
//      FOOTWEAR IS BEHIND ITS OWN KILL SWITCH (/config/refillEngine/
//      footwearTargets, absent = OFF) and this build does not touch it. The
//      model below therefore describes a world that does not exist and will not
//      exist until two separate switches are thrown by hand.
//
//   3. THE PER-SIZE SHAPES ALREADY IN THE LIVE DATA — which categories are
//      per-size, what their real size run is (derived from products, stock
//      cells and existing rows, never from a hardcoded list), and where the
//      taxonomy's declared run disagrees with the cells that actually exist.
//
//   4. WHICH CATEGORIES CARRY EXPLICIT /stock_targets ROWS, and how many. These
//      are the rows Junid has armed by hand over months. They are the source of
//      truth for the products that have them; this census counts them so the
//      card can say "N with their own rows" for EVERY category, not only the
//      armed ones.
//
//   5. MERGE CANDIDATES — a proposal list. Nothing is merged, no categoryKey is
//      changed, no row is deleted. A category with four products in it is a
//      suggestion for a person to consider, not an instruction.
//
// ── READS ARE PAGED ──────────────────────────────────────────────────────────
// No whole-node read of a large map. /products, /stock/<loc>, /stock_targets/
// <loc> and /refill_engine/open/<loc> all go through readMapPaged; the ledger
// is the scan's own 45-day orderByChild("ts") window.
//
// Usage:
//   node scripts/census-policy-groups.mjs
//   MOVEMENT_DAYS=90 node scripts/census-policy-groups.mjs
//   OUT=var/my-census.json node scripts/census-policy-groups.mjs

import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { modelCategoryPolicy, carriageForCategory } = require("../functions/lib/category-policy.cjs");
const { sizeRunForCategory, mergeCandidates, locationEntryMode } = require("../functions/lib/policy-groups.cjs");
const { encodeSizeKey } = require("../functions/lib/refill-engine.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT || join(ROOT, "var", `policy-groups-census-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const MOVEMENT_DAYS = Number(process.env.MOVEMENT_DAYS || 45);

// THE GROUP THIS BUILD SEEDS. The key and the exclusion are the brief's; the
// MEMBERS ARE NOT WRITTEN DOWN ANYWHERE HERE — they are read out of the
// taxonomy below.
const GROUP_KEY = "footwear-all";
const GROUP_TOP = "footwear";
const GROUP_EXCLUDE = ["soccer-boots"];

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const small = (p) => db.ref(p).once("value").then((s) => s.val() || {});

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const line = (n = 92) => "─".repeat(n);

(async () => {
  console.log(`\n${"═".repeat(92)}`);
  console.log(`  POLICY GROUPS + PER-SIZE — CENSUS            WRITES NOTHING TO RTDB`);
  console.log(`${"═".repeat(92)}`);

  const [config, taxonomy, locationsNode] = await Promise.all([
    small("config/refillEngine"), small("settings/productTaxonomy"), small("locations"),
  ]);
  const policy = config.categoryPolicy && typeof config.categoryPolicy === "object" ? config.categoryPolicy : {};
  const groups = config.policyGroups && typeof config.policyGroups === "object" ? config.policyGroups : {};
  const cats = taxonomy.cats && typeof taxonomy.cats === "object" ? taxonomy.cats : {};
  const allLocs = Object.keys(locationsNode);
  const destLocs = Object.keys(config.mode || {});

  console.log(`  taxonomy cats  : ${Object.keys(cats).length}`);
  console.log(`  armed map keys : ${Object.keys(policy).sort().join(", ") || "(none)"}`);
  console.log(`  policyGroups   : ${Object.keys(groups).sort().join(", ") || "(none — this build seeds the first)"}`);
  console.log(`  destinations   : ${destLocs.map((d) => `${d}=${config.mode[d]}`).join("  ")}`);
  console.log(`  cap            : maxIntentsPerRun ${config.maxIntentsPerRun}   maxUnitsPerIntent ${config.maxUnitsPerIntent}`);
  console.log(`  footwear switch: ${JSON.stringify(config.footwearTargets ?? null)}  ${config.footwearTargets ? "" : "(absent = OFF)"}`);

  console.log(`\n  reading (paged)…`);
  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const stock = {}, targets = {}, openIndex = {};
  for (const loc of allLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 500 });
  for (const loc of allLocs) targets[loc] = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
  for (const loc of destLocs) openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`, { pageSize: 500 });
  console.log(`  products ${Object.keys(products).length}   locations ${allLocs.length}`);

  // ── MOVEMENT, for the merge proposals ──────────────────────────────────────
  // Units that left a shelf in the window, by category. SALES ONLY — a transfer
  // moves a unit between our own shelves and says nothing about demand — net of
  // returns, which are the same sale coming back.
  //
  // The ledger's type is "sold", not "sale". Filtering on "sale" matched nothing
  // and reported every category at zero movement, which silently disabled the
  // twinned-merge proposal entirely: the first run of this script produced two
  // "tiny" proposals and no twinned ones, and it looked like a finding rather
  // than a typo. The live type histogram over 7 days is transfer_out 2264, sold
  // 1949, transfer_in 1205, received 880, adjustment 646, return 152.
  const SALE_TYPES = new Set(["sold"]);
  const windowStart = new Date(Date.now() - MOVEMENT_DAYS * 86400000).toISOString();
  const mvSnap = await db.ref("stock_movements").orderByChild("ts").startAt(windowStart).once("value");
  const movementByCategory = {};
  let mvCount = 0;
  mvSnap.forEach((c) => {
    mvCount += 1;
    const m = c.val() || {};
    const type = String(m.type || "");
    if (!SALE_TYPES.has(type) && type !== "return") return;
    const key = products[m.productId]?.categoryKey;
    if (!key) return;
    const q = Math.abs(typeof m.qty === "number" && Number.isFinite(m.qty) ? m.qty : 0);
    movementByCategory[key] = Math.max((movementByCategory[key] || 0) + (type === "return" ? -q : q), 0);
  });
  console.log(`  ledger slice: ${mvCount} movements in the ${MOVEMENT_DAYS}-day window`);

  // ── 1. THE FOOTWEAR GROUP'S MEMBERS, READ OUT OF THE TAXONOMY ──────────────
  const footwearKeys = Object.keys(cats).filter((k) => cats[k]?.top === GROUP_TOP).sort();
  const members = footwearKeys.filter((k) => !GROUP_EXCLUDE.includes(k));
  const excluded = footwearKeys.filter((k) => GROUP_EXCLUDE.includes(k));
  const missingExclusions = GROUP_EXCLUDE.filter((k) => !footwearKeys.includes(k));

  console.log(`\n── 1. GROUP "${GROUP_KEY}" — MEMBERS DERIVED FROM /settings/productTaxonomy ${line(14)}`);
  console.log(`  every categoryKey with top="${GROUP_TOP}", minus ${GROUP_EXCLUDE.join(", ")}`);
  console.log(`\n  ${pad("member", 20)} ${pad("active", 7)} ${pad("sizeMode", 9)} ${rpad("prods", 6)} ${rpad("units", 7)} ${rpad("sold", 6)} sizes`);
  const countsByCategory = {};
  for (const k of footwearKeys) {
    const { pids, byLocation } = carriageForCategory({ products, stock, categoryKey: k, locations: allLocs });
    countsByCategory[k] = pids.length;
    const units = Object.values(byLocation).reduce((n, v) => n + v.units, 0);
    const mark = GROUP_EXCLUDE.includes(k) ? "  ✗ EXCLUDED " : "  ";
    console.log(`${mark}${pad(k, GROUP_EXCLUDE.includes(k) ? 8 : 20)} ${pad(String(cats[k].active !== false), 7)} ${pad(cats[k].sizeMode, 9)} ${rpad(pids.length, 6)} ${rpad(units, 7)} ${rpad(movementByCategory[k] || 0, 6)} ${(cats[k].sizes || []).join(",")}`);
  }
  console.log(`\n  MEMBER LIST (${members.length}): ${members.join(", ")}`);
  console.log(`  EXCLUDED (${excluded.length}): ${excluded.join(", ") || "—"}`);
  if (missingExclusions.length) {
    console.log(`  ⚠ exclusion "${missingExclusions.join(", ")}" is not a footwear category in the taxonomy — check the key`);
  }

  // Counts for every category (needed by the merge proposals and the row census).
  for (const k of Object.keys(cats)) {
    if (countsByCategory[k] === undefined) {
      countsByCategory[k] = Object.keys(products).filter((pid) => products[pid]?.categoryKey === k).length;
    }
  }

  // ── 2. WHAT THE GROUP WOULD DO IF ARMED ────────────────────────────────────
  // Modelled with the group's proposed numbers injected as if they were each
  // member's OWN category entry — which is exactly what the resolution order
  // produces for a member with no entry of its own, so the arithmetic is the
  // same one the engine would walk.
  //
  // The proposed numbers are the location's existing footwear run
  // (/config/refillEngine/footwearRunByLocation), because that is the run the
  // footwear rule would have applied — modelling a made-up number would answer
  // a question nobody asked.
  console.log(`\n── 2. IF "${GROUP_KEY}" WERE ARMED — MODELLED, NOT DONE ${line(35)}`);
  const runByLoc = config.footwearRunByLocation || {};
  const groupPolicyProposed = { perSize: true };
  for (const loc of destLocs) {
    const run = runByLoc[loc];
    if (!run || typeof run !== "object") continue;
    const sizes = {};
    for (const [sk, t] of Object.entries(run)) {
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
      sizes[encodeSizeKey(sk)] = { target: t, minQty: Math.max(1, t - 1), reorderPoint: 0 };
    }
    if (Object.keys(sizes).length) groupPolicyProposed[loc] = { sizes };
  }
  const modelLocs = Object.keys(groupPolicyProposed).filter((k) => k !== "perSize");
  console.log(`  proposed numbers: the location's own footwear run, reorderPoint 0`);
  console.log(`  locations with a run: ${modelLocs.join(", ") || "(none — nothing to model)"}`);

  // The group is modelled AS A GROUP — armed:true in a throwaway copy of the
  // config, never written anywhere — so the number below comes through the same
  // resolution the scan would use, group precedence included. Modelling it by
  // injecting the policy as each member's own entry would have measured a
  // different arrangement and quietly answered a different question.
  const groupModel = [];
  let groupRequests = 0, groupUnits = 0;
  const armedCfg = {
    ...config,
    policyGroups: {
      ...groups,
      [GROUP_KEY]: {
        label: `All footwear except ${GROUP_EXCLUDE.join(", ")}`,
        memberCategoryKeys: members, armed: true, policy: groupPolicyProposed,
      },
    },
  };
  for (const k of members) {
    const m = modelCategoryPolicy({
      config: armedCfg, products, stock, targets, openIndex, categoryKey: k,
      locations: allLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
    });
    groupModel.push({ key: k, products: m.products, policySource: m.policySource, requests: m.totalRequests, units: m.totalUnits,
      liveRequests: m.liveRequests, liveUnits: m.liveUnits, centralOnHand: m.centralOnHand,
      overriddenProducts: m.overriddenProducts, legacyRowCells: m.legacyRowCells });
    groupRequests += m.totalRequests;
    groupUnits += m.totalUnits;
  }
  const cap = config.maxIntentsPerRun || 200;
  console.log(`\n  ${pad("member", 20)} ${rpad("prods", 6)} ${rpad("req", 6)} ${rpad("units", 7)} ${rpad("live req", 9)} ${rpad("own rows", 9)}`);
  for (const g of groupModel) {
    console.log(`  ${pad(g.key, 20)} ${rpad(g.products, 6)} ${rpad(g.requests, 6)} ${rpad(g.units, 7)} ${rpad(g.liveRequests, 9)} ${rpad(g.overriddenProducts, 9)}`);
  }
  console.log(`  ${pad("TOTAL", 20)} ${rpad("", 6)} ${rpad(groupRequests, 6)} ${rpad(groupUnits, 7)}`);
  console.log(`\n  per-scan cap: ${cap}.  modelled: ${groupRequests}.`);
  const exceedsCap = groupRequests > cap;
  if (exceedsCap) {
    console.log(`  🛑 STOP — the modelled footwear volume EXCEEDS the cap. Arming this group would`);
    console.log(`     fill every scan with footwear and starve the clothing categories that share it.`);
    console.log(`     The group is seeded DISARMED and this script does not arm anything.`);
  } else {
    console.log(`  ✓ under the cap — but the group is still seeded DISARMED, and the footwear kill`);
    console.log(`    switch (footwearTargets) is a SEPARATE switch that this build does not touch.`);
  }
  // ── THE SEEDED STATE, MEASURED RATHER THAN ASSERTED ───────────────────────
  // Write the group DISARMED into a copy of the live config and re-run the same
  // model. If a single number moves, the seed is not inert and this build stops.
  const disarmedCfg = { ...config, policyGroups: { ...groups,
    [GROUP_KEY]: { ...armedCfg.policyGroups[GROUP_KEY], armed: false } } };
  let disarmedDelta = 0;
  for (const k of members) {
    const before = modelCategoryPolicy({ config, products, stock, targets, openIndex, categoryKey: k,
      locations: allLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent });
    const after = modelCategoryPolicy({ config: disarmedCfg, products, stock, targets, openIndex, categoryKey: k,
      locations: allLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent });
    disarmedDelta += Math.abs(after.totalRequests - before.totalRequests) + Math.abs(after.totalUnits - before.totalUnits);
  }
  console.log(`\n  SEEDED DISARMED, measured against the live snapshot: delta ${disarmedDelta} across all ${members.length} members.`);
  if (disarmedDelta !== 0) {
    console.log(`  🛑 STOP — writing the group DISARMED moved ${disarmedDelta} of something. It must move nothing.`);
  }

  console.log(`\n  ARMED TODAY: no. This group does not exist in the live config yet, and when it is`);
  console.log(`  written it is written with armed:false — which takes it out of the resolution order`);
  console.log(`  entirely, so it cannot produce a single intent whatever these numbers say.`);

  // ── 3. PER-SIZE SHAPES IN THE LIVE DATA ────────────────────────────────────
  console.log(`\n── 3. PER-SIZE SHAPES — SIZE RUNS DERIVED FROM LIVE DATA ${line(33)}`);
  console.log(`  ${pad("category", 20)} ${pad("tax", 5)} ${pad("map", 5)} ${rpad("run", 4)} ${pad("derived run", 40)} notes`);
  const sizeRuns = {};
  const undeivable = [];
  for (const k of Object.keys(cats).sort()) {
    if (!countsByCategory[k]) continue;
    const run = sizeRunForCategory({ products, stock, targets, taxonomy, categoryKey: k, locations: allLocs });
    sizeRuns[k] = run;
    const mapMode = policy[k]?.perSize === true ? "size" : policy[k] ? "one" : "—";
    const notes = [];
    if (run.taxonomyOnly.length) notes.push(`registry-only: ${run.taxonomyOnly.join(",")}`);
    if (run.unregistered.length) notes.push(`unregistered: ${run.unregistered.join(",")}`);
    if (run.empty) notes.push("NO SIZE RUN — one-size only");
    console.log(`  ${pad(k, 20)} ${pad(cats[k].sizeMode, 5)} ${pad(mapMode, 5)} ${rpad(run.sizes.length, 4)} ${pad(run.sizes.join(",").slice(0, 39), 40)} ${notes.join("; ")}`);
    if (run.empty && cats[k].sizeMode === "list") undeivable.push(k);
  }
  if (undeivable.length) {
    console.log(`\n  🛑 STOP — these categories claim sizeMode "list" but NO size run can be derived from`);
    console.log(`     live data (no product declares a size, no cell exists, no row exists): ${undeivable.join(", ")}`);
    console.log(`     The per-size editor must refuse them rather than offer a guessed list.`);
  }

  // Shapes already stored in the live map — uniform or per-size, per location.
  console.log(`\n  SHAPES IN THE LIVE MAP:`);
  for (const [k, entry] of Object.entries(policy).sort()) {
    const shapes = Object.keys(entry).filter((x) => x !== "perSize")
      .map((loc) => `${loc}=${locationEntryMode(entry[loc])}`);
    console.log(`    ${pad(k, 20)} perSize=${entry.perSize === true}  ${shapes.join("  ")}`);
  }
  console.log(`  (every live location entry is "uniform" today — the per-size map shape is new)`);

  // ── 4. EXPLICIT ROWS PER CATEGORY — "N WITH THEIR OWN ROWS" ────────────────
  // Counted for EVERY category, armed or not. The shipped census only computed
  // this where the map was armed, so an unarmed clothing category with hundreds
  // of hand-made rows reported zero.
  console.log(`\n── 4. EXPLICIT /stock_targets ROWS BY CATEGORY — NOTHING HERE IS DELETED ${line(18)}`);
  const rowCensus = {};
  for (const loc of allLocs) {
    for (const [pid, bySize] of Object.entries(targets[loc] || {})) {
      const key = products[pid]?.categoryKey;
      if (!key) continue;
      const r = rowCensus[key] || (rowCensus[key] = { cells: 0, products: new Set(), byLocation: {}, bySize: {} });
      const n = Object.keys(bySize || {}).length;
      r.cells += n;
      r.products.add(pid);
      r.byLocation[loc] = (r.byLocation[loc] || 0) + n;
      for (const sk of Object.keys(bySize || {})) r.bySize[sk] = (r.bySize[sk] || 0) + 1;
    }
  }
  console.log(`  ${pad("category", 20)} ${rpad("cells", 6)} ${rpad("prods", 6)} ${pad("by location", 44)} armed`);
  let totalRowCells = 0, totalRowProducts = 0;
  for (const [k, r] of Object.entries(rowCensus).sort((a, b) => b[1].cells - a[1].cells)) {
    totalRowCells += r.cells; totalRowProducts += r.products.size;
    console.log(`  ${pad(k, 20)} ${rpad(r.cells, 6)} ${rpad(r.products.size, 6)} ${pad(Object.entries(r.byLocation).map(([l, n]) => `${l}=${n}`).join(" "), 44)} ${policy[k] ? "yes" : "—"}`);
  }
  console.log(`  ${pad("TOTAL", 20)} ${rpad(totalRowCells, 6)} ${rpad(totalRowProducts, 6)}`);
  console.log(`\n  These rows are the SOURCE OF TRUTH for the products that carry them. They are read`);
  console.log(`  and displayed as current values and edited in place; not one is deleted by anything`);
  console.log(`  in this build. The card's chip reads "N with their own rows", not "N overridden".`);

  // ── 5. MERGE CANDIDATES — A PROPOSAL LIST ──────────────────────────────────
  console.log(`\n── 5. MERGE CANDIDATES — PROPOSALS ONLY, NOTHING IS MERGED ${line(31)}`);
  const candidates = mergeCandidates({
    taxonomy, countsByCategory, movementByCategory, policy, groups: { [GROUP_KEY]: { memberCategoryKeys: members } },
  });
  if (!candidates.length) {
    console.log(`  none — no category is small enough or twinned closely enough to propose.`);
  } else {
    console.log(`  ${pad("kind", 9)} ${pad("categories", 34)} ${rpad("prods", 6)} ${rpad("sold", 6)} ${pad("armed", 6)} why`);
    for (const c of candidates) {
      console.log(`  ${pad(c.kind, 9)} ${pad(c.categories.join(" + "), 34)} ${rpad(c.products, 6)} ${rpad(c.movement, 6)} ${pad(c.armed ? "yes" : "—", 6)} ${c.why}`);
    }
  }
  console.log(`\n  A proposal is not a plan. Merging would change a product's categoryKey, which this`);
  console.log(`  build refuses to do anywhere — see the standing constraint. Grouping is the`);
  console.log(`  non-destructive alternative: the same numbers, without touching a single record.`);

  // ── OUTPUT ────────────────────────────────────────────────────────────────
  const payload = {
    generatedAt: new Date().toISOString(),
    writesNothing: true,
    movementWindowDays: MOVEMENT_DAYS,
    config: {
      mode: config.mode || null, routes: config.routes || null,
      maxIntentsPerRun: config.maxIntentsPerRun ?? null, maxUnitsPerIntent: config.maxUnitsPerIntent ?? null,
      footwearTargets: config.footwearTargets ?? null,
      ruleBasedTargets: config.ruleBasedTargets ?? null,
      categoryPolicyKeys: Object.keys(policy).sort(),
      policyGroups: groups,
    },
    group: {
      key: GROUP_KEY, top: GROUP_TOP, exclude: GROUP_EXCLUDE, disarmedDelta,
      members, excluded, missingExclusions,
      armedInThisBuild: false,
      proposedPolicy: groupPolicyProposed,
      model: groupModel,
      totalRequests: groupRequests, totalUnits: groupUnits, cap, exceedsCap,
    },
    sizeRuns,
    undeivableSizeRuns: undeivable,
    liveMapShapes: Object.fromEntries(Object.entries(policy).map(([k, e]) => [k, {
      perSize: e.perSize === true,
      locations: Object.fromEntries(Object.keys(e).filter((x) => x !== "perSize").map((loc) => [loc, locationEntryMode(e[loc])])),
    }])),
    explicitRows: Object.fromEntries(Object.entries(rowCensus).map(([k, r]) => [k, {
      cells: r.cells, products: r.products.size, byLocation: r.byLocation, bySize: r.bySize,
    }])),
    countsByCategory, movementByCategory,
    mergeCandidates: candidates,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\n  JSON → ${OUT}`);
  console.log(`  (var/ is gitignored — machine-local working data, regenerated on demand)\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
