// ─── PRODUCTS SEATED AT BOTH HUB 1 AND HUB 2 — READ-ONLY LIST ────────────────
// WRITES NOTHING. Reads /stock and /stock_targets for the two hubs a page at a
// time and prints the footwear the Arming tab's "Both hubs" list would show.
//   node scripts/audit/hub1-hub2-both.mjs
//
// Junid, 9 Nov 2026: list them; do not change them.
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const req = (() => { try { const r = createRequire(join(ROOT, "functions", "package.json")); r.resolve("firebase-admin"); return r; } catch { return adminRequire(import.meta.url); } })();
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
// The two pure modules vite resolves: run under vite-node (npx vite-node <this file>).
const { hubArming } = await import("../../src/components/stock/armingCore.js");
const { isFootwearProduct } = await import("../../src/components/stock/availabilityCore.js");
const { isDeactivated } = await import("../../src/utils/deactivation.js");

const products = await readMapPaged(db, "products");
for (const [id, p] of Object.entries(products)) p.id = id;
const stock = { hub1: await readMapPaged(db, "stock/hub1"), hub2: await readMapPaged(db, "stock/hub2") };
const targets = { hub1: await readMapPaged(db, "stock_targets/hub1"), hub2: await readMapPaged(db, "stock_targets/hub2") };
const config = (await db.ref("config/refillEngine").once("value")).val() || {};
const network = (await db.ref("network").once("value")).val();
const ctx = { products, stock, targets, config, network };
const units = (hub, pid) => Object.values(stock[hub]?.[pid] || {}).reduce((n, c) => n + Math.max(Number(c?.qty) || 0, 0), 0);
const rows = [];
for (const [pid, p] of Object.entries(products)) {
  if (!isFootwearProduct(p) || isDeactivated(p)) continue;
  if (hubArming(ctx, "hub1", pid).armed && hubArming(ctx, "hub2", pid).armed) rows.push({ pid, name: p.name, hub1: units("hub1", pid), hub2: units("hub2", pid) });
}
rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
console.log(JSON.stringify({ count: rows.length, rows }, null, 1));
process.exit(0);
