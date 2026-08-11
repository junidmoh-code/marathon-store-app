// ─── HEADWEAR ONE-SIZE POLICY — APPLY / REMOVE (DRY RUN BY DEFAULT) ──────────
//
// Writes the /stock_targets payload produced by
// scripts/model-headwear-onesize-policy.mjs, and removes it again. Requires
// --execute; without it, prints exactly what it would write and touches nothing.
//
// ── WHY THIS IS A SCRIPT AND NOT A firebase CLI ONE-LINER ────────────────────
// The obvious command is wrong in a way that is easy to miss and expensive to
// discover. `firebase database:update /stock_targets payload.json` with a
// payload shaped { "hub2": { … } } does NOT merge into hub2 — an RTDB update
// REPLACES the whole subtree named by each top-level key, so it would delete
// every OTHER product's targets at hub2 in one shot. Fine-grained merging comes
// only from SLASH-SEPARATED path keys ("hub2/<pid>/_"), which is the shape the
// model emits and the shape this script validates before writing.
//
// It also enforces the precondition the CLI cannot:
//
//   A ROW MAY ONLY BE ARMED ON A PRODUCT THAT HAS ALREADY COLLAPSED. A "_"
//   target row on a product still declaring ["S","M","L"] is inert at best —
//   the engine resolves targets per catalogue size, and "_" is not one of them
//   — and actively misleading at worst, because the row LOOKS armed in every
//   admin view. Worse, it survives: run the policy before the migration and the
//   rows sit there silently doing nothing until somebody eventually collapses
//   the product, at which point demand appears with no human deciding it should.
//   So: every product named in the payload is re-read here, and any that does
//   not declare exactly ["_"] refuses the whole run.
//
// ── THE OFF SWITCH ───────────────────────────────────────────────────────────
// Since #342 an explicit /stock_targets row WINS over the rule and outlives the
// ruleBasedTargets kill switch. Flipping that config key therefore does NOT
// disarm this policy. Removing the rows is the only off switch, which is what
// --delete does, from the rollback payload the model wrote alongside the main one.
//
// Usage:
//   node scripts/apply-headwear-policy.mjs <payload.json>                # dry run
//   node scripts/apply-headwear-policy.mjs <payload.json> --execute      # arm
//   node scripts/apply-headwear-policy.mjs <rollback.json> --execute --delete
//
// Exit 0 = applied (or dry run clean). Exit 1 = refused; nothing written.

import { createRequire } from "module";
import { readFileSync } from "fs";
import { headwearKind, invalidTargetRow, policyRowGate, emptyKindCount } from "./lib/headwearCollapseCore.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const io = {
  read: (p) => db.ref(p).once("value").then((s) => s.val()),
  update: (u) => db.ref().update(u),
};

const args = process.argv.slice(2);
const PAYLOAD_PATH = args.find((a) => !a.startsWith("--"));
const EXECUTE = args.includes("--execute");
const DELETE = args.includes("--delete");

(async () => {
  if (!PAYLOAD_PATH) {
    console.error("usage: node scripts/apply-headwear-policy.mjs <payload.json> [--execute] [--delete]");
    process.exit(1);
  }
  console.log(`\n${"═".repeat(78)}\n  HEADWEAR POLICY — ${DELETE ? "REMOVE" : "ARM"} — ${EXECUTE ? "EXECUTE (REAL WRITES)" : "DRY RUN"}\n  payload: ${PAYLOAD_PATH}\n${"═".repeat(78)}`);

  const payload = JSON.parse(readFileSync(PAYLOAD_PATH, "utf8"));
  const entries = Object.entries(payload);
  if (!entries.length) { console.error("ABORT: payload is empty."); process.exit(1); }

  // ── shape + rule validation ───────────────────────────────────────────────
  const problems = [];
  const pids = new Set();
  for (const [path, row] of entries) {
    const segs = path.split("/");
    if (segs.length !== 3 || segs.some((s) => !s)) {
      problems.push(`${path}: expected "<loc>/<pid>/<sizeKey>" — a payload keyed by location alone would REPLACE that location's whole target tree`);
      continue;
    }
    const [, pid, sizeKey] = segs;
    pids.add(pid);
    if (sizeKey !== "_") problems.push(`${path}: this policy only ever arms the "_" cell, not ${JSON.stringify(sizeKey)}`);
    if (DELETE) {
      if (row !== null) problems.push(`${path}: --delete expects every value to be null, got ${JSON.stringify(row)}`);
    } else {
      const why = invalidTargetRow(row);
      if (why) problems.push(`${path}: ${why}`);
    }
  }
  if (problems.length) {
    console.error(`\nABORT: ${problems.length} payload problem(s). Nothing written.`);
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    if (problems.length > 20) console.error(`  … and ${problems.length - 20} more`);
    process.exit(1);
  }
  console.log(`  ${entries.length} path(s) across ${pids.size} product(s) — shape and rule validation passed`);

  // ── the precondition: every product must have collapsed already ───────────
  const products = (await io.read("products")) || {};
  const notCollapsed = [], notHeadwear = [], notes = [];
  for (const pid of pids) {
    const g = policyRowGate(products[pid], { remove: DELETE });
    if (g.note) notes.push(`${pid} "${products[pid]?.name ?? "(gone)"}" — ${g.note}`);
    if (g.ok) continue;
    if (g.reason === "not-headwear") notHeadwear.push(`${pid} "${products[pid].name}" ${g.detail}`);
    else notCollapsed.push(`${pid} ${products[pid] ? `"${products[pid].name}" ` : ""}${g.detail}`);
  }
  for (const n of notes) console.log(`  note: ${n}`);
  if (notHeadwear.length) {
    console.error(`\nABORT: ${notHeadwear.length} product(s) in this payload are not headwear. Nothing written.`);
    for (const n of notHeadwear.slice(0, 10)) console.error(`  ${n}`);
    process.exit(1);
  }
  if (notCollapsed.length) {
    console.error(`\nABORT: ${notCollapsed.length} product(s) have NOT collapsed to one-size yet. Nothing written.`);
    console.error(`A "_" row on a product that still declares sizes is inert — the engine resolves`);
    console.error(`targets per catalogue size and "_" is not one of them — but it LOOKS armed, and it`);
    console.error(`will silently become real the moment that product is collapsed. Run the migration`);
    console.error(`first, then re-run the model so the payload matches what actually collapsed.`);
    for (const n of notCollapsed.slice(0, 15)) console.error(`  ${n}`);
    if (notCollapsed.length > 15) console.error(`  … and ${notCollapsed.length - 15} more`);
    process.exit(1);
  }
  if (!DELETE) console.log(`  every product collapsed to ["_"] — precondition met`);

  // ── what is already there ─────────────────────────────────────────────────
  const existing = [], identical = [];
  for (const [path, row] of entries) {
    const live = await io.read(`stock_targets/${path}`);
    if (live == null) continue;
    if (JSON.stringify(live) === JSON.stringify(row)) identical.push(path);
    else existing.push({ path, live });
  }
  if (identical.length) console.log(`  ${identical.length} row(s) already exactly match the payload — writing them is a no-op`);
  if (existing.length) {
    console.log(`\n  ${existing.length} row(s) ALREADY EXIST with different values and would be overwritten:`);
    for (const e of existing.slice(0, 10)) console.log(`     ${e.path}  live=${JSON.stringify(e.live)}`);
    if (existing.length > 10) console.log(`     … and ${existing.length - 10} more`);
  }

  const kinds = emptyKindCount();
  // A --delete run can name a product that has since been merged or deleted;
  // headwearKind(undefined) is null and kinds[null]++ yields NaN under a "null" key.
  for (const pid of pids) { const k = headwearKind(products[pid]); if (k) kinds[k]++; }
  console.log(`\n  ${DELETE ? "REMOVING" : "ARMING"} ${entries.length} row(s) — ${kinds.beanie} beanie / ${kinds.cap} cap / ${kinds.bucket} bucket-hat product(s)`);
  const byLoc = {};
  for (const [path] of entries) { const loc = path.split("/")[0]; byLoc[loc] = (byLoc[loc] || 0) + 1; }
  for (const [loc, n] of Object.entries(byLoc)) console.log(`     ${loc.padEnd(16)} ${n}`);
  console.log(`  sample: stock_targets/${entries[0][0]} = ${JSON.stringify(entries[0][1])}`);

  if (!EXECUTE) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --execute to apply.`);
    process.exit(0);
  }

  // ── write ─────────────────────────────────────────────────────────────────
  // ONE atomic multi-path update. approvedAt is stamped from RTDB's clock, not
  // this machine's, matching every other timestamp this tooling writes.
  const offset = (await io.read(".info/serverTimeOffset")) || 0;
  const nowIso = new Date(Date.now() + offset).toISOString();
  const updates = {};
  for (const [path, row] of entries) {
    updates[`stock_targets/${path}`] = DELETE ? null : { ...row, approvedAt: row.approvedAt ?? nowIso };
  }
  await io.update(updates);
  console.log(`\n  ${DELETE ? "REMOVED" : "WROTE"} ${entries.length} path(s) in one atomic update (server time ${nowIso}).`);

  // ── verify on fresh reads ─────────────────────────────────────────────────
  const bad = [];
  for (const [path, row] of entries) {
    const live = await io.read(`stock_targets/${path}`);
    if (DELETE) { if (live != null) bad.push(`${path} still present: ${JSON.stringify(live)}`); continue; }
    if (!live) { bad.push(`${path} missing after write`); continue; }
    if (live.target !== row.target || live.minQty !== row.minQty) bad.push(`${path} = ${JSON.stringify(live)}`);
    // reorderPoint ABSENT is load-bearing at the hub — an accidental 0 there
    // would flip it from "top up whenever below target" to "only when empty".
    // ?? undefined on BOTH sides: RTDB deletes a null child, so a row written
    // with reorderPoint null reads back with the key absent. Comparing null
    // against undefined reported a VERIFY FAILED on a write that did exactly
    // what was asked. (invalidTargetRow now refuses null outright, so this is
    // belt to that brace.) (CodeRabbit, PR #345.)
    const wantRp = row.reorderPoint ?? undefined;
    const gotRp = live.reorderPoint ?? undefined;
    if (wantRp !== gotRp) bad.push(`${path} reorderPoint ${JSON.stringify(gotRp)} ≠ intended ${JSON.stringify(wantRp)}`);
  }
  console.log(bad.length ? `\n  VERIFY FAILED:\n${bad.map((b) => `     ${b}`).join("\n")}` : `  verified on fresh reads: every row reads back as intended (reorderPoint presence included)`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
