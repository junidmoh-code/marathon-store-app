// ─── FIRST BATCH INCIDENT (2026-09-17) — READ-ONLY CENSUS ────────────────────
// WRITES NOTHING. Answers, from live data, the questions behind the report that
// the Source › Trophy (112) and Marathon (113) tabs were "full of shop refill
// requests sourced from Central" after PR #607/#608:
//   1. how many /refill_requests rows the first-batch path has EVER created
//      (createdFrom.firstBatch === true), in any status;
//   2. every OPEN request whose requestingLocation is a shop — its declared
//      source, its age, whether it is tagged first-batch, and whether the
//      product has any Hub 2 presence (a stock node; units);
//   3. the engine's open locks at the shops, by source;
//   4. whether any Central→shop refill fulfil (`rrf_` movement, reason
//      `{shop}_auto_refill` / `{shop}_refill_uncounted`) has landed since the
//      path went live (2026-09-17 16:05Z) — i.e. whether a tab's Fulfil moved
//      real stock from Central for a row the engine meant Hub 2 to send.
// Paged reads for /refill_requests, scoped reads for everything else.
//   node scripts/audit/first-batch-incident-census.mjs [--since ISO]
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const SINCE = opt("--since") || "2026-09-17T16:00:00.000Z";   // #607 hosting live 16:05Z
const req = (() => { try { const r = createRequire(join(ROOT, "functions", "package.json")); r.resolve("firebase-admin"); return r; } catch { return adminRequire(import.meta.url); } })();
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const SHOPS = ["marathon-pe", "trophy"];
const readAt = new Date().toISOString();
const config = (await db.ref("config/refillEngine").once("value")).val() || {};
console.log(`read at ${readAt}`);
console.log("routes", JSON.stringify(config.routes), "| enabled", config.enabled, "| mode", JSON.stringify(config.mode));
console.log("kill switches: ruleBasedTargets", config.ruleBasedTargets, "| footwearTargets", JSON.stringify(config.footwearTargets ?? null));

const refill = await readMapPaged(db, "refill_requests");
const all = Object.entries(refill).map(([id, r]) => ({ id, ...r }));
console.log(`\n/refill_requests rows: ${all.length}`);

// 1. every first-batch row ever
const fb = all.filter((r) => r.createdFrom?.firstBatch === true);
console.log(`first-batch-tagged rows (any status): ${fb.length}`);
for (const r of fb) console.log(`  ${r.id} ${r.status} ${r.requestingLocation} ${r.productId} size=${JSON.stringify(r.size)} qty=${r.qty} sent=${r.sentQty ?? 0} created=${r.createdAt} via=${r.createdFrom.via} hub2Leg=${JSON.stringify(r.firstBatch?.hub2Leg ?? null)}`);

// 2. open shop rows
const openShop = all.filter((r) => r.status === "open" && SHOPS.includes(r.requestingLocation));
const nowMs = Date.parse(readAt);
const ageH = (r) => (nowMs - Date.parse(r.createdAt)) / 3600e3;
const bucket = { "<6h": 0, "6-24h": 0, "24-48h": 0, ">=48h": 0 };
for (const r of openShop) { const h = ageH(r); if (h < 6) bucket["<6h"]++; else if (h < 24) bucket["6-24h"]++; else if (h < 48) bucket["24-48h"]++; else bucket[">=48h"]++; }
const count = (arr, f) => arr.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
console.log(`\nOPEN shop requests: ${openShop.length}`, JSON.stringify(count(openShop, (r) => r.requestingLocation)));
console.log("  by age", JSON.stringify(bucket));
console.log("  tagged first-batch:", openShop.filter((r) => r.createdFrom?.firstBatch === true).length);
console.log("  by declared source:", JSON.stringify(count(openShop, (r) => r.source || r.createdFrom?.source || "(none)")));
console.log("  by createdFrom.via:", JSON.stringify(count(openShop, (r) => r.createdFrom?.via || "(none — engine row)")));

const pids = [...new Set(openShop.map((r) => r.productId))];
let withHub2 = 0, withHub2Units = 0; const noHub2 = [];
const hub2Node = {};
for (const pid of pids) {
  const n = (await db.ref(`stock/hub2/${pid}`).once("value")).val();
  hub2Node[pid] = n;
  if (n && Object.keys(n).length) { withHub2++; if (Object.values(n).some((c) => c && c.qty > 0)) withHub2Units++; } else noHub2.push(pid);
}
console.log(`  distinct products: ${pids.length} — with a Hub 2 node: ${withHub2} (units > 0: ${withHub2Units}); with NO Hub 2 node: ${noHub2.length} ${JSON.stringify(noHub2.slice(0, 20))}`);
console.log("  oldest 5:");
for (const r of openShop.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 5))
  console.log(`    ${r.id} ${r.requestingLocation} ${r.productId} size=${JSON.stringify(r.size)} qty=${r.qty} age=${ageH(r).toFixed(1)}h source=${r.source || "-"} hub2=${JSON.stringify(Object.fromEntries(Object.entries(hub2Node[r.productId] || {}).map(([k, c]) => [k, c && c.qty])))}`);

// 3. shop locks by source
const lockSrc = {};
for (const s of SHOPS) {
  const node = (await db.ref(`refill_engine/open/${s}`).once("value")).val() || {};
  for (const bySz of Object.values(node)) for (const e of Object.values(bySz || {})) { if (!e) continue; const k = `${s}:${e.source || config.routes?.[s]}`; lockSrc[k] = (lockSrc[k] || 0) + 1; }
}
console.log("\nshop locks by source:", JSON.stringify(lockSrc));

// 4. any Central→shop refill fulfil since the path went live
const done = all.filter((r) => SHOPS.includes(r.requestingLocation) && r.status !== "open" && Date.parse(r.resolvedAt || 0) >= Date.parse(SINCE));
console.log(`\nshop rows resolved since ${SINCE}: ${done.length}`);
for (const r of done) console.log(`  ${r.id} ${r.status} ${r.requestingLocation} ${r.productId} size=${JSON.stringify(r.size)} fulfilledBy=${JSON.stringify(r.fulfilledBy ?? null)} reason=${r.cancelReason ?? "-"} fb=${!!r.createdFrom?.firstBatch}`);
const mv = (await db.ref("stock_movements").orderByChild("ts").startAt(SINCE).once("value")).val() || {};
const rows = Object.entries(mv);
const shopFulfils = rows.filter(([id, m]) => (id.startsWith("rrf_") || /^(trophy|marathon-pe)_(auto_refill|refill_uncounted)$/.test(String(m.reason || ""))) && SHOPS.includes(m.to));
console.log(`movements since ${SINCE}: ${rows.length}; rrf_ movements: ${rows.filter(([id]) => id.startsWith("rrf_")).length}; Central→shop refill fulfils: ${shopFulfils.length}`);
for (const [id, m] of shopFulfils) console.log(`  ${id} ${m.type} ${m.productId} ${m.size} qty=${m.qty} to=${m.to} reason=${m.reason} ts=${m.ts}`);
process.exit(0);
