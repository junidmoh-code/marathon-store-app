// ─── ENGINE POLICY, PASS 3 — READ-ONLY CENSUS + RESOLUTION SNAPSHOT ───────────
//
// WRITES NOTHING TO RTDB. The only output is JSON under var/ (gitignored) and
// text on stdout.
//
// ── WHAT IT ANSWERS ──────────────────────────────────────────────────────────
//
//   1. THE SIZE RUN of every category, DERIVED from live data (what the products
//      declare, what /stock holds, what /stock_targets rows exist, intersected
//      with the registry's declared run) — the same sizeRunForCategory the
//      callable and the card use, so this census and the editor offer one list.
//
//   2. THE SNEAKERS GROUP'S MEMBERS, each member's run, the UNION the group's
//      per-size editor would offer, and which sizes only SOME members carry.
//      STOP CONDITION: a union over 20 sizes is reported as a stop, because an
//      editor with more rows than that is a guess dressed as a list.
//
//   3. OLD-ROW COUNTS — explicit /stock_targets rows per category (cells and
//      products). None is deleted by anything in this pass; the count exists so
//      the "N old rows" chip says a true number.
//
//   4. A RESOLUTION SNAPSHOT. Every (destination × product × declared size) is
//      put through the engine's own resolveTarget, and every destination through
//      computeRefillPlan, against a COPY OF THE LIVE INPUTS that is saved to
//      disk. The results are hashed per category and per taxonomy top.
//
// ── WHY THE INPUTS ARE SAVED, NOT JUST THE RESULTS ───────────────────────────
// Stock moves between two runs, and the dead-size rule reads stock, so two
// live runs of the same code can legitimately differ. The branch is judged by
// REPLAYING the saved inputs through the branch's engine (--replay) and diffing
// against the saved results — same inputs, different code, so any difference is
// the code's. The clothing hash MUST come back identical; that is the first of
// the stop conditions for this pass.
//
// Usage:
//   node scripts/census-engine-policy-pass3.mjs                 # capture (live reads)
//   node scripts/census-engine-policy-pass3.mjs --replay var/pass3-inputs-<ts>.json
//
// Paged reads only: /products, /stock/<loc>, /stock_targets/<loc>,
// /refill_engine/open/<loc> all go through readMapPaged.

import { createRequire } from "module";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readMapPaged } from "./lib/rtdbPaged.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { resolveTarget, computeRefillPlan, encodeSizeKey } = require("../functions/lib/refill-engine.cjs");
const { sizeRunForCategory } = require("../functions/lib/policy-groups.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const GROUP_KEY = "footwear-all";
const UNION_STOP = 20;

const argv = process.argv.slice(2);
const replayIdx = argv.indexOf("--replay");
const REPLAY = replayIdx >= 0 ? argv[replayIdx + 1] : null;

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const line = (n = 96) => "─".repeat(n);
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

// Canonical key order so a hash is a hash of the VALUES, not of RTDB's read order.
function canon(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canon);
  const out = {};
  for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canon(v[k]);
  return out;
}

async function capture() {
  const admin = require("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
  const db = admin.database();
  const small = (p) => db.ref(p).once("value").then((s) => s.val() || {});
  const [config, taxonomy, locationsNode] = await Promise.all([
    small("config/refillEngine"), small("settings/productTaxonomy"), small("locations"),
  ]);
  const allLocs = Object.keys(locationsNode);
  const destLocs = Object.keys(config.mode || {});
  console.log(`  reading (paged)…`);
  const products = await readMapPaged(db, "products", { pageSize: 500 });
  const stock = {}, targets = {}, openIndex = {};
  for (const loc of allLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`, { pageSize: 500 });
  for (const loc of allLocs) targets[loc] = await readMapPaged(db, `stock_targets/${loc}`, { pageSize: 500 });
  for (const loc of destLocs) openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`, { pageSize: 500 });
  // nowMs is FROZEN into the inputs so a replay reproduces the plan exactly.
  const inputs = { capturedAt: STAMP, nowMs: Date.now(), config, taxonomy, locations: allLocs, products, stock, targets, openIndex };
  mkdirSync(join(ROOT, "var"), { recursive: true });
  const inputsPath = join(ROOT, "var", `pass3-inputs-${STAMP}.json`);
  writeFileSync(inputsPath, JSON.stringify(inputs));
  console.log(`  inputs saved → ${inputsPath}  (${Object.keys(products).length} products, ${allLocs.length} locations)`);
  await admin.app().delete().catch(() => {});
  return { inputs, inputsPath };
}

function analyse(inputs) {
  const { config, taxonomy, locations: allLocs, products, stock, targets, openIndex, nowMs } = inputs;
  const cats = taxonomy?.cats && typeof taxonomy.cats === "object" ? taxonomy.cats : {};
  const destLocs = Object.keys(config.mode || {});
  const groups = config.policyGroups && typeof config.policyGroups === "object" ? config.policyGroups : {};
  const policy = config.categoryPolicy && typeof config.categoryPolicy === "object" ? config.categoryPolicy : {};

  // ── 1. SIZE RUNS, EVERY CATEGORY ──────────────────────────────────────────
  const keys = [...new Set([...Object.keys(cats), ...Object.keys(policy)])].sort();
  const runs = {};
  for (const key of keys) {
    runs[key] = sizeRunForCategory({ products, stock, targets, taxonomy, categoryKey: key, locations: allLocs });
  }

  // ── 2. THE SNEAKERS GROUP ─────────────────────────────────────────────────
  const group = groups[GROUP_KEY] || null;
  const members = Array.isArray(group?.memberCategoryKeys) ? [...group.memberCategoryKeys].sort() : [];
  const memberRuns = Object.fromEntries(members.map((m) => [m, runs[m] || sizeRunForCategory({ products, stock, targets, taxonomy, categoryKey: m, locations: allLocs })]));
  const unionCount = {};
  for (const m of members) for (const s of memberRuns[m].sizes) unionCount[s] = (unionCount[s] || 0) + 1;
  const union = Object.keys(unionCount).sort((a, b) => {
    const na = Number(String(a).replace("_", ".")), nb = Number(String(b).replace("_", "."));
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
  const partial = union.filter((s) => unionCount[s] < members.filter((m) => memberRuns[m].sizes.length).length);

  // ── 3. OLD ROWS ───────────────────────────────────────────────────────────
  const rowsByCategory = {};
  for (const loc of allLocs) {
    for (const [pid, bySize] of Object.entries(targets[loc] || {})) {
      const key = products[pid]?.categoryKey;
      if (!key) continue;
      const r = rowsByCategory[key] || (rowsByCategory[key] = { cells: 0, products: new Set(), byLocation: {} });
      const n = Object.keys(bySize || {}).length;
      r.cells += n; r.products.add(pid);
      r.byLocation[loc] = (r.byLocation[loc] || 0) + n;
    }
  }

  // ── 4. RESOLUTION SNAPSHOT ────────────────────────────────────────────────
  // Every destination × product × declared size (or "_"), through resolveTarget.
  const ctx = { targets, config, products, stock };
  const cells = [];               // [dest, pid, size, result]
  for (const dest of destLocs) {
    for (const pid of Object.keys(products).sort()) {
      const p = products[pid];
      const sizes = Array.isArray(p?.sizes) && p.sizes.length ? p.sizes.map(String) : ["_"];
      for (const size of sizes) {
        const r = resolveTarget(ctx, dest, pid, size);
        cells.push([dest, pid, size, r ? canon(r) : null]);
      }
    }
  }
  const byCategory = {}, byTop = {};
  for (const c of cells) {
    const key = products[c[1]]?.categoryKey || "(none)";
    const top = cats[key]?.top || "(untaxonomied)";
    (byCategory[key] = byCategory[key] || []).push(c);
    (byTop[top] = byTop[top] || []).push(c);
  }
  const hashOf = (list) => ({ cells: list.length, resolved: list.filter((c) => c[3]).length, hash: sha(list) });
  const resolution = {
    all: hashOf(cells),
    byTop: Object.fromEntries(Object.keys(byTop).sort().map((t) => [t, hashOf(byTop[t])])),
    byCategory: Object.fromEntries(Object.keys(byCategory).sort().map((k) => [k, hashOf(byCategory[k])])),
  };
  // And the plan itself, per destination. Empty ledgers deliberately — the
  // snapshot is of RESOLUTION and the deficit arithmetic, not of suppression.
  const plan = computeRefillPlan({
    nowMs, config, targets, stock, products, openIndex, refillRequests: {}, orders: {}, movements: [],
    targetDecisions: {}, rejectStreak: {}, retryState: {},
  });
  const intents = (plan.intents || []).map((i) => canon({ dest: i.dest, source: i.source, pid: i.productId, size: i.size, sizeKey: i.sizeKey, qty: i.qty, priority: i.priority, mode: i.mode }));
  const intentsByTop = {};
  for (const i of intents) {
    const top = cats[products[i.pid]?.categoryKey]?.top || "(untaxonomied)";
    (intentsByTop[top] = intentsByTop[top] || []).push(i);
  }
  const planSummary = {
    intents: intents.length, hash: sha(intents),
    byTop: Object.fromEntries(Object.keys(intentsByTop).sort().map((t) => [t, { intents: intentsByTop[t].length, hash: sha(intentsByTop[t]) }])),
  };

  return { cats, keys, runs, group, members, memberRuns, union, unionCount, partial, rowsByCategory, resolution, planSummary, cells, intents, destLocs };
}

function report(a, { replayOf = null, previous = null } = {}) {
  const { cats, keys, runs, group, members, memberRuns, union, unionCount, partial, rowsByCategory, resolution, planSummary, destLocs } = a;
  console.log(`\n${"═".repeat(96)}`);
  console.log(`  ENGINE POLICY PASS 3 — CENSUS${replayOf ? ` (REPLAY of ${replayOf})` : ""}          WRITES NOTHING TO RTDB`);
  console.log(`${"═".repeat(96)}`);
  console.log(`  destinations : ${destLocs.join(", ")}`);

  console.log(`\n  1. SIZE RUNS (derived; ⚠ = registry calls it sized but no run can be derived)`);
  console.log(`  ${line()}`);
  for (const key of keys) {
    const r = runs[key];
    const flag = r.oneSize ? "one-size" : (r.empty ? "⚠ NO RUN" : `${r.sizes.length} sizes`);
    console.log(`  ${pad(key, 20)} ${pad(cats[key]?.top || "-", 12)} ${pad(flag, 10)} ${r.sizes.map((s) => s.replace("_", ".")).join(" ")}${r.extra.length ? `   [extra: ${r.extra.map((s) => s.replace("_", ".")).join(" ")}]` : ""}`);
  }

  console.log(`\n  2. THE SNEAKERS GROUP (${GROUP_KEY})`);
  console.log(`  ${line()}`);
  if (!group) console.log(`  group not present in live config`);
  else {
    console.log(`  label "${group.label}"   armed=${group.armed}   members ${members.length}`);
    for (const m of members) {
      const r = memberRuns[m];
      console.log(`  ${pad(m, 16)} ${pad(`${r.products} products`, 14)} ${pad(r.empty ? "no run" : `${r.sizes.length} sizes`, 9)} ${r.sizes.map((s) => s.replace("_", ".")).join(" ")}`);
    }
    console.log(`  UNION ${union.length} sizes: ${union.map((s) => s.replace("_", ".")).join(" ")}`);
    console.log(`  carried by only some members: ${partial.length ? partial.map((s) => `${s.replace("_", ".")}(${unionCount[s]})`).join(" ") : "none"}`);
    console.log(union.length > UNION_STOP ? `  🛑 STOP — union exceeds ${UNION_STOP} sizes` : `  ✓ union within the ${UNION_STOP}-size stop`);
  }

  console.log(`\n  3. OLD ROWS (explicit /stock_targets rows, per category — none deleted)`);
  console.log(`  ${line()}`);
  let totCells = 0, totProducts = new Set();
  for (const key of Object.keys(rowsByCategory).sort()) {
    const r = rowsByCategory[key];
    totCells += r.cells; for (const p of r.products) totProducts.add(p);
    console.log(`  ${pad(key, 20)} ${rpad(r.cells, 6)} rows  ${rpad(r.products.size, 5)} products   ${Object.entries(r.byLocation).map(([l, n]) => `${l}:${n}`).join(" ")}`);
  }
  console.log(`  ${pad("TOTAL", 20)} ${rpad(totCells, 6)} rows  ${rpad(totProducts.size, 5)} products`);

  console.log(`\n  4. RESOLUTION SNAPSHOT`);
  console.log(`  ${line()}`);
  console.log(`  all          ${rpad(resolution.all.cells, 7)} cells  ${rpad(resolution.all.resolved, 6)} resolved   hash ${resolution.all.hash}`);
  for (const [t, h] of Object.entries(resolution.byTop)) {
    console.log(`  ${pad(t, 12)} ${rpad(h.cells, 7)} cells  ${rpad(h.resolved, 6)} resolved   hash ${h.hash}`);
  }
  console.log(`  plan         ${rpad(planSummary.intents, 7)} intents                     hash ${planSummary.hash}`);
  for (const [t, h] of Object.entries(planSummary.byTop)) console.log(`    ${pad(t, 12)} ${rpad(h.intents, 6)} intents  hash ${h.hash}`);

  if (previous) {
    console.log(`\n  5. DIFF AGAINST THE CAPTURED RESULTS`);
    console.log(`  ${line()}`);
    let diffs = 0;
    const cmp = (label, a, b) => { const same = a === b; if (!same) diffs += 1; console.log(`  ${pad(label, 28)} ${same ? "IDENTICAL" : `DIFFERENT  ${b} → ${a}`}`); };
    cmp("all cells", resolution.all.hash, previous.resolution.all.hash);
    for (const t of new Set([...Object.keys(resolution.byTop), ...Object.keys(previous.resolution.byTop)])) {
      cmp(`top ${t}`, resolution.byTop[t]?.hash, previous.resolution.byTop[t]?.hash);
    }
    cmp("plan intents", planSummary.hash, previous.planSummary.hash);
    const catDiffs = Object.keys(resolution.byCategory).filter((k) => resolution.byCategory[k].hash !== previous.resolution.byCategory?.[k]?.hash);
    if (catDiffs.length) console.log(`  categories differing: ${catDiffs.join(", ")}`);
    console.log(diffs === 0 && !catDiffs.length ? `\n  ✓ ZERO DIFF — the branch resolves the captured world byte-identically.` : `\n  🛑 ${diffs + catDiffs.length} DIFFERENCES — STOP.`);
    return diffs + catDiffs.length;
  }
  return 0;
}

(async () => {
  let inputs, inputsPath, previous = null;
  if (REPLAY) {
    inputsPath = REPLAY;
    inputs = JSON.parse(readFileSync(REPLAY, "utf8"));
    try { previous = JSON.parse(readFileSync(REPLAY.replace("pass3-inputs-", "pass3-results-"), "utf8")); } catch { previous = null; }
  } else {
    ({ inputs, inputsPath } = await capture());
  }
  const a = analyse(inputs);
  const diffs = report(a, { replayOf: REPLAY, previous });
  const out = {
    capturedAt: inputs.capturedAt, inputsPath, replayOf: REPLAY,
    runs: Object.fromEntries(Object.keys(a.runs).map((k) => [k, { sizes: a.runs[k].sizes, extra: a.runs[k].extra, oneSize: a.runs[k].oneSize, empty: a.runs[k].empty, products: a.runs[k].products }])),
    group: a.group, members: a.members, union: a.union, unionCount: a.unionCount, partial: a.partial,
    rowsByCategory: Object.fromEntries(Object.entries(a.rowsByCategory).map(([k, r]) => [k, { cells: r.cells, products: r.products.size, byLocation: r.byLocation }])),
    resolution: a.resolution, planSummary: a.planSummary,
  };
  mkdirSync(join(ROOT, "var"), { recursive: true });
  const resultsPath = REPLAY
    ? join(ROOT, "var", `pass3-replay-${STAMP}.json`)
    : inputsPath.replace("pass3-inputs-", "pass3-results-");
  writeFileSync(resultsPath, JSON.stringify(out, null, 2));
  // The per-cell list too, so a diff can be read cell by cell when it is not zero.
  writeFileSync(resultsPath.replace(".json", "-cells.json"), JSON.stringify({ cells: a.cells, intents: a.intents }));
  console.log(`\n  results → ${resultsPath}\n`);
  process.exit(diffs ? 3 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
