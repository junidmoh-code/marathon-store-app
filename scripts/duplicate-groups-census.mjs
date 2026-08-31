// ─── DUPLICATE GROUPS CENSUS — READ ONLY ─────────────────────────────────────
// Live count of the duplicate groups the Duplicates screen renders, worst
// first, built on the SAME pure builder the screen uses (duplicateGroups.js) so
// the report can never drift from what the owner sees. Writes NOTHING.
import admin from "firebase-admin";
import { readMapPaged } from "./lib/rtdbPaged.mjs";
import { buildDuplicateGroups } from "../src/components/stock/duplicateGroups.js";
import labelIdentity from "../functions/lib/label-identity.cjs";
const { buildIdentityMap } = labelIdentity;

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const val = async (p) => (await db.ref(p).once("value")).val();

const productsMap = await readMapPaged(db, "products", { pageSize: 400 });
const products = Object.entries(productsMap).map(([id, p]) => (p && typeof p === "object" ? { ...p, id: p.id || id } : null)).filter((p) => p && p.id && p.name);
const [aliases, styleIndex, allStock] = await Promise.all([val("label_aliases"), val("style_code_index"), val("stock")]);
const identityMap = buildIdentityMap(aliases, styleIndex);

// Sales joined on productId over the joinable window (entries before
// 2026-06-10 carry no productId — see project_insights_pre_june_unjoinable).
// Bounded by KEY RANGE (push keys encode write time — src/insights/insightsLogRange.js):
// entries before 2026-06-10 carry no productId at all, so the window IS the join.
const SINCE_KEY = "-Ouip1V-";
const salesByPid = {};
let cursor = SINCE_KEY;
for (;;) {
  const snap = await db.ref("insights_log").orderByKey().startAt(cursor).limitToFirst(3001).once("value");
  const keys = []; snap.forEach((c) => { keys.push(c.key); });
  let added = 0;
  for (const k of keys) {
    if (k === cursor && added === 0 && cursor !== SINCE_KEY) continue;
    added += 1;
    tally(snap.child(k).val());
  }
  if (keys.length < 3001) break;
  cursor = keys[keys.length - 1];
}
function tally(e) {
  if (!e || !e.productId) return;
  if (e.action !== "collected" && e.action !== "ready") return;
  const ms = Date.parse(e.timestamp || 0) || 0;
  const row = salesByPid[e.productId] || (salesByPid[e.productId] = { units: 0, lastMs: 0 });
  row.units += 1;
  if (ms > row.lastMs) row.lastMs = ms;
}

const groups = buildDuplicateGroups({ products, allStock, identityMap, salesByPid });
console.log(`GROUPS: ${groups.length}  (members ${groups.reduce((t, g) => t + g.members.length, 0)}, split-stock ${groups.filter((g) => g.split).length})`);
for (const g of groups.slice(0, Number(process.argv[2] || 40))) {
  console.log(`\n[${g.split ? "SPLIT" : "     "}] ${g.units}u ${g.sold} sold — ${g.reason}`);
  for (const m of g.members) {
    console.log(`   ${m.id === g.survivorId ? "KEEP" : "    "} ${String(m.units).padStart(4)}u ${String(m.sold).padStart(3)}s ${m.hasPhoto ? "📷" : "  "} ${m.codes[0] || "no-code"}  ${m.name}${m.deactivated ? "  [DEACTIVATED]" : ""}`);
  }
}
process.exit(0);
