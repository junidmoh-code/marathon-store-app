// ─── BEANIE ONE-SIZE COLLAPSE — ROLLBACK (DRY RUN BY DEFAULT) ────────────────
//
// Restores product identity from a rollback snapshot written by
// scripts/collapse-one-size-beanies.mjs: `sizes`, the `barcodes` map, every
// barcode index record, and the explicit /stock_targets rows the migration
// retired. Requires --execute; without it, prints exactly what it would write.
//
// ── WHAT THIS DOES NOT DO, AND WHY ───────────────────────────────────────────
// It does NOT move stock. After a collapse the units sit in the "_" cell, and
// restoring identity alone leaves them there while the product declares its old
// sizes again — the sized cell reads 0 and the "_" cell is invisible to a
// catalogue that no longer lists "_". That is a REAL half-state, so this script
// refuses to pretend otherwise: it prints the stock placement it is leaving
// behind and tells you the compensating movements needed.
//
// Stock is a ledger, not a snapshot. Overwriting cells from the snapshot file
// would erase every sale and receive since the run. Reversing the stock half
// means new paired movements in the opposite direction, with fresh ids.
//
// ── THE ACTIVITY CHECK (the reason this is a script and not a one-liner) ─────
// The verification step of the runbook SELLS at the till, deliberately — a scan
// that completes a real sale is the only proof the barcode index was repaired.
// So by the time anyone reaches for a rollback, later activity is not just
// possible, it is expected. Restoring identity under that activity can strand
// units that arrived in "_" after the collapse.
//
// This script therefore reads the ledger for movements against each product
// AFTER its migration instant and REFUSES by default when it finds any, naming
// them. --force proceeds anyway, and prints what it is overriding.
// (CodeRabbit, PR #343.)
//
// Usage:
//   node scripts/rollback-beanie-collapse.mjs <snapshot.json>
//   node scripts/rollback-beanie-collapse.mjs <snapshot.json> --execute
//   node scripts/rollback-beanie-collapse.mjs <snapshot.json> --execute --force
//   node scripts/rollback-beanie-collapse.mjs <snapshot.json> --only=pid1,pid2

import { createRequire } from "module";
import { readFileSync } from "fs";

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
const SNAP_PATH = args.find((a) => !a.startsWith("--"));
const EXECUTE = args.includes("--execute");
const FORCE = args.includes("--force");
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);

// Movements this migration itself wrote — never counted as "later activity".
const isMigrationMovement = (id) => typeof id === "string" && id.startsWith("onesize_");

(async () => {
  if (!SNAP_PATH) {
    console.error("usage: node scripts/rollback-beanie-collapse.mjs <snapshot.json> [--execute] [--force] [--only=pid,…]");
    process.exit(1);
  }
  const snap = JSON.parse(readFileSync(SNAP_PATH, "utf8"));
  console.log(`\n${"═".repeat(78)}\n  BEANIE COLLAPSE ROLLBACK — ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n  snapshot: ${SNAP_PATH} (captured ${snap.capturedAt})\n${"═".repeat(78)}`);

  let pids = Object.keys(snap.products || {});
  if (ONLY.length) pids = pids.filter((p) => ONLY.includes(p));
  console.log(`  products in snapshot: ${Object.keys(snap.products || {}).length}${ONLY.length ? ` (restoring ${pids.length})` : ""}`);

  const capturedMs = Date.parse(snap.capturedAt);
  if (!Number.isFinite(capturedMs)) {
    console.error("ABORT: snapshot has no readable capturedAt — cannot tell later activity from earlier.");
    process.exit(1);
  }

  // ── activity check ────────────────────────────────────────────────────────
  const movements = (await io.read("stock_movements")) || {};
  const laterActivity = new Map();
  for (const [id, m] of Object.entries(movements)) {
    if (!m || !pids.includes(m.productId) || isMigrationMovement(id)) continue;
    const ts = Date.parse(m.appliedAt || m.ts);
    if (!Number.isFinite(ts) || ts <= capturedMs) continue;
    const list = laterActivity.get(m.productId) || [];
    list.push(`${id} (${m.type} ${m.qty} ${m.size} ${new Date(ts).toISOString()})`);
    laterActivity.set(m.productId, list);
  }

  // ── current stock placement, so the half-state is stated, not hidden ───────
  const stock = (await io.read("stock")) || {};
  const placement = {};
  for (const [loc, byPid] of Object.entries(stock)) {
    for (const pid of pids) {
      for (const [sizeKey, cell] of Object.entries(byPid?.[pid] || {})) {
        const q = typeof cell?.qty === "number" ? cell.qty : 0;
        if (q !== 0) (placement[pid] = placement[pid] || []).push(`${loc}/${sizeKey}=${q}`);
      }
    }
  }

  // ── the write plan ────────────────────────────────────────────────────────
  const updates = {};
  for (const pid of pids) {
    const p = snap.products[pid];
    updates[`products/${pid}/sizes`] = p.sizes ?? null;
    updates[`products/${pid}/barcodes`] = p.barcodes ?? null;
  }
  // WHOLE index records, not just `size` — a record may carry more than that,
  // and a snapshot entry of null means the record did NOT exist before the run
  // and must be REMOVED, not left behind. (CodeRabbit, PR #343.)
  const snapPids = new Set(pids);
  for (const [code, rec] of Object.entries(snap.barcodeIndex || {})) {
    if (rec && rec.productId && !snapPids.has(rec.productId)) continue;   // another product's code
    updates[`barcodes/${code}`] = rec ?? null;
  }
  // Target rows the migration retired to 0 — restoring identity without them
  // leaves the product with its old sizes and no refill policy.
  for (const [loc, byPid] of Object.entries(snap.stockTargets || {})) {
    for (const [pid, rows] of Object.entries(byPid)) {
      if (!snapPids.has(pid)) continue;
      updates[`stock_targets/${loc}/${pid}`] = rows ?? null;
    }
  }

  console.log(`\n── WRITE PLAN (${Object.keys(updates).length} paths) ─────────────────────────────────`);
  for (const [path, v] of Object.entries(updates).slice(0, 12)) console.log(`  ${path.padEnd(52)} = ${JSON.stringify(v)?.slice(0, 60)}`);
  if (Object.keys(updates).length > 12) console.log(`  … and ${Object.keys(updates).length - 12} more`);

  console.log(`\n── STOCK PLACEMENT THIS ROLLBACK DOES NOT CHANGE ──────────────────────────`);
  console.log(`  Restoring identity does NOT move stock. Units that the collapse merged into`);
  console.log(`  the "_" cell STAY there, while the product will again declare its old sizes —`);
  console.log(`  so those units read as 0 on the sized cell and are invisible to the app.`);
  const placed = Object.entries(placement);
  if (!placed.length) console.log("  (no product in scope holds stock anywhere)");
  for (const [pid, cells] of placed.slice(0, 15)) console.log(`  ${pid}  ${cells.join("  ")}`);
  if (placed.length > 15) console.log(`  … and ${placed.length - 15} more products`);
  console.log(`  To finish a rollback, move each "_" balance back with FRESH paired movements`);
  console.log(`  (new ids — the migration's own ids are spent and would no-op).`);

  console.log(`\n── LATER ACTIVITY SINCE THE SNAPSHOT ──────────────────────────────────────`);
  if (!laterActivity.size) {
    console.log("  none — no non-migration movement for these products after the snapshot instant");
  } else {
    for (const [pid, list] of laterActivity) {
      console.log(`  ${pid}: ${list.length} movement(s)`);
      for (const l of list.slice(0, 4)) console.log(`     ${l}`);
      if (list.length > 4) console.log(`     … and ${list.length - 4} more`);
    }
  }

  if (!EXECUTE) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --execute to apply.`);
    process.exit(0);
  }
  if (laterActivity.size && !FORCE) {
    console.error(`\nABORT: ${laterActivity.size} product(s) have moved since the snapshot.`);
    console.error("Restoring identity now can strand units that arrived in the \"_\" cell after");
    console.error("the collapse. Reconcile the stock placement above first, or re-run with");
    console.error("--force if you have decided the identity restore is what you want anyway.");
    process.exit(1);
  }
  if (laterActivity.size && FORCE) {
    console.log(`\n  --force: proceeding over later activity on ${laterActivity.size} product(s), listed above.`);
  }

  await io.update(updates);
  console.log(`\n  RESTORED ${Object.keys(updates).length} paths.`);

  // verify on fresh reads
  const problems = [];
  for (const pid of pids) {
    const p = await io.read(`products/${pid}`);
    if (JSON.stringify(p?.sizes ?? null) !== JSON.stringify(snap.products[pid].sizes ?? null)) problems.push(`${pid} sizes = ${JSON.stringify(p?.sizes)}`);
    if (JSON.stringify(p?.barcodes ?? null) !== JSON.stringify(snap.products[pid].barcodes ?? null)) problems.push(`${pid} barcodes = ${JSON.stringify(p?.barcodes)}`);
  }
  for (const [code, rec] of Object.entries(snap.barcodeIndex || {})) {
    if (rec && rec.productId && !snapPids.has(rec.productId)) continue;
    const live = await io.read(`barcodes/${code}`);
    if (JSON.stringify(live ?? null) !== JSON.stringify(rec ?? null)) problems.push(`barcodes/${code} = ${JSON.stringify(live)}`);
  }
  console.log(problems.length ? `\n  VERIFY FAILED:\n${problems.map((p) => `     ${p}`).join("\n")}` : "  verified on fresh reads: identity, index and target rows match the snapshot");
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
