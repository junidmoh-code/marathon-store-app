// ─── POLICY COVERAGE CENSUS — READ ONLY ───────────────────────────────────────
//
// WRITES NOTHING. For every product in the FOOTWEAR GROUP it asks the engine's
// OWN resolver — resolveTarget from functions/lib/refill-engine.cjs, imported,
// never re-implemented — whether a target resolves at Hub 1 and at Hub 2, size
// by size, and when the answer is "no" it says WHY, in the resolver's own
// precedence:
//
//   explicit row > category policy (own entry, then armed group) > footwear
//   rule > kill switch > size run — with storeCarries (cell presence) gating
//   the last two and, since #446/#451, any category leg marked carriedOnly.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Owner report 2026-09-15: "products with no engine policy despite every
// sneaker being armed". The Seating card for one product read "Cell only — no
// target" at Hub 2 (a cell exists, nothing arms it) and "Not carried" at Hub 1
// (no cell). Those are two different failures. This census separates them for
// the whole group and, crucially, isolates the residue that NONE of the known
// reasons explains — that residue is the finding.
//
// It also answers one question explicitly: is being unarmed correlated with
// being created after the 2026-08-25 arming run (#448)? If yes, arming was a
// frozen snapshot; if no, it is a live rule and the gap is a data property.
//
// ── THE BUCKETS, per product × hub ───────────────────────────────────────────
//   armed           at least one declared size resolves target > 0
//   switched_off    an explicit target:0 row (Seating / Exclude) and nothing armed
//   no_cell         the product has NO stock cell at this hub, so a carriage-
//                   scoped policy (carriedOnly) refuses it — the Seating card's
//                   "Not carried"
//   outside_group   the product's categoryKey resolves NO policy at this hub —
//                   key absent, or a key no armed policy/group names. The
//                   distinct offending (categoryKey | category | productType)
//                   values are listed.
//   size_run        a policy speaks here and the product is carried, but none of
//                   its declared sizes is in the per-size map
//   size_key        the cells at this hub sit under keys that no declared size
//                   encodes to (5.5 vs 5_5 vs "5,5", " 8", Free_Size vs "_")
//   dormant         the policy arms every size at 0 — the dead-size rule (zero
//                   units anywhere in the network) — nothing to replenish yet
//   deactivated     resolver refuses before the explicit row (#445)
//   unexplained     none of the above — enumerated one by one in the report
//
// ── READS ────────────────────────────────────────────────────────────────────
// Paged only (readMapPaged), never a whole-node read of /stock or /products.
// Every /stock location is read because the dead-size rule counts units
// ANYWHERE (sizeUnitsAnywhere) — a hub-only read can only under-arm and would
// mis-file a live size as dormant. --dump saves the snapshot under var/ and
// --from-dump replays it, so iterating on the report costs no second read.
//
//   node scripts/audit/policy-coverage-census.mjs                 → live, prints report + writes var/policy-coverage-<stamp>.json
//   node scripts/audit/policy-coverage-census.mjs --dump           → also saves the raw snapshot to var/policy-coverage-snapshot-<stamp>.json
//   node scripts/audit/policy-coverage-census.mjs --from-dump F   → replay a saved snapshot
//   node scripts/audit/policy-coverage-census.mjs --trace <pid>   → one product, line by line, at both hubs (add --from-dump to replay;
//                                                                    --without-rows also replays it with its explicit rows removed)
//
// The resolver this imports is the one the deployed refillHealthScan runs:
// verify by downloading the function's source zip and diffing lib/refill-engine.cjs
// and lib/policy-resolve.cjs against the repo (done 2026-09-15, revision
// refillhealthscan-00053-yat, byte-identical). The report prints the sha256 of
// the file it actually loaded so the comparison can be repeated.

import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const req = adminRequire(import.meta.url);
const ENGINE_PATH = join(ROOT, "functions", "lib", "refill-engine.cjs");
const { resolveTarget, encodeSizeKey, categoryPolicyEntry, policyCategoryKey } = req(ENGINE_PATH);
const { locationPolicyFor } = req(join(ROOT, "functions", "lib", "policy-resolve.cjs"));
const ENGINE_SHA = createHash("sha256").update(readFileSync(ENGINE_PATH)).digest("hex");

const HUBS = ["hub1", "hub2"];
const ARMING_DATE = "2026-08-25";   // PR #448 — Hub 1 sneaker arming run
const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

// ── THE UNIVERSE: the footwear group, by every signal the catalogue carries ──
// The taxonomy's footwear categories (top === "footwear") are the group. A
// product is IN the group when its categoryKey is one of them; a product with
// NO key is admitted on the legacy category "Footwear" (productIsFootwear's
// own fallback, src/utils/footwearLine.js); and a product carrying neither but
// productType "sneaker" is admitted too, precisely so the outside_group bucket
// can see it — a shoe the resolver cannot recognise is the thing being counted.
function footwearKeys(tax) {
  const cats = tax?.cats || {};
  return Object.keys(cats).filter((k) => cats[k]?.top === "footwear").sort();
}
function admitted(p, keys) {
  if (!p || typeof p !== "object") return null;
  const key = typeof p.categoryKey === "string" ? p.categoryKey.trim() : "";
  if (key && keys.includes(key)) return "categoryKey";
  if (!key && p.category === "Footwear") return "legacy_category";
  if (p.productType === "sneaker") return "productType";
  return null;
}

// Creation instant: the createdBy stamp (#283) when present, else the pid's
// own epoch-ms (p<ms>) — the catalogue carries no createdAt field.
function createdMs(pid, p) {
  const at = p?.createdBy?.at;
  if (typeof at === "number" && Number.isFinite(at)) return at;
  const m = /^p(\d{13})$/.exec(pid);
  return m ? Number(m[1]) : null;
}
function isoWeek(ms) {
  if (ms == null) return "unknown";
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;   // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
// RTDB hands back an ARRAY for a row whose keys are dense small integers
// (shoe sizes 3..11 do it: 560 of 5,793 hub/central rows on 2026-09-15).
// Holes come back as null. Iterate entries and skip nulls, exactly as the
// engine's own loops do with `c?.qty`.
const cellEntries = (row) => Object.entries(row || {}).filter(([, c]) => c && typeof c === "object");
const storeCarries = (stock, loc, pid) => !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
const declaredSizes = (p) => (Array.isArray(p?.sizes) ? p.sizes : []).map(String);

// ── ONE (product, hub) VERDICT ───────────────────────────────────────────────
function classify(ctx, hub, pid) {
  const { products, stock, targets, config } = ctx;
  const p = products[pid];
  const sizes = declaredSizes(p);
  // The key the RESOLVER uses — policyCategoryKey, not the raw field — so the
  // reason this census gives agrees with the resolver it imports. (Before the
  // 2026-09-15 fix the two were the same thing; after it a keyless legacy
  // sneaker resolves "sneakers", and a census reading the raw field would file
  // it "outside_group" while the engine armed it. Spec review, PR #606.)
  const key = policyCategoryKey(p) || "";
  const policy = key ? locationPolicyFor(config, key, hub) : null;
  const carries = storeCarries(stock, hub, pid);
  const cells = stock?.[hub]?.[pid];
  const rows = targets?.[hub]?.[pid] || {};
  const perSize = [];
  let armed = 0, off = 0, dormant = 0, sizeRun = 0, unexplained = 0, noCell = 0, outside = 0;
  for (const size of sizes) {
    const k = encodeSizeKey(size);
    const t = resolveTarget(ctx, hub, pid, size);
    let verdict, why;
    if (t && t.target > 0) { verdict = "armed"; why = t.source; armed++; }
    else if (t && t.source === "explicit") { verdict = "switched_off"; why = "explicit target 0"; off++; }
    else if (t && t.source === "category_policy") { verdict = "dormant"; why = "policy arms it; zero units anywhere (dead-size rule)"; dormant++; }
    else if (t) { verdict = "unexplained"; why = `target ${t.target} from ${t.source}`; unexplained++; }
    else if (p?.deactivated) { verdict = "deactivated"; why = "product.deactivated"; }
    else if (!policy) {
      verdict = "outside_group"; outside++;
      why = key ? `key "${key}"${p?.categoryKey ? "" : " (legacy pair)"} resolves no policy at ${hub}` : "no categoryKey on the record (and not the Footwear+Sneakers legacy pair)";
    }
    else if (policy.carriedOnly && !carries) { verdict = "no_cell"; why = "carriedOnly leg, no stock cell here"; noCell++; }
    else if (policy.sizes && !policy.sizes[k]) { verdict = "size_run"; why = `size ${size} (${k}) not in the ${hub} per-size map`; sizeRun++; }
    else if (policy.sizes && !(typeof policy.sizes[k]?.target === "number" && policy.sizes[k].target > 0)) { verdict = "size_run"; why = `map row for ${k} has no positive target`; sizeRun++; }
    else { verdict = "unexplained"; why = "policy speaks, carried, size in run — resolver still null"; unexplained++; }
    perSize.push({ size, key: k, cellQty: cells?.[k] ? num(cells[k].qty) : (cells && k in cells ? "null-hole" : "no-cell"), row: rows[k] ? { target: rows[k].target, source: rows[k].source || null } : null, resolved: t, verdict, why });
  }
  // Cells whose key no declared size encodes to — the encoding-mismatch class.
  const declaredKeys = new Set(sizes.map(encodeSizeKey));
  const strayKeys = cellEntries(cells).map(([k]) => k).filter((k) => !declaredKeys.has(k));
  const strayUnits = strayKeys.reduce((n, k) => n + Math.max(num(cells[k]?.qty), 0), 0);

  let bucket;
  if (p?.deactivated) bucket = "deactivated";
  else if (armed > 0) bucket = "armed";
  else if (off > 0) bucket = "switched_off";
  else if (!sizes.length) bucket = strayKeys.length ? "size_key" : "outside_group";
  else if (outside === sizes.length) bucket = "outside_group";
  else if (noCell === sizes.length) bucket = "no_cell";
  else if (dormant > 0 && dormant + sizeRun === sizes.length) bucket = "dormant";
  else if (sizeRun === sizes.length) bucket = strayKeys.length ? "size_key" : "size_run";
  else bucket = "unexplained";
  const units = cellEntries(cells).reduce((n, [, c]) => n + Math.max(num(c.qty), 0), 0);
  return { bucket, armed, off, dormant, sizeRun, noCell, outside, unexplained, carries, units, strayKeys, strayUnits, perSize, policy: policy ? { source: policy.source, groupKey: policy.groupKey, carriedOnly: policy.carriedOnly, perSize: policy.perSize } : null };
}

// ── THE SNAPSHOT ─────────────────────────────────────────────────────────────
async function readLive() {
  const admin = req("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB_URL });
  const db = admin.database();
  let bytes = 0;
  const meter = (v) => { bytes += JSON.stringify(v ?? null).length; };
  const [config, tax, locations] = await Promise.all([
    db.ref("config/refillEngine").once("value").then((s) => s.val() || {}),
    db.ref("settings/productTaxonomy").once("value").then((s) => s.val() || {}),
    db.ref("locations").once("value").then((s) => s.val() || {}),
  ]);
  meter(config); meter(tax); meter(locations);
  const products = await readMapPaged(db, "products", { pageSize: 400, meter });
  const locs = [...new Set([...Object.keys(locations), "in_transit"])].sort();
  const stock = {};
  for (const loc of locs) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 400, meter });
  const targets = {};
  for (const hub of HUBS) targets[hub] = await readMapPaged(db, `stock_targets/${hub}`, { pageSize: 400, meter });
  await admin.app().delete();
  return { readAt: new Date().toISOString(), bytesRead: bytes, config, tax, locations, products, stock, targets };
}

// ── THE REPORT ───────────────────────────────────────────────────────────────
function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

function traceProduct(ctx, pid, keys) {
  const p = ctx.products[pid];
  if (!p) { console.log(`\n${pid}: no such product`); return; }
  console.log(`\n══ TRACE ${pid} ${JSON.stringify(p.name)}`);
  console.log(`   category=${JSON.stringify(p.category)} categoryKey=${JSON.stringify(p.categoryKey)} productType=${JSON.stringify(p.productType)} subcategory=${JSON.stringify(p.subcategory)}`);
  console.log(`   hubs=${JSON.stringify(p.hubs ?? p.hub ?? null)} deactivated=${!!p.deactivated} sizes=${JSON.stringify(p.sizes)} admitted-as=${admitted(p, keys)}`);
  const c = createdMs(pid, p);
  console.log(`   created ${c ? new Date(c).toISOString() : "unknown"} (${p.createdBy ? "createdBy stamp" : "pid epoch"}) — ${c && c > Date.parse(ARMING_DATE) ? "AFTER" : "BEFORE"} the ${ARMING_DATE} arming run`);
  for (const loc of Object.keys(ctx.stock).sort()) {
    const row = ctx.stock[loc][pid];
    if (!row) continue;
    const cells = cellEntries(row).map(([k, cell]) => `${k}→${num(cell.qty)}${cell.lastType ? ` (${cell.lastType} ${String(cell.updatedAt || "").slice(0, 10)})` : ""}`);
    console.log(`   stock/${loc}${Array.isArray(row) ? " [array-coerced row]" : ""}: ${cells.join(", ") || "(row with no cells)"}`);
  }
  for (const hub of HUBS) {
    const r = classify(ctx, hub, pid);
    const rows = ctx.targets[hub]?.[pid];
    console.log(`   ── ${hub}: ${r.bucket.toUpperCase()}  (carried=${r.carries}, units=${r.units}, explicit rows=${rows ? Object.keys(rows).length : 0}, policy=${r.policy ? `${r.policy.source}${r.policy.groupKey ? "/" + r.policy.groupKey : ""} carriedOnly=${r.policy.carriedOnly}` : "none"})`);
    for (const s of r.perSize) {
      console.log(`      size ${pad(s.size, 5)} key ${pad(s.key, 5)} cell ${pad(s.cellQty, 9)} row ${pad(s.row ? `t=${s.row.target}/${s.row.source}` : "—", 22)} → ${pad(s.verdict, 13)} ${s.resolved ? `target ${s.resolved.target} (${s.resolved.source})` : "null"}  ${s.why}`);
    }
    if (r.strayKeys.length) console.log(`      stray cell keys (no declared size encodes to them): ${r.strayKeys.join(", ")} holding ${r.strayUnits} unit(s)`);
  }
}

async function main() {
  const fromDump = opt("--from-dump");
  const snap = fromDump ? JSON.parse(readFileSync(fromDump, "utf8")) : await readLive();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(join(ROOT, "var"), { recursive: true });
  if (flag("--dump") && !fromDump) {
    const f = join(ROOT, "var", `policy-coverage-snapshot-${stamp}.json`);
    writeFileSync(f, JSON.stringify(snap));
    console.log(`snapshot saved → ${f}`);
  }
  const { config, tax, products, stock, targets } = snap;
  const ctx = { config, products, stock, targets };
  const keys = footwearKeys(tax);

  console.log(`\nPOLICY COVERAGE CENSUS — ${fromDump ? `replay of ${fromDump} (read ${snap.readAt})` : `live ${snap.readAt}`}`);
  console.log(`resolver: functions/lib/refill-engine.cjs sha256 ${ENGINE_SHA}`);
  console.log(`footwear group (taxonomy top=footwear): ${keys.join(", ")}`);
  console.log(`config: footwearTargets=${JSON.stringify(config.footwearTargets ?? null)} ruleBasedTargets=${JSON.stringify(config.ruleBasedTargets ?? null)} categoryPolicy legs: ${Object.keys(config.categoryPolicy || {}).filter((k) => keys.includes(k)).map((k) => `${k}[${HUBS.filter((h) => config.categoryPolicy[k][h]).join("+")}]`).join(" ") || "none in group"}; groups: ${Object.entries(config.policyGroups || {}).map(([g, v]) => `${g}(${v.armed ? "ARMED" : "disarmed"})`).join(" ") || "none"}`);
  if (!fromDump) console.log(`read ${(snap.bytesRead / 1024 / 1024).toFixed(2)} MB, paged`);

  const tracePid = opt("--trace");
  if (tracePid) {
    traceProduct(ctx, tracePid, keys);
    // --without-rows: the same product with its explicit /stock_targets rows
    // removed, so a hand-armed product shows what the POLICY alone says.
    if (flag("--without-rows")) {
      console.log(`\n── the same product with its explicit rows removed (policy only):`);
      traceProduct({ ...ctx, targets: {} }, tracePid, keys);
    }
    return;
  }

  // ── walk ──
  const universe = Object.keys(products).filter((pid) => admitted(products[pid], keys)).sort();
  const byBucket = { hub1: {}, hub2: {} };
  const offending = {};              // outside_group: distinct (key|category|type) → count
  const unexplainedRows = [];
  const strayRows = [];
  const weekTab = {};                // week → { total, armedAnywhere, unarmedEverywhere, ... }
  const results = {};
  for (const pid of universe) {
    const p = products[pid];
    const per = {};
    for (const hub of HUBS) {
      const r = classify(ctx, hub, pid);
      per[hub] = r;
      (byBucket[hub][r.bucket] ||= []).push(pid);
      if (r.bucket === "outside_group") {
        const sig = `categoryKey=${JSON.stringify(p.categoryKey ?? null)} | category=${JSON.stringify(p.category ?? null)} | productType=${JSON.stringify(p.productType ?? null)}`;
        (offending[sig] ||= { count: 0, sample: [] });
        offending[sig].count++;
        if (offending[sig].sample.length < 5) offending[sig].sample.push(pid);
      }
      if (r.bucket === "unexplained") unexplainedRows.push({ pid, hub, name: p.name, perSize: r.perSize.filter((s) => s.verdict === "unexplained") });
      if (r.strayKeys.length && r.carries) strayRows.push({ pid, hub, name: p.name, strayKeys: r.strayKeys, strayUnits: r.strayUnits, declared: declaredSizes(p) });
    }
    const ms = createdMs(pid, p);
    const wk = isoWeek(ms);
    const w = (weekTab[wk] ||= { week: wk, total: 0, armedAnywhere: 0, stockedAtAHubUnarmedThere: 0, outsideGroup: 0, noCellBoth: 0, deactivated: 0, switchedOff: 0, dormant: 0, sizeRun: 0, sizeKey: 0, unexplained: 0 });
    w.total++;
    // Every bucket, per week — a product counts once per bucket if EITHER hub files it there.
    for (const [b, f] of [["switched_off", "switchedOff"], ["dormant", "dormant"], ["size_run", "sizeRun"], ["size_key", "sizeKey"], ["unexplained", "unexplained"]]) {
      if (HUBS.some((h) => per[h].bucket === b)) w[f]++;
    }
    const armedAnywhere = HUBS.some((h) => per[h].bucket === "armed");
    if (armedAnywhere) w.armedAnywhere++;
    if (HUBS.some((h) => per[h].carries && per[h].units > 0 && !["armed", "switched_off", "deactivated", "dormant"].includes(per[h].bucket))) w.stockedAtAHubUnarmedThere++;
    if (HUBS.some((h) => per[h].bucket === "outside_group")) w.outsideGroup++;
    if (HUBS.every((h) => per[h].bucket === "no_cell")) w.noCellBoth++;
    if (p.deactivated) w.deactivated++;
    results[pid] = { name: p.name, createdMs: ms, week: wk, hub1: per.hub1.bucket, hub2: per.hub2.bucket, units: { hub1: per.hub1.units, hub2: per.hub2.units } };
  }

  // ── print ──
  console.log(`\nUNIVERSE: ${universe.length} products (admitted by: ${["categoryKey", "legacy_category", "productType"].map((s) => `${s} ${universe.filter((pid) => admitted(products[pid], keys) === s).length}`).join(", ")})`);
  const ORDER = ["armed", "switched_off", "no_cell", "outside_group", "size_run", "size_key", "dormant", "deactivated", "unexplained"];
  console.log(`\n${pad("bucket", 16)}${rpad("hub1", 8)}${rpad("hub2", 8)}   sample pids`);
  for (const b of ORDER) {
    const a = byBucket.hub1[b] || [], c = byBucket.hub2[b] || [];
    if (!a.length && !c.length) continue;
    console.log(`${pad(b, 16)}${rpad(a.length, 8)}${rpad(c.length, 8)}   ${[...new Set([...a.slice(0, 3), ...c.slice(0, 3)])].join(" ")}`);
  }
  // Stocked-but-unarmed is the number that matters: units sitting at a hub with
  // nothing arming them there.
  for (const hub of HUBS) {
    const stockedUnarmed = universe.filter((pid) => { const r = classify(ctx, hub, pid); return r.carries && r.units > 0 && !["armed", "switched_off", "deactivated", "dormant"].includes(r.bucket); });
    const units = stockedUnarmed.reduce((n, pid) => n + classify(ctx, hub, pid).units, 0);
    console.log(`\n${hub}: ${stockedUnarmed.length} product(s) HOLD UNITS here and are NOT armed here (${units} units) — by reason: ${ORDER.map((b) => { const n = stockedUnarmed.filter((pid) => classify(ctx, hub, pid).bucket === b).length; return n ? `${b} ${n}` : null; }).filter(Boolean).join(", ") || "none"}`);
  }

  console.log(`\nOUTSIDE THE ARMED GROUP — distinct offending values (product × hub counts):`);
  for (const [sig, v] of Object.entries(offending).sort((a, b) => b[1].count - a[1].count)) console.log(`  ${rpad(v.count, 5)}  ${sig}   e.g. ${v.sample.join(" ")}`);

  console.log(`\nSIZE-KEY MISMATCH — cells at a hub under keys no declared size encodes to: ${strayRows.length} (product × hub)`);
  for (const r of strayRows.slice(0, 25)) console.log(`  ${r.pid} ${r.hub} ${JSON.stringify(r.name)} stray ${r.strayKeys.join(",")} (${r.strayUnits}u) declared ${r.declared.join(",")}`);
  if (strayRows.length > 25) console.log(`  … ${strayRows.length - 25} more in the JSON`);

  console.log(`\nUNEXPLAINED — the finding, one line each: ${unexplainedRows.length}`);
  for (const r of unexplainedRows) console.log(`  ${r.pid} ${r.hub} ${JSON.stringify(r.name)}: ${r.perSize.map((s) => `${s.size}: ${s.why}`).join("; ")}`);

  console.log(`\nBY CREATION WEEK (Monday), the ${ARMING_DATE} arming run falls in week 2026-08-24:`);
  console.log(`${pad("week", 12)}${rpad("total", 7)}${rpad("armed@1+", 9)}${rpad("stocked", 9)}${rpad("outside", 9)}${rpad("noCell2", 9)}${rpad("off", 5)}${rpad("dormant", 9)}${rpad("sizeRun", 9)}${rpad("sizeKey", 9)}${rpad("unexpl", 8)}${rpad("deact", 7)}   (stocked = holds units at a hub and is not armed there; noCell2 = no cell at either hub)`);
  const weeks = Object.values(weekTab).sort((a, b) => a.week.localeCompare(b.week));
  for (const w of weeks) console.log(`${pad(w.week, 12)}${rpad(w.total, 7)}${rpad(w.armedAnywhere, 9)}${rpad(w.stockedAtAHubUnarmedThere, 9)}${rpad(w.outsideGroup, 9)}${rpad(w.noCellBoth, 9)}${rpad(w.switchedOff, 5)}${rpad(w.dormant, 9)}${rpad(w.sizeRun, 9)}${rpad(w.sizeKey, 9)}${rpad(w.unexplained, 8)}${rpad(w.deactivated, 7)}`);
  // Unknown creation dates are in NEITHER cohort — folding them into BEFORE
  // would inflate that side (CodeRabbit, PR #606).
  const dated = universe.filter((pid) => results[pid].createdMs != null);
  const before = dated.filter((pid) => results[pid].createdMs <= Date.parse(ARMING_DATE));
  const after = dated.filter((pid) => results[pid].createdMs > Date.parse(ARMING_DATE));
  if (dated.length !== universe.length) console.log(`  (${universe.length - dated.length} product(s) with no creation date are in neither cohort)`);
  const rate = (arr, f) => (arr.length ? `${arr.filter(f).length}/${arr.length} (${(100 * arr.filter(f).length / arr.length).toFixed(1)}%)` : "0/0");
  const stockedUnarmed = (pid) => HUBS.some((h) => { const r = classify(ctx, h, pid); return r.carries && r.units > 0 && !["armed", "switched_off", "deactivated", "dormant"].includes(r.bucket); });
  const armedSomewhere = (pid) => HUBS.some((h) => results[pid][h] === "armed");
  console.log(`\nCORRELATION WITH ${ARMING_DATE}:`);
  console.log(`  created BEFORE: armed at ≥1 hub ${rate(before, armedSomewhere)}; stocked-at-a-hub-and-unarmed-there ${rate(before, stockedUnarmed)}`);
  console.log(`  created AFTER : armed at ≥1 hub ${rate(after, armedSomewhere)}; stocked-at-a-hub-and-unarmed-there ${rate(after, stockedUnarmed)}`);
  console.log(`  → if AFTER's stocked-unarmed rate is not materially higher than BEFORE's, arming is a LIVE rule (category policy resolved per scan), not a frozen snapshot.`);

  const out = join(ROOT, "var", `policy-coverage-${stamp}.json`);
  writeFileSync(out, JSON.stringify({ readAt: snap.readAt, engineSha256: ENGINE_SHA, footwearKeys: keys, universe: universe.length, byBucket: Object.fromEntries(HUBS.map((h) => [h, Object.fromEntries(Object.entries(byBucket[h]).map(([b, a]) => [b, a.length]))])), offending, strayRows, unexplainedRows, weekTab, results }, null, 1));
  console.log(`\nJSON → ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
