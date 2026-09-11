// ─── REPAIR — credit the units the negative-base defect swallowed ─────────────
// Phase E of FULFIL-CREDIT-GAP.md. Input is the probe's report
// (probe-report.json → phaseB.creditGap.rows, cause
// credit_absorbed_by_negative_destination_cell): every fulfilled refill request
// whose destination credit landed on a negative cell and was absorbed.
//
// WHAT IT WRITES: one real `adjustment` movement per cell, +absorbed units,
// reason "fulfil_credit_repair", through the same server-side writer the
// stranded-transit sweep uses (functions/lib/admin-movement.cjs — ledger row +
// cell in ONE atomic update, v+1, deterministic movement id so a re-run is a
// no-op per cell). Never a raw cell write.
//
// WHAT IT REFUSES (evidence rules, stated in the brief):
//   • the source was NOT deducted — the credit movement's own before/after
//     must show the source leg (a `received` fulfil has no source; it still
//     absorbed, and is credited: the unit was physically put on the shelf);
//   • the cell has been COUNTED since the credit (a hub count / recount /
//     stock-audit adjustment on that cell after the credit's instant) — the
//     count settled the truth and a repair would double-count;
//   • the product record is gone — nothing to credit;
//   • more than MAX_WRITES corrections — stop and report (owner cap).
//
// BEFORE-STATE: every planned write is recorded, with the live cell as read
// (qty, v, mv), to <report dir>/repair-before-state.json AND to
// /reports/stock_corrections/{push} before any cell changes. Rollback = an
// adjustment of the same size in the other direction; the file has the ids.
//
// Usage:
//   node scripts/repair-fulfil-credit-gap.mjs <dump dir>            # dry-run (default)
//   node scripts/repair-fulfil-credit-gap.mjs <dump dir> --commit

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { adminRequire } from "./adminRequire.mjs";

const require = createRequire(import.meta.url);
const { applyMovementAdmin } = require("../functions/lib/admin-movement.cjs");
const { encodeSizeKey } = require("../functions/lib/refill-engine.cjs");

const DIR = process.argv[2];
const COMMIT = process.argv.includes("--commit");
if (!DIR) { console.error("usage: <dump dir> [--commit]"); process.exit(2); }
const MAX_WRITES = 50;
const ACTOR = "script:repair-fulfil-credit-gap";
const REASON = "fulfil_credit_repair";
const COUNT_REASON = /hub_sneaker_count|recount|stock_audit|stockAudit|count/i;

const report = JSON.parse(readFileSync(`${DIR}/probe-report.json`, "utf8"));
const MV = JSON.parse(readFileSync(`${DIR}/movements.json`, "utf8"));
const rows = report.phaseB.creditGap.rows.filter((r) => r.cause === "credit_absorbed_by_negative_destination_cell");

const adminReq = adminRequire(import.meta.url);
const admin = adminReq("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const read = async (p) => (await db.ref(p).once("value")).val();
const ms = (iso) => Date.parse(iso || "") || 0;

// Later count on this cell? From the ledger snapshot (the probe's dump) —
// one whole-ledger read is the forensic budget, not one per cell.
function countedSince(loc, pid, sizeKey, sinceMs) {
  return Object.entries(MV).filter(([, m]) =>
    m && m.productId === pid && encodeSizeKey(String(m.size)) === sizeKey && m.type === "adjustment"
    && (m.to === loc || m.from === loc) && ms(m.appliedAt || m.ts) > sinceMs && COUNT_REASON.test(String(m.reason || "")));
}

const plan = [];
const refused = [];
for (const r of rows) {
  const credit = await read(`stock_movements/${r.movementId}`);
  const sizeKey = encodeSizeKey(String(r.size));
  const base = { requestId: r.requestId, creditMovementId: r.movementId, dest: r.dest, productId: r.productId, name: r.name, size: String(r.size), sizeKey, units: r.units };
  if (!credit) { refused.push({ ...base, why: "credit movement not found live" }); continue; }
  const before = credit.before && credit.before[r.dest];
  if (typeof before !== "number" || before >= 0) { refused.push({ ...base, why: `live before[${r.dest}] is ${before} — not negative` }); continue; }
  const absorbed = Math.min(Number(credit.qty) || 0, -before);
  if (absorbed <= 0) { refused.push({ ...base, why: "nothing absorbed" }); continue; }
  const sourceDeducted = credit.from
    ? (typeof credit.before?.[credit.from] === "number" && credit.after?.[credit.from] === credit.before[credit.from] - Number(credit.qty))
    : null;   // `received` fulfil: no source leg by design
  if (credit.from && !sourceDeducted) { refused.push({ ...base, why: "source leg does not show the deduct" }); continue; }
  if (!(await read(`products/${r.productId}/id`)) && !(await read(`products/${r.productId}/name`))) { refused.push({ ...base, why: "product record missing" }); continue; }
  const counts = countedSince(r.dest, r.productId, sizeKey, ms(credit.appliedAt || credit.ts));
  if (counts.length) { refused.push({ ...base, why: `counted since the credit: ${counts.map(([id]) => id).join(", ")}` }); continue; }
  if (await read(`stock_movements/fcr_${r.movementId}`)) { refused.push({ ...base, why: "already repaired (fcr_ movement exists)" }); continue; }
  const cell = await read(`stock/${r.dest}/${r.productId}/${sizeKey}`);
  plan.push({ ...base, units: absorbed, sourceDeducted: sourceDeducted ?? "n/a (received)", creditAppliedAt: credit.appliedAt, liveCell: cell ? { qty: cell.qty, v: cell.v, mv: cell.mv, lastType: cell.lastType } : null, movementId: `fcr_${r.movementId}` });
}

console.log(`\n${COMMIT ? "COMMIT" : "DRY RUN"} — ${plan.length} correction(s) planned, ${refused.length} refused, ${plan.reduce((n, p) => n + p.units, 0)} unit(s)\n`);
console.log("| dest | product | size | cell now | +units | credit movement | source deducted |");
console.log("|---|---|---|---|---|---|---|");
for (const p of plan) console.log(`| ${p.dest} | ${p.name} [${p.productId}] | ${p.size} | ${p.liveCell ? p.liveCell.qty : "—"} (v${p.liveCell ? p.liveCell.v : "—"}) | +${p.units} | ${p.creditMovementId} | ${p.sourceDeducted} |`);
if (refused.length) { console.log("\nRefused:"); for (const r of refused) console.log(`- ${r.dest} ${r.name} size ${r.size}: ${r.why}`); }

if (plan.length > MAX_WRITES) { console.error(`\nSTOP: ${plan.length} corrections exceed the ${MAX_WRITES} cap — owner decision required.`); process.exit(3); }

const beforeState = { generatedAt: new Date().toISOString(), commit: COMMIT, plan, refused };
writeFileSync(`${DIR}/repair-before-state.json`, JSON.stringify(beforeState, null, 2));
console.log(`\nbefore-state → ${DIR}/repair-before-state.json`);

if (!COMMIT) { console.log("\nDry run — nothing written. Re-run with --commit."); process.exit(0); }

const recRef = db.ref("reports/stock_corrections").push();
await recRef.set({ kind: "fulfil_credit_repair", actor: ACTOR, at: beforeState.generatedAt, plan, refused });
console.log(`before-state also at /reports/stock_corrections/${recRef.key}`);

const results = [];
for (const p of plan) {
  const nowIso = new Date().toISOString();
  const res = await applyMovementAdmin(db, {
    type: "adjustment", productId: p.productId, size: p.size, qty: p.units, to: p.dest, from: null,
    reason: REASON, movementId: p.movementId, actor: ACTOR, actorRole: "admin",
    link: { refillId: p.requestId, repairOf: p.creditMovementId, correctionsRecord: recRef.key },
  }, { nowIso });
  const after = await read(`stock/${p.dest}/${p.productId}/${p.sizeKey}`);
  results.push({ ...p, result: res, cellAfter: after ? { qty: after.qty, v: after.v, mv: after.mv } : null });
  console.log(`${res.ok ? "✓" : "✗"} ${p.dest} ${p.name} size ${p.size}: ${p.liveCell ? p.liveCell.qty : "—"} → ${after ? after.qty : "—"} (${p.movementId}${res.idempotent ? ", idempotent" : ""}${res.ok ? "" : `, ${res.reason}`})`);
}
writeFileSync(`${DIR}/repair-results.json`, JSON.stringify(results, null, 2));
await recRef.child("results").set(results.map((r) => ({ movementId: r.movementId, ok: r.result.ok, reason: r.result.reason || null, cellAfter: r.cellAfter })));
process.exit(results.every((r) => r.result.ok) ? 0 : 1);
