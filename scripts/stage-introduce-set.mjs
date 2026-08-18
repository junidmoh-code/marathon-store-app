// ─── THE INTRODUCE SET — OPTION B, STAGED (--execute TO APPLY) ────────────────
//
// The provenance predicate (PR #376) refuses to arm a location that has never sold a
// product there and never received it via a stocking-class movement. That is correct,
// and it creates one circle it cannot break on its own: a shop that has never held a
// line has no provenance, so it gets no target, so it is never refilled, so it never
// acquires provenance. `introduce: true` is the deliberate act that breaks the circle,
// and this script is where the owner's chosen set is written.
//
// ── WHAT WAS CHOSEN, AND WHY IT IS ONE PRODUCT ───────────────────────────────
// The provenance study listed 34 (location, product) pairs whose ONLY evidence is a
// ledger-invisible `seed` cell from setCellState(). Two readings of a seed are
// defensible — "a human deliberately started tracking this here" and "this is exactly
// the 2026-07-29 failure, where zero cells seeded at Trophy raised 15 CR requests for
// jerseys Trophy had never stocked" — so the set was an owner decision, not a
// technical one. Two candidate sets were put up:
//
//   OPTION A — introduce all 34, i.e. treat every seed as owner intent.
//   OPTION B — introduce ONE: hub2 × p1784206551366 "Nike NOCTA Golf T-Shirt White".
//
// OPTION B TAKEN (owner, 2026-08-18). The reasoning is worth recording because it is
// the reasoning, not the list, that will be needed next time:
//
//   1. ON A ZERO-HELD CELL, `introduce` MEANS "RAISE THE FULL SIZE RUN".
//      Every one of the 34 pairs holds 0 units. An introduction therefore does not
//      gently permit future replenishment — it opens the whole run against an on-hand
//      of nothing. Option A would have raised 34 full runs in one scan. (Subject to
//      the reject guards below, which is why the report separates the run a pair
//      RESOLVES from the units it ACTUALLY ASKS FOR.)
//
//   2. THE OTHER 33 HAVE NEVER SOLD A UNIT ANYWHERE. Verified against the live index
//      at the top of this run, not asserted: for every other pair on the worklist,
//      every location's provenance record shows `s` absent. This one product is the
//      only one on the list with a sale on it anywhere in the network — marathon-pe
//      has sold 4 — so it is the only one with evidence that it is a line the business
//      actually trades rather than one somebody once seeded.
//
//   3. REAL TRADE TURNS THE REST ON BY ITSELF. Provenance is maintained forward from
//      applyMovement, so the first genuine stocking movement into any of the other 33
//      makes its pair carry with no opt-in and no script. That is not a theory: this
//      run REPORTS how many of the 34 have already crossed that line since the study
//      was written. Waiting costs an empty shelf that someone will notice; introducing
//      early costs stock moved to a shop that never asked for it, which is the incident
//      that started this work.
//
// ── CARRIAGE IS NOT ORDERING, AND THE REPORT MUST SAY WHICH IT MEANS ─────────
// `introduce: true` decides whether a TARGET RESOLVES. Two guards further down the
// deficit loop decide whether an INTENT IS RAISED, and neither consults provenance
// or this flag: the loop guard (N human rejections while the source's counted cell
// still claims stock → Recount Needed) and the 24h auto-retry.
//
// This is not hypothetical for the chosen pair. On 2026-08-17 at 13:37 an admin
// REJECTED all five sizes of it at hub2, and the streak now stands at 4 of a limit
// of 4 on every size while central's count shows stock. So applying this set today
// arms the line and raises ZERO units — the target resolves and the loop guard parks
// it. That is correct behaviour twice over: carriage answers "does this shop stock
// the line" and a rejection answers "do we want this delivery now", and an opt-in
// must not overrule a person who said no yesterday.
//
// So the report reads both guards live and prints "resolves" and "ACTUALLY ASKS" as
// SEPARATE columns. A staging report that promised a full run while a human's
// rejection was parked against it would be telling the owner the opposite of what
// happens — and it is the number in that report that the decision to apply rests on.
//
// ── SHAPE OF THE WRITE ───────────────────────────────────────────────────────
// One row per DECLARED CATALOGUE SIZE at /stock_targets/{loc}/{pid}/{sizeKey}:
//
//     { introduce: true, introducedAt, introducedBy, note }
//
// NO `target` FIELD, DELIBERATELY. resolveTarget's explicit branch fires on
// `typeof explicit.target === "number"`, so a row carrying a number would PIN these
// quantities forever and outrank the hub2 size run — including any future change to
// that run. Omitting it lets the row say only "this shop stocks this line" and leaves
// the numbers where they belong, in /config/refillEngine/defaultRunByStore. The same
// omission keeps solvePlan.js's mirror in step: explicitTarget() also requires a
// number, so both the engine and the app's Solve fall through to the run.
//
// ONE ROW WOULD HAVE BEEN ENOUGH — introducedAt() returns true if ANY size row under
// (loc, pid) carries the flag. A row per size is written anyway so that the record is
// legible at the size a person is actually looking at, and so that editing a single
// size later does not silently revoke the introduction for the whole product.
//
// ⚠ THESE ROWS CANNOT BE WRITTEN OR EDITED FROM THE APP. The live console rule on
// /stock_targets/$loc/$pid/$size is:
//
//     ".validate": "newData.hasChildren(['target','minQty']) && ... isNumber()"
//
// so a row without a numeric `target` and `minQty` is refused for every client. The
// Admin SDK bypasses rules, which is why this script can write it — but it means the
// engine's claim that introducing a line is "a data edit, no deploy" is only true for
// a script today. That gap is REPORTED, not worked around here: widening the rule is
// a separate decision on a separate paste, and quietly adding target/minQty to make
// the row rule-shaped would reintroduce exactly the pinning that (2) above avoids.
//
// Usage:
//   node scripts/stage-introduce-set.mjs             # match table, writes nothing
//   node scripts/stage-introduce-set.mjs --execute   # apply
//   INTRO_MD=~/report.md node scripts/stage-introduce-set.mjs

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { homedir } from "os";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const { carriesByIndex } = require("../functions/lib/provenance-index.cjs");
const { encodeSizeKey } = await import("../src/utils/sizeKey.js");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const EXECUTE = process.argv.includes("--execute");
const ACTOR = "scripts/stage-introduce-set.mjs";
const NOTE = "Option B introduce set, owner decision 2026-08-18 — the only pair on the 34-pair seed-only worklist with a recorded sale anywhere in the network.";
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

// THE SET. Resolved by pid, never by name — the catalogue has twin names (PR #307).
const SET = [
  { loc: "hub2", pid: "p1784206551366", expectName: "Nike NOCTA Golf T-Shirt White" },
];

// The 34-pair worklist from the provenance study, verbatim, so the claims in the
// header block above are CHECKED on every run rather than trusted.
const WORKLIST = [
  ["hub2", "p1784448340082"], ["hub2", "p1784365145774"], ["hub2", "p1783424090385"],
  ["hub2", "p1784206419956"], ["hub2", "p1784206551366"], ["hub2", "p1786797587841"],
  ["hub2", "p1786798359548"], ["hub2", "p1786798900136"], ["hub2", "p1786799389307"],
  ["hub2", "p1786800063306"], ["hub2", "p1786800705938"], ["hub2", "p1786801583707"],
  ["hub2", "p1786801945086"], ["hub2", "p1786802376909"], ["hub2", "p1786802970277"],
  ["hub2", "p1786804039596"], ["marathon-pe", "p1785069260687"],
  ["marathon-pe", "p1784365145774"], ["marathon-pe", "p1783424090385"],
  ["marathon-pe", "p1784206419956"], ["marathon-pe", "p1784717976460"],
  ["marathon-pe", "p1786797587841"], ["marathon-pe", "p1786798359548"],
  ["marathon-pe", "p1786798900136"], ["marathon-pe", "p1786799389307"],
  ["marathon-pe", "p1786800063306"], ["marathon-pe", "p1786801583707"],
  ["marathon-pe", "p1786802376909"], ["marathon-pe", "p1786802970277"],
  ["marathon-pe", "p1786804039596"], ["marathon-pe", "p1784013526141"],
  ["trophy", "p1784448340082"], ["trophy", "p1786800705938"], ["trophy", "p1786801945086"],
];

const [productsSnap, targetsSnap, stockSnap, provSnap, cfgSnap, streakSnap, retrySnap] = await Promise.all([
  db.ref("/products").once("value"),
  db.ref("/stock_targets").once("value"),
  db.ref("/stock").once("value"),
  db.ref("/stock_provenance").once("value"),
  db.ref("/config/refillEngine").once("value"),
  db.ref("/refill_engine/rejectStreak").once("value"),
  db.ref("/refill_engine/retryState").once("value"),
]);
const products = productsSnap.val() || {};
const targets = targetsSnap.val() || {};
const stock = stockSnap.val() || {};
const prov = provSnap.val() || {};
const cfg = cfgSnap.val() || {};
const rejectStreak = streakSnap.val() || {};
const retryState = retrySnap.val() || {};
const provLocs = Object.keys(prov).filter((k) => k !== "_meta");
const NOW_MS = Date.now();

const nameOf = (pid) => String(products?.[pid]?.name ?? "(unknown)").trim();
const sizesOf = (pid) => (products?.[pid]?.sizes || []).map(String);
const runFor = (loc) => cfg?.defaultRunByStore?.[loc] || {};
const entryAt = (loc, pid) => prov?.[loc]?.[pid] ?? null;
const soldAnywhere = (pid) => provLocs.filter((l) => Number(prov?.[l]?.[pid]?.s) > 0);
const availAt = (loc, pid, sk) => Math.max(0, Number(stock?.[loc]?.[pid]?.[sk]?.qty) || 0);

// The engine's opt-in test, restated on the data this script is about to write.
// BOTH branches, because introducedAt() has two: an explicit /stock_targets row,
// OR the destination's entry in a categoryPolicy category. Mirroring only the first
// would print "not introduced yet" for a pair the engine already considers
// introduced, and then claim credit for a change it did not make.
const introducedRow = (loc, pid) => {
  const rows = targets?.[loc]?.[pid];
  if (rows && typeof rows === "object" && !Array.isArray(rows)
      && Object.keys(rows).some((k) => rows[k]?.introduce === true)) return true;
  const key = products?.[pid]?.categoryKey;
  if (typeof key === "string" && key) {
    const cat = cfg?.categoryPolicy?.[key];
    if (cat && typeof cat === "object" && !Array.isArray(cat) && cat[loc]?.introduce === true) return true;
  }
  return false;
};

// ── THE REJECT GATES — WHY "IT CARRIES" IS NOT "IT ORDERS" ───────────────────
// storeCarries() decides whether a target RESOLVES. Two independent guards sit
// further down the deficit loop and can still park the cell, and neither consults
// provenance or the introduce flag:
//
//   • THE LOOP GUARD (refill-engine.cjs streakState/`st.flagged`). N human
//     rejections while the DENIER's counted cell still claims stock means the
//     count is the problem, not the demand — the cell goes to Recount Needed and
//     the scan raises nothing until someone recounts or taps "Ask again".
//   • THE 24h AUTO-RETRY (`rt.nextRetryAt > now`). An ordinary rejection parks the
//     cell until its scheduled retry.
//
// A report that says "introducing this raises the full run" while a human's
// rejection is parked against it is telling the owner the opposite of what will
// happen. So both are read live and mirrored here. This is a MIRROR of
// streakState() — kept deliberately literal against the three conditions it
// tests, because the engine does not export it.
const streakLimit = Math.max(1, Number(cfg?.rejectStreakLimit) || 3);
const confirmedOutMs = Math.max(1, Number(cfg?.confirmedOutDays) || 14) * 86400e3;
const cooldownMin = Number(cfg?.recheckCooldownMinutes) || 1440;

function rejectGate(dest, pid, size, sizeKey) {
  const denier = cfg?.routes?.[dest] || null;
  const s = rejectStreak?.[dest]?.[pid]?.[sizeKey] || null;
  const rt = retryState?.[dest]?.[pid]?.[sizeKey] || null;
  const out = { parked: false, why: null, streak: s, retry: rt, denier: s?.by || denier };
  if (s) {
    const ts = Date.parse(s.lastTs || 0) || 0;
    const stale = NOW_MS - ts > confirmedOutMs;
    const count = Number(s.count) || 0;
    const has = out.denier ? availAt(out.denier, pid, sizeKey) : 0;
    if (!stale && count >= streakLimit && has > 0) {
      out.parked = true;
      out.why = `LOOP GUARD — rejected ${count}× (limit ${streakLimit}) at \`${out.denier}\` while its count shows ${has}. Recount Needed; clears on a recount or "Ask again" in Health.`;
      return out;
    }
  }
  if (rt?.nextRetryAt && Date.parse(rt.nextRetryAt) > NOW_MS) {
    out.parked = true;
    out.why = `24h AUTO-RETRY — last rejected ${rt.lastRejectedAt}, next retry ${rt.nextRetryAt} (${cooldownMin}min cooldown).`;
  }
  return out;
}

say(`# Introduce set — Option B — ${EXECUTE ? "**EXECUTE**" : "STAGED (nothing written)"}`);
say();
say(`Snapshot ${new Date().toISOString()}. Resolved by pid throughout.`);
say();

// ── 1. THE CHOSEN SET ────────────────────────────────────────────────────────
say(`## 1. The set`);
say();
say(`| location | pid | name | catalogue sizes | provenance there | carries there today | already introduced |`);
say(`|---|---|---|---|---|---|---|`);
let mismatched = 0, sizeless = 0;
for (const s of SET) {
  const e = entryAt(s.loc, s.pid);
  const live = nameOf(s.pid);
  const sizes = sizesOf(s.pid);
  if (s.expectName && live !== s.expectName) mismatched += 1;
  if (!sizes.length) sizeless += 1;
  say(`| \`${s.loc}\` | \`${s.pid}\` | ${JSON.stringify(live)}${s.expectName && live !== s.expectName ? ` ⛔ expected ${JSON.stringify(s.expectName)}` : ""} | ${sizes.join(", ") || "**none ⛔**"} | ${e ? JSON.stringify(e) : "absent"} | ${carriesByIndex(e) ? "TRUE" : "**false**"} | ${introducedRow(s.loc, s.pid) ? "YES" : "no"} |`);
}
say();
if (mismatched) {
  say(`⛔ **${mismatched} pid resolves to a different product than the decision named.** The pid is`);
  say(`authoritative and the name is display-only, but a disagreement means the decision and the`);
  say(`catalogue have diverged since it was made. Nothing is written. Re-check before forcing it.`);
  say();
}
if (sizeless) {
  // Without declared sizes there is nothing to write a row against, and the
  // "already applied" branch below would otherwise report a set of zero rows as
  // a set that is fully in place — a false all-clear on an empty write.
  say(`⛔ **${sizeless} pid declares NO catalogue sizes**, so there is no size key to introduce it on`);
  say(`and the size run has nothing to apply. Nothing is written. Fix the product record first.`);
  say();
}
const refuse = mismatched + sizeless;

// ── 2. WHAT IT RAISES TONIGHT ────────────────────────────────────────────────
say(`## 2. What the introduction raises on the next scan`);
say();
say(`\`introduce: true\` makes storeCarries() answer TRUE, and the clothing size run then applies to`);
say(`every declared size against the on-hand at that location. With every cell at zero that is the`);
say(`FULL RUN — which is the whole reason this set is one product and not thirty-four.`);
say();
say(`**Carrying is not ordering.** Two guards sit below the target and consult neither provenance nor`);
say(`the introduce flag: the loop guard (N human rejections while the source still counts stock) and`);
say(`the 24h auto-retry. Both are read live below, because a report that promises a full run while a`);
say(`human's rejection is parked against it is telling you the opposite of what will happen.`);
say();
say(`| location | size | run target | held | source | source has | resolves | ACTUALLY ASKS |`);
say(`|---|---|---|---|---|---|---|---|`);
let resolveTotal = 0, askTotal = 0;
const parked = [];
for (const s of SET) {
  const run = runFor(s.loc);
  const src = cfg?.routes?.[s.loc] || null;
  for (const size of sizesOf(s.pid)) {
    const sk = encodeSizeKey(size);
    const held = Number(stock?.[s.loc]?.[s.pid]?.[sk]?.qty) || 0;
    const t = Number(run[size]) || 0;
    const want = Math.max(0, t - Math.max(0, held));
    resolveTotal += want;
    const gate = rejectGate(s.loc, s.pid, size, sk);
    const ask = gate.parked ? 0 : want;
    askTotal += ask;
    if (gate.parked) parked.push({ ...s, size, want, gate });
    say(`| \`${s.loc}\` | ${size} | ${t || "—"} | ${held} | \`${src}\` | ${availAt(src, s.pid, sk)} | ${want} | ${gate.parked ? "**0 — PARKED**" : ask} |`);
  }
}
say();
if (parked.length) {
  say(`### ⛔ ${parked.length} of ${resolveTotal ? sizesOf(SET[0].pid).length : 0} size(s) are PARKED BY A HUMAN REJECTION`);
  say();
  say(`The target resolves. The intent is not raised. **${resolveTotal} unit(s) would be asked for; ${askTotal} actually will be.**`);
  say();
  for (const p of parked) say(`- \`${p.loc}\` ${p.size} — ${p.gate.why}`);
  say();
  say(`**Read this before applying.** Somebody rejected these lines deliberately, in the app. The`);
  say(`introduce flag does NOT override that and should not: carriage answers "does this shop stock`);
  say(`the line", a rejection answers "do we want this delivery now", and they are different`);
  say(`questions. Introducing is still the right standing decision — the flag is what lets the line`);
  say(`arm at all once the rejection clears — but it will not move stock tonight.`);
  say();
  say(`To make it move: recount the source cell, or tap **Ask again** in Health for these sizes.`);
  say(`Neither is this script's business, and neither should be done just to make a number appear.`);
  say();
} else {
  say(`✅ No reject streak or retry gate is parked against any size. **${askTotal} unit(s)** of demand`);
  say(`on the next scan after the rewired engine deploys.`);
  say();
}
say(`Timing, precisely: \`introducedAt()\` is checked BEFORE the readiness gate (refill-engine.cjs),`);
say(`so an introduced pair arms even while \`/stock_provenance/_meta\` is missing. **The gate is the`);
say(`FUNCTIONS deploy, not the backfill** — nothing here moves until \`refillHealthScan\` ships the`);
say(`rewired engine, and after that it moves on the next scan whether or not the index is ready.`);
say();
say(`Against \`maxIntentsPerRun\` = ${JSON.stringify(cfg?.maxIntentsPerRun)}, mode ${JSON.stringify(cfg?.mode)}, \`rejectStreakLimit\` = ${streakLimit}.`);
say();

// ── 3. THE CLAIM THE DECISION RESTS ON, RE-CHECKED ───────────────────────────
say(`## 3. The decision's premise, re-checked against the live index`);
say();
say(`The set was chosen because this is the only pair on the 34-pair seed-only worklist whose product`);
say(`has EVER sold anywhere. That is a claim about live data, so it is tested here rather than trusted.`);
say();
const chosen = new Set(SET.map((s) => `${s.loc}|${s.pid}`));
const withSales = [], nowCarries = [], stillDark = [];
for (const [loc, pid] of WORKLIST) {
  const sold = soldAnywhere(pid);
  if (sold.length) withSales.push({ loc, pid, sold });
  if (carriesByIndex(entryAt(loc, pid))) nowCarries.push({ loc, pid });
  else stillDark.push({ loc, pid });
}
say(`| | pairs |`);
say(`|---|---|`);
say(`| on the worklist | ${WORKLIST.length} |`);
say(`| whose product has a recorded sale ANYWHERE | ${withSales.length} |`);
say(`| **already carrying under the predicate today** (real trade turned them on) | **${nowCarries.length}** |`);
say(`| still refused, and left refused by this decision | ${stillDark.filter((d) => !chosen.has(`${d.loc}|${d.pid}`)).length} |`);
say(`| introduced by this script | ${SET.length} |`);
say();
if (withSales.length) {
  say(`Pairs whose product has sold somewhere:`);
  say();
  say(`| loc | pid | name | sold at | in the chosen set? |`);
  say(`|---|---|---|---|---|`);
  for (const w of withSales) {
    say(`| \`${w.loc}\` | \`${w.pid}\` | ${JSON.stringify(nameOf(w.pid))} | ${w.sold.map((l) => `\`${l}\`:${prov[l][w.pid].s}`).join(" ")} | ${chosen.has(`${w.loc}|${w.pid}`) ? "**YES**" : "no"} |`);
  }
  say();
}
const unexpected = withSales.filter((w) => !chosen.has(`${w.loc}|${w.pid}`));
say(unexpected.length
  ? `⚠️ **${unexpected.length} worklist pair(s) with sales are NOT in the chosen set.** The premise that this is the only one has stopped holding — the table above is the current picture and the set may deserve revisiting.`
  : `✅ Premise holds: the chosen set is exactly the worklist pairs whose product has ever sold.`);
say();
if (nowCarries.length) {
  say(`### ${nowCarries.length} worklist pair(s) no longer need an opt-in`);
  say();
  say(`They acquired a stocking-class movement after the study was written, so the predicate now answers`);
  say(`TRUE for them without any row. This is the self-healing the decision counted on, measured rather`);
  say(`than assumed — and it is why introducing the rest early would have been a write nobody needed.`);
  say();
  say(`| loc | pid | name | provenance |`);
  say(`|---|---|---|---|`);
  for (const c of nowCarries) say(`| \`${c.loc}\` | \`${c.pid}\` | ${JSON.stringify(nameOf(c.pid))} | ${JSON.stringify(entryAt(c.loc, c.pid))} |`);
  say();
}

// ── 4. BEFORE / AFTER ────────────────────────────────────────────────────────
let rowsBefore = 0, introBefore = 0, pinnedBefore = 0, zeroBefore = 0;
for (const loc of Object.keys(targets)) {
  for (const pid of Object.keys(targets[loc] || {})) {
    for (const sk of Object.keys(targets[loc][pid] || {})) {
      const row = targets[loc][pid][sk];
      rowsBefore += 1;
      if (row?.introduce === true) introBefore += 1;
      if (typeof row?.target === "number") pinnedBefore += 1;
      if (row?.target === 0) zeroBefore += 1;
    }
  }
}
const now = new Date().toISOString();
const updates = {};
// Which size keys ALREADY hold a row? A leaf written under an existing row MERGES
// into it rather than creating one, so the row total would be overstated — and the
// "no existing row touched" sentence would be false. Measured, not assumed.
const touchingExisting = [];
// Rows this run CREATES, as opposed to rows it merges a flag into. The distinction is
// only visible here, and the rollback below is wrong without it: deleting a whole row
// that someone else created — and this run merely added a flag to — destroys their
// target along with our flag. (CodeRabbit, PR #380.)
const brandNew = new Set();
if (!refuse) {
  for (const s of SET) {
    for (const size of sizesOf(s.pid)) {
      const sk = encodeSizeKey(size);
      const row = targets?.[s.loc]?.[s.pid]?.[sk];
      if (row?.introduce === true) continue;   // idempotent — already introduced
      if (row) touchingExisting.push({ loc: s.loc, pid: s.pid, sk, row });
      else brandNew.add(`stock_targets/${s.loc}/${s.pid}/${sk}`);
      updates[`stock_targets/${s.loc}/${s.pid}/${sk}/introduce`] = true;
      updates[`stock_targets/${s.loc}/${s.pid}/${sk}/introducedAt`] = now;
      updates[`stock_targets/${s.loc}/${s.pid}/${sk}/introducedBy`] = ACTOR;
      updates[`stock_targets/${s.loc}/${s.pid}/${sk}/note`] = NOTE;
    }
  }
}
const newRows = Object.keys(updates).filter((k) => k.endsWith("/introduce")).length;
const brandNewRows = newRows - touchingExisting.length;

say(`## 4. Before / after`);
say();
say(`| | before | after |`);
say(`|---|---|---|`);
say(`| \`/stock_targets\` rows total | ${rowsBefore} | ${rowsBefore + brandNewRows} |`);
say(`| rows carrying \`introduce: true\` | ${introBefore} | ${introBefore + newRows} |`);
say(`| rows carrying a numeric \`target\` | ${pinnedBefore} | ${pinnedBefore} |`);
say(`| \`target: 0\` policy rows | ${zeroBefore} | ${zeroBefore} |`);
say(`| locations answering carries for \`${SET.map((s) => s.pid).join(", ")}\` | ${SET.filter((s) => carriesByIndex(entryAt(s.loc, s.pid)) || introducedRow(s.loc, s.pid)).length} of ${SET.length} | ${SET.length} of ${SET.length} |`);
say();
if (touchingExisting.length) {
  say(`⚠️ **${touchingExisting.length} of the ${newRows} flag(s) land on a size key that ALREADY holds a row**, so they`);
  say(`merge into it rather than creating one — which is why the row total above rises by only`);
  say(`${brandNewRows}. Those rows keep every field they have, including any numeric \`target\`, and a`);
  say(`numeric target OUTRANKS the size run. Check these before applying:`);
  say();
  for (const t of touchingExisting) say(`- \`${t.loc}/${t.pid}/${t.sk}\` → ${JSON.stringify(t.row)}`);
  say();
} else {
  say(`Nothing existing is modified — checked, not assumed: every one of the ${newRows} path(s) written`);
  say(`lands on a size key that holds no row today. No \`target\`, no \`minQty\`, no existing row touched.`);
  say();
}

if (!EXECUTE) {
  say(`## Nothing written`);
  say();
  say("```bash");
  say(`node scripts/stage-introduce-set.mjs --execute`);
  say("```");
  say();
  say(`${newRows} row(s) staged across ${Object.keys(updates).length} paths, one atomic update. A re-run`);
  say(`skips any row that already carries the flag, so it resumes rather than doubles.`);
} else if (refuse) {
  say(`## Refused`);
  say();
  say(`Nothing written — see the refusal(s) above.`);
} else {
  if (newRows) {
    say(`## Applying`);
    say();
    // ── OWNERSHIP RE-CHECK, AS LATE AS POSSIBLE (CodeRabbit, PR #380) ────────
    // The match table was computed from a snapshot taken minutes ago. If another
    // writer created one of these rows since — the app's target editor, the
    // Introduce Existing migration, another script — then merging a flag into it
    // silently attaches this decision to somebody else's row, and the rollback
    // below would delete their work along with our flag.
    //
    // RTDB has no conditional multi-path update, so this is a guard, not a CAS: it
    // re-reads each affected row and refuses if the answer moved. Same honest limit
    // as the negative-cell script — it narrows the window to one round trip and
    // does not close it. Run it quiet, or accept a one-row blast radius that the
    // report names exactly.
    const rowPaths = [...new Set(Object.keys(updates).map((k) => k.replace(/\/[^/]+$/, "")))];
    const fresh = await Promise.all(rowPaths.map((p) => db.ref(p).once("value").then((s) => s.val())));
    const moved = [];
    rowPaths.forEach((p, i) => {
      const before = brandNew.has(p) ? null : (touchingExisting.find((t) => `stock_targets/${t.loc}/${t.pid}/${t.sk}` === p)?.row ?? null);
      const nowRow = fresh[i];
      if (before === null && nowRow !== null) moved.push(`${p} — created by another writer since the match table`);
      else if (before !== null && JSON.stringify(nowRow) !== JSON.stringify(before)) moved.push(`${p} — changed since the match table`);
    });
    if (moved.length) {
      say(`⛔ **Refused at the ownership re-check — nothing written.** ${moved.length} row(s) moved since the`);
      say(`match table above was computed, so applying would merge this decision into a row someone else`);
      say(`just wrote:`);
      say();
      for (const m of moved) say(`- \`${m}\``);
      say();
      say(`Re-run to get a fresh match table and decide against the current state.`);
      process.exitCode = 1;
    } else {
    try {
      await db.ref().update(updates);
    } catch (err) {
      say(`⛔ the write FAILED and nothing landed: ${String(err?.message || err)}`);
      say();
      say(`A multi-path update is atomic, so this is all-or-nothing — re-run once the cause is fixed.`);
      process.exitCode = 1;
    }
    if (!process.exitCode) say(`- wrote ${newRows} row(s), ${Object.keys(updates).length} paths, in one atomic update.`);
    }
  } else {
    say(`## Already applied — re-verifying anyway`);
    say();
    say(`Every row in the set already carries \`introduce: true\`, so nothing is written. The invariant`);
    say(`is still checked below: "already introduced" and "still correct" are different claims, and a`);
    say(`row that acquired a numeric \`target\` since it was written is exactly what this run should`);
    say(`catch. Skipping the check on the no-op path would blind it precisely when it is being used`);
    say(`to confirm state. (CodeRabbit-substitute review, PR #380.)`);
  }
  say();
  // ── THE INVARIANT, CHECKED ON EVERY --execute ──────────────────────────────
  // Runs whether or not anything was written. The row must carry the flag AND
  // must NOT carry a numeric target: a `{target, minQty}` write is rule-shaped, so
  // the console and any future app writer are ALLOWED to add one, which would
  // silently pin the quantities and defeat the whole design of the row.
  say(`## Verification`);
  say();
  const fresh = (await db.ref("/stock_targets").once("value")).val() || {};
  say(`| location | pid | size | introduce | has numeric target (must be none) |`);
  say(`|---|---|---|---|---|`);
  let bad = 0;
  for (const s of SET) {
    for (const size of sizesOf(s.pid)) {
      const row = fresh?.[s.loc]?.[s.pid]?.[encodeSizeKey(size)] || null;
      const ok = row?.introduce === true;
      const pinned = typeof row?.target === "number";
      if (!ok || pinned) bad += 1;
      say(`| \`${s.loc}\` | \`${s.pid}\` | ${size} | ${ok ? "✅ true" : "⛔ missing"} | ${pinned ? `⛔ ${row.target} — the run is overruled` : "✅ none"} |`);
    }
  }
  say();
  say(bad ? `⛔ ${bad} row(s) are wrong — investigate before the next scan.` : `✅ every row carries the flag and none pins a target.`);
  if (bad) process.exitCode = 1;
}
say();
say(`## Rollback`);
say();
say(`Delete the rows. The predicate reverts to the index alone and the location goes dark again for`);
say(`this product — no other product, no other location, nothing else keyed to these rows.`);
say();
say(`Runnable, not illustrative. A row this run CREATED is removed whole; a row that already`);
say(`existed and merely gained the flag has ONLY the introduce leaves removed — deleting it whole`);
say(`would destroy a target somebody else wrote. (CodeRabbit, PR #380.)`);
say();
say("```bash");
{
  const merged = new Set(touchingExisting.map((t) => `stock_targets/${t.loc}/${t.pid}/${t.sk}`));
  for (const s of SET) {
    for (const size of sizesOf(s.pid)) {
      const p = `stock_targets/${s.loc}/${s.pid}/${encodeSizeKey(size)}`;
      if (merged.has(p)) {
        for (const leaf of ["introduce", "introducedAt", "introducedBy", "note"]) {
          say(`firebase database:remove /${p}/${leaf} --project marathon-club --force`);
        }
      } else {
        say(`firebase database:remove /${p} --project marathon-club --force`);
      }
    }
  }
}
say("```");
say();
say(`⚠️ Re-read the match table before pasting: which branch a row belongs in is decided by whether`);
say(`it existed when this ran, and that is a fact about the moment, not about the path.`);
say();

if (process.env.INTRO_MD) {
  const path = process.env.INTRO_MD.replace(/^~/, homedir());
  writeFileSync(path, out.join("\n") + "\n");
  console.log(`\n[written] ${path}`);
}
if (refuse) process.exitCode = 1;
process.exit(process.exitCode || 0);
