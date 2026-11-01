// ─── HUB 2 AUDIT — SNAPSHOT DUMP (READ ONLY) ─────────────────────────────────
//
// WRITES NOTHING to the database. Reads, once, the nodes refillHealthScan reads
// (same paths, same 45-day ledger window), plus the stock of EVERY location in
// the registry (for the section-wall check) and the write-off records, and
// saves them as one JSON file per path ("/" → "_") in OUT_DIR — the census
// layout scripts/audit/refusal-writeoff-backfill.mjs and
// scripts/audit/hub2-audit.mjs replay offline.
//
//   node scripts/audit/hub2-audit-dump.mjs OUT_DIR [--since ISO]
//
// Cost: the same reads as ONE hourly scan, plus /stock for the locations the
// scan does not route (Hub 3, Concrete, Pine). Run it on a machine whose node
// reaches Google (the Mac mini); the Mac's node cannot.

import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { adminRequire } from "../adminRequire.mjs";

const out = resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: hub2-audit-dump.mjs OUT_DIR"); process.exit(2); }
mkdirSync(out, { recursive: true });

const admin = adminRequire(import.meta.url)("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const save = (p, v) => writeFileSync(join(out, `${p.replace(/\//g, "_")}.json`), JSON.stringify(v ?? null));
const val = async (p) => { const v = (await db.ref(p).once("value")).val(); save(p, v); return v; };

const WINDOW_DAYS = 45;   // functions/refill-scan.cjs MOVEMENTS_WINDOW_DAYS
const nowMs = Date.now();
// The audit looks 30 days back from every request since --since (default the
// #787 merge), so the ledger must reach that far even when the scan's 45 days
// do not (CodeRabbit #831).
const sinceIdx = process.argv.indexOf("--since");
const sinceMs = Date.parse(sinceIdx > 0 ? process.argv[sinceIdx + 1] : "2026-10-24T12:00:23Z");
const windowStartMs = Math.min(nowMs - WINDOW_DAYS * 864e5, (Number.isFinite(sinceMs) ? sinceMs : nowMs) - 31 * 864e5);
const windowStart = new Date(windowStartMs).toISOString();

const paths = [
  "config/refillEngine", "stock_targets", "stock_targets_decisions", "products",
  "refill_engine/open", "refill_requests", "orders", "refill_engine/rejectStreak",
  "refill_engine/retryState", "settings/stockHold/held", "refill_engine/refusalWriteoffCursor",
  "refill_engine/refusalWriteoffs", "refill_engine/refusalWriteoffDigestStatus",
  "refill_engine/refusalWriteoffDigestQueue", "locations", "network",
];
const got = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await val(p)])));
const mv = (await db.ref("stock_movements").orderByChild("ts").startAt(windowStart).once("value")).val() || {};
save("stock_movements", mv);
const locs = Object.keys(got.locations || {});
for (const l of new Set([...locs, "central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "concrete"])) {
  await val(`stock/${l}`);
}
// Refusers' names only (never the whole /users node).
const rr = got.refill_requests || {};
const uids = new Set(Object.values(rr).map((r) => r && r.resolvedBy).filter((u) => typeof u === "string" && u && !u.includes("/")));
const users = {};
for (const u of uids) users[u] = (await db.ref(`users/${u}/displayName`).once("value")).val() || null;
save("users", users);
writeFileSync(join(out, "_meta.json"), JSON.stringify({ nowMs, at: new Date(nowMs).toISOString(), windowStart, movements: Object.keys(mv).length }));
console.log(JSON.stringify({ out, at: new Date(nowMs).toISOString(), movements: Object.keys(mv).length, locations: locs }));
await admin.app().delete();
