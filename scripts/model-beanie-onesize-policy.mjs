// ─── BEANIE ONE-SIZE COLLAPSE — COMMIT 4: POLICY MODEL (WRITES NOTHING) ───────
//
// Models "shop 5 per colour, hub2 15" over a POST-COLLAPSE simulation of the
// live database. It writes nothing, anywhere, ever — no /stock_targets row, no
// config key. The arming decision is the owner's and is made separately.
//
// ── WHY IT RUNS THE REAL ENGINE ──────────────────────────────────────────────
// The classification vocabulary (REQUEST / SILENT / PARKED / AT TARGET) is the
// engine's own behaviour, not a description of it. So this loads the live
// snapshot, mutates a COPY into the post-collapse shape, injects the proposed
// target rows in memory, and calls functions/lib/refill-engine.cjs's real
// computeRefillPlan — the same function the 15-minute scan calls. A
// reimplementation here would model the model, not the engine.
//
//   REQUEST   the scan would create a refill intent for this cell today
//   SILENT    a reorderPoint is set and on-hand sits above it — no card, no
//             request, indistinguishable from a cell that has met target
//   PARKED    a real deficit the source cannot fill: awaiting upstream stock,
//             awaiting a supplier, waiting out a rejection, or reorder-listed
//   AT TARGET on-hand + inbound already meets the target
//
// ── THE POST-COLLAPSE SIMULATION ─────────────────────────────────────────────
// Faithful to what the migration actually leaves behind:
//   • sizes → ["_"], quantities summed into the "_" cell per location
//   • the sized cells REMAIN at qty 0 (applyMovement never deletes a cell) —
//     which matters, because storeCarries() infers assortment from node
//     presence, so those zero husks keep the product "carried" at that location
//   • existing explicit rows on retired sizes → target 0 ("excluded")
//
// ── THE CLOTHING TRIPWIRE ────────────────────────────────────────────────────
// Beanies are productType "clothing" under Accessories, so isClothing() is true
// and ruleBasedTargets is live at every destination. The exposure is asymmetric
// and worth stating precisely: "_" was deliberately kept OUT of
// defaultRunByStore (owner rejected adding it — it is shared by every one-size
// product, so it would arm sunglasses, belts and jewellery too), so after the
// collapse a beanie resolves NO rule-based target and sits inert. The ONLY
// target it can hold is an explicit /stock_targets row. That is what this
// models, and the model reports what the engine does with each option.
//
// Usage: node scripts/model-beanie-onesize-policy.mjs
//        MODEL_JSON=/path/model.json node scripts/model-beanie-onesize-policy.mjs

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isInScope } from "./lib/beanieCollapseCore.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { computeRefillPlan, resolveTarget } = require("../functions/lib/refill-engine.cjs");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const g = (p) => db.ref(p).once("value").then((s) => s.val());

const SHOP_TARGET = 5;      // per colour, per shop
const HUB_TARGET = 15;      // per colour at hub2
const SHOPS = ["marathon-pe", "trophy"];
const HUB = "hub2";
const OUT = process.env.MODEL_JSON || join(tmpdir(), `beanie-policy-model-${Date.now()}.json`);

// Measured on the live ledger (2026-08-10): the Central→hub2 lane's own
// fulfilled refill requests, created → resolved.
const LEAD_P50_H = 17.0, LEAD_P90_H = 49.8;

const cellQty = (stock, loc, pid, key) => {
  const q = stock?.[loc]?.[pid]?.[key]?.qty;
  return typeof q === "number" ? q : 0;
};

(async () => {
  console.log(`\n${"═".repeat(78)}\n  BEANIE ONE-SIZE POLICY MODEL — shop ${SHOP_TARGET} / hub2 ${HUB_TARGET}\n  WRITES NOTHING\n${"═".repeat(78)}`);

  const [config, targetsLive, stockLive, productsLive, openIndex, refillRequests, orders, movementsRaw, targetDecisions, rejectStreak, retryState] =
    await Promise.all([
      g("config/refillEngine"), g("stock_targets"), g("stock"), g("products"),
      g("refill_engine/open"), g("refill_requests"), g("orders"), g("stock_movements"),
      g("stock_targets_decisions"), g("refill_engine/rejectStreak"), g("refill_engine/retryState"),
    ]).then((r) => r.map((v) => v || {}));

  const beanies = Object.entries(productsLive).filter(([, p]) => isInScope(p)).map(([pid]) => pid);
  const beanieSet = new Set(beanies);
  console.log(`  in scope: ${beanies.length} beanies`);

  // ── post-collapse simulation ───────────────────────────────────────────────
  const products = JSON.parse(JSON.stringify(productsLive));
  const stock = JSON.parse(JSON.stringify(stockLive));
  const targetsBase = JSON.parse(JSON.stringify(targetsLive));
  for (const pid of beanies) {
    products[pid].sizes = ["_"];
    for (const loc of Object.keys(stock)) {
      const bySize = stock[loc]?.[pid];
      if (!bySize) continue;
      let merged = cellQty(stock, loc, pid, "_");
      for (const [k, cell] of Object.entries(bySize)) {
        if (k === "_") continue;
        merged += typeof cell?.qty === "number" ? cell.qty : 0;
        cell.qty = 0;                       // the husk stays — storeCarries reads node presence
      }
      bySize._ = { ...(bySize._ || { v: 0, mv: "model", lastType: "adjustment" }), qty: merged };
    }
    for (const loc of Object.keys(targetsBase)) {
      for (const k of Object.keys(targetsBase[loc]?.[pid] || {})) {
        if (k !== "_") targetsBase[loc][pid][k] = { target: 0, minQty: 0, source: "excluded" };
      }
    }
  }

  // Which beanies each location actually carries (a cell node exists there).
  const carriedAt = (loc) => beanies.filter((pid) => !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length);
  const carried = Object.fromEntries([HUB, ...SHOPS, "central"].map((l) => [l, carriedAt(l)]));
  console.log(`  carried:  ${Object.entries(carried).map(([l, a]) => `${l}=${a.length}`).join("  ")}`);
  const centralHeld = beanies.reduce((t, pid) => t + cellQty(stock, "central", pid, "_"), 0);
  const hubHeld = beanies.reduce((t, pid) => t + cellQty(stock, HUB, pid, "_"), 0);
  const peHeld = beanies.reduce((t, pid) => t + cellQty(stock, "marathon-pe", pid, "_"), 0);
  console.log(`  post-collapse on hand: central=${centralHeld}  ${HUB}=${hubHeld}  marathon-pe=${peHeld}`);

  // ── the proposed rows (IN MEMORY ONLY) ─────────────────────────────────────
  // Two arming widths, because they imply very different numbers:
  //   ALL     every in-scope beanie gets a row at hub2 and at each shop
  //   CARRIED only where the location already has a cell for that product
  const buildTargets = (width, hubReorderPoint) => {
    const t = JSON.parse(JSON.stringify(targetsBase));
    const put = (loc, pid, row) => { (t[loc] = t[loc] || {})[pid] = { ...(t[loc][pid] || {}), _: row }; };
    const hubPids = width === "ALL" ? beanies : carried[HUB];
    for (const pid of hubPids) {
      put(HUB, pid, { target: HUB_TARGET, minQty: Math.ceil(HUB_TARGET / 2), source: "model",
        ...(hubReorderPoint === "absent" ? {} : { reorderPoint: hubReorderPoint }) });
    }
    for (const shop of SHOPS) {
      const shopPids = width === "ALL" ? beanies : carried[shop];
      for (const pid of shopPids) put(shop, pid, { target: SHOP_TARGET, minQty: Math.ceil(SHOP_TARGET / 2), source: "model" });
    }
    return t;
  };

  // The engine reads a windowed slice of the ledger; pass it the same shape the
  // scan does (array of movements).
  const movements = Object.entries(movementsRaw).map(([id, m]) => ({ id, ...m }));
  const nowMs = Date.now();

  const runModel = (targets) => {
    const plan = computeRefillPlan({
      nowMs, config, targets, stock, products, openIndex, refillRequests, orders, movements,
      targetDecisions, rejectStreak, retryState,
    });
    // Classify every beanie "_" cell at hub2 + the shops, using the same
    // resolveTarget the plan used, and the plan's own lists for the outcome.
    // Exception lists come back as { count, items } with items capped (300, or
    // 900/1500 for the big ones). A truncated list would silently mislabel a
    // cell, so the cap state is carried out with the result and reported.
    const truncated = [];
    for (const [name, l] of Object.entries(plan.exceptions || {})) {
      if (l && typeof l.count === "number" && l.items && l.count > l.items.length) truncated.push(`${name} ${l.items.length}/${l.count}`);
    }
    const inList = (list, loc, pid) => (plan.exceptions?.[list]?.items || []).some((r) => r.loc === loc && r.pid === pid);
    const rows = [];
    for (const loc of [HUB, ...SHOPS]) {
      for (const pid of beanies) {
        const t = resolveTarget({ targets, config, products, stock }, loc, pid, "_");
        if (!t || t.target <= 0) continue;
        const have = Math.max(cellQty(stock, loc, pid, "_"), 0);
        const deficit = t.target - have;
        let cls;
        if (deficit <= 0) cls = "AT TARGET";
        else if (t.reorderPoint != null && have > t.reorderPoint) cls = "SILENT";
        else if (plan.intents.some((i) => i.dest === loc && i.productId === pid)) cls = "REQUEST";
        else if (inList("awaitingUpstream", loc, pid) || inList("awaitingSupplier", loc, pid)
          || inList("waitingForStock", loc, pid) || inList("missingSizes", loc, pid)
          || inList("recountNeeded", loc, pid)) cls = "PARKED";
        else cls = "PARKED";   // a below-target cell the scan produced no card for
        rows.push({ loc, pid, name: products[pid].name, have, target: t.target, reorderPoint: t.reorderPoint ?? null, deficit: Math.max(deficit, 0), cls });
      }
    }
    return { plan, rows, truncated };
  };

  const summarise = (label, width, rp) => {
    const targets = buildTargets(width, rp);
    const { plan, rows, truncated } = runModel(targets);
    const byLocCls = {};
    for (const r of rows) {
      const k = `${r.loc}`;
      byLocCls[k] = byLocCls[k] || { REQUEST: 0, SILENT: 0, PARKED: 0, "AT TARGET": 0, units: 0, cells: 0, wanted: 0 };
      byLocCls[k][r.cls]++; byLocCls[k].cells++; byLocCls[k].units += r.have; byLocCls[k].wanted += r.target;
    }
    const beanieIntents = plan.intents.filter((i) => beanieSet.has(i.productId));
    const requestUnits = beanieIntents.reduce((t, i) => t + i.qty, 0);
    console.log(`\n── ${label} ───────────────────────────────────────────────`);
    console.log(`  ${"location".padEnd(13)} ${"cells".padStart(5)} ${"REQUEST".padStart(8)} ${"SILENT".padStart(7)} ${"PARKED".padStart(7)} ${"AT TGT".padStart(7)} ${"on hand".padStart(8)} ${"wanted".padStart(7)}`);
    for (const [loc, c] of Object.entries(byLocCls)) {
      console.log(`  ${loc.padEnd(13)} ${String(c.cells).padStart(5)} ${String(c.REQUEST).padStart(8)} ${String(c.SILENT).padStart(7)} ${String(c.PARKED).padStart(7)} ${String(c["AT TARGET"]).padStart(7)} ${String(c.units).padStart(8)} ${String(c.wanted).padStart(7)}`);
    }
    console.log(`  beanie intents this scan: ${beanieIntents.length} (${requestUnits} units) · engine computed ${plan.policy.intentsComputed} clothing intents overall, cap ${plan.policy.maxIntentsPerRun}${plan.policy.throttled ? " — THROTTLED" : ""}`);
    if (truncated.length) console.log(`  NOTE — engine capped these exception lists, so PARKED detail is partial: ${truncated.join(", ")}`);
    return { label, width, rp, byLocCls, intents: beanieIntents.length, requestUnits,
      throttled: plan.policy.throttled, intentsComputed: plan.policy.intentsComputed, truncated, rows };
  };

  const results = [];
  console.log(`\n${"─".repeat(78)}\n  ARMING WIDTH: only where the location already carries the product`);
  results.push(summarise(`CARRIED · hub2 reorderPoint 0`, "CARRIED", 0));
  results.push(summarise(`CARRIED · hub2 reorderPoint absent`, "CARRIED", "absent"));
  results.push(summarise(`CARRIED · hub2 reorderPoint 8`, "CARRIED", 8));
  console.log(`\n${"─".repeat(78)}\n  ARMING WIDTH: every in-scope beanie, everywhere`);
  results.push(summarise(`ALL · hub2 reorderPoint 0`, "ALL", 0));
  results.push(summarise(`ALL · hub2 reorderPoint absent`, "ALL", "absent"));
  results.push(summarise(`ALL · hub2 reorderPoint 8`, "ALL", 8));

  // ── what the policy implies in total, and what Central can actually fund ───
  console.log(`\n── WHAT THE POLICY WANTS vs WHAT EXISTS ───────────────────────────────────`);
  const implied = (width) => {
    const hubPids = width === "ALL" ? beanies : carried[HUB];
    const shopPids = SHOPS.map((s) => (width === "ALL" ? beanies : carried[s]));
    const hubWant = hubPids.length * HUB_TARGET;
    const shopWant = shopPids.reduce((t, a) => t + a.length * SHOP_TARGET, 0);
    return { hubPids: hubPids.length, hubWant, shopWant, total: hubWant + shopWant };
  };
  for (const width of ["CARRIED", "ALL"]) {
    const im = implied(width);
    const netOnHand = hubHeld + peHeld;
    console.log(`  ${width.padEnd(8)} hub2 wants ${String(im.hubWant).padStart(5)} (${im.hubPids} colours × ${HUB_TARGET})   shops want ${String(im.shopWant).padStart(5)}   TOTAL ${String(im.total).padStart(5)}`);
    console.log(`  ${"".padEnd(8)} against on hand: hub2 ${hubHeld} + shops ${peHeld} = ${netOnHand}, central ${centralHeld}`);
    console.log(`  ${"".padEnd(8)} shortfall vs everything in the network (${netOnHand + centralHeld}): ${im.total - netOnHand - centralHeld > 0 ? `${im.total - netOnHand - centralHeld} units SHORT — the policy cannot be met from stock on hand` : `${netOnHand + centralHeld - im.total} units spare`}`);
  }

  // ── cover across the Central→hub lead time ─────────────────────────────────
  console.log(`\n── COVER AT hub2 ACROSS THE CENTRAL→HUB LEAD TIME ─────────────────────────`);
  // Draw rate: beanie units leaving hub2 for the shops, measured on the ledger.
  const DAY = 86400000;
  const since = nowMs - 45 * DAY;
  let hubOut = 0, sold = 0, spanFirst = null;
  for (const m of movements) {
    if (!beanieSet.has(m.productId)) continue;
    const ts = Date.parse(m.ts || m.appliedAt || 0) || 0;
    if (!ts || ts < since) continue;
    if (spanFirst === null || ts < spanFirst) spanFirst = ts;
    if (m.from === HUB && m.to && m.to !== HUB) hubOut += Number(m.qty) || 0;
    if (m.type === "sold") sold += Number(m.qty) || 0;
  }
  const spanDays = spanFirst ? Math.max((nowMs - spanFirst) / DAY, 1) : 45;
  const drawPerDay = hubOut / spanDays;
  const soldPerDay = sold / spanDays;
  console.log(`  measured over ${spanDays.toFixed(0)} days of ledger: ${hubOut} units left hub2 (${drawPerDay.toFixed(2)}/day), ${sold} sold at the shops (${soldPerDay.toFixed(2)}/day)`);
  console.log(`  Central→hub2 lead time (that lane's own fulfilled requests): p50 ${LEAD_P50_H}h, p90 ${LEAD_P90_H}h`);
  // An average across 81 colours flatters the answer — the draw is concentrated.
  // Report the average AND the busiest colour, and judge cover on the busiest.
  const perPid = new Map();
  for (const m of movements) {
    if (!beanieSet.has(m.productId) || m.from !== HUB || !m.to || m.to === HUB) continue;
    const ts = Date.parse(m.ts || m.appliedAt || 0) || 0;
    if (!ts || ts < since) continue;
    perPid.set(m.productId, (perPid.get(m.productId) || 0) + (Number(m.qty) || 0));
  }
  const rates = [...perPid.values()].map((u) => u / spanDays).sort((a, b) => a - b);
  const meanColourDraw = drawPerDay / Math.max(carried[HUB].length, 1);
  const p90ColourDraw = rates.length ? rates[Math.floor(rates.length * 0.9)] : 0;
  const maxColourDraw = rates.length ? rates.at(-1) : 0;
  console.log(`  per-colour draw from ${HUB}: mean ${meanColourDraw.toFixed(3)}/day across ${carried[HUB].length} carried colours;`);
  console.log(`  ${"".padEnd(2)}of the ${rates.length} colours that actually moved: p90 ${p90ColourDraw.toFixed(3)}/day, busiest ${maxColourDraw.toFixed(3)}/day`);
  for (const [label, rp] of [["reorderPoint 0", 0], ["reorderPoint absent", null], ["reorderPoint 8", 8]]) {
    // "absent" asks the moment the cell is below target, so the buffer standing
    // when the ask goes out is target − 1.
    const trigger = rp === null ? HUB_TARGET - 1 : rp;
    const cover = (rate) => (rate > 0 ? trigger / rate : Infinity);
    const verdict = (days) => days === Infinity ? "n/a (no measured draw)"
      : days * 24 >= LEAD_P90_H ? `covers p90 (${LEAD_P90_H}h)`
      : days * 24 >= LEAD_P50_H ? `covers p50 (${LEAD_P50_H}h) but NOT p90`
      : `does NOT cover even p50 (${LEAD_P50_H}h)`;
    console.log(`  ${label.padEnd(20)} hub2 re-asks central while still holding ${trigger}/colour`);
    console.log(`  ${"".padEnd(20)} cover on the BUSIEST colour: ${cover(maxColourDraw) === Infinity ? "n/a" : `${cover(maxColourDraw).toFixed(1)} days`} — ${verdict(cover(maxColourDraw))}`);
    console.log(`  ${"".padEnd(20)} cover on a p90 colour:      ${cover(p90ColourDraw) === Infinity ? "n/a" : `${cover(p90ColourDraw).toFixed(1)} days`} — ${verdict(cover(p90ColourDraw))}`);
    console.log(`  ${"".padEnd(20)} units this parks at hub2:   ${trigger * carried[HUB].length} across the carried colours`);
  }

  console.log(`\n── CLOTHING TRIPWIRE EXPOSURE ─────────────────────────────────────────────`);
  const anyRuleTarget = beanies.filter((pid) => {
    const t = resolveTarget({ targets: targetsBase, config, products, stock }, HUB, pid, "_");
    return t && t.source !== "explicit";
  });
  console.log(`  ruleBasedTargets is ${JSON.stringify(config.ruleBasedTargets)} and every beanie is isClothing=true.`);
  console.log(`  After the collapse, beanies resolving a NON-explicit target at ${HUB}: ${anyRuleTarget.length}`);
  console.log(`  ("_" is deliberately absent from defaultRunByStore, and no subcategory policy names`);
  console.log(`   Caps & Hats, so the rule cannot arm them — an explicit row is the only lever.`);
  console.log(`   The corollary: nothing here is reversible by flipping ruleBasedTargets. Removing`);
  console.log(`   the rows is the off switch, and #342 made an explicit row outlive the kill switch.)`);
  const subPolicy = config?.subcategoryRunByLocation || {};
  const capsNamed = Object.entries(subPolicy).filter(([, run]) => run && "Caps & Hats" in run);
  console.log(`  subcategoryRunByLocation naming "Caps & Hats": ${capsNamed.length ? JSON.stringify(Object.fromEntries(capsNamed)) : "none — adding one would arm all 190 caps too, not just beanies"}`);

  writeFileSync(OUT, JSON.stringify({ modelledAt: new Date().toISOString(), scope: beanies.length, carried:
    Object.fromEntries(Object.entries(carried).map(([k, v]) => [k, v.length])),
    onHand: { central: centralHeld, hub2: hubHeld, "marathon-pe": peHeld },
    leadTimeHours: { p50: LEAD_P50_H, p90: LEAD_P90_H }, drawPerDay, soldPerDay, results }, null, 2));
  console.log(`\n  JSON: ${OUT}`);
  console.log(`  NOTHING WAS WRITTEN — no target row, no config key.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
