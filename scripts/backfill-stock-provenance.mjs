// ─── COMMIT 2 — BACKFILL /stock_provenance (STAGED; --execute TO APPLY) ───────
//
// Materialises the derived carries index from the whole ledger so the engine never
// has to. Reads /stock_movements end to end — TWICE under --execute: once to compute
// and once for the convergence pass at the end, which is the only exact way to catch
// movements that landed mid-run (see that block for why no increment-based catch-up
// works, and why there is no key-range shortcut). This script is where the ledger's
// full read cost is paid; the engine never pays it.
//
// Every record is classified through the single shared classifier in
// src/components/stock/provenanceClass.js. The fold is per (loc, pid), and writes:
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
// ORDER OF WRITES IS LOAD-BEARING, WITHIN PASS 1. Pairs are written FIRST, the
// readiness sentinel LAST, per location: `indexReady()` gates arming on the sentinel,
// so a run that dies halfway leaves the location unarmed rather than armed against
// half a picture. Never reorder those two.
//
// The convergence pass then writes pairs AFTER those sentinels exist, and re-touches
// `_meta` at the end. That is deliberate and safe, not an exception to the rule above:
// a location armed during convergence reads pass-1 values, and pass-1 values can only
// be LOW relative to the truth (see the residual note in that block), so the engine
// under-arms for a few seconds rather than over-arming. Arming early beats staying
// dark, given the direction of the error is known.
//
// THE SENTINEL IS ALSO THE DEPLOY GATE. The engine refuses to arm a location whose
// sentinel is missing, so this backfill should complete before the rewired engine
// deploys — otherwise those locations arm nothing until it does. (The engine no
// longer WITHDRAWS on an unready index either; that was a genuine hazard and is
// fixed in refill-engine.cjs.) Full order, and why hosting is last, in
// PROVENANCE-RULES.md: rules → backfill → functions → hosting.
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
// Reported for the operator's record only. Deliberately NOT used to select anything:
// the convergence pass at the end re-folds the full ledger rather than trying to
// identify a tail by time or by id, because neither is answerable (see that block).
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

  // ── THE CONVERGENCE PASS ───────────────────────────────────────────────────
  // The counters above were SET from a ledger read taken before the writes began.
  // If forward maintenance is live, a movement landing in that gap incremented a
  // counter that the SET has just overwritten, so its contribution is lost and a
  // pair that was genuinely stocked can be written back to non-carrying.
  //
  // TWO EARLIER ATTEMPTS AT THIS WERE BOTH WRONG, in instructive ways:
  //
  //  1. Re-apply movements with `appliedAt > readStartedAt` as INCREMENTS. Wrong
  //     because the initial read is paginated and runs for a while: a movement
  //     written during it can be stamped after readStartedAt and STILL be in that
  //     read, so its units were already in the SET and incrementing double-counts.
  //     (CodeRabbit.)
  //  2. Re-apply movements whose ID was absent from the initial read, as
  //     INCREMENTS. Selection is now exact with respect to the READ — but that is
  //     the wrong reference point. Whether an increment survived depends on when
  //     the movement landed relative to the SET WRITE OF ITS PAIR, not relative to
  //     the read. A movement landing after its pair's SET but before the re-read
  //     sees its key has a surviving increment AND gets incremented again. The
  //     window is the entire write phase. (Kimi, reviewing the delta CodeRabbit
  //     was rate-limited out of.)
  //
  // The lesson is that no INCREMENT-based catch-up can be exact, because "was this
  // already counted" is not answerable from the ledger alone. So this pass does not
  // increment. It re-folds the FULL ledger from a fresh read and SETS any pair whose
  // authoritative value differs from what pass 1 wrote.
  //
  // THE RESIDUAL, AND WHY IT IS THE RIGHT ONE. A movement landing between this
  // re-read and this SET still has its increment overwritten. That is a LOST update,
  // not a double count — the counter ends up too LOW, which makes the predicate
  // refuse to arm. Every ambiguity in this engine resolves to "arm nothing" (see the
  // kill-switch and fail-safe notes in refill-engine.cjs), and a re-run corrects it.
  // An inflated counter would instead arm a shop that does not trade the line, which
  // is the entire bug this index exists to fix. Given a choice of residual, take the
  // one that fails in the direction the system already fails safely in.
  //
  // WHY THE FULL LEDGER IS RE-READ. There is no key-range shortcut: movement ids are
  // NOT uniformly push ids — `disp_018_…`, `cr_R004-2_…`, `sold:…`, `crundo_…` and
  // `rrf_…` are all hand-built. A new `cr_…` id sorts before an existing `sold:…`
  // one, so `orderByKey().startAt(lastKey)` would silently miss exactly the
  // clothing-refill movements this index cares most about. The second read is the
  // price of that, once, in an owner-run script.
  say();
  say(`### Convergence pass`);
  say();
  const seenIds = new Set(Object.keys(movements));
  const reread = await readPaged("/stock_movements");
  const newIds = Object.keys(reread).filter((id) => !seenIds.has(id));
  say(`Initial read covered ${seenIds.size} movement(s); re-read found ${Object.keys(reread).length}, of which ${newIds.length} are new.`);

  const reProv = foldProvenance(Object.values(reread).filter(Boolean));
  const converge = {};
  const changed = [];
  for (const [key, e] of reProv.entries()) {
    const [loc, pid] = key.split("|");
    if (!LOCS.includes(loc)) continue;
    const rec = idx.toRecord(e);
    if (!Object.keys(rec).length) continue;
    const path = idx.pairPath(loc, pid);
    // Compare against what pass 1 wrote, not against live — live may already hold a
    // forward increment we are about to (correctly) supersede.
    if (JSON.stringify(rec) === JSON.stringify(payload[path] || null)) continue;
    // LEAF-LEVEL PATHS WITH EXPLICIT NULLS, not `{path: rec}`. RTDB update() expands
    // an object value into leaf writes and does NOT delete keys absent from it, so
    // `{path: rec}` is a MERGE dressed as a SET. Today that is indistinguishable —
    // counters only accumulate, so a changed record's key set is always a superset —
    // but the exactness argument should not rest on that. Writing each counter and
    // nulling the absent ones makes the primitive match the claim, and survives a
    // future classifier version that lets a counter fall. (Admin SDK bypasses the
    // newData.exists() rule that stops CLIENTS nulling a counter.)
    for (const f of ["s", "k", "u"]) converge[`${path}/${f}`] = rec[f] ?? null;
    changed.push({ loc, pid, from: payload[path] || null, to: rec });
  }
  // ── THE ONE INFLATION PATH, NAMED AND CHECKED ──────────────────────────────
  // Everything above iterates `reProv`, so a pair that pass 1 wrote but the re-fold
  // NO LONGER PRODUCES is never visited and pass 1's value survives. That is the only
  // way this run can leave a counter too HIGH, and the "never inflated" claim depends
  // on it being impossible. It is impossible only because the ledger is APPEND-ONLY:
  // counters accumulate (an undo adds to `u`, it never subtracts from `k`), and no
  // code path deletes a /stock_movements record — undos are new records with their own
  // ids (`crundo_…`). That premise is now stated rather than assumed, and checked
  // rather than trusted, because it is load-bearing for a safety claim.
  const vanished = Object.keys(payload).filter((path) => {
    const [, loc, pid] = path.split("/");
    return !reProv.has(`${loc}|${pid}`);
  });
  if (vanished.length) {
    say(`⛔ **${vanished.length} pair(s) written by pass 1 are no longer produced by the re-fold.**`);
    say(`This should be impossible on an append-only ledger and means a movement record was deleted`);
    say(`or mutated mid-run. Those pairs keep pass 1's value, which may now be too HIGH — the unsafe`);
    say(`direction. Re-run this script and investigate the ledger before trusting the index.`);
    say();
    for (const path of vanished.slice(0, 20)) say(`- \`${path}\` still holds \`${JSON.stringify(payload[path])}\``);
    say();
  } else {
    say(`Append-only premise holds: every pair pass 1 wrote is still produced by the re-fold, so no`);
    say(`counter can have been left too high.`);
    say();
  }

  if (!changed.length) {
    say(`No pair's authoritative value changed. Pass 1 is already converged.`);
  } else {
    say(`${changed.length} pair(s) differ from what pass 1 wrote — re-SET to the authoritative value:`);
    say();
    say(`| location | pid | pass 1 | authoritative |`);
    say(`|---|---|---|---|`);
    for (const c of changed.slice(0, 40)) {
      say(`| \`${c.loc}\` | \`${c.pid}\` | \`${JSON.stringify(c.from)}\` | \`${JSON.stringify(c.to)}\` |`);
    }
    if (changed.length > 40) say(`| … | | | _${changed.length - 40} more_ |`);
    say();
    const CH = 400;
    const entries = Object.entries(converge);
    for (let i = 0; i < entries.length; i += CH) await db.ref().update(Object.fromEntries(entries.slice(i, i + CH)));
    say(`Applied ${entries.length} counter write(s) across ${changed.length} pair(s).`);
    // The orphan table above was printed BEFORE pass 1 and said "this run will NOT
    // change it". A movement landing mid-run can give an orphan fresh provenance, in
    // which case this pass does change it — correct behaviour, but it makes that
    // earlier sentence false unless it is corrected here.
    const wereOrphans = changed.filter((c) => orphanPaths.some((o) => o.loc === c.loc && o.pid === c.pid));
    if (wereOrphans.length) {
      say(`⚠ ${wereOrphans.length} of these were listed as ORPHANS above — they gained provenance during`);
      say(`this run, so that part of the orphan table is now out of date. They are correct as written.`);
    }
  }
  // The sentinels were written after pass 1 so each location became armable as early
  // as possible; refresh their metadata now so `at` and `pairs` describe the state
  // the run actually left behind rather than an intermediate one.
  // `pairs` keeps ONE meaning across both writes: pairs THIS RUN computed for the
  // location. Pass 1 wrote that; the refresh must not quietly redefine it as "children
  // currently at the node", which would include orphans and any foreign record and so
  // disagree with a pass-1-only sentinel under the same field name. It is counted from
  // the re-fold rather than by re-reading the node — the data is already in hand, and a
  // read-then-count would also race an app increment creating a pair between the two.
  const rePairs = new Map();
  for (const key of reProv.keys()) {
    const [loc, pid] = key.split("|");
    if (!LOCS.includes(loc)) continue;
    if (!Object.keys(idx.toRecord(reProv.get(`${loc}|${pid}`))).length) continue;
    rePairs.set(loc, (rePairs.get(loc) || 0) + 1);
  }
  for (const loc of LOCS) {
    await db.ref(idx.metaPath(loc)).update({
      at: new Date().toISOString(),
      pairs: rePairs.get(loc) || 0,
      ledgerRecords: Object.keys(reread).length,
    });
  }
  say();
  say(`Sentinels refreshed. A movement landing during this pass leaves its counter LOW, never high —`);
  say(`the predicate then refuses to arm, which is the safe direction, and a re-run corrects it.`);
}
say();

if (process.env.BACKFILL_MD) {
  const p = process.env.BACKFILL_MD.replace(/^~/, homedir());
  writeFileSync(p, out.join("\n") + "\n");
  console.log(`\n[written] ${p}`);
}
process.exit(0);
