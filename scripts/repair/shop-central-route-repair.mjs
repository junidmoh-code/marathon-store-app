// ─── SHOP ← CENTRAL — LIVE DATA REPAIR (3 Oct 2026) ──────────────────────────
// Owner rule: a shop refill for a product its hub has held by ANY means is
// sourced from the hub, never from Central (SHOP-CENTRAL-ROUTE-INVESTIGATION.md).
// For every OPEN /refill_requests row that is shop ← Central:
//   • untouched (no sentQty), not mid-pick, and the shop's hub shows presence
//     → WITHDRAWN by CAS with `cancelReason: first_batch_hub2_present` (a
//     reason, so the engine reads a withdrawal: no cooldown, no rejection
//     learned at the shop's cell). The shop's engine lock is released by CAS
//     on this row's own refillId. The engine's next hourly scan re-raises the
//     shop's need from its hub (lib/shop-source-rule.cjs is the same rule,
//     and from this PR on the scan applies it by itself every hour).
//   • untouched with NO hub presence → kept: it is a legitimate first batch.
//   • touched (sentQty > 0) or mid-pick → NEVER touched. Listed, so the
//     owner knows units are physically moving from Central.
// Also LISTED (never changed): shop ← Central rows already fulfilled since
// `--since` (default 2026-09-01), so the owner sees what physically moved.
//
// Reads: open rows by the `resolvedAt` index (equalTo null), the history by
// the `createdAt` index, /locations + /config/refillEngine (small), and per
// product the hub's stock node, its lock node and the hold lane (scoped).
// Never a whole-node read. NO STOCK MOVES: the only writes are the CAS cancel
// and the CAS lock release. Re-running finds nothing to do.
//   node scripts/repair/shop-central-route-repair.mjs [--apply] [--since=YYYY-MM-DD]
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
import { adminRequire } from "../adminRequire.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPLY = process.argv.includes("--apply");
const SINCE = (process.argv.find((a) => a.startsWith("--since=")) || "--since=2026-09-01").slice(8);
const req = (() => { try { const r = createRequire(join(ROOT, "functions", "package.json")); r.resolve("firebase-admin"); return r; } catch { return adminRequire(import.meta.url); } })();
const rule = req(join(ROOT, "functions", "lib", "shop-source-rule.cjs"));
const { encodeSizeKey } = req(join(ROOT, "functions", "lib", "refill-engine.cjs"));
export const REPAIR_REASON = rule.SHOP_HUB_PRESENT_REASON;

const sourceOf = (r, routes) => r?.createdFrom?.source || r?.source || routes[r?.requestingLocation] || null;
export const isShopCentral = (r, { routes, locations }) =>
  !!r && rule.forbiddenShopSource({ dest: r.requestingLocation, source: sourceOf(r, routes), routes, locations });

// Pure: the decision for one open shop ← Central row given its scoped reads.
export function decideRow({ row, routes, locations, hubNode, hubLocks, heldLines, openRows, order }) {
  const hub = rule.shopHubFor(row.requestingLocation, { routes, locations });
  const untouched = row.status === "open" && rule.requestUntouched(row);
  // A row that carries an ORDER (an engine store leg) is never this script's
  // to cancel: its mid-pick state lives on the order (clothingPlanGen), which
  // can change between this plan and the apply, and no request-level CAS can
  // see it. The engine's reconcile owns those, with its own order-first
  // transaction (refill-scan.cjs). First-batch rows carry no order. (CodeRabbit,
  // PR #673.)
  const midPick = !!(order || row.createdFrom?.orderId || row.orderId);
  const hubOpenRequests = (openRows || [])
    .filter((r) => r && r.status === "open" && r.productId === row.productId && r.requestingLocation === hub && !r.shadow)
    .map((r) => ({ createdAt: r.createdAt }));
  const presence = hub ? rule.hubPresenceSignals({ hubNode, hubLocks, hubOpenRequests, heldLines, sinceIso: row.createdAt, pid: row.productId }) : [];
  const withdraw = !!hub && untouched && !midPick && presence.length > 0;
  return { hub, untouched, midPick, presence, withdraw, inFlight: !untouched || midPick };
}

export async function buildPlan(db, { readOpen, readSince } = {}) {
  const [routes, locations] = await Promise.all([
    db.ref("config/refillEngine/routes").once("value").then((s) => s.val() || {}),
    db.ref("locations").once("value").then((s) => s.val() || null),
  ]);
  const ctx = { routes, locations };
  const openMap = readOpen ? await readOpen(db)
    : (await db.ref("refill_requests").orderByChild("resolvedAt").equalTo(null).once("value")).val() || {};
  const openRows = Object.entries(openMap).map(([id, r]) => ({ id, ...r }));
  const target = openRows.filter((r) => r.status === "open" && isShopCentral(r, ctx));
  const cache = {};
  const plan = [];
  for (const row of target) {
    const hub = rule.shopHubFor(row.requestingLocation, ctx);
    const key = `${hub}|${row.productId}`;
    if (hub && !cache[key]) cache[key] = {
      hubNode: (await db.ref(`stock/${hub}/${row.productId}`).once("value")).val(),
      hubLocks: (await db.ref(`refill_engine/open/${hub}/${row.productId}`).once("value")).val(),
      heldLines: (await db.ref(`settings/stockHold/held/${hub}`).once("value")).val(),
    };
    const order = row.createdFrom?.orderId ? (await db.ref(`orders/${row.createdFrom.orderId}`).once("value")).val() : null;
    const d = decideRow({ row, routes, locations, ...(cache[key] || {}), openRows, order });
    plan.push({ id: row.id, pid: row.productId, size: row.size, store: row.requestingLocation, sentQty: row.sentQty || 0,
      firstBatch: row.createdFrom?.firstBatch === true, createdAt: row.createdAt, ...d, row });
  }
  // History (report only): shop ← Central rows fulfilled since SINCE.
  const sinceMap = readSince ? await readSince(db, SINCE)
    : (await db.ref("refill_requests").orderByChild("createdAt").startAt(SINCE).once("value")).val() || {};
  const picked = Object.entries(sinceMap).map(([id, r]) => ({ id, ...r }))
    .filter((r) => (r.status === "fulfilled" || (Number(r.sentQty) || 0) > 0) && isShopCentral(r, ctx))
    .map((r) => ({ id: r.id, pid: r.productId, size: r.size, store: r.requestingLocation, status: r.status,
      sentQty: r.sentQty || 0, firstBatch: r.createdFrom?.firstBatch === true, createdAt: r.createdAt, resolvedAt: r.resolvedAt || null }));
  return { plan, openTotal: openRows.length, picked, routes };
}

// The writes: a CAS cancel that re-verifies "open, untouched, no reason"
// inside the transaction, then a CAS release of the shop's lock only while it
// still names this row. Both are no-ops the second time.
export async function applyPlan(db, plan, nowIso) {
  let withdrawn = 0, refused = 0, locksReleased = 0;
  for (const p of plan) {
    if (!p.withdraw) continue;
    // COLD-NULL: the first callback can see null for a row that exists.
    // Returning null PROBES — a present row fails the compare and the callback
    // re-runs with the server value; a row truly gone commits null onto
    // nothing (a no-op). Never the plan's snapshot: that would re-create a
    // deleted request as a cancelled copy. (CodeRabbit, PR #673.)
    const res = await db.ref(`refill_requests/${p.id}`).transaction((cur) => {
      if (cur === null || cur === undefined) return null;
      if (cur.status !== "open" || !rule.requestUntouched(cur) || cur.cancelReason) return undefined;
      const next = { ...cur, status: "cancelled", cancelReason: REPAIR_REASON, resolvedAt: nowIso };
      // The first-batch trigger's "done" marker in the same write, so the
      // re-fire this cancel causes raises no Hub 2 leg from it.
      if (cur.createdFrom?.firstBatch === true) next.firstBatch = { ...(cur.firstBatch || {}), hub2Leg: { none: "hub2_present", at: nowIso } };
      return next;
    });
    if (!res.committed || res.snapshot.val()?.cancelReason !== REPAIR_REASON) { refused++; continue; }
    withdrawn++;
    const lockRef = db.ref(`refill_engine/open/${p.store}/${p.pid}/${encodeSizeKey(String(p.size ?? ""))}`);
    const held = (await lockRef.once("value")).val();
    const rel = await lockRef.transaction((raw) => {
      const cur = raw === null || raw === undefined ? held : raw;
      return cur && cur.refillId === p.id ? null : undefined;
    });
    if (rel.committed) locksReleased++;
  }
  return { withdrawn, refused, locksReleased };
}

async function main() {
  const admin = req("firebase-admin");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = admin.database();
  const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
  const nowIso = new Date(Date.now() + offset).toISOString();   // server time, not the laptop's
  const { plan, openTotal, picked, routes } = await buildPlan(db);
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} at ${nowIso} — open /refill_requests ${openTotal}; routes ${JSON.stringify(routes)}`);
  console.log(`  open shop ← Central rows: ${plan.length}`);
  console.log(`    withdraw (hub holds it, untouched): ${plan.filter((p) => p.withdraw).length}`);
  console.log(`    keep (legitimate first batch — hub never held it): ${plan.filter((p) => !p.withdraw && !p.inFlight).length}`);
  console.log(`    left alone (sent / mid-pick): ${plan.filter((p) => p.inFlight).length}`);
  for (const p of plan) console.log(`    ${p.id} ${p.store} ${p.pid} size=${JSON.stringify(p.size)} sent=${p.sentQty} presence=[${p.presence}] withdraw=${p.withdraw}`);
  console.log(`  shop ← Central rows already picked since ${SINCE}: ${picked.length} (first batch: ${picked.filter((r) => r.firstBatch).length})`);
  mkdirSync(join(ROOT, "var"), { recursive: true });
  const out = join(ROOT, "var", `shop-central-route-repair-${APPLY ? "apply" : "dry"}-${nowIso.replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ nowIso, apply: APPLY, since: SINCE, plan: plan.map(({ row, ...p }) => p), picked }, null, 1));
  console.log("  log →", out);
  if (!APPLY) process.exit(0);
  const r = await applyPlan(db, plan, nowIso);
  console.log(`  applied: withdrawn ${r.withdrawn}, refused by CAS ${r.refused}, shop locks released ${r.locksReleased}`);
  process.exit(0);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
