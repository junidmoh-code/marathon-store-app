// ─── RE-FILE MIS-KEYED CAPS, BEANIES AND BUCKET HATS AS CAPS & BEANIES ───────
// (Junid, 20 Nov 2026) — dry-run by default.
//
// The census (scripts/audit/caps-beanies-solve-census.mjs) found normal caps,
// beanies and bucket hats filed as "Chains & Bracelets" (subcategory
// Jewellery) — so the caps-beanies refill policy never saw them and their
// Missing Products Solve greyed "No refill policy covers this one-size product
// yet". This re-files each one: categoryKey "caps-beanies" and the legacy
// triple the taxonomy registry gives that key (Clothing / Caps & Hats /
// clothing). Nothing else is written — no stock cell, barcode, target row or
// policy. styleCodeNormalised is never touched.
//
// SCOPE: utils/headwearCategory.js — the SAME rule the Add Product form now
// applies — over every product, read in pages. Only products that are already
// one-size (sizes exactly ["_"]) are re-filed here; a mis-keyed product that is
// still sized is reported for the one-size collapse instead (a key change must
// never strand a size). Fitted caps and visors are never in scope.
//
// GUARDED, per product: a drift check (name, key and sizes still what the plan
// was built from) evaluated INSIDE a per-product transaction, so it holds at
// the instant of the write; the rollback snapshot written to
// disk and READ BACK before any write; one multi-path update per product; then
// a post-verify read. --execute performs the writes; without it nothing is
// written but the snapshot.
//
// Usage:  node --import ./scripts/lib/appModuleLoader.mjs scripts/caps-beanies-rekey.mjs [--execute] [--only=pid,pid]
//         ROLLBACK_PATH=/path.json …  (default ~/caps-beanies-rekey-rollback-<stamp>.json)
// Rollback: node --import ./scripts/lib/appModuleLoader.mjs scripts/caps-beanies-rekey.mjs --rollback=/path.json [--execute]
import { createRequire } from "module";
import { writeFileSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readMapPaged } from "./lib/rtdbPaged.mjs";
import { headwearCategoryKeyFor, normalHeadwearKind } from "../src/utils/headwearCategory.js";
import { legacyFor } from "../src/utils/productTaxonomy.js";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const read = async (p) => (await db.ref(p).once("value")).val();
const EXECUTE = process.argv.includes("--execute");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const ROLLBACK = (process.argv.find((a) => a.startsWith("--rollback=")) || "").slice(11);
const FIELDS = ["categoryKey", "category", "subcategory", "productType"];
const isOneSize = (p) => Array.isArray(p?.sizes) && p.sizes.length === 1 && String(p.sizes[0]) === "_";
const pick = (p) => Object.fromEntries(FIELDS.map((f) => [f, p?.[f] ?? null]));

// THE CONDITIONAL WRITE. A read followed by update() leaves a window in which
// an edit (say, to fitted-caps with sizes ["57"]) would be overwritten. A
// per-product transaction checks the expected state against the value it
// commits: `expect(cur)` returns a drift reason (abort) or null (write).
// The first local call may see null (cold cache); returning null then is a
// no-op the server rejects and re-runs with the real value.
async function conditionalSet(pid, expect, fields) {
  let why = null;
  const res = await db.ref(`products/${pid}`).transaction((cur) => {
    if (cur === null) return null;
    why = expect(cur);
    if (why) return;   // abort
    const next = { ...cur };
    for (const [f, v] of Object.entries(fields)) { if (v === null) delete next[f]; else next[f] = v; }
    return next;
  }, undefined, false);
  return res.committed && res.snapshot.exists() ? null : (why || "product no longer exists");
}

async function rollback() {
  const snap = JSON.parse(readFileSync(ROLLBACK, "utf8"));
  console.log(`ROLLBACK from ${ROLLBACK} (${Object.keys(snap.products).length} products) — ${EXECUTE ? "EXECUTE" : "dry run"}`);
  for (const [pid, { before, after }] of Object.entries(snap.products)) {
    const changed = (cur) => JSON.stringify(pick(cur)) !== JSON.stringify(after) ? `changed since the fix ${JSON.stringify(pick(cur))}` : null;
    if (!EXECUTE) { const live = await read(`products/${pid}`); console.log(`  ${pid} → ${JSON.stringify(before)} ${changed(live) || ""}`); continue; }
    const why = await conditionalSet(pid, changed, before);
    console.log(`  ${why ? `SKIP ${pid}: ${why}` : `${pid} → ${JSON.stringify(before)}`}`);
  }
  process.exit(0);
}
if (ROLLBACK) await rollback();

const registry = await read("settings/productTaxonomy");
const products = await readMapPaged(db, "products", { pageSize: 500 });
const plan = [];
const sizedReport = [];
for (const [pid, p] of Object.entries(products)) {
  if (!p || p.mergedInto) continue;
  if (ONLY.length && !ONLY.includes(pid)) continue;
  const fix = headwearCategoryKeyFor(p.name, p.categoryKey);
  if (!fix) continue;
  if (!isOneSize(p)) { sizedReport.push({ pid, name: p.name, categoryKey: p.categoryKey ?? null, sizes: p.sizes ?? null }); continue; }
  const legacy = legacyFor(registry, fix);
  if (!legacy) { console.error(`ABORT: the registry has no assignable "${fix}" — nothing written.`); process.exit(1); }
  const after = { categoryKey: fix, category: legacy.category, subcategory: legacy.subcategory ?? null, productType: legacy.productType ?? null };
  plan.push({ pid, name: p.name, kind: normalHeadwearKind(p.name), sizes: p.sizes, before: pick(p), after });
}
plan.sort((a, b) => String(a.name).localeCompare(String(b.name)));
console.log(`\n${"═".repeat(78)}\n  RE-FILE AS CAPS & BEANIES — ${EXECUTE ? "EXECUTE (REAL WRITES)" : "DRY RUN"}\n${"═".repeat(78)}`);
console.log(`  ${plan.length} one-size product(s) to re-file:`);
for (const r of plan) console.log(`   ${String(r.kind).padEnd(10)} ${r.pid}  ${r.name}   ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`);
console.log(`  ${sizedReport.length} mis-keyed but still SIZED (left for the collapse, not touched here):`);
for (const r of sizedReport) console.log(`   ${r.pid}  ${r.name}  key=${JSON.stringify(r.categoryKey)} sizes=${JSON.stringify(r.sizes)}`);

// ── rollback snapshot on disk, read back, BEFORE any write ──────────────────
const ROLLBACK_PATH = process.env.ROLLBACK_PATH || join(homedir(), `caps-beanies-rekey-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const snapshot = { capturedAt: new Date().toISOString(), mode: EXECUTE ? "execute" : "dry-run",
  products: Object.fromEntries(plan.map((r) => [r.pid, { name: r.name, sizes: r.sizes, before: r.before, after: r.after }])) };
writeFileSync(ROLLBACK_PATH, JSON.stringify(snapshot, null, 2));
const back = JSON.parse(readFileSync(ROLLBACK_PATH, "utf8"));
if (Object.keys(back.products).length !== plan.length) { console.error("ABORT: rollback snapshot did not read back complete — nothing written."); process.exit(1); }
console.log(`  rollback snapshot: ${ROLLBACK_PATH} (read back: ${Object.keys(back.products).length} products)`);
if (!EXECUTE) { console.log("  DRY RUN — nothing written except the rollback snapshot."); process.exit(0); }

const results = [];
for (const r of plan) {
  // Drift check INSIDE the write: name, every field this write replaces, sizes.
  const drift = (live) => live.mergedInto ? "merged since the plan"
    : live.name !== r.name ? `renamed to ${JSON.stringify(live.name)}`
    : JSON.stringify(pick(live)) !== JSON.stringify(r.before) ? `fields changed: ${JSON.stringify(pick(live))}`
    : !isOneSize(live) ? `sizes now ${JSON.stringify(live.sizes)}` : null;
  const pre = await read(`products/${r.pid}`);
  const why = await conditionalSet(r.pid, drift, r.after);
  if (why) { results.push({ ...r, status: "SKIPPED (drift)", detail: why }); continue; }
  const post = await read(`products/${r.pid}`);
  const ok = JSON.stringify(pick(post)) === JSON.stringify(r.after) && isOneSize(post) && post.name === r.name
    && post.styleCodeNormalised === pre?.styleCodeNormalised;
  results.push({ ...r, status: ok ? "DONE" : "VERIFY-FAILED", detail: ok ? "" : JSON.stringify(pick(post)) });
}
for (const r of results) console.log(`  ${r.status.padEnd(16)} ${r.pid}  ${r.name}  ${r.detail || ""}`);
const bad = results.filter((r) => r.status !== "DONE");
console.log(`\n  SUMMARY: done=${results.length - bad.length}  not done=${bad.length}`);
process.exit(bad.length ? 1 : 0);
