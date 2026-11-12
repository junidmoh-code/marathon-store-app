// ─── CONCRETE DIVISION — READ-ONLY LIVE SNAPSHOT (Junid, 10 Nov 2026) ────────
// WRITES NOTHING TO THE DATABASE. Paged per-location reads, scoped queries only
// (no whole-node read). Everything the scan's plan reads for the division, plus
// the seats and the ledger since 30 Oct, saved to one local JSON file so the
// diagnosis, the audit and the next-scan dry run replay the same data.
//   node scripts/audit/concrete-division-dump.mjs <out.json>
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const req = (() => { try { const r = createRequire(join(ROOT, "functions", "package.json")); r.resolve("firebase-admin"); return r; } catch { return adminRequire(import.meta.url); } })();
const admin = req("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const LOCS = ["central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "concrete", "in_transit"];
const once = async (p) => (await db.ref(p).once("value")).val();
const SINCE = process.argv[3] || "2026-10-30T00:00:00.000Z";

const out = { readAt: new Date().toISOString(), since: SINCE };
out.config = (await once("config/refillEngine")) || {};
out.network = await once("network");
out.locations = await once("locations");
out.products = await readMapPaged(db, "products");
out.stock = {};
for (const l of LOCS) out.stock[l] = await readMapPaged(db, `stock/${l}`);
out.targets = {};
for (const l of LOCS) if (l !== "central" && l !== "in_transit") out.targets[l] = await readMapPaged(db, `stock_targets/${l}`);
out.open = (await once("refill_engine/open")) || {};
out.seats = {};
out.seatReleases = {};
for (const l of ["hub3", "marathon-pine", "concrete"]) {
  out.seats[l] = (await once(`refill_engine/seats/${l}`)) || {};
  out.seatReleases[l] = (await once(`refill_engine/seatReleases/${l}`)) || {};
}
out.held = (await once("settings/stockHold/held")) || {};
out.rejectStreak = (await once("refill_engine/rejectStreak")) || {};
out.retryState = (await once("refill_engine/retryState")) || {};
// Push ids only: "web_…" keys sort after them and would crowd the window out.
const recent = await db.ref("refill_requests").orderByKey().endAt("-~").limitToLast(6000).once("value");
out.recentRequests = recent.val() || {};
out.orders = await readMapPaged(db, "orders");
const mv = await db.ref("stock_movements").orderByChild("ts").startAt(SINCE).once("value");
out.movements = mv.val() || {};
const runs = await db.ref("refill_engine/runs").orderByKey().limitToLast(12).once("value");
out.recentRuns = runs.val() || {};
writeFileSync(process.argv[2], JSON.stringify(out));
console.log("written", process.argv[2], "movements", Object.keys(out.movements).length, "requests", Object.keys(out.recentRequests).length);
process.exit(0);
