// READ-ONLY probe. Scoped reads for the 59 paper bags named in the #729 rollback file.
import { createRequire } from "module";
import fs from "fs";
import { adminRequire } from "./adminRequire.mjs";
const local = createRequire(import.meta.url);
const admin = adminRequire(import.meta.url)("firebase-admin");
const writer = local("../functions/lib/category-policy-write.cjs");
const RB = process.argv[2];
const rb = JSON.parse(fs.readFileSync(RB, "utf8"));
admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const val = (p) => db.ref(p).once("value").then((s) => s.val());
const pids = rb.categoryKeys.map((c) => c.pid);
const out = { at: new Date().toISOString() };
out.policy = await val("config/refillEngine/categoryPolicy/paper-bags");
out.policyKeys = Object.keys((await val("config/refillEngine/categoryPolicy")) || {});
out.configScalars = Object.fromEntries(Object.entries((await val("config/refillEngine")) || {}).filter(([k, v]) => typeof v !== "object"));
out.taxonomy = await val("settings/productTaxonomy/cats/paper-bags");
// catalogue paged, as the Engine Policy writer reads it — find any product keyed paper-bags beyond the 59
const products = await writer.readMapPaged(db, "products");
out.catalogueSize = Object.keys(products).length;
out.keyedPaperBags = Object.entries(products).filter(([, p]) => p?.categoryKey === "paper-bags").map(([pid, p]) => ({ pid, name: p.name, inRollback: pids.includes(pid) }));
out.nameMatchNotIn59 = Object.entries(products).filter(([pid, p]) => /paper\s*-?\s*bag/i.test(p?.name || "") && !pids.includes(pid)).map(([pid, p]) => ({ pid, name: p.name, categoryKey: p.categoryKey ?? null, createdAt: p.createdAt ?? null }));
out.products = {};
for (const pid of pids) out.products[pid] = { name: products[pid]?.name, categoryKey: products[pid]?.categoryKey ?? null, sizes: products[pid]?.sizes || [] };
const LOCS = ["central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine"];
const ROWLOCS = [...new Set(rb.rows.map((r) => r.loc).concat(["hub2", "marathon-pe", "trophy"]))];
out.rowLocs = ROWLOCS;
out.stock = {}; out.targets = {}; out.locks = {};
await Promise.all(pids.map(async (pid) => {
  for (const l of LOCS) { const v = await val(`stock/${l}/${pid}`); if (v) (out.stock[l] ||= {})[pid] = v; }
  for (const l of ROWLOCS) {
    const t = await val(`stock_targets/${l}/${pid}`); if (t) (out.targets[l] ||= {})[pid] = t;
    const k = await val(`refill_engine/open/${l}/${pid}`); if (k) (out.locks[l] ||= {})[pid] = k;
  }
}));
const since = "2026-10-16T17:00:00.000Z";
const rr = (await db.ref("refill_requests").orderByChild("createdAt").startAt(since).once("value")).val() || {};
out.requestsSinceTotal = Object.keys(rr).length;
out.requests = Object.entries(rr).filter(([, r]) => pids.includes(r?.productId)).map(([id, r]) => ({ id, ...r, name: products[r.productId]?.name }));
const mv = (await db.ref("stock_movements").orderByChild("ts").startAt(since).once("value")).val() || {};
out.movementsSinceTotal = Object.keys(mv).length;
out.movements = Object.entries(mv).filter(([, m]) => pids.includes(m?.productId || m?.pid)).map(([id, m]) => ({ id, ...m, name: products[m.productId || m.pid]?.name }));
out.movementSampleKeys = Object.keys(Object.values(mv)[0] || {});
const runs = (await db.ref("refill_engine/runs").orderByKey().startAt("2026-10-16T13").once("value")).val() || {};
out.runs = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { startedAt: v.startedAt, intents: v.intentsWritten ?? v.intents ?? v.summary?.intents ?? null, keys: Object.keys(v).slice(0, 25), policy: v.policy ?? v.plan?.policy ?? null, errors: v.errors ?? null }]));
const hist = (await db.ref("engine_policy_history").orderByKey().startAt("-P44").once("value")).val() || {};
out.history = Object.entries(hist).filter(([, h]) => h?.categoryKey === "paper-bags" || pids.includes(h?.pid)).map(([id, h]) => ({ id, kind: h.kind || "category", by: h.by, at: h.at, status: h.status, loc: h.loc, pid: h.pid, categoryKey: h.categoryKey, changes: (h.changes || []).length }));
out.historyTotalScanned = Object.keys(hist).length;
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
console.log("probe written", process.argv[3]);
process.exit(0);
