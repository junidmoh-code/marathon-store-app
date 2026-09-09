// ─── RE-ARM SLIDES AT HUB 1 + HUB 2, THROUGH THE SEATING GATE ─────────────────
//
// DRY RUN BY DEFAULT. Pass --execute to write.
//
// The same numbers as the 2026-09-08 arming — per-size keep 3, minimum 2, ask
// at 1, over the category's size run — written through applyCategoryPolicy,
// which now scopes every NEW leg to seated products (gateNewLegsToSeated). The
// numbers are read back out of the history entry that recorded the original
// arming, not retyped, so what is re-armed is exactly what was asked for.
//
// THE SANITY CHECK IS THE POINT OF THE SCRIPT. After the dry run it resolves
// every slide at every hub through the ENGINE's own resolveTarget, against the
// live catalogue and cells, and reports the split: hub1 only / hub2 only / both
// / neither. If "both" comes anywhere near the whole catalogue the gate is not
// working, and the script REFUSES to write — a re-arm that reproduces the
// incident is worse than no re-arm.
//
// The 13 explicit rows at hub2 are neither read for the decision nor written;
// they outrank the map and keep doing so.
//
// Usage:  node scripts/rearm-slides-seated.mjs [--execute]

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "./adminRequire.mjs";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
const { applyCategoryPolicy } = require("../functions/lib/category-policy-write.cjs");
const { resolveTarget } = require("../functions/lib/refill-engine.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTE = process.argv.includes("--execute");
const CATEGORY = "slides";
const HUBS = ["hub1", "hub2"];
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const ORIGINAL_ARMING = "-P1-t_VYDbVyCVI0m-ce";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(ROOT, "var", `slides-rearm-${STAMP}.json`);

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const small = (p) => db.ref(p).once("value").then((s) => s.val());
const carries = (stockLoc, pid) => !!stockLoc?.[pid] && Object.keys(stockLoc[pid]).length > 0;

(async () => {
  console.log("═".repeat(96));
  console.log(`  RE-ARM SLIDES, SEATED ONLY${EXECUTE ? "" : "        DRY RUN — nothing will be written"}`);
  console.log("═".repeat(96));

  const live = await small(`config/refillEngine/categoryPolicy/${CATEGORY}`);
  if (live) {
    console.error(`\n  REFUSED: categoryPolicy.${CATEGORY} is already armed at ${Object.keys(live).filter((k) => k !== "perSize").join(", ")}.`);
    console.error(`  This script only ever arms a category that is absent. Reverse first, or edit through the card.`);
    process.exit(2);
  }
  const orig = await small(`engine_policy_history/${ORIGINAL_ARMING}`);
  if (!orig?.after?.hub1?.sizes || !orig?.after?.hub2?.sizes) {
    console.error(`\n  REFUSED: history entry ${ORIGINAL_ARMING} does not hold the original per-size legs.`); process.exit(2);
  }
  // The numbers, untouched; the scope is what the gate adds. Sent WITHOUT
  // carriedOnly on purpose: the run proves the server stamps it.
  const policy = { perSize: true, hub1: { sizes: orig.after.hub1.sizes }, hub2: { sizes: orig.after.hub2.sizes } };
  console.log(`\n  numbers from ${ORIGINAL_ARMING}: hub1 ${Object.keys(policy.hub1.sizes).length} sizes, hub2 ${Object.keys(policy.hub2.sizes).length} sizes, keep ${[...new Set(Object.values(policy.hub1.sizes).map((r) => r.target))].join("/")}`);

  const offset = (await small(".info/serverTimeOffset")) || 0;
  const dry = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "slides-rearm-runner",
    data: { categoryKey: CATEGORY, policy, dryRun: true }, nowMs: Date.now() + offset,
  });
  const gated = HUBS.every((h) => dry.after?.[h]?.carriedOnly === true);
  console.log(`  gate stamped carriedOnly on: ${JSON.stringify(dry.seatedOnlyLocations)}   both legs scoped: ${gated ? "yes" : "NO"}`);
  if (!gated) { console.error(`\n  REFUSED: the dry run did not scope both legs. The gate is not doing its job — nothing written.`); process.exit(3); }
  console.log(`  modelled next scan: ${dry.preview.after.totalRequests} requests, ${dry.preview.after.totalUnits} units (cap ${dry.preview.after.cap})`);

  // ── THE SPLIT, RESOLVED BY THE ENGINE AGAINST THE GATED POLICY ─────────────
  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const pids = Object.keys(products).filter((p) => products[p]?.categoryKey === CATEGORY && products[p]?.active !== false && !products[p]?.mergedInto);
  const stock = {};
  for (const loc of ["central", ...HUBS]) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 500 });
  const targets = {};
  for (const loc of HUBS) targets[loc] = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
  const config = { ...(await small("config/refillEngine")), categoryPolicy: { ...((await small("config/refillEngine/categoryPolicy")) || {}), [CATEGORY]: dry.after } };
  const ctx = { targets, config, products, stock };

  const armedAt = (loc, pid) => (products[pid].sizes || []).some((s) => {
    const t = resolveTarget(ctx, loc, pid, String(s));
    return t && t.target > 0 && t.source === "category_policy";
  });
  const split = { hub1Only: [], hub2Only: [], both: [], neither: [] };
  for (const pid of pids) {
    const a = armedAt("hub1", pid), b = armedAt("hub2", pid);
    (a && b ? split.both : a ? split.hub1Only : b ? split.hub2Only : split.neither).push(pid);
  }
  const seated = { hub1: pids.filter((p) => carries(stock.hub1, p)).length, hub2: pids.filter((p) => carries(stock.hub2, p)).length,
    both: pids.filter((p) => carries(stock.hub1, p) && carries(stock.hub2, p)).length };
  console.log(`\n  ── WHO GETS ARMED (engine resolveTarget, gated policy) ─────────────────`);
  console.log(`    live slides       ${pids.length}`);
  console.log(`    hub1 only         ${split.hub1Only.length}`);
  console.log(`    hub2 only         ${split.hub2Only.length}`);
  console.log(`    both              ${split.both.length}      (cells at both: ${seated.both})`);
  console.log(`    neither           ${split.neither.length}`);
  console.log(`    seated per hub    hub1 ${seated.hub1}   hub2 ${seated.hub2}`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), executed: EXECUTE, policySent: policy, policyGated: dry.after, split, seated,
    modelled: dry.preview.after }, null, 2));
  console.log(`\n  → ${OUT}`);

  // THE STOP. "Both" must be a small number — the products with a cell at both
  // hubs, and no more. Anything near the catalogue means unscoped.
  if (split.both.length > seated.both || split.both.length > pids.length / 2) {
    console.error(`\n  STOP: ${split.both.length} products would arm at BOTH hubs against ${seated.both} that hold a cell at both. The gate is not working. Nothing written.`);
    process.exit(4);
  }
  if (!EXECUTE) { console.log(`\n  DRY RUN — pass --execute to write.\n`); process.exit(0); }

  const res = await applyCategoryPolicy({
    db, callerEmail: ADMIN_EMAIL, adminEmail: ADMIN_EMAIL, callerUid: "slides-rearm-runner",
    data: { categoryKey: CATEGORY, policy, expectedBefore: null }, nowMs: Date.now() + offset,
  });
  const written = await small(`config/refillEngine/categoryPolicy/${CATEGORY}`);
  const ok = res.ok && HUBS.every((h) => written?.[h]?.carriedOnly === true);
  console.log(`\n  ${ok ? "✓" : "✗"} written  history ${res.historyId}   carriedOnly: hub1=${written?.hub1?.carriedOnly} hub2=${written?.hub2?.carriedOnly}\n`);
  process.exit(ok ? 0 : 5);
})().catch((e) => { console.error(e); process.exit(1); });
