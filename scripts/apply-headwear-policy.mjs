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
import { isInScope, headwearKind } from "./lib/headwearCollapseCore.mjs";

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

// Mirrors the LIVE rule at /stock_targets/$loc/$pid/$size:
//   hasChildren(['target','minQty']) && target.isNumber() && minQty.isNumber()
// The Admin SDK bypasses rules, so an invalid row would be accepted here and
// then rejected the first time anything client-side tried to touch it. Validate
// against the rule rather than discovering it later.
function invalidRow(row) {
  if (!row || typeof row !== "object") return "not an object";
  if (typeof row.target !== "number" || !Number.isFinite(row.target)) return "target is not a finite number";
  if (typeof row.minQty !== "number" || !Number.isFinite(row.minQty)) return "minQty is not a finite number (the live rule REQUIRES it)";
  if (row.target < 0 || row.minQty < 0) return "negative target/minQty";
  // reorderPoint is optional; when present the engine only honours a finite >= 0
  // (anything else falls back to "no gate", i.e. eager ordering).
  if ("reorderPoint" in row && row.reorderPoint !== null
    && !(typeof row.reorderPoint === "number" && Number.isFinite(row.reorderPoint) && row.reorderPoint >= 0)) {
    return `reorderPoint ${JSON.stringify(row.reorderPoint)} would be ignored by the engine — omit the key instead`;
  }
  return null;
}

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
      const why = invalidRow(row);
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
  const notCollapsed = [], notHeadwear = [];
  for (const pid of pids) {
    const p = products[pid];
    if (!p) { notCollapsed.push(`${pid}: no such product`); continue; }
    if (!isInScope(p)) { notHeadwear.push(`${pid} "${p.name}" is not a beanie or a cap`); continue; }
    if (JSON.stringify(p.sizes || null) !== JSON.stringify(["_"])) {
      notCollapsed.push(`${pid} "${p.name}" still declares ${JSON.stringify(p.sizes)}`);
    }
  }
  if (notHeadwear.length) {
    console.error(`\nABORT: ${notHeadwear.length} product(s) in this payload are not headwear. Nothing written.`);
    for (const n of notHeadwear.slice(0, 10)) console.error(`  ${n}`);
    process.exit(1);
  }
  if (notCollapsed.length && !DELETE) {
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

  const kinds = { beanie: 0, cap: 0 };
  for (const pid of pids) kinds[headwearKind(products[pid])]++;
  console.log(`\n  ${DELETE ? "REMOVING" : "ARMING"} ${entries.length} row(s) — ${kinds.beanie} beanie / ${kinds.cap} cap product(s)`);
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
    const wantRp = "reorderPoint" in row ? row.reorderPoint : undefined;
    const gotRp = "reorderPoint" in (live || {}) ? live.reorderPoint : undefined;
    if (wantRp !== gotRp) bad.push(`${path} reorderPoint ${JSON.stringify(gotRp)} ≠ intended ${JSON.stringify(wantRp)}`);
  }
  console.log(bad.length ? `\n  VERIFY FAILED:\n${bad.map((b) => `     ${b}`).join("\n")}` : `  verified on fresh reads: every row reads back as intended (reorderPoint presence included)`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
