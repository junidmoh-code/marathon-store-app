// ─── ZERO EVERY NEGATIVE STOCK CELL ──────────────────────────────────────────
//
// Owner decision 2026-08-25 (Hub 1 availability brief, Piece 1): negative
// stock cells become zero, network-wide. A negative cell is a count artifact —
// it can never be picked, and it poisons every availability read that clamps
// (the clamp hides it) or doesn't (the negative eats real units elsewhere).
//
// HOW: real `adjustment` movements through the same write shape as
// applyMovement (ledger row + qty/v/mv/lastType/updatedAt/updatedBy), NEVER a
// raw cell write — the Admin SDK bypasses the v+1 rule, so the version guard
// is re-implemented as read → compute → re-read → CAS-style retry, the exact
// pattern of scripts/lib/headwearCollapseCore.mjs applyMovementAdmin.
//
// SAFETY:
//   • default is --dry-run; --commit applies
//   • rollback file written BEFORE any write (full before-cells, incl. v)
//   • plan also backed up to /reports/stock_corrections (push key)
//   • deterministic movement ids: negzero_<stamp>_<loc>_<pid>_<sizeKey> —
//     re-running the script is idempotent per cell
//   • per-cell LIVE re-read: a cell that healed since the scan is skipped;
//     the delta is computed from the live qty, never the scan file
//
// Usage:
//   node scripts/zero-negative-cells.mjs <scan.json>              # dry-run
//   node scripts/zero-negative-cells.mjs <scan.json> --commit
import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
import { readFileSync, writeFileSync } from "fs";
import { stockCellPath, decodeSizeKey, assertSafeSegment } from "../src/utils/sizeKey.js";

const ACTOR = "script:zero-negative-cells";
const REASON = "negative_cell_zeroed: owner-authorised network-wide clamp to 0 (Hub 1 availability work, 2026-08-25). Negative balances are count artifacts and read as phantom stock.";
// The RUN date, not a frozen literal: a hard-coded stamp made every later run
// a silent no-op ("idempotent" against last month's movement id) that exited
// 0 having zeroed nothing. Idempotent within a day, retryable across days —
// and always safe, because the delta is computed from the LIVE qty (a cell
// already at 0 is skipped before any id is minted).
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const CONFLICT_RETRIES = 5;

const scanPath = process.argv[2];
const COMMIT = process.argv.includes("--commit");
if (!scanPath) { console.error("usage: zero-negative-cells.mjs <scan.json> [--commit]"); process.exit(2); }
const scanRows = JSON.parse(readFileSync(scanPath, "utf8"));

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const read = async (p) => (await db.ref(p).once("value")).val();

// ── live re-read + plan ──────────────────────────────────────────────────────
const plan = [];
const skipped = [];
for (const r of scanRows) {
  const path = `stock/${r.location}/${r.productId}/${r.sizeKey}`;
  const cell = await read(path);
  const qty = cell && typeof cell.qty === "number" ? cell.qty : 0;
  if (qty >= 0) { skipped.push({ ...r, liveQty: qty }); continue; }
  plan.push({ location: r.location, productId: r.productId, sizeKey: r.sizeKey, qty, cell });
}

// product names for the human table (one tiny read per distinct pid)
const names = {};
for (const pid of [...new Set(plan.map((p) => p.productId))]) {
  names[pid] = (await read(`products/${pid}/name`)) || "(unnamed)";
}

const fmt = (p) => `${p.location.padEnd(14)} ${p.productId.padEnd(16)} ${decodeSizeKey(p.sizeKey).padEnd(6)} ${String(p.qty).padStart(4)}  ${names[p.productId]}`;
console.log(`\nBEFORE — ${plan.length} negative cells (live re-read), ${-plan.reduce((n, p) => n + p.qty, 0)} units below zero; ${skipped.length} scan rows already healed`);
console.log("location       productId        size    qty  name");
for (const p of plan) console.log(fmt(p));

if (!COMMIT) { console.log("\nDRY RUN — nothing written. Re-run with --commit."); process.exit(0); }

// ── rollback file BEFORE any write ───────────────────────────────────────────
const rollbackFile = `${process.env.HOME}/negative-zero-rollback-${STAMP}.json`;
writeFileSync(rollbackFile, JSON.stringify({ appliedAt: new Date().toISOString(), actor: ACTOR, plan }, null, 2));
console.log(`\nrollback file: ${rollbackFile}`);
const backupRef = await db.ref("reports/stock_corrections").push({
  script: ACTOR, at: new Date().toISOString(), reason: REASON,
  cells: plan.map(({ cell, ...rest }) => ({ ...rest, beforeV: cell?.v ?? null })),
});
console.log(`plan backup: /reports/stock_corrections/${backupRef.key}`);

// ── apply, one guarded adjustment per cell ───────────────────────────────────
const nowIso = new Date().toISOString();
const results = [];
for (const p of plan) {
  // Double-underscore separators: loc/pid/sizeKey may themselves contain "_",
  // and a single-underscore join could collide two different cells into one
  // "idempotent" skip.
  const mvId = assertSafeSegment(`negzero_${STAMP}__${p.location}__${p.productId}__${p.sizeKey}`, "movementId");
  const rawSize = decodeSizeKey(p.sizeKey);
  const path = stockCellPath(p.location, p.productId, rawSize);
  let outcome = null;
  for (let attempt = 1; attempt <= CONFLICT_RETRIES; attempt++) {
    const existing = await read(`stock_movements/${mvId}`);
    if (existing) { outcome = { ok: true, idempotent: true }; break; }
    const cell = await read(path);
    const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
    if (curQty >= 0) { outcome = { ok: true, alreadyHealed: true, curQty }; break; }
    const delta = -curQty;
    const mv = {
      type: "adjustment", productId: p.productId, size: rawSize, qty: delta,
      from: null, to: p.location,
      before: { [p.location]: curQty }, after: { [p.location]: 0 },
      actor: ACTOR, actorRole: "admin", ts: nowIso, appliedAt: nowIso,
      reason: REASON,
      link: { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null },
    };
    const updates = {};
    updates[`stock_movements/${mvId}`] = mv;
    updates[`${path}/qty`] = 0;
    updates[`${path}/v`] = cell && typeof cell.v === "number" ? cell.v + 1 : 0;
    updates[`${path}/mv`] = mvId;
    updates[`${path}/lastType`] = "adjustment";
    updates[`${path}/updatedAt`] = nowIso;
    updates[`${path}/updatedBy`] = ACTOR;
    const recheck = await read(path);
    const q = (c) => (c && typeof c.qty === "number" ? c.qty : 0);
    const v = (c) => (c && typeof c.v === "number" ? c.v : null);
    if (q(cell) !== q(recheck) || v(cell) !== v(recheck)) continue;   // moved — recompute
    await db.ref().update(updates);
    outcome = { ok: true, movementId: mvId, credited: delta };
    break;
  }
  results.push({ ...p, cell: undefined, outcome: outcome || { ok: false, reason: "conflict_retries_exhausted" } });
}

// ── verify + after-state ─────────────────────────────────────────────────────
let creditedUnits = 0, applied = 0, failed = 0, healedMeanwhile = 0;
console.log("\nAFTER — verification re-read");
console.log("location       productId        size    qty  outcome");
for (const r of results) {
  const liveQty = (await read(`stock/${r.location}/${r.productId}/${r.sizeKey}/qty`)) ?? 0;
  const oc = r.outcome;
  if (oc.credited) { applied++; creditedUnits += oc.credited; }
  else if (oc.alreadyHealed || oc.idempotent) healedMeanwhile++;
  else failed++;
  const tag = oc.credited ? `zeroed (+${oc.credited})` : oc.idempotent ? "idempotent" : oc.alreadyHealed ? "healed meanwhile" : `FAILED ${oc.reason}`;
  console.log(`${r.location.padEnd(14)} ${r.productId.padEnd(16)} ${decodeSizeKey(r.sizeKey).padEnd(6)} ${String(liveQty).padStart(4)}  ${tag}`);
  if (liveQty < 0) {
    // Still negative counts as a FAILURE, whatever the apply claimed — the
    // exit code is the only thing an unattended caller reads.
    failed++;
    console.log(`  ^^ STILL NEGATIVE after apply (concurrent sale?) — counted as failed`);
  }
}
console.log(`\nDONE: ${applied} cells zeroed, ${creditedUnits} units credited, ${healedMeanwhile} healed/idempotent, ${failed} failed.`);
process.exit(failed ? 1 : 0);
