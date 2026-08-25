// ─── HUB 1 SNEAKER POLICY — THE DRY RUN. WRITES NOTHING TO RTDB. ─────────────
//
// (2026-08-25 scope change: the carriedOnly gate is GONE — the policy arms
// EVERY sneaker product at hub1; the engine's standing actionable-only source
// gate at the request step is the only filter.) Models the policy against the
// LIVE snapshot through the real engine and prints the arming decision's
// numbers:
//
//   1. products armed, and how many hold no stock anywhere (the ghost lines);
//      unregistered zero-stock ghosts still UNFLAGGED (not deactivated), and
//      the run they would wake to if a unit appeared
//   2. target rows by size (declared / live-anywhere / dead-size 0)
//   3. the demand the first scan WOULD raise IGNORING Central (central
//      overlaid as infinite) vs what SURVIVES the real source gate
//   4. unfillable needs day one — the awaitingSupplier / awaitingUpstream
//      surface (Health → Waiting for Supplier / Awaiting Transfer)
//   5. hub1 cells at 6.5 / 7.5 / 8.5 / 9.5 / 10.5 / 12 / 13 with quantities
//   6. the sanity net: hub2/hub3/shop intents unchanged by the overlay
//
// Run: node scripts/model-hub1-sneaker-policy.mjs
import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { computeRefillPlan, encodeSizeKey } = require("../functions/lib/refill-engine.cjs");
import { readMapPaged } from "./lib/rtdbPaged.mjs";
import { writeFileSync } from "fs";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const small = async (p) => (await db.ref(p).once("value")).val() || {};

// The owner's run — the SAME module the daily armer writes from, so the
// modelled numbers and the written numbers cannot drift.
import { HUB1_RUN as RUN, runRow } from "./lib/hub1SneakerRun.mjs";
const HUB1_SIZES = Object.fromEntries(Object.keys(RUN).map((k) => [k, runRow(k)]));
const SNEAKER_POLICY = { perSize: true, hub1: { sizes: HUB1_SIZES } };

const ODD_SIZES = ["6_5", "7_5", "8_5", "9_5", "10_5", "12", "13"];

(async () => {
  const [config, locationsNode] = await Promise.all([small("config/refillEngine"), small("locations")]);
  const allLocs = Object.keys(locationsNode);
  const destLocs = Object.keys(config.mode || {});

  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const stock = {};
  for (const loc of allLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 500 });
  const targets = {};
  for (const loc of allLocs) targets[loc] = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
  const openIndex = {};
  for (const loc of [...new Set([...destLocs, "hub1"])]) {
    openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`, { pageSize: 500 });
  }
  const refillRequests = (await db.ref("refill_requests").orderByChild("status").equalTo("open").once("value")).val() || {};

  // ── 1. THE ARMED UNIVERSE (no scope gate — every sneaker) ──────────────────
  const sneakers = Object.keys(products).filter((pid) => products[pid]?.categoryKey === "sneakers"
    && !products[pid]?.deactivated);
  const deactivatedSneakers = Object.keys(products).filter((pid) => products[pid]?.categoryKey === "sneakers"
    && products[pid]?.deactivated);
  const carried = sneakers;   // downstream loops keep the name; it now means ALL armed sneakers
  const unitsAnywhereOf = (pid) => {
    let n = 0;
    for (const loc of allLocs) for (const c of Object.values(stock[loc]?.[pid] || {})) n += Math.max(0, Number(c?.qty) || 0);
    return n;
  };
  const zeroAnywhere = sneakers.filter((pid) => unitsAnywhereOf(pid) === 0);
  console.log(`\ncategoryKey "sneakers": ${sneakers.length} products ARMED (no scope gate)`
    + `${deactivatedSneakers.length ? ` + ${deactivatedSneakers.length} deactivated (engine skips them)` : ""}`);
  console.log(`of the armed: ${zeroAnywhere.length} hold ZERO stock anywhere — dead-size rule resolves their every size to target 0 (dormant until a unit appears)`);
  // The unregistered zero-stock ghosts still unflagged at this moment, and the
  // run they would wake to if one unit appeared anywhere.
  const aliases = (await db.ref("label_aliases").once("value")).val();
  const styleIndex = (await db.ref("style_code_index").once("value")).val();
  const identityIds = new Set();
  for (const [code, rec] of Object.entries(styleIndex || {})) {
    if (rec?.productId) identityIds.add(rec.productId);
    for (const sib of Object.keys(rec?.siblings || {})) identityIds.add(sib);
  }
  for (const [pid, rec] of Object.entries(aliases || {})) {
    if ((rec?.c && Object.keys(rec.c).length) || (rec?.t && Object.keys(rec.t).length)) identityIds.add(pid);
  }
  const isReg = (pid) => !!products[pid]?.styleCodeNormalised || identityIds.has(pid);
  let ghostCount = 0, ghostWakeTargets = 0;
  for (const pid of Object.keys(products)) {
    const p = products[pid];
    if (!p || p.category !== "Footwear" || p.deactivated || p.mergedInto) continue;
    let hasCell = false;
    for (const loc of allLocs) if (stock[loc]?.[pid]) { hasCell = true; break; }
    if (!hasCell || unitsAnywhereOf(pid) > 0 || isReg(pid)) continue;
    ghostCount++;
    if (p.categoryKey === "sneakers") {
      for (const s of (p.sizes || []).map(String)) {
        const k = encodeSizeKey(s);
        if (RUN[k] !== undefined) ghostWakeTargets += RUN[k];
      }
    }
  }
  console.log(`unregistered zero-stock footwear STILL UNFLAGGED (not deactivated): ${ghostCount}`);
  console.log(`  their resolved target TODAY: 0 on every size (dead-size rule); would wake to ${ghostWakeTargets} sneaker-policy units if single units appeared per size`);
  const otherFootwearCarried = Object.keys(stock.hub1 || {}).filter((pid) =>
    products[pid]?.category === "Footwear" && products[pid]?.categoryKey !== "sneakers");
  const byCat = {};
  for (const pid of otherFootwearCarried) byCat[products[pid].categoryKey || "(none)"] = (byCat[products[pid].categoryKey || "(none)"] || 0) + 1;
  console.log(`hub1 also carries footwear OUTSIDE the policy (stays unarmed): ${JSON.stringify(byCat)}`);

  // ── 2. TARGET ROWS BY SIZE ─────────────────────────────────────────────────
  console.log(`\nrows by size (carried products declaring the size / with live units anywhere):`);
  for (const [k, t] of Object.entries(RUN)) {
    const raw = k.replace("_", ".");
    let declared = 0, alive = 0;
    for (const pid of carried) {
      const sizes = (products[pid]?.sizes || []).map(String);
      if (!sizes.some((s) => encodeSizeKey(s) === k)) continue;
      declared++;
      let units = 0;
      for (const loc of allLocs) units += Math.max(0, Number(stock[loc]?.[pid]?.[k]?.qty) || 0);
      if (units > 0) alive++;
    }
    console.log(`  ${raw.padEnd(5)} target ${t}  declared ${String(declared).padStart(4)}  live-anywhere ${String(alive).padStart(4)}  (dead → explicit 0: ${declared - alive})`);
  }

  // ── 3+4+6. THE ENGINE, OVERLAID ────────────────────────────────────────────
  const overlay = (caps) => ({
    ...config,
    categoryPolicy: { ...(config.categoryPolicy || {}), sneakers: SNEAKER_POLICY },
    mode: { ...(config.mode || {}), hub1: "live" },
    ...caps,
  });
  const runPlan = (cfg) => computeRefillPlan({
    nowMs: Date.now(), config: cfg, targets, stock, products,
    openIndex, refillRequests, orders: {}, movements: [], targetDecisions: {},
    rejectStreak: (/* live */ {}), retryState: {},
  });
  const LIFT = { maxIntentsPerRun: 100000, maxFootwearIntentsPerRun: 100000 };
  const uncapped = runPlan(overlay(LIFT));
  const capped = runPlan(overlay({}));
  // Caps lifted on BOTH sides — comparing an uncapped overlay against the
  // capped baseline would report the shared 75-cap rationing as "changed".
  const baseline = runPlan({ ...config, ...LIFT });

  const h1 = (p) => p.intents.filter((i) => i.dest === "hub1");
  const others = (p) => p.intents.filter((i) => i.dest !== "hub1").map((i) => JSON.stringify(i)).sort();
  const full = h1(uncapped);
  const units = full.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  console.log(`\nFIRST SCAN, caps lifted: ${full.length} hub1 request lines, ${units} units`);
  console.log(`per-run caps live (maxFootwearIntentsPerRun ${config.maxFootwearIntentsPerRun ?? 25}): first run raises ${h1(capped).length} lines`);
  const bySize = {}, linesBySize = {};
  for (const i of full) {
    bySize[i.sizeKey] = (bySize[i.sizeKey] || 0) + i.qty;
    linesBySize[i.sizeKey] = (linesBySize[i.sizeKey] || 0) + 1;
  }
  console.log(`units by size: ${JSON.stringify(bySize)}`);
  console.log(`lines by size: ${JSON.stringify(linesBySize)}`);

  // ── 3b. DEMAND IGNORING CENTRAL vs SURVIVING THE SOURCE GATE ──────────────
  // "Ignoring Central" = the same plan with Central overlaid as effectively
  // infinite for every armed sneaker size, so the source gate never bites and
  // the raw NEED is visible. (confirmed-out and cooldown gates read movements/
  // rejections, both empty in this model, so the delta is the source gate.)
  const boosted = JSON.parse(JSON.stringify(stock));
  for (const pid of sneakers) {
    boosted.central[pid] = { ...(boosted.central[pid] || {}) };
    for (const s of (products[pid]?.sizes || []).map(String)) {
      const k = encodeSizeKey(s);
      if (RUN[k] === undefined) continue;
      // Boost only sizes with units somewhere — the dead-size rule (units
      // anywhere > 0 arms the size) must keep its own verdict, or the "need"
      // would include lines the policy deliberately leaves dormant. Boosting
      // Central WOULD itself wake dead sizes, which is a different question.
      let anywhere = 0;
      for (const loc of allLocs) anywhere += Math.max(0, Number(stock[loc]?.[pid]?.[k]?.qty) || 0);
      if (anywhere > 0) boosted.central[pid][k] = { qty: 100000 + Math.max(0, Number(boosted.central[pid][k]?.qty) || 0) };
    }
  }
  const ignoringCentral = computeRefillPlan({
    nowMs: Date.now(), config: overlay(LIFT), targets, stock: boosted, products,
    openIndex, refillRequests, orders: {}, movements: [], targetDecisions: {},
    rejectStreak: {}, retryState: {},
  });
  const needLines = ignoringCentral.intents.filter((i) => i.dest === "hub1");
  const needUnits = needLines.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  const needBySize = {};
  for (const i of needLines) needBySize[i.sizeKey] = (needBySize[i.sizeKey] || 0) + 1;
  console.log(`\ndemand IGNORING Central: ${needLines.length} lines / ${needUnits} units`);
  console.log(`need lines by size (ignoring Central): ${JSON.stringify(needBySize)}`);
  console.log(`surviving the real source gate: ${full.length} lines / ${units} units (vs a normal window's 12-45 lines / 24-82 units)`);
  const supplier = (uncapped.exceptions?.awaitingSupplier?.items || []).filter((x) => x.loc === "hub1");
  const upstream = (uncapped.exceptions?.awaitingUpstream?.items || []).filter((x) => x.loc === "hub1");
  const supplierCount = uncapped.exceptions?.awaitingSupplier?.count ?? supplier.length;
  console.log(`unfillable day one (the shortage surface — Health → Waiting for Supplier / Awaiting Transfer):`);
  console.log(`  awaitingSupplier hub1 rows: ${supplier.length} (plan-wide count ${supplierCount}, item list caps at 900)`);
  console.log(`  awaitingUpstream hub1 rows: ${upstream.length}`);
  const supUnits = supplier.reduce((n, x) => n + (Number(x.deficit) || 0), 0);
  console.log(`  units short at Central: ${supUnits}`);
  console.log(`sanity: baseline hub1 lines today (policy absent): ${h1(baseline).length}`);
  const same = JSON.stringify(others(uncapped)) === JSON.stringify(others(baseline));
  console.log(`hub2/hub3/shops unchanged by the overlay: ${same ? "YES — intents deep-equal" : "NO — INVESTIGATE"}`);

  // ── 5. THE ODD SIZES ───────────────────────────────────────────────────────
  console.log(`\nhub1 cells at 6.5/7.5/8.5/9.5/10.5/12/13 (owner believes these do not exist):`);
  let oddRows = 0;
  for (const [pid, bySz] of Object.entries(stock.hub1 || {})) {
    for (const k of ODD_SIZES) {
      if (bySz && Object.prototype.hasOwnProperty.call(bySz, k) && bySz[k]) {
        console.log(`  ${pid}  ${k.replace("_", ".").padEnd(5)} qty ${bySz[k].qty}  ${products[pid]?.name || ""}`);
        oddRows++;
      }
    }
  }
  if (!oddRows) console.log(`  (none — the owner is right)`);

  writeFileSync(process.env.HOME + "/hub1-sneaker-policy-dryrun.json", JSON.stringify({
    at: new Date().toISOString(), sneakers: sneakers.length, zeroAnywhere: zeroAnywhere.length,
    ghostsUnflagged: ghostCount, ghostWakeTargets,
    needLines: needLines.length, needUnits,
    fullLines: full.length, fullUnits: units, bySize, linesBySize, cappedFirstRun: h1(capped).length,
    awaitingSupplierHub1: supplier.length, awaitingUpstreamHub1: upstream.length, needBySize,
    othersUnchanged: same, intents: full, supplier,
  }, null, 2));
  console.log(`\nsaved: ~/hub1-sneaker-policy-dryrun.json`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
