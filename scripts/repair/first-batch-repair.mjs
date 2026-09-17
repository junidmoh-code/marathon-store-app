// ─── FIRST BATCH — LIVE DATA REPAIR (incident 2026-09-17) ────────────────────
// Phase 2 of the incident plan. For every /refill_requests row the first-batch
// path created (createdFrom.firstBatch === true, requestingLocation a SHOP):
//   • OPEN and untouched (sentQty 0) with Hub 2 PRESENCE for the product — a
//     stock node (any cell, qty 0 included), an open engine lock at Hub 2, an
//     open Hub 2 request, or an explicit /stock_targets/hub2 row — the shop
//     must request from Hub 2, never Central: the Central request is WITHDRAWN
//     by CAS with `cancelReason: first_batch_repair_hub2_present` (a reason, so
//     the engine reads a withdrawal — no cooldown, no rejection learned at the
//     shop's cell) and Hub 2 is seeded for that size so the engine can serve
//     the shop from Hub 2 on its next scan (the shop's own seed already exists).
//   • OPEN and untouched with NO Hub 2 presence — the request stands (Central
//     really is the only source) and Hub 2 is seeded for that size so the NEXT
//     refill routes shop←hub2 / hub2←central as normal.
//   • touched or resolved — real stock has moved or the row is closed: only the
//     Hub 2 seed is checked (the trigger normally wrote it).
// NO STOCK MOVES. The only writes are qty-0 carriage cells by create-if-absent
// transaction (functions/lib/first-batch.cjs seedIfAbsent — the real function)
// and CAS cancels that re-verify "open and untouched" inside the transaction.
// There is therefore no applyMovement call to make and no movement id to mint:
// nothing is created, destroyed or moved. Re-running finds nothing to do.
// Dry-run by default: prints counts and a sample. `--apply` writes.
//   node scripts/repair/first-batch-repair.mjs [--apply]
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { adminRequire } from "../adminRequire.mjs";
import { readMapPaged } from "../lib/rtdbPaged.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPLY = process.argv.includes("--apply");
const req = (() => { try { const r = createRequire(join(ROOT, "functions", "package.json")); r.resolve("firebase-admin"); return r; } catch { return adminRequire(import.meta.url); } })();
const { seedIfAbsent, FIRST_BATCH_HUB } = req(join(ROOT, "functions", "lib", "first-batch.cjs"));
const { encodeSizeKey } = req(join(ROOT, "functions", "lib", "refill-engine.cjs"));
export const REPAIR_REASON = "first_batch_repair_hub2_present";

// Pure: the decision for one first-batch shop row given its scoped reads.
// Exported so the test drives the same function the script runs.
export function decideRepair({ row, hub2Node, hub2Locks, hub2OpenRequests, hub2TargetRow }) {
  const sizeKey = encodeSizeKey(String(row.size ?? ""));
  const presence = [];
  // A qty-0 carriage cell stamped by the trigger or by THIS repair
  // (seedCell: mv "seed", updatedBy "first_batch") is Hub 2 made a valid
  // source by us — not prior presence. Counting it would withdraw a kept
  // Central request on the very next run (the repair seeds every kept row).
  // Any other cell — units, a movement, a human's or a Solve's seed — is.
  const ownSeed = (c) => !!c && c.mv === "seed" && c.updatedBy === "first_batch" && !((Number(c.qty) || 0) > 0);
  const nodeCells = Array.isArray(hub2Node) ? hub2Node.filter((c) => c != null) : Object.values(hub2Node || {}).filter((c) => c != null);
  if (nodeCells.some((c) => !ownSeed(c))) presence.push("stock_node");
  if (hub2Locks && Object.keys(hub2Locks).length) presence.push("engine_lock");
  if (hub2OpenRequests && hub2OpenRequests.length) presence.push("open_hub2_request");
  if (hub2TargetRow && typeof hub2TargetRow === "object" && Object.keys(hub2TargetRow).length) presence.push("explicit_row");
  // `== null`: an array-coerced row answers null in a hole → absent cell
  const seedNeeded = !hub2Node || hub2Node[sizeKey] == null;
  const openUntouched = row.status === "open" && !((Number(row.sentQty) || 0) > 0);
  const withdraw = openUntouched && presence.length > 0;
  return { sizeKey, presence, seedNeeded, openUntouched, withdraw };
}

// The plan, from the live (or fake) db: one scoped read per product for the
// three Hub 2 presence nodes; /refill_requests paged. Pure apart from reads.
export async function buildPlan(db, { readAll } = {}) {
  const refill = readAll ? await readAll(db) : await readMapPaged(db, "refill_requests");
  const all = Object.entries(refill || {}).map(([id, r]) => ({ id, ...r }));
  const shopRows = all.filter((r) => r?.createdFrom?.firstBatch === true && r.requestingLocation && r.requestingLocation !== FIRST_BATCH_HUB);
  const hub2OpenByPid = {};
  for (const r of all) if (r.requestingLocation === FIRST_BATCH_HUB && r.status === "open" && r.productId) (hub2OpenByPid[r.productId] = hub2OpenByPid[r.productId] || []).push(r.id);
  const plan = [];
  const cache = {};
  for (const row of shopRows) {
    const pid = row.productId;
    if (!cache[pid]) cache[pid] = {
      hub2Node: (await db.ref(`stock/${FIRST_BATCH_HUB}/${pid}`).once("value")).val(),
      hub2Locks: (await db.ref(`refill_engine/open/${FIRST_BATCH_HUB}/${pid}`).once("value")).val(),
      hub2TargetRow: (await db.ref(`stock_targets/${FIRST_BATCH_HUB}/${pid}`).once("value")).val(),
    };
    const d = decideRepair({ row, ...cache[pid], hub2OpenRequests: hub2OpenByPid[pid] || [] });
    plan.push({ id: row.id, pid, size: row.size, store: row.requestingLocation, status: row.status, sentQty: row.sentQty || 0, ...d, row });
  }
  return { plan, total: all.length, shopRows: shopRows.length };
}

// The writes. Seeds by create-if-absent (the real seedIfAbsent); withdrawals
// by CAS that re-verifies "open and untouched" inside the transaction. Both
// are no-ops the second time: idempotent by construction.
export async function applyPlan(db, plan, nowIso) {
  let seeded = 0, withdrawn = 0, refused = 0;
  for (const p of plan) {
    if (p.seedNeeded) { if (await seedIfAbsent(db, `stock/${FIRST_BATCH_HUB}/${p.pid}/${p.sizeKey}`, nowIso)) seeded++; }
    if (p.withdraw) {
      // COLD-NULL TRAP (admin-movement.cjs): judge a null first callback
      // against the row the plan read; the proposal CASes on the server value.
      const res = await db.ref(`refill_requests/${p.id}`).transaction((raw) => {
        const cur = raw === null || raw === undefined ? p.row : raw;
        if (!cur || cur.status !== "open" || (Number(cur.sentQty) || 0) > 0) return undefined;
        if (cur.cancelReason) return undefined;
        return { ...cur, status: "cancelled", cancelReason: REPAIR_REASON, resolvedAt: nowIso, resolvedBy: "first_batch_repair",
          firstBatch: { ...(cur.firstBatch || {}), hub2Leg: { none: "repair_hub2_present", at: nowIso } } };
      });
      if (res.committed) withdrawn++; else refused++;
    }
  }
  return { seeded, withdrawn, refused };
}

async function main() {
  const admin = req("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = admin.database();
  const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
  const nowIso = new Date(Date.now() + offset).toISOString();   // server time, not the laptop's
  const { plan, total, shopRows } = await buildPlan(db);
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} at ${nowIso} — /refill_requests rows ${total}; first-batch SHOP rows ${shopRows}`);
  const withdraws = plan.filter((p) => p.withdraw);
  const keepCentral = plan.filter((p) => p.openUntouched && !p.withdraw);
  const seeds = plan.filter((p) => p.seedNeeded);
  console.log(`  withdraw (Hub 2 present → shop asks Hub 2): ${withdraws.length}`);
  console.log(`  keep as Central request (no Hub 2 presence): ${keepCentral.length}`);
  console.log(`  Hub 2 seeds to write: ${seeds.length} (distinct products ${new Set(seeds.map((p) => p.pid)).size})`);
  console.log(`  stock quantities moved: 0 (by construction)`);
  for (const p of plan.slice(0, 10)) console.log(`  sample ${p.id} ${p.store} ${p.pid} size=${JSON.stringify(p.size)} ${p.status} sent=${p.sentQty} presence=[${p.presence}] seed=${p.seedNeeded} withdraw=${p.withdraw}`);
  mkdirSync(join(ROOT, "var"), { recursive: true });
  const out = join(ROOT, "var", `first-batch-repair-${APPLY ? "apply" : "dry"}-${nowIso.replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ nowIso, apply: APPLY, plan: plan.map(({ row, ...p }) => p) }, null, 1));
  console.log("  plan →", out);
  if (!APPLY) { process.exit(0); }
  const r = await applyPlan(db, plan, nowIso);
  console.log(`  applied: seeds ${r.seeded}, withdrawn ${r.withdrawn}, refused by CAS ${r.refused}`);
  process.exit(0);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
