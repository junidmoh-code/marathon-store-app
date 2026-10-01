// ─── ONE FOOTWEAR POLICY — READ-ONLY CENSUS ───────────────────────────────────
//
// WRITES NOTHING TO RTDB. The only output is JSON under var/ and text on stdout.
//
// Junid's trigger (24 Sep 2026): Timberland Premium 6-Inch Wheat, Hub 1, read
// "Category policy" but its Targets table showed 6 keep 0, 7/8 keep 3, 9–11
// keep 2 and 12/13 "Not carried" (13 holding 2 units). This census answers, for
// the WHOLE footwear population and not one product:
//
//   1. PER FOOTWEAR CATEGORY KEY: what policy speaks for it at each hub (its
//      own entry, the footwear-all group, or nothing), the sizes / keep / ask-at
//      in force, and every size where that differs from the standing run.
//   2. PER FOOTWEAR PRODUCT at Hub 1 and Hub 2: which level governs each
//      STOCKED size (cell qty > 0) — explicit row / own category entry / group
//      / footwear rule / size run / nothing — counted per category, with every
//      deviation from the standing run listed.
//   3. THE EXPLICIT ROWS on footwear products at the two hubs — the product
//      rows that outrank any policy and that this work does NOT touch — with
//      who wrote them and when, where recorded.
//   4. THE CARRIED SET: (product, hub) pairs holding a stock cell, and the
//      pairs ARMED (some size resolves a positive target) before and after the
//      proposal. The proposal must arm nothing outside the carried set, and
//      the Slides split must come out identical.
//   5. KIDS SHOES: products, and the size labels they use.
//   6. THE REQUEST WAVE: modelCategoryPolicy (the card's own model, the
//      engine's own arithmetic) per member, before and after.
//
// "AFTER" IS MODELLED EXPLICITLY — scripts/lib/footwearStanding.mjs
// proposedConfig(), passed in — never by reading the live policy this measures.
// Run it again after the apply and the next scan, with --label after, and the
// live state IS the after state; the report then diffs against a saved before.
//
// Reads are paged (readMapPaged). Every /stock location is read because the
// dead-size rule counts units ANYWHERE.
//
//   node scripts/audit/footwear-one-policy-census.mjs                     live, label "before"
//   node scripts/audit/footwear-one-policy-census.mjs --label after --compare var/footwear-one-policy-before-….json
//   node scripts/audit/footwear-one-policy-census.mjs --from-dump var/…snapshot….json   replay
//
// A worktree without functions/node_modules: NODE_PATH=<checkout>/functions/node_modules.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { STANDING_KEEP, STANDING_ASK_AT, STANDING_HUBS, FOOTWEAR_KEYS, FOOTWEAR_GROUP_KEY, proposedConfig } from "../lib/footwearStanding.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const req = createRequire(join(ROOT, "functions", "package.json"));
const { resolveTarget, encodeSizeKey, categoryPolicyEntry, policyCategoryKey } = req(join(ROOT, "functions", "lib", "refill-engine.cjs"));
const { locationPolicyFor, footwearPolicyDrift } = req(join(ROOT, "functions", "lib", "policy-resolve.cjs"));
const { modelCategoryPolicy } = req(join(ROOT, "functions", "lib", "category-policy.cjs"));

const DB_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; if (!v || v.startsWith("--")) { console.error(`${n} needs a value`); process.exit(2); } return v; };
const LABEL = opt("--label") || "before";
const TIMBERLAND = "p1777990658712";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const cellEntries = (row) => Object.entries(row || {}).filter(([, c]) => c && typeof c === "object");
const storeCarries = (stock, loc, pid) => !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
const declared = (p) => (Array.isArray(p?.sizes) ? p.sizes : []).map(String);
const rawSize = (p, k) => declared(p).find((s) => encodeSizeKey(s) === k) ?? String(k).replace(/(\d)_(\d)/, "$1.$2");

async function readLive() {
  const admin = req("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DB_URL });
  const db = admin.database();
  const [config, tax, locations] = await Promise.all([
    db.ref("config/refillEngine").once("value").then((s) => s.val() || {}),
    db.ref("settings/productTaxonomy").once("value").then((s) => s.val() || {}),
    db.ref("locations").once("value").then((s) => s.val() || {}),
  ]);
  const products = await readMapPaged(db, "products", { pageSize: 400 });
  const locs = [...new Set([...Object.keys(locations), "in_transit"])].sort();
  const stock = {};
  for (const loc of locs) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 400 });
  const targets = {}, openIndex = {};
  for (const hub of STANDING_HUBS) {
    targets[hub] = await readMapPaged(db, `stock_targets/${hub}`, { pageSize: 400 });
    openIndex[hub] = await readMapPaged(db, `refill_engine/open/${hub}`, { pageSize: 400 });
  }
  await admin.app().delete();
  return { readAt: new Date().toISOString(), config, tax, locations, products, stock, targets, openIndex };
}

// Who wrote an explicit row, and when — every stamp shape the writers use:
// the card's override (setBy/setAt), Seating's switch-off (offByEmail/offAt,
// epoch ms), and the older batch writers (approvedBy/approvedAt).
function whoWhen(row) {
  const by = row.setBy || row.offByEmail || row.approvedBy || row.updatedBy || row.by || null;
  const rawAt = row.setAt ?? row.offAt ?? row.approvedAt ?? row.updatedAt ?? row.at ?? null;
  const at = typeof rawAt === "number" ? new Date(rawAt).toISOString() : rawAt;
  return { setBy: by, setAt: at, batchId: row.batchId || null };
}

// The level that governs one (hub, product, size) under `config`.
function governing(ctx, hub, pid, size) {
  const t = resolveTarget(ctx, hub, pid, size);
  if (!t) return { level: "nothing", t: null };
  if (t.source === "explicit") return { level: "explicit_row", t };
  if (t.source === "category_policy") {
    const e = categoryPolicyEntry(ctx.config, ctx.products, ctx.stock, pid, hub);
    return { level: e?.policySource === "group" ? "group" : "own_category", t };
  }
  if (t.source === "footwear_default") return { level: "footwear_rule", t };
  return { level: "size_run", t };
}

// One key's policy at one hub, as the table the card would show.
function keyPolicyAt(config, key, hub) {
  const r = locationPolicyFor(config, key, hub);
  if (!r) return { source: null, sizes: null };
  const sizes = {};
  if (r.sizes) for (const [k, row] of Object.entries(r.sizes)) sizes[k] = { keep: row?.target ?? null, minQty: row?.minQty ?? null, askAt: typeof row?.reorderPoint === "number" ? row.reorderPoint : null };
  return { source: r.source, groupKey: r.groupKey, carriedOnly: r.carriedOnly, perSize: r.perSize, uniform: r.sizes ? null : { keep: r.target, askAt: r.reorderPoint }, sizes };
}

function policyDeviations(pol) {
  const out = [];
  if (!pol.source) { out.push({ size: "*", issue: "no policy at this hub" }); return out; }
  if (!pol.sizes || pol.uniform) { out.push({ size: "*", issue: "not a per-size policy" }); return out; }
  for (const [k, keep] of Object.entries(STANDING_KEEP)) {
    const row = pol.sizes[k];
    if (!row) { out.push({ size: k, issue: "missing", want: keep }); continue; }
    if (row.keep !== keep) out.push({ size: k, issue: "keep", have: row.keep, want: keep });
    if (row.askAt !== STANDING_ASK_AT) out.push({ size: k, issue: "askAt", have: row.askAt, want: STANDING_ASK_AT });
  }
  for (const k of Object.keys(pol.sizes)) if (!(k in STANDING_KEEP)) out.push({ size: k, issue: "armed but not in the run", have: pol.sizes[k].keep });
  return out;
}

function census(snap, config) {
  const { products, stock, targets, tax } = snap;
  const ctx = { config, products, stock, targets };
  const pidsByKey = {};
  for (const [pid, p] of Object.entries(products)) {
    const k = policyCategoryKey(p);
    if (FOOTWEAR_KEYS.includes(k)) (pidsByKey[k] = pidsByKey[k] || []).push(pid);
  }
  const categories = {};
  for (const key of FOOTWEAR_KEYS) {
    const byHub = {};
    for (const hub of STANDING_HUBS) {
      const pol = keyPolicyAt(config, key, hub);
      byHub[hub] = { ...pol, deviations: policyDeviations(pol) };
    }
    const pids = pidsByKey[key] || [];
    const levels = {};
    const sizeLabels = {};
    for (const pid of pids) for (const s of declared(products[pid])) sizeLabels[s] = (sizeLabels[s] || 0) + 1;
    categories[key] = {
      products: pids.length,
      deactivated: pids.filter((pid) => products[pid]?.deactivated).length,
      registrySizes: tax?.cats?.[key]?.sizes || null,
      sizeLabels,
      ownEntry: config?.categoryPolicy?.[key] ?? null,
      inGroup: (config?.policyGroups?.[FOOTWEAR_GROUP_KEY]?.memberCategoryKeys || []).includes(key),
      byHub, levels,
    };
  }

  // ── PER STOCKED SIZE ──────────────────────────────────────────────────────
  const stockedDeviations = [];
  const explicitRows = [];
  const carried = new Set(), armed = new Set();
  for (const hub of STANDING_HUBS) {
    for (const key of FOOTWEAR_KEYS) {
      const lv = categories[key].levels[hub] = { explicit_row: 0, own_category: 0, group: 0, footwear_rule: 0, size_run: 0, nothing: 0, stockedCells: 0, stockedUnits: 0 };
      for (const pid of pidsByKey[key] || []) {
        const p = products[pid];
        if (storeCarries(stock, hub, pid)) carried.add(`${pid}|${hub}`);
        // Armed: any size the engine would walk here resolves a positive target.
        const walk = new Set([...declared(p), ...Object.keys(targets?.[hub]?.[pid] || {}).map((k) => rawSize(p, k))]);
        for (const s of walk) { const t = resolveTarget(ctx, hub, pid, s); if (t && t.target > 0) { armed.add(`${pid}|${hub}`); break; } }
        for (const [k, row] of Object.entries(targets?.[hub]?.[pid] || {})) {
          if (!isObj(row)) continue;
          explicitRows.push({ hub, pid, name: p?.name || "", key, size: k, target: row.target ?? null, reorderPoint: row.reorderPoint ?? null,
            source: row.source || null, ...whoWhen(row) });
        }
        if (p?.deactivated) continue;
        for (const [k, c] of cellEntries(stock?.[hub]?.[pid])) {
          const q = Math.max(num(c.qty), 0);
          if (q <= 0) continue;
          const size = rawSize(p, k);
          const g = governing(ctx, hub, pid, size);
          lv[g.level]++; lv.stockedCells++; lv.stockedUnits += q;
          const want = STANDING_KEEP[k];
          if (g.level === "explicit_row") continue;          // a product decision, listed separately
          const have = g.t ? g.t.target : null;
          const haveAsk = g.t ? g.t.reorderPoint : null;
          if (want === undefined) {
            if (have) stockedDeviations.push({ hub, pid, name: p?.name || "", key, size: k, units: q, level: g.level, have, want: null, issue: "armed outside the run" });
            continue;
          }
          // The dead-size 0 is governance (units nowhere) — it cannot happen on a
          // stocked cell, so a 0 here is a real deviation too.
          if (have !== want || haveAsk !== STANDING_ASK_AT) {
            const declaredHere = declared(p).some((s) => encodeSizeKey(s) === k);
            stockedDeviations.push({ hub, pid, name: p?.name || "", key, size: k, units: q, level: g.level, have, haveAsk, want, wantAsk: STANDING_ASK_AT,
              issue: !g.t ? (declaredHere ? "ungoverned" : "size not declared on the record") : "different numbers" });
          }
        }
      }
    }
  }
  return { categories, stockedDeviations, explicitRows, carried: [...carried].sort(), armed: [...armed].sort(), drift: footwearPolicyDrift(config) };
}

function modelWave(snap, config) {
  const locations = Object.keys(snap.stock);
  const out = {};
  let requests = 0, units = 0;
  for (const key of FOOTWEAR_KEYS) {
    const m = modelCategoryPolicy({ config, products: snap.products, stock: snap.stock, targets: snap.targets, openIndex: snap.openIndex || {},
      categoryKey: key, locations, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent });
    out[key] = { requests: m.totalRequests, units: m.totalUnits, source: m.policySource };
    requests += m.totalRequests; units += m.totalUnits;
  }
  return { perKey: out, requests, units };
}

function traceTimberland(snap, config) {
  const ctx = { config, products: snap.products, stock: snap.stock, targets: snap.targets };
  const p = snap.products[TIMBERLAND];
  if (!p) return null;
  const rows = {};
  for (const hub of STANDING_HUBS) {
    rows[hub] = {};
    for (const s of ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11", "12", "13"]) {
      const g = governing(ctx, hub, TIMBERLAND, s);
      rows[hub][s] = { cell: snap.stock?.[hub]?.[TIMBERLAND]?.[encodeSizeKey(s)]?.qty ?? null, declared: declared(p).includes(s), level: g.level, keep: g.t?.target ?? null, askAt: g.t?.reorderPoint ?? null,
        row: snap.targets?.[hub]?.[TIMBERLAND]?.[encodeSizeKey(s)] || null };
    }
  }
  return { pid: TIMBERLAND, name: p.name, categoryKey: p.categoryKey, subcategory: p.subcategory, sizes: p.sizes, rows };
}

function summarise(c) {
  const byKey = {};
  for (const [k, v] of Object.entries(c.categories)) {
    byKey[k] = { products: v.products, own: !!v.ownEntry, inGroup: v.inGroup,
      hub1: `${v.byHub.hub1.source || "none"} (${v.byHub.hub1.deviations.length} dev)`, hub2: `${v.byHub.hub2.source || "none"} (${v.byHub.hub2.deviations.length} dev)`,
      levelsHub1: v.levels.hub1, levelsHub2: v.levels.hub2 };
  }
  return byKey;
}

async function main() {
  const fromDump = opt("--from-dump");
  const snap = fromDump ? JSON.parse(readFileSync(fromDump, "utf8")) : await readLive();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(join(ROOT, "var"), { recursive: true });
  if (!fromDump) writeFileSync(join(ROOT, "var", `footwear-one-policy-snapshot-${LABEL}-${stamp}.json`), JSON.stringify(snap));

  const live = census(snap, snap.config);
  const proposed = LABEL === "before" ? proposedConfig(snap.config) : null;
  const after = proposed ? census(snap, proposed) : null;
  const armedNotCarriedAfter = after ? after.armed.filter((k) => !live.carried.includes(k)) : null;
  const armedGrowth = after ? after.armed.filter((k) => !live.armed.includes(k)) : null;
  const slidesPairs = (c, cfgSnap) => c.armed.filter((k) => policyCategoryKey(cfgSnap.products[k.split("|")[0]]) === "slides");
  const report = {
    label: LABEL, readAt: snap.readAt, fromDump: fromDump || null,
    live: { drift: live.drift, summary: summarise(live), categories: live.categories,
      stockedDeviations: live.stockedDeviations, explicitRows: live.explicitRows,
      carriedPairs: live.carried.length, armedPairs: live.armed.length, armedNotCarried: live.armed.filter((k) => !live.carried.includes(k)) },
    timberland: traceTimberland(snap, snap.config),
    ...(after ? {
      proposed: { drift: after.drift, summary: summarise(after), stockedDeviations: after.stockedDeviations,
        armedPairs: after.armed.length, armedNotCarried: armedNotCarriedAfter,
        newlyArmedPairs: armedGrowth,
        slidesArmedIdentical: JSON.stringify(slidesPairs(live, snap)) === JSON.stringify(slidesPairs(after, snap)),
        slidesArmedPairs: slidesPairs(after, snap).length },
      timberlandAfter: traceTimberland(snap, proposed),
      wave: { before: modelWave(snap, snap.config), after: modelWave(snap, proposed),
        maxFootwearIntentsPerRun: snap.config.maxFootwearIntentsPerRun ?? null },
    } : {}),
  };
  const compare = opt("--compare");
  if (compare) {
    const prev = JSON.parse(readFileSync(compare, "utf8"));
    report.compare = { against: compare, before: prev.live.summary, after: report.live.summary,
      stockedDeviationsBefore: prev.live.stockedDeviations.length, stockedDeviationsAfter: report.live.stockedDeviations.length,
      driftBefore: prev.live.drift, driftAfter: report.live.drift };
  }
  const f = join(ROOT, "var", `footwear-one-policy-${LABEL}-${stamp}.json`);
  writeFileSync(f, JSON.stringify(report, null, 1));

  console.log(`\nONE FOOTWEAR POLICY CENSUS — ${LABEL} — read ${snap.readAt}`);
  console.log(`\nDRIFT (live): ${live.drift.length ? live.drift.map((d) => `${d.kind}${d.key ? ":" + d.key : ""}${d.loc ? "@" + d.loc : ""}`).join(", ") : "none"}`);
  console.log("\nPER CATEGORY (live) — policy source per hub, deviations from the standing run, governing level of stocked cells");
  for (const [k, v] of Object.entries(live.categories)) {
    console.log(`  ${k.padEnd(15)} products ${String(v.products).padStart(5)}  own entry ${v.ownEntry ? "YES" : "no "}  in group ${v.inGroup ? "yes" : "NO "}`);
    for (const hub of STANDING_HUBS) {
      const h = v.byHub[hub], l = v.levels[hub];
      console.log(`     ${hub}: ${String(h.source || "none").padEnd(8)} dev ${h.deviations.map((d) => `${d.size}:${d.issue}${d.have !== undefined ? `(${d.have}→${d.want})` : ""}`).join(" ") || "—"}`);
      console.log(`           stocked cells ${l.stockedCells} (${l.stockedUnits}u): explicit ${l.explicit_row} · own ${l.own_category} · group ${l.group} · footwear rule ${l.footwear_rule} · size run ${l.size_run} · nothing ${l.nothing}`);
    }
  }
  console.log(`\nSTOCKED-CELL DEVIATIONS (live, excluding explicit rows): ${live.stockedDeviations.length}`);
  const tally = {};
  for (const d of live.stockedDeviations) { const t = `${d.key}|${d.hub}|${d.issue}`; tally[t] = (tally[t] || 0) + 1; }
  for (const [t, n] of Object.entries(tally).sort()) console.log(`  ${t.padEnd(50)} ${n}`);
  console.log(`\nEXPLICIT ROWS on footwear products at the hubs: ${live.explicitRows.length} rows on ${new Set(live.explicitRows.map((r) => r.pid + "|" + r.hub)).size} product×hub`);
  console.log(`CARRIED (cell) pairs ${live.carried.length} · ARMED pairs ${live.armed.length} · armed without a cell ${report.live.armedNotCarried.length} (explicit rows)`);
  if (after) {
    console.log(`\nPROPOSED: drift ${after.drift.length ? after.drift.map((d) => d.kind).join(",") : "none"} · armed pairs ${after.armed.length} · newly armed ${armedGrowth.length} · armed without a cell ${armedNotCarriedAfter.length}`);
    console.log(`  newly armed pairs all carried: ${armedGrowth.every((k) => live.carried.includes(k))}`);
    console.log(`  slides armed pairs identical: ${report.proposed.slidesArmedIdentical} (${report.proposed.slidesArmedPairs})`);
    console.log(`  stocked-cell deviations after: ${after.stockedDeviations.length}`);
    const at = {};
    for (const d of after.stockedDeviations) { const t = `${d.key}|${d.hub}|${d.issue}`; at[t] = (at[t] || 0) + 1; }
    for (const [t, n] of Object.entries(at).sort()) console.log(`    ${t.padEnd(50)} ${n}`);
    console.log(`  WAVE (modelled, next scan, before pacing): before ${report.wave.before.requests} req / ${report.wave.before.units}u → after ${report.wave.after.requests} req / ${report.wave.after.units}u; paced at ${report.wave.maxFootwearIntentsPerRun}/scan`);
    for (const k of FOOTWEAR_KEYS) console.log(`    ${k.padEnd(15)} ${report.wave.before.perKey[k].requests} → ${report.wave.after.perKey[k].requests}`);
  }
  const tl = report.timberland;
  if (tl) {
    console.log(`\nTIMBERLAND ${tl.name} (${tl.pid}) key=${tl.categoryKey} subcategory=${tl.subcategory} sizes=${JSON.stringify(tl.sizes)}`);
    for (const hub of STANDING_HUBS) {
      const live1 = tl.rows[hub], aft = report.timberlandAfter?.rows?.[hub];
      console.log(`  ${hub}: ` + Object.entries(live1).filter(([s, r]) => r.declared || r.cell != null).map(([s, r]) => `${s}:${r.level === "nothing" ? "—" : r.keep}${r.level === "explicit_row" ? "*" : ""}${aft ? "→" + (aft[s].level === "nothing" ? "—" : aft[s].keep) : ""}`).join(" "));
    }
    console.log("  (* = explicit product row)");
  }
  console.log(`\nJSON → ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
