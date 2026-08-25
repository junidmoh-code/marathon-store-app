// ─── HUB 1 SNEAKER POLICY — THE DRY RUN. WRITES NOTHING TO RTDB. ─────────────
//
// Models the 2026-08-25 Hub 1 per-size sneaker policy against the LIVE
// snapshot, through the real engine (computeRefillPlan with the proposed
// config overlaid), and prints everything the arming decision needs:
//
//   1. products passing the carriedOnly scope gate, and how derived
//   2. target rows by size (declared / armed / dead-size 0)
//   3. the FULL first-scan demand (caps lifted) and the capped per-run slice
//   4. how much of it Central could actually fill (the engine's source gate)
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

// The owner's run. minQty = ceil(target/2) (the engine's own default ratio);
// reorderPoint 1 = ask when a cell drops to 1.
const RUN = {
  3: 2, 4: 2, 5: 2, "5_5": 2, 6: 3, 7: 3, 8: 3, 9: 2, 10: 2, 11: 2,
};
export const HUB1_SIZES = Object.fromEntries(Object.entries(RUN).map(([k, t]) =>
  [k, { target: t, minQty: Math.ceil(t / 2), reorderPoint: 1 }]));
const SNEAKER_POLICY = { perSize: true, hub1: { sizes: HUB1_SIZES, carriedOnly: true } };

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

  // ── 1. THE SCOPE GATE ──────────────────────────────────────────────────────
  const sneakers = Object.keys(products).filter((pid) => products[pid]?.categoryKey === "sneakers");
  const carried = sneakers.filter((pid) => stock.hub1?.[pid] && Object.keys(stock.hub1[pid]).length > 0);
  console.log(`\ncategoryKey "sneakers": ${sneakers.length} products in the catalogue`);
  console.log(`carriedOnly gate (hub1 stock cell exists): ${carried.length} products pass`);
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

  // Central fill: the engine's own source gate already caps intent qty to what
  // Central holds minus reservations, so `full` IS what Central can fill NOW.
  // The parked counts say what it cannot.
  const parked = uncapped.missingSizes || uncapped.awaitingUpstream || null;
  console.log(`deficits Central cannot fill are parked, not raised — see the plan's parked/missing buckets.`);
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
    at: new Date().toISOString(), sneakers: sneakers.length, carried: carried.length,
    fullLines: full.length, fullUnits: units, bySize, cappedFirstRun: h1(capped).length,
    othersUnchanged: same, intents: full,
  }, null, 2));
  console.log(`\nsaved: ~/hub1-sneaker-policy-dryrun.json`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
