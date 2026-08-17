// ─── COMMIT 2 — BACKFILL /stock_provenance (STAGED; --execute TO APPLY) ───────
//
// Materialises the derived carries index from the whole ledger, once, so the engine
// never has to. Reads /stock_movements end to end (56k+ records — this is the ONE
// place that cost is paid), classifies every record through the single shared
// classifier in src/components/stock/provenanceClass.js, folds the result per
// (loc, pid), and writes:
//
//   /stock_provenance/{loc}/{pid} = { s, k, u }        ← counters, zeroes omitted
//   /stock_provenance/_meta/{loc} = { at, pairs, version }   ← readiness sentinel
//
// IDEMPOTENT AND RE-RUNNABLE. The index is a pure function of the ledger, so a
// re-run recomputes the same values and writes the same bytes. It is NOT additive:
// each run SETS the counters it computed rather than incrementing them, which is
// what makes a second run safe. Concretely:
//   • re-running after new trade → counters advance to the new truth
//   • re-running after a partial/interrupted run → completes it, no double-count
//   • re-running after forward maintenance (Commit 5) has been incrementing →
//     replaces the incremented values with the recomputed ones, which are
//     authoritative.
//
// ⚠ THE LIMIT OF THAT CLAIM (CodeRabbit, PR #376). A re-run repairs any pair the
// fold still PRODUCES. It cannot repair one it no longer produces, because the
// apply step writes paths and never deletes them — an orphaned record (a pair whose
// evidence was reclassified away, or one written by an older index version) survives
// untouched and keeps the shop carrying the line. So this is a repair path for
// DRIFTED counters, not for ORPHANED records. The run reports the difference against
// the live index rather than silently leaving it: clearing an orphan is a delete, and
// deletes here get read and decided one at a time, not swept.
//
// ORDER OF WRITES IS LOAD-BEARING. Pairs are written FIRST, the readiness sentinel
// LAST, per location. `indexReady()` gates arming on the sentinel, so a run that
// dies halfway leaves the location unarmed rather than armed against half a
// picture. Never reorder these.
//
// THE SENTINEL IS ALSO THE DEPLOY GATE. The engine refuses to arm a location whose
// sentinel is missing, so this backfill must complete BEFORE the rewired engine
// deploys — otherwise every location goes quiet. Rules first, backfill second,
// functions third.
//
// SEED CELLS ESTABLISH NOTHING. 540 cells carry `mv: "seed"` from setCellState(),
// which writes outside the ledger by design, and 34 (loc,pid) pairs have no other
// evidence. They are reported here as a worklist, never silently promoted — see
// the provenance study for why both readings are defensible and why the
// conservative one was taken.
//
// Usage:
//   node scripts/backfill-stock-provenance.mjs                      # dry run
//   node scripts/backfill-stock-provenance.mjs --execute            # apply
//   LEDGER_DIR=/path node scripts/backfill-stock-provenance.mjs     # use a cache
//   BACKFILL_MD=~/report.md node scripts/backfill-stock-provenance.mjs

import { createRequire } from "module";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { foldProvenance, carriesByProvenance } from "../src/components/stock/provenanceClass.js";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const idx = require("../functions/lib/provenance-index.cjs");

const EXECUTE = process.argv.includes("--execute");
const DIR = process.env.LEDGER_DIR || null;
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

async function readPaged(path, pageSize = 3000) {
  const acc = {}; let lastKey = null;
  for (;;) {
    let q = db.ref(path).orderByKey().limitToFirst(pageSize + (lastKey ? 1 : 0));
    if (lastKey) q = q.startAt(lastKey);
    const snap = await q.once("value");
    const keys = []; snap.forEach((c) => { keys.push(c.key); });   // braces load-bearing
    let added = 0;
    for (const k of keys) { if (k === lastKey) continue; acc[k] = snap.child(k).val(); added += 1; }
    if (added === 0) break;
    lastKey = keys[keys.length - 1];
    if (added < pageSize) break;
  }
  return acc;
}

// The ledger is the only expensive read; a local cache may stand in for a dry run,
// but NEVER for --execute. Writing live state from a snapshot of unknown age is how
// a backfill silently reverts an hour of trade.
// Stamped BEFORE the ledger read so the tail merge at the end can find everything
// that landed while this script was running.
const readStartedAt = new Date().toISOString();

let movements, stock, products, config;
if (DIR && existsSync(`${DIR}/movements.json`) && !EXECUTE) {
  const j = (f) => JSON.parse(readFileSync(`${DIR}/${f}.json`, "utf8"));
  movements = j("movements"); stock = j("stock"); products = j("products"); config = j("config");
  say(`_source: cache ${DIR} (dry run only)_`);
} else {
  if (DIR && EXECUTE) say(`_LEDGER_DIR ignored for --execute — live read required_`);
  [movements, products] = await Promise.all([readPaged("/stock_movements"), readPaged("/products")]);
  stock = (await db.ref("/stock").once("value")).val() || {};
  config = (await db.ref("/config/refillEngine").once("value")).val() || {};
  say(`_source: live RTDB_`);
}

const mvList = Object.values(movements).filter(Boolean);
const prov = foldProvenance(mvList);

// Locations to index: every refill destination AND every route source, matching the
// engine's own `locs` derivation (refill-scan.cjs:384) so the index covers exactly
// what the engine will look up — plus any location that already holds stock, so a
// route added later finds history waiting rather than an empty node.
const routeLocs = [...new Set([...Object.keys(config?.routes || {}), ...Object.values(config?.routes || {})])];
const LOCS = [...new Set([...routeLocs, ...Object.keys(stock || {})])]
  .filter((l) => !["in_transit", "base", "studio"].includes(l))
  .sort();

say(`# /stock_provenance backfill — ${EXECUTE ? "**EXECUTE**" : "DRY RUN"}`);
say();
say(`${mvList.length} ledger records folded. Index version ${idx.INDEX_VERSION}.`);
say(`Locations: ${LOCS.map((l) => `\`${l}\``).join(", ")}`);
say(`Route locations the engine will look up: ${routeLocs.map((l) => `\`${l}\``).join(", ")}`);
say();

// ── build the payload ────────────────────────────────────────────────────────
const payload = {};      // path → value
const perLoc = new Map();
for (const [key, e] of prov.entries()) {
  const [loc, pid] = key.split("|");
  if (!LOCS.includes(loc)) continue;
  const rec = idx.toRecord(e);
  if (!Object.keys(rec).length) continue;     // nothing worth storing
  payload[idx.pairPath(loc, pid)] = rec;
  const g = perLoc.get(loc) || { pairs: 0, carries: 0, sold: 0, stocked: 0, unstocked: 0 };
  g.pairs += 1;
  if (carriesByProvenance(e)) g.carries += 1;
  g.sold += e.sold; g.stocked += e.stockedUnits; g.unstocked += e.unstockedUnits;
  perLoc.set(loc, g);
}

say(`## Payload by location`);
say();
say(`| location | pairs indexed | of which carry | sale events | stocked units | unstocked units |`);
say(`|---|---|---|---|---|---|`);
for (const loc of LOCS) {
  const g = perLoc.get(loc) || { pairs: 0, carries: 0, sold: 0, stocked: 0, unstocked: 0 };
  say(`| \`${loc}\` | ${g.pairs} | ${g.carries} | ${g.sold} | ${g.stocked} | ${g.unstocked} |`);
}
say();
say(`Total paths to write: **${Object.keys(payload).length}** pairs + ${LOCS.length} sentinels.`);
say();

// ── ORPHANS — records the live index holds that this run does NOT produce ─────
// The apply step writes paths and never deletes them, so anything already at
// /stock_provenance that the fold no longer emits would survive a re-run and keep a
// shop carrying a line on evidence that no longer exists. Reported, never swept: a
// delete here changes what the engine will refill, so it is a decision.
const liveIndex = (await db.ref(idx.PROVENANCE_ROOT).once("value")).val() || {};
const orphanPaths = [];
for (const loc of Object.keys(liveIndex)) {
  if (loc === "_meta") continue;
  for (const pid of Object.keys(liveIndex[loc] || {})) {
    const path = idx.pairPath(loc, pid);
    if (payload[path]) continue;                       // recomputed — will be overwritten
    orphanPaths.push({ loc, pid, path, live: liveIndex[loc][pid], indexed: LOCS.includes(loc) });
  }
}
say(`## Orphans — live records this run does not reproduce`);
say();
if (!Object.keys(liveIndex).length) {
  say(`_the index is empty — this is the first run, so there is nothing to orphan_`);
} else if (!orphanPaths.length) {
  say(`_none: every live record is reproduced by this run_`);
} else {
  say(`**${orphanPaths.length}** record(s). Each one keeps its shop carrying the line and this run will`);
  say(`NOT change it. Review, then clear individually if the evidence really is gone.`);
  say();
  say(`| location | pid | name (display only) | live record | still carries | location indexed here |`);
  say(`|---|---|---|---|---|---|`);
  for (const o of orphanPaths.slice(0, 80)) {
    say(`| \`${o.loc}\` | \`${o.pid}\` | ${JSON.stringify(products?.[o.pid]?.name ?? null)} | \`${JSON.stringify(o.live)}\` | ${idx.carriesByIndex(o.live)} | ${o.indexed ? "yes" : "**no**"} |`);
  }
  if (orphanPaths.length > 80) say(`| … | | | | | _${orphanPaths.length - 80} more_ |`);
  say();
  say("```bash");
  say(`# to clear one, after deciding it should go:`);
  for (const o of orphanPaths.slice(0, 3)) say(`#   firebase database:remove /${o.path}`);
  say("```");
}
say();

// ── the match table: before → after against the CURRENT gate ─────────────────
const storeCarriesOld = (loc, pid) => !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
const held = (loc, pid) => Object.values(stock?.[loc]?.[pid] || {}).reduce((s, c) => s + Math.max(0, Number(c?.qty) || 0), 0);

say(`## Match table — every pair whose answer CHANGES`);
say();
const changes = [];
for (const loc of LOCS) {
  const pids = new Set([...Object.keys(stock?.[loc] || {})]);
  for (const key of prov.keys()) {
    const [l, p] = key.split("|");
    if (l === loc) pids.add(p);
  }
  for (const pid of pids) {
    const before = storeCarriesOld(loc, pid);
    const after = carriesByProvenance(prov.get(`${loc}|${pid}`));
    if (before === after) continue;
    const e = prov.get(`${loc}|${pid}`);
    changes.push({
      loc, pid, before, after,
      cat: products?.[pid]?.categoryKey || products?.[pid]?.productType || "(uncategorised)",
      name: products?.[pid]?.name ?? null,
      held: held(loc, pid),
      s: e?.sold || 0, k: e?.stockedUnits || 0, u: e?.unstockedUnits || 0, c: e?.collectedUnits || 0,
      seedOnly: Object.values(stock?.[loc]?.[pid] || {}).some((x) => x?.mv === "seed"),
    });
  }
}
// ARMING ONLY HAPPENS AT A DESTINATION. `routes` maps destination → source, so the
// KEYS are the only locations resolveTarget is ever asked about. A flip at central,
// hub3 or marathon-pine changes no behaviour whatsoever — those locations are
// sources or standalone, never asked "do you carry this". Splitting the count is
// the difference between a headline of 413 and the ~165 that can actually act.
const DESTINATIONS = new Set(Object.keys(config?.routes || {}));
const isDest = (loc) => DESTINATIONS.has(loc);
const toFalse = changes.filter((c) => c.before && !c.after);
const toTrue = changes.filter((c) => !c.before && c.after);
const toFalseDest = toFalse.filter((c) => isDest(c.loc));
const toTrueDest = toTrue.filter((c) => isDest(c.loc));
say(`Refill DESTINATIONS (the only locations \`resolveTarget\` asks about): ${[...DESTINATIONS].map((d) => `\`${d}\``).join(", ")}`);
say();
say(`| direction | at a destination (**changes behaviour**) | elsewhere (no effect) | total |`);
say(`|---|---|---|---|`);
say(`| TRUE → FALSE (demand stops) | **${toFalseDest.length}** | ${toFalse.length - toFalseDest.length} | ${toFalse.length} |`);
say(`| FALSE → TRUE (demand starts) | **${toTrueDest.length}** | ${toTrue.length - toTrueDest.length} | ${toTrue.length} |`);
say();
say(`### TRUE → FALSE`);
say();
say(`\`dest?\` marks the rows that can change arming. The rest are bookkeeping.`);
say();
say(`| dest? | loc | pid | name (display only) | category | units held | sold | stocked | unstocked | collected | seed-only |`);
say(`|---|---|---|---|---|---|---|---|---|---|---|`);
for (const c of toFalse.sort((a, b) => (isDest(b.loc) - isDest(a.loc)) || a.loc.localeCompare(b.loc) || String(a.cat).localeCompare(String(b.cat)))) {
  say(`| ${isDest(c.loc) ? "**YES**" : "no"} | \`${c.loc}\` | \`${c.pid}\` | ${JSON.stringify(c.name)} | \`${c.cat}\` | ${c.held} | ${c.s} | ${c.k} | ${c.u} | ${c.c} | ${c.seedOnly ? "**yes**" : "no"} |`);
}
say();
if (toTrue.length) {
  say(`### FALSE → TRUE`);
  say();
  say(`These locations have provenance but no /stock cell. The engine will now arm them; \`resolveTarget\``);
  say(`still needs a declared size and a run entry, so this is not automatically new demand.`);
  say();
  say(`| loc | pid | name | category | sold | stocked |`);
  say(`|---|---|---|---|---|---|`);
  for (const c of toTrue.sort((a, b) => b.s - a.s).slice(0, 80)) {
    say(`| \`${c.loc}\` | \`${c.pid}\` | ${JSON.stringify(c.name)} | \`${c.cat}\` | ${c.s} | ${c.k} |`);
  }
  if (toTrue.length > 80) say(`| … | | | | | _${toTrue.length - 80} more_ |`);
  say();
}

// ── the seed worklist ────────────────────────────────────────────────────────
const seedWork = toFalse.filter((c) => c.seedOnly && c.s === 0 && c.k === 0 && isDest(c.loc));
say(`## Seed worklist — cells created outside the ledger`);
say();
say(`\`setCellState()\` writes \`{qty:0, v:0, mv:"seed", lastType:"count"}\` with NO ledger record, so the`);
say(`index cannot see it. **${seedWork.length}** pair(s) flip to FALSE on that basis alone. If any of these should`);
say(`keep arming, they need \`introduce: true\` on the policy/target entry — never a code change.`);
say();
if (seedWork.length) {
  say(`| loc | pid | name | category |`);
  say(`|---|---|---|---|`);
  for (const c of seedWork.sort((a, b) => a.loc.localeCompare(b.loc))) {
    say(`| \`${c.loc}\` | \`${c.pid}\` | ${JSON.stringify(c.name)} | \`${c.cat}\` |`);
  }
}
say();

// ── apply ────────────────────────────────────────────────────────────────────
if (!EXECUTE) {
  say(`## Nothing written`);
  say();
  say(`Dry run. To apply:`);
  say();
  say("```bash");
  say(`node scripts/backfill-stock-provenance.mjs --execute`);
  say("```");
  say();
  say(`Requires \`/stock_provenance\` rules published first — see PROVENANCE-RULES.md.`);
} else {
  say(`## Applying`);
  say();
  // Pairs first, sentinel LAST, per location — see the header. Chunked because a
  // single multi-path update of thousands of paths is rejected for size.
  const CHUNK = 400;
  let written = 0;
  for (const loc of LOCS) {
    const entries = Object.entries(payload).filter(([p]) => p.startsWith(`${idx.PROVENANCE_ROOT}/${loc}/`));
    for (let i = 0; i < entries.length; i += CHUNK) {
      const upd = Object.fromEntries(entries.slice(i, i + CHUNK));
      await db.ref().update(upd);
      written += Object.keys(upd).length;
      say(`- \`${loc}\`: wrote ${Math.min(i + CHUNK, entries.length)}/${entries.length} pairs`);
    }
    // Sentinel last. An interrupted run therefore leaves the location UNARMED.
    const g = perLoc.get(loc) || { pairs: 0 };
    await db.ref(idx.metaPath(loc)).set({
      at: new Date().toISOString(),
      pairs: g.pairs,
      version: idx.INDEX_VERSION,
      ledgerRecords: mvList.length,
      by: "scripts/backfill-stock-provenance.mjs",
    });
    say(`- \`${loc}\`: **sentinel written** (${g.pairs} pairs) — location is now armable`);
  }
  say();
  say(`**${written} pair records + ${LOCS.length} sentinels written.**`);

  // ── THE TAIL MERGE (CodeRabbit, PR #376) ───────────────────────────────────
  // The counters above were SET from a ledger read taken before the writes began.
  // If forward maintenance is live, a movement landing in that gap incremented a
  // counter which the set has just overwritten — the movement's contribution is
  // lost, and a pair that was genuinely stocked can be written back to a
  // non-carrying state.
  //
  // Deploying hosting AFTER this run avoids the gap entirely (see
  // PROVENANCE-RULES.md), but relying on operator sequencing for correctness is
  // not the same as being correct. So the tail is re-read and re-applied as
  // INCREMENTS, which is what the lost writes would have been.
  say();
  say(`### Tail merge`);
  say();
  const tail = Object.values(await readPaged("/stock_movements"))
    .filter((m) => m && String(m.appliedAt || m.ts || "") > readStartedAt);
  say(`${tail.length} movement(s) landed after the ledger read at \`${readStartedAt}\`.`);
  if (tail.length) {
    const tailProv = foldProvenance(tail);
    const upd = {};
    for (const [key, e] of tailProv.entries()) {
      const [loc, pid] = key.split("|");
      if (!LOCS.includes(loc)) continue;
      if (e.sold > 0) upd[`${idx.pairPath(loc, pid)}/s`] = admin.database.ServerValue.increment(e.sold);
      if (e.stockedUnits > 0) upd[`${idx.pairPath(loc, pid)}/k`] = admin.database.ServerValue.increment(e.stockedUnits);
      if (e.unstockedUnits > 0) upd[`${idx.pairPath(loc, pid)}/u`] = admin.database.ServerValue.increment(e.unstockedUnits);
    }
    if (Object.keys(upd).length) {
      await db.ref().update(upd);
      say(`Merged ${Object.keys(upd).length} counter increment(s) across ${tailProv.size} pair(s).`);
    } else {
      say(`None of them affect a counter at an indexed location.`);
    }
    say();
    say(`⚠ A movement landing during the tail merge itself is still possible. Re-running this script`);
    say(`is always safe and always converges — that is what the SET semantics buy.`);
  }
}
say();

if (process.env.BACKFILL_MD) {
  const p = process.env.BACKFILL_MD.replace(/^~/, homedir());
  writeFileSync(p, out.join("\n") + "\n");
  console.log(`\n[written] ${p}`);
}
process.exit(0);
