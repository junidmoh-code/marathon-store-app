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
//   1. ON A ZERO-HELD CELL, `introduce` MEANS "RAISE THE FULL SIZE RUN TONIGHT".
//      Every one of the 34 pairs holds 0 units. An introduction therefore does not
//      gently permit future replenishment — it opens the whole run against an on-hand
//      of nothing, immediately. Option A would have raised 34 full runs in one scan.
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

const [productsSnap, targetsSnap, stockSnap, provSnap, cfgSnap] = await Promise.all([
  db.ref("/products").once("value"),
  db.ref("/stock_targets").once("value"),
  db.ref("/stock").once("value"),
  db.ref("/stock_provenance").once("value"),
  db.ref("/config/refillEngine").once("value"),
]);
const products = productsSnap.val() || {};
const targets = targetsSnap.val() || {};
const stock = stockSnap.val() || {};
const prov = provSnap.val() || {};
const cfg = cfgSnap.val() || {};
const provLocs = Object.keys(prov).filter((k) => k !== "_meta");

const nameOf = (pid) => String(products?.[pid]?.name ?? "(unknown)").trim();
const sizesOf = (pid) => (products?.[pid]?.sizes || []).map(String);
const runFor = (loc) => cfg?.defaultRunByStore?.[loc] || {};
const entryAt = (loc, pid) => prov?.[loc]?.[pid] ?? null;
const soldAnywhere = (pid) => provLocs.filter((l) => Number(prov?.[l]?.[pid]?.s) > 0);
// The engine's own opt-in test, restated on the data this script is about to write.
const introducedRow = (loc, pid) => {
  const rows = targets?.[loc]?.[pid];
  if (!rows || typeof rows !== "object") return false;
  return Object.keys(rows).some((k) => rows[k]?.introduce === true);
};

say(`# Introduce set — Option B — ${EXECUTE ? "**EXECUTE**" : "STAGED (nothing written)"}`);
say();
say(`Snapshot ${new Date().toISOString()}. Resolved by pid throughout.`);
say();

// ── 1. THE CHOSEN SET ────────────────────────────────────────────────────────
say(`## 1. The set`);
say();
say(`| location | pid | name | catalogue sizes | provenance there | carries there today | already introduced |`);
say(`|---|---|---|---|---|---|---|`);
let mismatched = 0;
for (const s of SET) {
  const e = entryAt(s.loc, s.pid);
  const live = nameOf(s.pid);
  if (s.expectName && live !== s.expectName) mismatched += 1;
  say(`| \`${s.loc}\` | \`${s.pid}\` | ${JSON.stringify(live)}${s.expectName && live !== s.expectName ? ` ⛔ expected ${JSON.stringify(s.expectName)}` : ""} | ${sizesOf(s.pid).join(", ") || "—"} | ${e ? JSON.stringify(e) : "absent"} | ${carriesByIndex(e) ? "TRUE" : "**false**"} | ${introducedRow(s.loc, s.pid) ? "YES" : "no"} |`);
}
say();
if (mismatched) {
  say(`⛔ **${mismatched} pid resolves to a different product than the decision named.** The pid is`);
  say(`authoritative and the name is display-only, but a disagreement means the decision and the`);
  say(`catalogue have diverged since it was made. Nothing is written. Re-check before forcing it.`);
  say();
}

// ── 2. WHAT IT RAISES TONIGHT ────────────────────────────────────────────────
say(`## 2. What the introduction raises on the next scan`);
say();
say(`\`introduce: true\` makes storeCarries() answer TRUE, and the clothing size run then applies to`);
say(`every declared size against the on-hand at that location. With every cell at zero that is the`);
say(`FULL RUN, immediately — which is the whole reason this set is one product and not thirty-four.`);
say();
say(`| location | size | hub run target | units held there | units it will ask for | source available |`);
say(`|---|---|---|---|---|---|`);
let askTotal = 0;
for (const s of SET) {
  const run = runFor(s.loc);
  const src = cfg?.routes?.[s.loc] || null;
  for (const size of sizesOf(s.pid)) {
    const sk = encodeSizeKey(size);
    const held = Number(stock?.[s.loc]?.[s.pid]?.[sk]?.qty) || 0;
    const t = Number(run[size]) || 0;
    const ask = Math.max(0, t - Math.max(0, held));
    askTotal += ask;
    const avail = Math.max(0, Number(stock?.[src]?.[s.pid]?.[sk]?.qty) || 0);
    say(`| \`${s.loc}\` | ${size} | ${t || "—"} | ${held} | ${ask} | \`${src}\` holds ${avail} |`);
  }
}
say();
say(`**${askTotal} unit(s)** of demand, once the provenance index is ready and the rewired engine is live.`);
say(`Against \`maxIntentsPerRun\` = ${JSON.stringify(cfg?.maxIntentsPerRun)} and mode ${JSON.stringify(cfg?.mode)}.`);
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
say(`| still refused, and left refused by this decision | ${stillDark.length - SET.length} |`);
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
let rowsBefore = 0, introBefore = 0;
for (const loc of Object.keys(targets)) {
  for (const pid of Object.keys(targets[loc] || {})) {
    for (const sk of Object.keys(targets[loc][pid] || {})) {
      rowsBefore += 1;
      if (targets[loc][pid][sk]?.introduce === true) introBefore += 1;
    }
  }
}
const now = new Date().toISOString();
const updates = {};
if (!mismatched) {
  for (const s of SET) {
    for (const size of sizesOf(s.pid)) {
      const sk = encodeSizeKey(size);
      if (targets?.[s.loc]?.[s.pid]?.[sk]?.introduce === true) continue;   // idempotent
      updates[`stock_targets/${s.loc}/${s.pid}/${sk}/introduce`] = true;
      updates[`stock_targets/${s.loc}/${s.pid}/${sk}/introducedAt`] = now;
      updates[`stock_targets/${s.loc}/${s.pid}/${sk}/introducedBy`] = ACTOR;
      updates[`stock_targets/${s.loc}/${s.pid}/${sk}/note`] = NOTE;
    }
  }
}
const newRows = Object.keys(updates).filter((k) => k.endsWith("/introduce")).length;

say(`## 4. Before / after`);
say();
say(`| | before | after |`);
say(`|---|---|---|`);
say(`| \`/stock_targets\` rows total | ${rowsBefore} | ${rowsBefore + newRows} |`);
say(`| rows carrying \`introduce: true\` | ${introBefore} | ${introBefore + newRows} |`);
say(`| rows carrying a numeric \`target\` | unchanged | unchanged |`);
say(`| \`target: 0\` policy rows | unchanged | unchanged |`);
say(`| locations answering carries for \`${SET.map((s) => s.pid).join(", ")}\` | ${SET.filter((s) => carriesByIndex(entryAt(s.loc, s.pid))).length} of ${SET.length} | ${SET.length} of ${SET.length} |`);
say();
say(`Nothing existing is modified: every path written is a NEW leaf under a size key that holds no`);
say(`row today. No \`target\`, no \`minQty\`, no existing row touched.`);
say();

if (!EXECUTE) {
  say(`## Nothing written`);
  say();
  say("```bash");
  say(`node scripts/stage-introduce-set.mjs --execute`);
  say("```");
  say();
  say(`${newRows} row(s) staged across ${Object.keys(updates).length} paths. Re-running after a partial`);
  say(`failure skips rows that already carry the flag, so it repairs rather than doubles.`);
} else if (mismatched) {
  say(`## Refused`);
  say();
  say(`Nothing written — see the pid/name disagreement above.`);
} else if (!newRows) {
  say(`## Already applied`);
  say();
  say(`Every row in the set already carries \`introduce: true\`. Nothing written.`);
} else {
  say(`## Applying`);
  say();
  await db.ref().update(updates);
  say(`- wrote ${newRows} row(s), ${Object.keys(updates).length} paths, in one atomic update.`);
  say();
  say(`## Verification`);
  say();
  const fresh = (await db.ref("/stock_targets").once("value")).val() || {};
  say(`| location | pid | size | introduce | has numeric target (must be no) |`);
  say(`|---|---|---|---|---|`);
  let bad = 0;
  for (const s of SET) {
    for (const size of sizesOf(s.pid)) {
      const row = fresh?.[s.loc]?.[s.pid]?.[encodeSizeKey(size)] || null;
      const ok = row?.introduce === true;
      const pinned = typeof row?.target === "number";
      if (!ok || pinned) bad += 1;
      say(`| \`${s.loc}\` | \`${s.pid}\` | ${size} | ${ok ? "✅ true" : "⛔ missing"} | ${pinned ? `⛔ ${row.target}` : "✅ none"} |`);
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
say("```bash");
for (const s of SET) for (const size of sizesOf(s.pid)) say(`# stock_targets/${s.loc}/${s.pid}/${encodeSizeKey(size)}`);
say("```");
say();

if (process.env.INTRO_MD) {
  const path = process.env.INTRO_MD.replace(/^~/, homedir());
  writeFileSync(path, out.join("\n") + "\n");
  console.log(`\n[written] ${path}`);
}
if (mismatched) process.exitCode = 1;
process.exit(process.exitCode || 0);
