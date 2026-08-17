// ─── COMMIT 2 — BACKFILL /stock_provenance (STAGED; --execute TO APPLY) ───────
//
// Materialises the derived carries index from the whole ledger so the engine never
// has to. Reads /stock_movements end to end at least twice under --execute: once to
// compute, then again to establish that nothing else wrote provenance while it was
// writing. This script is where the ledger's full read cost is paid; the engine never
// pays it.
//
// AUTHORITATIVE OR UNREADY — there is no third state. A backfill that races another
// writer cannot be reconciled from the ledger, because "was this already counted" is
// not a question the ledger answers. So the run either PROVES it was alone and claims
// authority, or removes the readiness sentinels and leaves every location unarmed for
// a later quiet run. It never leaves a half-trusted index behind. The reasoning, and
// the three rejected designs that led here, are in that block.
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
// fixed in refill-engine.cjs.)
//
// ORDER — rules → HOSTING → this script, quiet → functions.
// See PROVENANCE-RULES.md for the measurement behind it. Hosting is SECOND, not last.
// An earlier version of this file said last, reasoning that it kept forward maintenance
// from racing the backfill. It does — but it also leaves the index materialised and
// UNMAINTAINED until hosting lands, and that interval is not safe in both directions:
// an unrecorded UNSTOCK leaves `u` low, so `k − u` reads HIGH, so the index over-states
// carriage and fails toward ARMING a shop that holds nothing. Under-counting `s` or `k`
// merely under-arms; over-counting carriage is the bug this index exists to prevent.
//
// With hosting already live, a daytime run is not dangerous — it is merely futile. The
// full-subtree contention check sees the concurrent writes and REMOVES the sentinels
// rather than claiming authority. Quiescence is what this script verifies, never what
// the deploy order assumes on its behalf. Run it before 07:00 or after 19:00.
//
// SEED CELLS ESTABLISH NOTHING. 540 cells carry `mv: "seed"` from setCellState(),
// which writes outside the ledger by design, and 34 (loc,pid) pairs have no other
// evidence. They are reported here as a worklist, never silently promoted — see
// the provenance study for why both readings are defensible and why the
// conservative one was taken.
//
// Usage (step 3 of four — see the ORDER note below; hosting must already be deployed):
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

// ── COMPARING TWO PROVENANCE RECORDS ─────────────────────────────────────────
// NOT JSON.stringify. The first live --execute run reported 283 pairs as CONTENDED
// and removed every sentinel, on differences that were entirely key ORDER: RTDB
// returns a node's children lexicographically (`{k, s}`) while `toRecord` builds them
// in counter order (`{s, k, u}`), so `{"s":2,"k":14}` and `{"k":14,"s":2}` — the same
// record — compared unequal. The fail-safe behaved exactly as designed; it was the
// evidence feeding it that was wrong.
//
// The contract is three integer counters, so the comparison is on those three values,
// with an absent counter and a zero counter treated alike (toRecord omits zeroes, so
// both spellings of "none" occur). Any key outside the contract on either side is
// still a real difference and still reported — that is a foreign write, which is
// exactly what this check exists to catch.
// CANONICALISING, NOT FORGIVING. The distinction is the whole point: this check is the
// fail-safe that stopped a bad publish, and it is not being traded for convenience.
//
// Equal ONLY when, for each of the three counters, the two records agree on the same
// integer — where "absent" and "0" are the same integer, because toRecord OMITS zeroes
// and so both spellings of "none" legitimately occur in live data. Everything else is a
// difference:
//   • any counter differing by any amount, in either direction  → different
//   • a counter PRESENT but not a finite integer                → different (a corrupt
//     or foreign write must not be laundered into 0 and matched against an absent one)
//   • any key outside the three                                 → different
//   • a null/array/non-object on one side only                  → different
function normCounter(v) {
  if (v === undefined || v === null) return 0;                     // absent === zero
  if (typeof v !== "number" || !Number.isFinite(v) || v % 1 !== 0) return NaN;   // corrupt
  return v;
}
const COUNTER_FIELDS = ["s", "k", "u"];
function sameRecord(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  for (const f of COUNTER_FIELDS) {
    const x = normCounter(a[f]), y = normCounter(b[f]);
    // NaN !== NaN, so a corrupt counter can never compare equal to anything — not even
    // to another corrupt one. That is deliberate: it forces CONTENDED rather than a
    // quiet match.
    if (!(x === y)) return false;
  }
  const foreign = (o) => Object.keys(o).some((k) => !COUNTER_FIELDS.includes(k));
  return !foreign(a) && !foreign(b);
}

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
// Every pair that existed BEFORE this run, by path. The contention check below needs
// it to tell "a record this run does not touch" from "a record something else just
// wrote" — without it, every pre-existing orphan would read as contention.
const preExistingOrphans = new Map();
for (const loc of Object.keys(liveIndex)) {
  if (loc === "_meta") continue;
  for (const pid of Object.keys(liveIndex[loc] || {})) preExistingOrphans.set(idx.pairPath(loc, pid), liveIndex[loc][pid]);
}
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

  // ── THE AUTHORITATIVE-OR-UNREADY PASS ──────────────────────────────────────
  // Pass 1 SET every counter from a ledger read taken before the writes began. If
  // anything else was writing provenance during that window, some of those writes
  // were overwritten. Three designs for reconciling that were tried and rejected,
  // and the third failure is the reason this block now refuses rather than repairs:
  //
  //  1. Re-apply movements stamped after the read, as INCREMENTS. Wrong: the read is
  //     paginated, so a movement stamped after it began can already be IN it and gets
  //     counted twice. (CodeRabbit.)
  //  2. Re-apply movements whose ID was absent from the read, as INCREMENTS. Wrong:
  //     survival of an increment depends on when the movement landed relative to the
  //     SET WRITE OF ITS PAIR, not relative to the read, so one landing after its
  //     pair's SET is both preserved and re-incremented. (Kimi.)
  //  3. Re-SET every differing pair from a fresh full fold, calling the residual a
  //     lost update that "fails closed". Wrong, and this is the important one: a lost
  //     update is only safe for `s` and `k`. The predicate is `k - u > 0`, so losing
  //     a `u` increment makes net stocking LARGER. Overwrite a concurrent `u` and a
  //     pair that correctly does not carry starts carrying — {k:4,u:3} re-SET over a
  //     live {k:4,u:4} arms a shop that has nothing. That is the exact bug this index
  //     exists to prevent, reintroduced by its own repair path. (CodeRabbit.)
  //
  // There is no write protocol that reconciles a concurrent writer from the ledger
  // alone, because "was this already counted" is not a question the ledger answers.
  // So this pass does not try. It establishes whether the run was QUIESCENT and acts
  // on the answer:
  //
  //   quiescent  → no other writer touched provenance, pass 1 IS authoritative, and
  //                the only work left is catching movements that landed after the
  //                read. Those are increments of ids pass 1 provably did not count,
  //                which is exact precisely because nothing else incremented them.
  //   contended  → this run cannot produce an authoritative index. The sentinels are
  //                REMOVED, so every location reads as unready: the engine arms
  //                nothing, and the needGone guard stops it withdrawing anything on
  //                the strength of a target that only failed to resolve because the
  //                index was missing. It does NOT freeze withdrawal altogether —
  //                explicit `target: 0` rows and target-met withdrawals stay active,
  //                deliberately, since neither consults provenance. Nothing is left
  //                half-trusted. Re-run during a quiet window.
  //
  // Quiescence is DETECTED, not assumed. If forward maintenance is live, its increment
  // is already visible in the index — either as a changed pair or as a pair that did
  // not exist when this run started. So the check compares the WHOLE indexed subtree
  // against the state this run expects, and treats a changed, missing OR unexpected
  // pair as contention. Comparing only the pairs pass 1 wrote is not enough: a
  // concurrent movement for a previously unseen (loc, pid) creates its counter at a
  // path pass 1 never had, which such a check cannot see.
  //
  // NOTHING HERE ASSUMES QUIESCENCE — it is verified. Under the documented order hosting
  // is already live, so applyMovement's provenance leg CAN write while this runs; that
  // is precisely why the check below is a full-subtree comparison rather than a trust in
  // sequencing. A run during trading finds contention and declines. A run in a quiet
  // window finds none and claims authority. (The POS app never writes this node, so
  // tills are not a source of contention — only this repo's own hosting bundle is.)
  say();
  say(`### Authoritative-or-unready pass`);
  say();
  const seenIds = new Set(Object.keys(movements));
  let authoritative = true;
  let rounds = 0;

  for (rounds = 1; rounds <= 3; rounds += 1) {
    const reread = await readPaged("/stock_movements");
    const newIds = Object.keys(reread).filter((id) => !seenIds.has(id) && reread[id]);
    say(`Round ${rounds}: ledger holds ${Object.keys(reread).length} record(s); ${newIds.length} are new since pass 1's read.`);

    // CONTENTION CHECK — THE WHOLE SUBTREE, NOT JUST THE PAIRS PASS 1 WROTE.
    //
    // The first version of this check iterated `payload` only, which misses the case
    // that matters most: a movement arriving after pass 1's read for a (loc, pid) that
    // pass 1 never saw. applyMovement creates its ledger record AND its provenance
    // counter in one atomic update, so a brand-new pair appears live at a path absent
    // from `payload`. Comparing only `payload` finds no difference, declares the run
    // quiescent, and then the tail pass sees that movement's id as new and increments
    // the counter the app already wrote — {k:1} becomes {k:2}, and for an undo
    // sequence it inflates `u` instead. Exactly the double-count the whole
    // authoritative-or-unready design exists to make impossible. (CodeRabbit.)
    //
    // So contention means ANY difference between the live indexed subtree and the state
    // this run expects: a changed pair, a MISSING pair, or an UNEXPECTED one.
    //
    // Pairs that were already live before pass 1 and are not reproduced by the fold
    // (the orphans reported above) are expected to be present and unchanged — they are
    // pre-existing records this run deliberately does not touch, not evidence of a
    // concurrent writer.
    const contended = [];
    for (const loc of LOCS) {
      const liveLoc = (await db.ref(idx.locPath(loc)).once("value")).val() || {};
      const seenPaths = new Set();
      for (const pid of Object.keys(liveLoc)) {
        const path = idx.pairPath(loc, pid);
        seenPaths.add(path);
        const expected = payload[path] ?? preExistingOrphans.get(path) ?? null;
        if (expected === null) {
          contended.push({ path, live: liveLoc[pid], expected: "(pair did not exist when this run started)" });
        } else if (!sameRecord(liveLoc[pid], expected)) {
          contended.push({ path, live: liveLoc[pid], expected });
        }
      }
      // A pair this run wrote that is now GONE is contention too — something removed it.
      for (const path of Object.keys(payload)) {
        if (path.startsWith(`${idx.PROVENANCE_ROOT}/${loc}/`) && !seenPaths.has(path)) {
          contended.push({ path, live: "(missing)", expected: payload[path] });
        }
      }
      if (contended.length) break;
    }
    if (contended.length) {
      say();
      say(`⛔ **CONTENDED — another writer is maintaining /stock_provenance while this run is writing.**`);
      say();
      say(`| path | this run expected | live now |`);
      say(`|---|---|---|`);
      for (const c of contended.slice(0, 20)) say(`| \`${c.path}\` | \`${JSON.stringify(c.expected)}\` | \`${JSON.stringify(c.live)}\` |`);
      if (contended.length > 20) say(`| … | | _${contended.length - 20} more_ |`);
      say();
      say(`A concurrent \`u\` increment cannot be reconciled from the ledger: overwriting it RAISES`);
      say(`\`k - u\` and would arm a shop that holds nothing. So this run will not claim authority.`);
      authoritative = false;
      break;
    }

    if (!newIds.length) { say(`Quiescent — pass 1 is authoritative.`); break; }

    // Increments of ids pass 1 provably did not count, applied only after quiescence
    // has been established, so nothing else has counted them either.
    const tailProv = foldProvenance(newIds.map((id) => reread[id]));
    const upd = {};
    let touched = 0;
    for (const [key, e] of tailProv.entries()) {
      const [loc, pid] = key.split("|");
      if (!LOCS.includes(loc)) continue;
      if (e.sold > 0) upd[`${idx.pairPath(loc, pid)}/s`] = admin.database.ServerValue.increment(e.sold);
      if (e.stockedUnits > 0) upd[`${idx.pairPath(loc, pid)}/k`] = admin.database.ServerValue.increment(e.stockedUnits);
      if (e.unstockedUnits > 0) upd[`${idx.pairPath(loc, pid)}/u`] = admin.database.ServerValue.increment(e.unstockedUnits);
      touched += 1;
    }
    if (Object.keys(upd).length) {
      await db.ref().update(upd);
      say(`Applied ${Object.keys(upd).length} increment(s) across ${touched} pair(s) for the new movements.`);
      // Fold the applied ids into BOTH the seen set and `payload`, so the next round's
      // contention check compares against what is now expected rather than flagging
      // this pass's own writes as someone else's.
      for (const id of newIds) seenIds.add(id);
      for (const [key, e] of tailProv.entries()) {
        const [loc, pid] = key.split("|");
        if (!LOCS.includes(loc)) continue;
        const path = idx.pairPath(loc, pid);
        const base = payload[path] || {};
        payload[path] = idx.toRecord({
          sold: (base.s || 0) + e.sold,
          stockedUnits: (base.k || 0) + e.stockedUnits,
          unstockedUnits: (base.u || 0) + e.unstockedUnits,
        });
      }
    } else {
      for (const id of newIds) seenIds.add(id);
      say(`None of the new movements affect a counter at an indexed location.`);
      break;
    }
    if (rounds === 3) { say(); say(`⛔ Still not quiescent after 3 rounds — the ledger is too busy for this run to claim authority.`); authoritative = false; }
  }

  say();
  if (!authoritative) {
    // Leave NOTHING half-trusted. Unready arms nothing, and no line is withdrawn
    // BECAUSE the index is missing — explicit-0 and target-met withdrawals continue
    // on their own evidence, which is correct.
    for (const loc of LOCS) await db.ref(idx.metaPath(loc)).remove();
    say(`## ⛔ Sentinels REMOVED — the index is not armed`);
    say();
    say(`Pair records are still in place (they are useful and mostly correct) but every location now`);
    say(`reads as UNREADY, so the engine arms nothing new and withdraws nothing on account of the`);
    say(`missing index. (Explicit \`target: 0\` and target-met withdrawals still run — they never`);
    say(`consulted provenance.)`);
    say();
    say(`WHAT TO DO: re-run this script in a QUIET WINDOW — before 07:00 or after 19:00 SAST. Something`);
    say(`is writing /stock_provenance concurrently, which is expected once hosting is live (that is the`);
    say(`documented order: rules → hosting → this script → functions). A concurrent writer cannot be`);
    say(`reconciled from the ledger, so the run declines instead of publishing a number it cannot`);
    say(`vouch for. Nothing is broken and nothing needs undoing.`);
  } else {
    // `pairs` keeps ONE meaning in both writes: pairs this run computed for the
    // location. Counted from `payload`, which now includes any increments applied
    // above, so it cannot disagree with a pass-1-only sentinel under the same name.
    const finalPairs = new Map();
    for (const path of Object.keys(payload)) {
      const loc = path.split("/")[1];
      finalPairs.set(loc, (finalPairs.get(loc) || 0) + 1);
    }
    for (const loc of LOCS) {
      await db.ref(idx.metaPath(loc)).update({
        at: new Date().toISOString(),
        pairs: finalPairs.get(loc) || 0,
        rounds,
      });
    }
    say(`## ✅ Authoritative — sentinels confirmed after ${rounds} round(s)`);
    say();
    say(`No other writer touched /stock_provenance during this run, so pass 1's SET values stand and`);
    say(`the increments applied above are exact. Every location is armable.`);
  }
}
say();

if (process.env.BACKFILL_MD) {
  const p = process.env.BACKFILL_MD.replace(/^~/, homedir());
  writeFileSync(p, out.join("\n") + "\n");
  console.log(`\n[written] ${p}`);
}
process.exit(0);
