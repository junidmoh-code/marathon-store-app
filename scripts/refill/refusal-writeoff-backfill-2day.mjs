// ─── ONE-OFF: the two-refused-days backfill (Junid, 1 Nov 2026) ──────────────
//
// Junid lowered the refusal write-off from four refused days to two
// (functions/lib/refusal-writeoff.cjs MIN_DISTINCT_DAYS). Every cell already
// sitting at two or three refused days — paused, never written off under the
// four rule — is written off NOW, so the next scan raises its refill.
//
// It is the scan's own pass, run once by hand: the same reads as
// refillHealthScan (no whole-node read the scan does not already make every
// hour), planRefusalWriteoffs with the new constant, and applyRefusalWriteoffs
// — the same writer, the same ledger rows (type refusal_writeoff, guarded by
// the exact count planned from), the same per-cell cursor (a run is never
// written off twice), the same Junid-only records + digest queue. Pine stays
// excluded (the planner's rule). Then one Junid-only log of this run at
// /refill_engine/refusalWriteoffBackfills/{runId}.
//
//   node scripts/refill/refusal-writeoff-backfill-2day.mjs            dry run: prints the list, writes nothing
//   node scripts/refill/refusal-writeoff-backfill-2day.mjs --apply    writes it off (refuses above 300 units)
//
// Run where node reaches Google (the Mac mini).

import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "../adminRequire.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const wo = require(join(ROOT, "functions/lib/refusal-writeoff.cjs"));
const engine = require(join(ROOT, "functions/lib/refill-engine.cjs"));
const { loadNetwork } = require(join(ROOT, "functions/lib/network-load.cjs"));

export const MAX_UNITS = 300;   // Junid's stop line: above it, print the list and stop
const APPLY = process.argv.includes("--apply");
const WINDOW_DAYS = 45;          // functions/refill-scan.cjs MOVEMENTS_WINDOW_DAYS

const admin = adminRequire(import.meta.url)("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const val = async (p) => (await db.ref(p).once("value")).val() || {};

const nowMs = Date.now();
const runId = `backfill-2day-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}`;
try {
  // The scan stands down while Central is receiving a shipment — so does this.
  const session = await val("receiving_session");
  if (session.active) throw new Error(`receiving session open since ${session.openedAt || "?"} — run it after it closes`);
  const config = await val("config/refillEngine");
  const network = await loadNetwork(db, { nowMs });
  const routing = engine.networkRouting(config, network);
  const locs = [...new Set([...Object.keys(routing.routes), ...Object.values(routing.routes), ...routing.locs])];
  const windowDays = Math.max(WINDOW_DAYS, (Number(config.confirmedOutDays) || 14) + 1);
  const windowStart = new Date(nowMs - windowDays * 864e5).toISOString();
  const [products, refillRequests, rejectStreak, cursors, mv, ...stocks] = await Promise.all([
    val("products"), val("refill_requests"), val("refill_engine/rejectStreak"), val("refill_engine/refusalWriteoffCursor"),
    db.ref("stock_movements").orderByChild("ts").startAt(windowStart).once("value").then((s) => s.val() || {}),
    ...locs.map((l) => val(`stock/${l}`).then((s) => [l, s])),
  ]);
  const snapshot = {
    nowMs, config, stock: Object.fromEntries(stocks), products, refillRequests, movements: Object.values(mv),
    rejectStreak, cursors, windowStartMs: Date.parse(windowStart), network,
  };
  const plan = wo.planRefusalWriteoffs(snapshot);
  const units = plan.writeoffs.reduce((t, w) => t + (w.repair ? 0 : w.qty), 0);
  const rows = plan.writeoffs.map((w) => ({
    id: w.id, location: w.loc, product: products[w.pid]?.name || w.pid, pid: w.pid, size: w.size, units: w.qty,
    paper: w.paperQty, days: w.days, refusals: w.refusals.map((r) => ({ day: r.day, rrId: r.rrId, byUid: r.byUid, byRole: r.byRole })),
  }));
  console.log(`threshold: ${wo.MIN_DISTINCT_DAYS} different days · ${rows.length} size(s) · ${units} unit(s) · deferred ${plan.deferred.length}`);
  for (const r of rows) console.log(`  ${r.location.padEnd(8)} ${r.product} · ${r.size} · ${r.units}u (paper ${r.paper}) · refused ${r.days.join(", ")}`);
  for (const d of plan.deferred) console.log(`  deferred ${d.reason}: ${d.loc} ${products[d.pid]?.name || d.pid} · ${d.size}`);
  if (units > MAX_UNITS) {
    console.log(`STOP: ${units} units is above the ${MAX_UNITS}-unit line Junid set. Nothing written.`);
    process.exitCode = 3;
  } else if (!APPLY) {
    console.log("dry run — nothing written (add --apply)");
  } else if (rows.length) {
    const res = await wo.applyRefusalWriteoffs({
      db, writeoffs: plan.writeoffs, snapshot, nowMs, runId,
      update: async (patch) => { try { await db.ref().update(patch); return true; } catch (e) { console.error(String(e?.message || e)); return false; } },
      maxPerRun: 500, deadlineMs: Date.now() + 10 * 60e3,
    });
    await db.ref(`refill_engine/refusalWriteoffBackfills/${runId}`).set({
      atMs: nowMs, threshold: wo.MIN_DISTINCT_DAYS, applied: res.applied.length, units: res.units,
      ids: res.applied.map((r) => r.id), skipped: res.skipped, by: "one-off script (Junid's 1 Nov 2026 rule change)",
      // The list itself, for Junid: what, where, how many, when refused and by whom.
      list: res.applied.map((r) => ({
        id: r.id, loc: r.loc, product: r.productName || r.pid, size: r.size, units: r.qty, before: r.before, after: r.after, days: r.days,
        refusedBy: (r.refusals || []).map((x) => ({ day: x.day, by: x.byName || (x.byRole ? `${x.byRole} account` : `${x.byLoc} staff`) })),
      })),
    });
    console.log(`APPLIED ${res.applied.length} write-off(s), ${res.units} unit(s); skipped ${res.skipped.length}${res.skipped.length ? ` ${JSON.stringify(res.skipped)}` : ""}`);
    console.log(`log: /refill_engine/refusalWriteoffBackfills/${runId}`);
  }
} finally {
  await admin.app().delete().catch(() => {});
}
