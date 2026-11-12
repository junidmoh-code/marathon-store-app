// ─── HUB 3 POLICY — READ-ONLY LIVE SNAPSHOT ──────────────────────────────────
// WRITES NOTHING TO THE DATABASE. Paged per-location reads only. Saves the
// snapshot computeRefillPlan needs to one local JSON file so the investigation
// and the next-scan dry run replay the same data.
//   node scripts/audit/hub3-policy-dump.mjs <out.json>
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

const out = { readAt: new Date().toISOString() };
out.config = (await once("config/refillEngine")) || {};
out.network = await once("network");
out.locations = await once("locations");
out.products = await readMapPaged(db, "products");
out.stock = {};
for (const l of LOCS) out.stock[l] = await readMapPaged(db, `stock/${l}`);
out.targets = {};
for (const l of LOCS) if (l !== "central" && l !== "in_transit") out.targets[l] = await readMapPaged(db, `stock_targets/${l}`);
out.open = (await once("refill_engine/open")) || {};
// Newest rows by key, bounded: /refill_requests has no status index, so an
// equalTo("open") would download the whole node on the client.
const recent = await db.ref("refill_requests").orderByKey().limitToLast(4000).once("value");
out.recentRequests = recent.val() || {};
out.openRequests = Object.fromEntries(Object.entries(out.recentRequests).filter(([, r]) => r && r.status === "open"));
out.runs = await once("refill_engine/lastRun");
const runs = await db.ref("refill_engine/runs").orderByKey().limitToLast(30).once("value");
out.recentRuns = runs.val() || {};
out.seating = await once("config/seating");
writeFileSync(process.argv[2], JSON.stringify(out));
console.log("written", process.argv[2]);
process.exit(0);
