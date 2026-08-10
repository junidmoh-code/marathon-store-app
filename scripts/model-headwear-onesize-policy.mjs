// ─── HEADWEAR ONE-SIZE COLLAPSE — COMMIT 4: POLICY MODEL (WRITES NO RTDB) ─────
//
// Models the decided policy — 5 per design at each shop, 15 at hub2, hub2's
// reorderPoint ABSENT — over a POST-COLLAPSE simulation of the live database,
// and emits the exact /stock_targets payload that would arm it.
//
// IT WRITES NOTHING TO RTDB. Ever. No target row, no config key. The only thing
// it puts on disk is the payload FILE, which is inert until somebody runs
// scripts/apply-headwear-policy.mjs --execute against it. The arming decision is
// the owner's and is made separately.
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
// ── WHICH LOCATIONS GET ARMED, AND THE TRAP IN THAT QUESTION ─────────────────
// "Which locations currently carry headwear" has TWO answers, and the gap
// between them is a known way to arm demand that should not exist:
//
//   BY CELL PRESENCE (what storeCarries actually tests — a cell node EXISTS):
//     marathon-pe 232, hub2 158, central 69, marathon-pine 3
//   BY STOCK ACTUALLY HELD (a cell with a non-zero quantity):
//     marathon-pe 177, hub2 78, central 69, marathon-pine 0
//
// marathon-pine's three cap cells are all qty 0, lastType "transfer_out",
// stamped by a reconciliation run on 2026-08-01. Pine is a real, busy store
// (474 products, 2,122 units) that has never stocked headwear — those husks are
// the residue of stock leaving, not evidence of an assortment. Arming them
// would manufacture 15 units of demand at a store that does not sell hats, the
// same shape as the PE/Trophy clothing contamination. Trophy carries no
// headwear cell at all. So the recommendation is hub2 + marathon-pe, and this
// script reports exactly what including pine or trophy would cost so the choice
// is made on numbers.
//
// ── minQty IS NOT OPTIONAL, EVEN THOUGH THE POLICY DOES NOT MENTION IT ───────
// The LIVE rule at /stock_targets/$loc/$pid/$size requires
// hasChildren(['target','minQty']) with both numeric. A row without minQty is
// invalid and any client write of it bounces. It drives ONE thing in the engine
// — card priority (`have < minQty ? "high" : "normal"`) — so it is set to
// ceil(target/2), which splits "topping up" from "nearly out" instead of
// marking every card high.
//
// Usage: node scripts/model-headwear-onesize-policy.mjs
//        MODEL_JSON=/path/model.json PAYLOAD_JSON=/path/payload.json \
//          node scripts/model-headwear-onesize-policy.mjs
//        SHOPS=marathon-pe,trophy node scripts/model-headwear-onesize-policy.mjs

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isInScope, headwearKind } from "./lib/headwearCollapseCore.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { computeRefillPlan, resolveTarget } = require("../functions/lib/refill-engine.cjs");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const g = (p) => db.ref(p).once("value").then((s) => s.val());

// ── THE DECIDED POLICY ───────────────────────────────────────────────────────
const SHOP_TARGET = 5;              // per design, per shop
const HUB_TARGET = 15;              // per design at hub2
const HUB = "hub2";
const HUB_REORDER_POINT = null;     // ABSENT — hub2 re-asks central as soon as it is below target
const SHOP_REORDER_POINT = 0;       // a shop re-asks only when the cell hits zero
const BATCH_ID = "headwear-onesize-policy";
// Overridable so the "what would trophy/pine cost" question can be answered by
// running it, not by arguing about it.
const SHOPS = (process.env.SHOPS || "marathon-pe").split(",").map((s) => s.trim()).filter(Boolean);

const OUT = process.env.MODEL_JSON || join(tmpdir(), `headwear-policy-model-${Date.now()}.json`);
const PAYLOAD_OUT = process.env.PAYLOAD_JSON || join(tmpdir(), `headwear-policy-payload-${Date.now()}.json`);

// Measured on the live ledger (2026-08-10): the Central→hub2 lane's own
// fulfilled refill requests, created → resolved.
const LEAD_P50_H = 17.0, LEAD_P90_H = 49.8;

const cellQty = (stock, loc, pid, key) => {
  const q = stock?.[loc]?.[pid]?.[key]?.qty;
  return typeof q === "number" ? q : 0;
};
const minQtyFor = (target) => Math.ceil(target / 2);

(async () => {
  console.log(`\n${"═".repeat(78)}\n  HEADWEAR ONE-SIZE POLICY MODEL — shop ${SHOP_TARGET} (reorderPoint ${SHOP_REORDER_POINT}) / ${HUB} ${HUB_TARGET} (reorderPoint ABSENT)\n  WRITES NOTHING TO RTDB\n${"═".repeat(78)}`);

  const [config, targetsLive, stockLive, productsLive, openIndex, refillRequests, orders, movementsRaw, targetDecisions, rejectStreak, retryState, locations] =
    await Promise.all([
      g("config/refillEngine"), g("stock_targets"), g("stock"), g("products"),
      g("refill_engine/open"), g("refill_requests"), g("orders"), g("stock_movements"),
      g("stock_targets_decisions"), g("refill_engine/rejectStreak"), g("refill_engine/retryState"),
      g("locations"),
    ]).then((r) => r.map((v) => v || {}));

  const headwear = Object.entries(productsLive).filter(([, p]) => isInScope(p)).map(([pid]) => pid);
  const headwearSet = new Set(headwear);
  const kindOf = Object.fromEntries(Object.entries(productsLive).filter(([, p]) => isInScope(p)).map(([pid, p]) => [pid, headwearKind(p)]));
  console.log(`  in scope: ${headwear.length} products (${headwear.filter((p) => kindOf[p] === "beanie").length} beanies, ${headwear.filter((p) => kindOf[p] === "cap").length} caps)`);

  // ── post-collapse simulation ───────────────────────────────────────────────
  const products = JSON.parse(JSON.stringify(productsLive));
  const stock = JSON.parse(JSON.stringify(stockLive));
  const targetsBase = JSON.parse(JSON.stringify(targetsLive));
  let retiredRows = 0;
  for (const pid of headwear) {
    products[pid].sizes = ["_"];
    for (const loc of Object.keys(stock)) {
      const bySize = stock[loc]?.[pid];
      if (!bySize) continue;
      let merged = cellQty(stock, loc, pid, "_");
      let moved = false;
      for (const [k, cell] of Object.entries(bySize)) {
        if (k === "_") continue;
        const q = typeof cell?.qty === "number" ? cell.qty : 0;
        if (q !== 0) moved = true;
        merged += q;
        cell.qty = 0;                       // the husk stays — storeCarries reads node presence
      }
      // Create a "_" cell ONLY where the migration would: it takes a paired
      // movement to mint one, and a location holding nothing but zero husks
      // gets no pair and therefore no "_" cell. Minting one here would model a
      // state the migration does not produce. (CodeRabbit, PR #343.)
      if (moved || bySize._) {
        bySize._ = { ...(bySize._ || { v: 0, mv: "model", lastType: "adjustment" }), qty: merged };
      }
    }
    for (const loc of Object.keys(targetsBase)) {
      for (const k of Object.keys(targetsBase[loc]?.[pid] || {})) {
        if (k !== "_") { targetsBase[loc][pid][k] = { target: 0, minQty: 0, source: "excluded" }; retiredRows++; }
      }
    }
  }

  // ── who carries what — presence vs stock actually held ─────────────────────
  const carriedBy = (loc, test) => headwear.filter((pid) => {
    const cells = stockLive?.[loc]?.[pid];
    if (!cells || !Object.keys(cells).length) return false;
    return test === "presence" || Object.values(cells).some((c) => (typeof c?.qty === "number" ? c.qty : 0) !== 0);
  });
  const allLocs = Object.keys(stockLive).filter((loc) => carriedBy(loc, "presence").length);
  console.log(`\n── WHICH LOCATIONS CARRY HEADWEAR ─────────────────────────────────────────`);
  console.log(`  ${"location".padEnd(16)} ${"kind".padEnd(10)} ${"cells exist".padStart(11)} ${"holding stock".padStart(14)} ${"units".padStart(7)}`);
  for (const loc of allLocs.sort()) {
    const pres = carriedBy(loc, "presence"), held = carriedBy(loc, "held");
    const units = held.reduce((t, pid) => t + Object.values(stockLive[loc][pid]).reduce((a, c) => a + (typeof c?.qty === "number" ? c.qty : 0), 0), 0);
    console.log(`  ${loc.padEnd(16)} ${String(locations[loc]?.kind || "?").padEnd(10)} ${String(pres.length).padStart(11)} ${String(held.length).padStart(14)} ${String(units).padStart(7)}`);
  }
  const husksOnly = allLocs.filter((loc) => carriedBy(loc, "presence").length && !carriedBy(loc, "held").length);
  if (husksOnly.length) {
    console.log(`\n  ⚠ ${husksOnly.join(", ")} carr${husksOnly.length === 1 ? "ies" : "y"} headwear CELLS but zero units — empty husks.`);
    console.log(`    storeCarries() reads node presence, so the engine treats these as assortment.`);
    console.log(`    They are NOT armed by this model. Arming them would manufacture demand at a`);
    console.log(`    store that has never stocked headwear (the PE/Trophy contamination shape).`);
    for (const loc of husksOnly) for (const pid of carriedBy(loc, "presence")) {
      console.log(`      ${loc}/${pid} "${productsLive[pid].name}" ${JSON.stringify(stockLive[loc][pid])}`);
    }
  }
  const notCarrying = ["trophy", "marathon-pine"].filter((l) => locations[l] && !carriedBy(l, "held").length);
  console.log(`\n  ARMING: ${HUB} + ${SHOPS.join(", ")}${notCarrying.length ? `   (NOT arming ${notCarrying.join(", ")} — no headwear stock)` : ""}`);

  const centralHeld = headwear.reduce((t, pid) => t + cellQty(stock, "central", pid, "_"), 0);
  const hubHeld = headwear.reduce((t, pid) => t + cellQty(stock, HUB, pid, "_"), 0);
  const shopHeld = Object.fromEntries(SHOPS.map((s) => [s, headwear.reduce((t, pid) => t + cellQty(stock, s, pid, "_"), 0)]));
  const shopsHeld = Object.values(shopHeld).reduce((a, b) => a + b, 0);
  console.log(`  post-collapse on hand: central=${centralHeld}  ${HUB}=${hubHeld}  ${SHOPS.map((s) => `${s}=${shopHeld[s]}`).join("  ")}`);

  // ── the proposed rows (IN MEMORY, then to a payload FILE) ──────────────────
  // ARMING WIDTH: only where the location already carries the product. Arming
  // every product everywhere would create rows for products a location has
  // never seen, which is demand invented by a script rather than observed.
  const carriedAt = (loc) => carriedBy(loc, "presence");
  const payload = {};                      // FLAT path → row (multi-path update shape)
  const proposed = { [HUB]: {}, ...Object.fromEntries(SHOPS.map((s) => [s, {}])) };
  const row = (target, reorderPoint) => ({
    target, minQty: minQtyFor(target),
    ...(reorderPoint == null ? {} : { reorderPoint }),
    source: "explicit", batchId: BATCH_ID, approvedBy: "owner", approvedAt: null,
  });
  for (const pid of carriedAt(HUB)) proposed[HUB][pid] = row(HUB_TARGET, HUB_REORDER_POINT);
  for (const shop of SHOPS) for (const pid of carriedAt(shop)) proposed[shop][pid] = row(SHOP_TARGET, SHOP_REORDER_POINT);
  for (const [loc, byPid] of Object.entries(proposed)) {
    for (const [pid, r] of Object.entries(byPid)) payload[`${loc}/${pid}/_`] = r;
  }

  const targets = JSON.parse(JSON.stringify(targetsBase));
  for (const [loc, byPid] of Object.entries(proposed)) {
    for (const [pid, r] of Object.entries(byPid)) (targets[loc] = targets[loc] || {})[pid] = { ...(targets[loc][pid] || {}), _: r };
  }

  // WINDOW THE LEDGER THE WAY THE SCAN DOES. Production reads
  // stock_movements orderByChild("ts").startAt(now − 45 days)
  // (refill-scan.cjs MOVEMENTS_WINDOW_DAYS). Handing the engine the whole
  // 50k-record ledger models a scan that never happens, and several gates read
  // that slice as evidence — arrival lifts, the confirmed-out window, in-flight
  // detection — so an unwindowed slice can change the classification it is
  // supposed to be measuring. (CodeRabbit, PR #343.)
  const nowMs = Date.now();
  const MOVEMENTS_WINDOW_DAYS = 45;
  const windowStart = new Date(nowMs - MOVEMENTS_WINDOW_DAYS * 86400000).toISOString();
  const movements = Object.entries(movementsRaw)
    .map(([id, m]) => ({ id, ...m }))
    .filter((m) => (m.ts || "") >= windowStart);
  console.log(`  ledger slice: ${movements.length} of ${Object.keys(movementsRaw).length} movements (${MOVEMENTS_WINDOW_DAYS}-day window, as the scan reads it)`);

  // ── DAY ONE, AS THE ENGINE WOULD SEE IT ────────────────────────────────────
  const plan = computeRefillPlan({
    nowMs, config, targets, stock, products, openIndex, refillRequests, orders, movements,
    targetDecisions, rejectStreak, retryState,
  });
  const truncated = [];
  for (const [name, l] of Object.entries(plan.exceptions || {})) {
    if (l && typeof l.count === "number" && l.items && l.count > l.items.length) truncated.push(`${name} ${l.items.length}/${l.count}`);
  }
  const inList = (list, loc, pid) => (plan.exceptions?.[list]?.items || []).some((r) => r.loc === loc && r.pid === pid);
  // INBOUND, the way the engine counts it: units already promised to this cell
  // by an open engine intent. AT TARGET is on-hand PLUS inbound meeting target
  // (engine: deficit = target − have − inbound). (CodeRabbit, PR #343.)
  const inboundFor = (loc, pid) => {
    let n = 0;
    for (const [sizeKey, entry] of Object.entries(openIndex?.[loc]?.[pid] || {})) {
      if (sizeKey !== "_") continue;
      n += Number(entry?.qty) || 1;
    }
    return n;
  };
  const rows = [];
  for (const loc of [HUB, ...SHOPS]) {
    for (const pid of headwear) {
      const t = resolveTarget({ targets, config, products, stock }, loc, pid, "_");
      if (!t || t.target <= 0) continue;
      // Math.max(q, 0) is the ENGINE'S OWN reading, not a convenience here:
      // refill-engine.cjs:166 `const avail = (q) => Math.max(q, 0)` and :1159
      // `const have = avail(q)`. A negative cell is an oversell signal, not
      // negative stock, and the deficit maths refuses to let it inflate demand.
      // The visible consequence is that a location's "on hand" here reads
      // HIGHER than the census total for the same location whenever a merged
      // "_" cell is negative — 403 vs 396 at marathon-pe today. Both numbers
      // are right; they answer different questions, and this one has to answer
      // the engine's.
      const have = Math.max(cellQty(stock, loc, pid, "_"), 0);
      const inbound = inboundFor(loc, pid);
      const deficit = t.target - have - inbound;
      let cls;
      if (deficit <= 0) cls = "AT TARGET";
      else if (t.reorderPoint != null && have > t.reorderPoint) cls = "SILENT";
      else if (plan.intents.some((i) => i.dest === loc && i.productId === pid)) cls = "REQUEST";
      else cls = "PARKED";
      rows.push({ loc, pid, kind: kindOf[pid], name: products[pid].name, have, inbound,
        target: t.target, reorderPoint: t.reorderPoint ?? null, deficit: Math.max(deficit, 0), cls,
        parkedReason: cls !== "PARKED" ? null
          : ["awaitingUpstream", "awaitingSupplier", "waitingForStock", "missingSizes", "recountNeeded"]
            .find((l) => inList(l, loc, pid)) || "below target, no card produced" });
    }
  }

  console.log(`\n── DAY-ONE CLASSIFICATION, PER LOCATION ───────────────────────────────────`);
  console.log(`  ${"location".padEnd(13)} ${"cells".padStart(5)} ${"REQUEST".padStart(8)} ${"SILENT".padStart(7)} ${"PARKED".padStart(7)} ${"AT TGT".padStart(7)} ${"on hand".padStart(8)} ${"wanted".padStart(7)} ${"short".padStart(6)}`);
  const byLoc = {};
  for (const r of rows) {
    const c = byLoc[r.loc] = byLoc[r.loc] || { REQUEST: 0, SILENT: 0, PARKED: 0, "AT TARGET": 0, cells: 0, units: 0, wanted: 0, deficit: 0 };
    c[r.cls]++; c.cells++; c.units += r.have; c.wanted += r.target; c.deficit += r.deficit;
  }
  for (const [loc, c] of Object.entries(byLoc)) {
    console.log(`  ${loc.padEnd(13)} ${String(c.cells).padStart(5)} ${String(c.REQUEST).padStart(8)} ${String(c.SILENT).padStart(7)} ${String(c.PARKED).padStart(7)} ${String(c["AT TARGET"]).padStart(7)} ${String(c.units).padStart(8)} ${String(c.wanted).padStart(7)} ${String(c.deficit).padStart(6)}`);
  }
  const hwIntents = plan.intents.filter((i) => headwearSet.has(i.productId));
  const requestUnits = hwIntents.reduce((t, i) => t + i.qty, 0);
  console.log(`\n  headwear intents this scan: ${hwIntents.length} (${requestUnits} units)`);
  console.log(`  engine computed ${plan.policy.intentsComputed} clothing intents overall against a cap of ${plan.policy.maxIntentsPerRun}${plan.policy.throttled ? " — THROTTLED, so day one lands over several scans" : ""}`);
  if (truncated.length) console.log(`  NOTE — engine capped these exception lists, so PARKED detail is partial: ${truncated.join(", ")}`);
  const parkedWhy = {};
  for (const r of rows) if (r.cls === "PARKED") parkedWhy[r.parkedReason] = (parkedWhy[r.parkedReason] || 0) + 1;
  if (Object.keys(parkedWhy).length) console.log(`  PARKED breakdown: ${Object.entries(parkedWhy).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // ── target-cell counts, before and after ──────────────────────────────────
  const countRows = (t) => {
    let sized = 0, one = 0, live = 0;
    for (const byPid of Object.values(t)) for (const pid of headwear) {
      for (const [k, r] of Object.entries(byPid?.[pid] || {})) {
        if (k === "_") one++; else sized++;
        if (r && r.target > 0) live++;
      }
    }
    return { sized, one, live, total: sized + one };
  };
  const before = countRows(targetsLive), after = countRows(targets);
  console.log(`\n── TARGET-CELL COUNTS ─────────────────────────────────────────────────────`);
  console.log(`  ${"".padEnd(22)} ${"sized rows".padStart(11)} ${'"_" rows'.padStart(9)} ${"total".padStart(7)} ${"with target>0".padStart(14)}`);
  console.log(`  ${"before (live today)".padEnd(22)} ${String(before.sized).padStart(11)} ${String(before.one).padStart(9)} ${String(before.total).padStart(7)} ${String(before.live).padStart(14)}`);
  console.log(`  ${"after collapse+policy".padEnd(22)} ${String(after.sized).padStart(11)} ${String(after.one).padStart(9)} ${String(after.total).padStart(7)} ${String(after.live).padStart(14)}`);
  console.log(`  the migration's Step 3 retires ${retiredRows} sized rows to target 0 ("excluded" — kept, not deleted,`);
  console.log(`  because target 0 is how the engine records a deliberate exclusion). This policy then`);
  console.log(`  adds ${Object.keys(payload).length} new "_" rows.`);

  // ── what the policy wants vs what exists ──────────────────────────────────
  const hubWant = carriedAt(HUB).length * HUB_TARGET;
  const shopWant = SHOPS.reduce((t, s) => t + carriedAt(s).length * SHOP_TARGET, 0);
  const total = hubWant + shopWant;
  const netOnHand = hubHeld + shopsHeld;
  console.log(`\n── WHAT THE POLICY WANTS vs WHAT EXISTS ───────────────────────────────────`);
  console.log(`  ${HUB} wants ${hubWant} (${carriedAt(HUB).length} designs × ${HUB_TARGET})`);
  for (const s of SHOPS) console.log(`  ${s} wants ${carriedAt(s).length * SHOP_TARGET} (${carriedAt(s).length} designs × ${SHOP_TARGET})`);
  console.log(`  TOTAL WANTED ${total}   against on hand at those locations: ${netOnHand}`);
  console.log(`  CENTRAL HOLDS ${centralHeld} — the only place the deficit can be filled from.`);
  const gap = total - netOnHand - centralHeld;
  console.log(`  Everything in the network is ${netOnHand + centralHeld}, so the policy is ${gap > 0 ? `${gap} units SHORT — it cannot be met from stock on hand and the remainder sits PARKED against a purchase order` : `${-gap} units within reach`}.`);

  // ── cover across the Central→hub lead time ─────────────────────────────────
  console.log(`\n── COVER AT ${HUB} ACROSS THE CENTRAL→HUB LEAD TIME ───────────────────────────`);
  const DAY = 86400000;
  const since = nowMs - 45 * DAY;
  let hubOut = 0, sold = 0, spanFirst = null;
  const perPid = new Map();
  for (const m of movements) {
    if (!headwearSet.has(m.productId)) continue;
    const ts = Date.parse(m.ts || m.appliedAt || 0) || 0;
    if (!ts || ts < since) continue;
    if (spanFirst === null || ts < spanFirst) spanFirst = ts;
    if (m.from === HUB && m.to && m.to !== HUB) {
      hubOut += Number(m.qty) || 0;
      perPid.set(m.productId, (perPid.get(m.productId) || 0) + (Number(m.qty) || 0));
    }
    if (m.type === "sold" && SHOPS.includes(m.from)) sold += Number(m.qty) || 0;
  }
  const spanDays = spanFirst ? Math.max((nowMs - spanFirst) / DAY, 1) : 45;
  const drawPerDay = hubOut / spanDays;
  console.log(`  measured over ${spanDays.toFixed(0)} days of ledger: ${hubOut} units left ${HUB} (${drawPerDay.toFixed(2)}/day), ${sold} sold at ${SHOPS.join("/")} (${(sold / spanDays).toFixed(2)}/day)`);
  console.log(`  Central→${HUB} lead time (that lane's own fulfilled requests): p50 ${LEAD_P50_H}h, p90 ${LEAD_P90_H}h`);
  // An average across ~230 designs flatters the answer — the draw is concentrated.
  const rates = [...perPid.values()].map((u) => u / spanDays).sort((a, b) => a - b);
  const p90ColourDraw = rates.length ? rates[Math.floor(rates.length * 0.9)] : 0;
  const maxColourDraw = rates.length ? rates.at(-1) : 0;
  console.log(`  per-design draw from ${HUB}: mean ${(drawPerDay / Math.max(carriedAt(HUB).length, 1)).toFixed(3)}/day across ${carriedAt(HUB).length} carried designs;`);
  console.log(`  of the ${rates.length} designs that actually moved: p90 ${p90ColourDraw.toFixed(3)}/day, busiest ${maxColourDraw.toFixed(3)}/day`);
  // reorderPoint ABSENT → the ask goes out the moment the cell is below target,
  // so the buffer standing when it does is target − 1.
  const trigger = HUB_TARGET - 1;
  const cover = (rate) => (rate > 0 ? trigger / rate : Infinity);
  const verdict = (d) => d === Infinity ? "n/a (no measured draw)"
    : d * 24 >= LEAD_P90_H ? `covers p90 (${LEAD_P90_H}h)`
    : d * 24 >= LEAD_P50_H ? `covers p50 (${LEAD_P50_H}h) but NOT p90`
    : `does NOT cover even p50 (${LEAD_P50_H}h)`;
  console.log(`  reorderPoint ABSENT → ${HUB} re-asks central while still holding ${trigger}/design`);
  console.log(`     cover on the BUSIEST design: ${cover(maxColourDraw) === Infinity ? "n/a" : `${cover(maxColourDraw).toFixed(1)} days`} — ${verdict(cover(maxColourDraw))}`);
  console.log(`     cover on a p90 design:      ${cover(p90ColourDraw) === Infinity ? "n/a" : `${cover(p90ColourDraw).toFixed(1)} days`} — ${verdict(cover(p90ColourDraw))}`);

  // ── the clothing tripwire ─────────────────────────────────────────────────
  console.log(`\n── CLOTHING TRIPWIRE EXPOSURE ─────────────────────────────────────────────`);
  const anyRuleTarget = headwear.filter((pid) => {
    const t = resolveTarget({ targets: targetsBase, config, products, stock }, HUB, pid, "_");
    return t && t.source !== "explicit";
  });
  console.log(`  ruleBasedTargets is ${JSON.stringify(config.ruleBasedTargets)} and every headwear record is isClothing=true.`);
  console.log(`  After the collapse, headwear resolving a NON-explicit target at ${HUB}: ${anyRuleTarget.length}`);
  console.log(`  "_" is deliberately absent from defaultRunByStore (${JSON.stringify(Object.keys(config.defaultRunByStore?.[HUB] || {}))}),`);
  console.log(`  and no subcategory policy names "Caps & Hats" (${JSON.stringify(config.subcategoryRunByLocation)}),`);
  console.log(`  so the rule CANNOT arm a one-size product — an explicit row is the only lever.`);
  console.log(`  THE COROLLARY: none of this is reversible by flipping ruleBasedTargets. Since #342 an`);
  console.log(`  explicit row outlives the kill switch, so DELETING THE ROWS IS THE OFF SWITCH.`);
  const capsInSubcat = Object.values(productsLive).filter((p) => p?.subcategory === "Caps & Hats" && !isInScope(p)).length;
  console.log(`  (Adding "Caps & Hats" to subcategoryRunByLocation would also arm the ${capsInSubcat} shelf-mates`);
  console.log(`   this migration deliberately excludes — visors and bucket hats. Do not use that lever.)`);

  // ── the payload + the commands ────────────────────────────────────────────
  writeFileSync(PAYLOAD_OUT, JSON.stringify(payload, null, 2));
  const rollback = Object.fromEntries(Object.keys(payload).map((k) => [k, null]));
  const ROLLBACK_OUT = PAYLOAD_OUT.replace(/\.json$/, "") + ".rollback.json";
  writeFileSync(ROLLBACK_OUT, JSON.stringify(rollback, null, 2));

  console.log(`\n── THE PAYLOAD (written to disk, NOT to the database) ─────────────────────`);
  console.log(`  ${Object.keys(payload).length} rows: ${Object.keys(proposed[HUB]).length} at ${HUB} (target ${HUB_TARGET}, minQty ${minQtyFor(HUB_TARGET)}, NO reorderPoint)`);
  for (const s of SHOPS) console.log(`  ${" ".repeat(String(Object.keys(payload).length).length)}  ${Object.keys(proposed[s]).length} at ${s} (target ${SHOP_TARGET}, minQty ${minQtyFor(SHOP_TARGET)}, reorderPoint ${SHOP_REORDER_POINT})`);
  console.log(`  payload:  ${PAYLOAD_OUT}`);
  console.log(`  rollback: ${ROLLBACK_OUT}`);
  console.log(`\n  sample row (${HUB}):        ${JSON.stringify(Object.values(proposed[HUB])[0])}`);
  console.log(`  sample row (${SHOPS[0]}): ${JSON.stringify(Object.values(proposed[SHOPS[0]] || {})[0])}`);
  console.log(`\n  ARM IT (dry run first — the apply script refuses any product that has not collapsed):`);
  console.log(`     node scripts/apply-headwear-policy.mjs ${PAYLOAD_OUT}`);
  console.log(`     node scripts/apply-headwear-policy.mjs ${PAYLOAD_OUT} --execute`);
  console.log(`  TURN IT OFF (removing the rows is the off switch — the kill switch cannot reach them):`);
  console.log(`     node scripts/apply-headwear-policy.mjs ${ROLLBACK_OUT} --execute --delete`);

  writeFileSync(OUT, JSON.stringify({ modelledAt: new Date().toISOString(), scope: headwear.length,
    policy: { SHOP_TARGET, HUB_TARGET, HUB, HUB_REORDER_POINT, SHOP_REORDER_POINT, SHOPS },
    carried: Object.fromEntries(allLocs.map((l) => [l, { presence: carriedBy(l, "presence").length, held: carriedBy(l, "held").length }])),
    onHand: { central: centralHeld, [HUB]: hubHeld, ...shopHeld },
    targetCells: { before, after, retiredRows, newRows: Object.keys(payload).length },
    wanted: { hub: hubWant, shops: shopWant, total, gap },
    dayOne: byLoc, rows, intents: hwIntents.length, requestUnits,
    throttled: plan.policy.throttled, intentsComputed: plan.policy.intentsComputed, truncated,
    payloadPath: PAYLOAD_OUT, rollbackPath: ROLLBACK_OUT }, null, 2));
  console.log(`\n  model JSON: ${OUT}`);
  console.log(`  NOTHING WAS WRITTEN TO RTDB — no target row, no config key.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
