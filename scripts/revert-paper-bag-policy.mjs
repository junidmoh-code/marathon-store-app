#!/usr/bin/env node
// ─── PAPER BAGS: put the live data back to how it was before 16 Oct 2026 ─────
//
//   node scripts/revert-paper-bag-policy.mjs              # DRY RUN — writes nothing
//   node scripts/revert-paper-bag-policy.mjs --execute    # apply
//
// Junid's decision, 17 Oct 2026: the paper-bag refill policy work (PR #729) is
// reversed in full. The code revert is the commit before this one; this script
// is the data half. It restores EXACTLY the values the #729 data step
// (scripts/apply-paper-bag-policy.mjs --execute, 16 Oct 17:07Z) replaced, read
// from the rollback file that step wrote after every write:
//
//   scripts/data/paper-bag-policy-before-state-2026-10-16.json
//
// Scoped to the paths that file names and nothing else. Idempotent — every path
// is read first and classified:
//     restored   live still holds what #729 wrote        → put the before-value back
//     done       live already holds the before-value     → nothing to do
//     conflict   live holds something else (a later edit) → LEFT ALONE and listed
//
// Steps, in this order (the order matters — see each step):
//   1. ROWS      /stock_targets/{loc}/{pid}/{sizeKey}: 81 product × location
//                edits. A cell #729 cleared gets its exact old row back (all
//                fields, byte for byte); a cell #729 set gets its exact old row
//                back, or is removed where there was none. One
//                /engine_policy_history entry per edit (kind "targets", the
//                shape the Engine Policy card reads), by paper-bag-revert-runner.
//   2. CANCEL    every OPEN engine paper-bag request raised under the new policy
//                that nobody has picked or sent, through the engine's own close
//                sequence (refill-scan.cjs): order transaction decides → request
//                cancelled (cancelReason paper_bag_policy_revert — the engine's
//                self-withdrawal shape: no cooldown, no strike) → lock removed.
//                Claimed or partly-sent requests are left alone and listed.
//                The 30 requests #729 cancelled are NOT resurrected: the next
//                scan re-raises whatever the restored policy asks for.
//   3. POLICY    /config/refillEngine/categoryPolicy/paper-bags did not exist
//                before 16 Oct. Removed through the Engine Policy writer with
//                policy: null — its documented off switch — so the history
//                shows the un-arming with a one-tap revert. Must run while the
//                taxonomy entry still exists (the writer checks the key).
//   4. RE-KEY    products/{pid}/categoryKey → its previous key (52 "bags",
//                7 "packaging"), each in a transaction that refuses unless the
//                key still reads "paper-bags".
//   5. TAXONOMY  /settings/productTaxonomy/cats/paper-bags did not exist before
//                16 Oct. Removed only if it is still byte-identical to what
//                #729 created; an edited entry is a conflict and stays.
//   6. MODEL     the restored engine's computeRefillPlan on the paper bags alone,
//                after 1–5: what the next scan raises for each.
//
// Reads are per product / per path (never a whole /stock or /refill_requests
// read; the one refill_requests query is an indexed createdAt window).
//
// Writes, beside the cwd:
//   paper-bag-revert-dry-run-<stamp>.json   every path: current value → restored value
//   paper-bag-revert-applied-<stamp>.json   (--execute) what was written
//   paper-bag-revert-undo-<stamp>.json      (--execute) the live values this run replaced
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { adminRequire } from "./adminRequire.mjs";

const local = createRequire(import.meta.url);
const admin = adminRequire(import.meta.url)("firebase-admin");
const engine = local("../functions/lib/refill-engine.cjs");
const writer = local("../functions/lib/category-policy-write.cjs");
const { pickInProgress } = local("../functions/lib/shop-source-rule.cjs");
const { loadNetwork } = local("../functions/lib/network-load.cjs");
const closeRequestTxn = local("../functions/refill-scan.cjs")._closeRequestTxn;

const EXECUTE = process.argv.includes("--execute");
const RUNNER = "paper-bag-revert-runner";
const APPLIED_BY = "paper-bag-policy-runner";          // what #729's data step stamped on every row it wrote
const KEY = "paper-bags";
const CANCEL_REASON = "paper_bag_policy_revert";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEFORE_FILE = path.join(HERE, "data", "paper-bag-policy-before-state-2026-10-16.json");
const EXECUTE_REPORT = path.join(HERE, "data", "paper-bag-policy-execute-report-2026-10-16.json");

const before = JSON.parse(fs.readFileSync(BEFORE_FILE, "utf8"));
const appliedReport = JSON.parse(fs.readFileSync(EXECUTE_REPORT, "utf8"));
const TAXONOMY_CREATED = appliedReport.steps?.taxonomy?.create;
if (!TAXONOMY_CREATED || before.policyBefore !== null) throw new Error("before-state file is not the 16 Oct rollback file");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}
const db = admin.database();
const val = (p) => db.ref(p).once("value").then((s) => s.val());
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => writer.sameValue(a ?? null, b ?? null);
const log = (...a) => console.log(...a);

// The server's clock, not this machine's: every `at` written here is the RTDB
// server time (offset read once from .info/serverTimeOffset).
let serverOffsetMs = 0;
const serverNowMs = () => Date.now() + serverOffsetMs;

const diff = [];       // every path: { step, path, current, restored, action }
const applied = [];    // --execute: what landed
const undo = [];       // --execute: { path, was } for every write, so this run can itself be undone
const UNDO_FILE = `paper-bag-revert-undo-${STAMP}.json`;
const saveUndo = () => { if (EXECUTE) fs.writeFileSync(UNDO_FILE, JSON.stringify({ at: new Date().toISOString(), undo, applied }, null, 1)); };
const note = (step, p, current, restored, action, extra) => diff.push({ step, path: p, current: current ?? null, restored: restored ?? null, action, ...(extra || {}) });

// Write `next` at `p` only if the live value still equals `expect` (null = absent).
async function guardedWrite(p, expect, next) {
  const r = await db.ref(p).transaction((cur) => {
    if (cur === null && expect !== null) return null;             // cold cache probe (#199): re-run with the truth
    if (!same(cur, expect)) return undefined;                      // moved since it was read — refuse
    return next === null ? null : next;
  });
  const landed = r.committed && same(r.snapshot.val(), next);
  if (landed) { undo.push({ path: p, was: expect }); applied.push({ path: p, value: next }); saveUndo(); }
  return landed;
}

async function main() {
  log("═".repeat(88));
  log(`PAPER BAGS — REVERT TO PRE-16-OCT — ${EXECUTE ? "EXECUTE" : "DRY RUN (nothing is written)"} — ${new Date().toISOString()}`);
  log("═".repeat(88));
  serverOffsetMs = Number(await val(".info/serverTimeOffset")) || 0;

  const pids = before.categoryKeys.map((c) => c.pid);
  const [config, locationsNode] = await Promise.all([val("config/refillEngine"), val("locations")]);
  const knownLocations = Object.keys(locationsNode || {});
  const network = await loadNetwork(db);
  const rowLocs = writer.rowLocationsFor(config || {}, network);
  const products = {};
  await Promise.all(pids.map(async (pid) => { products[pid] = (await val(`products/${pid}`)) || {}; }));
  const nameOf = (pid) => products[pid]?.name || pid;
  log(`\n${pids.length} paper bags named by the before-state file; row locations ${rowLocs.join(", ")}.`);

  // ── 1. ROWS ────────────────────────────────────────────────────────────────
  log(`\n1. ROWS — ${before.rows.length} product × location edits from #729`);
  let rowsRestored = 0, rowsDone = 0, rowsConflict = 0;
  const rowWrites = [];   // { loc, pid, sizeKey, path, cur, want }
  for (const e of before.rows) {
    for (const [sizeKey, was] of Object.entries(e.before || {})) {
      const p = `stock_targets/${e.loc}/${e.pid}/${sizeKey}`;
      const cur = await val(p);
      const want = isObj(was) ? was : null;
      if (same(cur, want)) { rowsDone++; note("rows", p, cur, want, "done"); continue; }
      // #729 either cleared the cell (cur absent) or wrote a 50/25/ask-10 row stamped by its runner.
      const isSetBy729 = isObj(cur) && cur.setBy === APPLIED_BY && cur.source === "policy_target" && cur.target === 50 && cur.reorderPoint === 10;
      const isClearedBy729 = cur === null && want !== null;
      if (!isSetBy729 && !isClearedBy729) {
        rowsConflict++; note("rows", p, cur, want, "conflict", { why: "the cell no longer holds what #729 left — edited since; left alone" });
        log(`   CONFLICT ${e.loc.padEnd(11)} ${sizeKey.padEnd(2)} now ${JSON.stringify(cur)} — ${nameOf(e.pid)}`);
        continue;
      }
      rowsRestored++;
      note("rows", p, cur, want, want === null ? "remove" : "restore");
      rowWrites.push({ loc: e.loc, pid: e.pid, sizeKey, path: p, cur, want });
      log(`   ${(want === null ? "remove" : "restore").padEnd(8)} ${e.loc.padEnd(11)} ${sizeKey.padEnd(2)} ${want ? `${want.target}/${want.reorderPoint ?? "–"} (${want.source || "?"})` : "no row"}`.padEnd(60) + nameOf(e.pid));
    }
  }
  log(`   ${rowsRestored} to restore, ${rowsDone} already as before, ${rowsConflict} conflicts (left alone)`);
  if (EXECUTE && rowWrites.length) {
    let ok = 0;
    // One history entry per product × location, the shape the card reads.
    const byEdit = new Map();
    for (const w of rowWrites) { const k = `${w.loc}|${w.pid}`; if (!byEdit.has(k)) byEdit.set(k, []); byEdit.get(k).push(w); }
    for (const [, ws] of byEdit) {
      const { loc, pid } = ws[0];
      const historyRef = db.ref(writer.HISTORY_PATH).push();
      const changes = ws.map((w) => ({ sizeKey: w.sizeKey, field: "target", from: isObj(w.cur) && typeof w.cur.target === "number" ? w.cur.target : null, to: w.want ? w.want.target : null }));
      await historyRef.set({
        kind: "targets", loc, pid, productName: nameOf(pid), categoryKey: products[pid]?.categoryKey ?? null,
        at: serverNowMs(), by: RUNNER, byUid: null, rowCount: ws.length,
        before: ws.map((w) => ({ sizeKey: w.sizeKey, row: w.cur })),
        after: ws.map((w) => (w.want ? { sizeKey: w.sizeKey, row: w.want } : { sizeKey: w.sizeKey, absent: true })),
        changes, status: "pending", revertOfPaperBagPolicy: true,
      });
      let landed = 0;
      for (const w of ws) if (await guardedWrite(w.path, w.cur, w.want)) landed++; else log(`   ! ${w.path} moved while writing — left`);
      ok += landed;
      await historyRef.update({ status: landed === ws.length ? "applied" : "partial", verifiedAt: serverNowMs() });
    }
    writer.invalidateCensusCache();
    log(`   ✓ ${ok}/${rowWrites.length} cells restored`);
  }

  // ── 2. CANCEL ──────────────────────────────────────────────────────────────
  // Stock cells are read per product for the on-hand column only.
  const stock = {};
  for (const l of [...new Set([...knownLocations, "central", "hub2", "marathon-pe", "trophy"])]) stock[l] = {};
  await Promise.all(pids.map(async (pid) => {
    await Promise.all(Object.keys(stock).map(async (l) => { const v = await val(`stock/${l}/${pid}`); if (v) stock[l][pid] = v; }));
  }));
  const cancels = [], leftAlone = [];
  const lockedIds = new Set();
  for (const dest of rowLocs) {
    for (const pid of pids) {
      const locks = await val(`refill_engine/open/${dest}/${pid}`);
      for (const [sizeKey, lock] of Object.entries(locks || {})) {
        if (!isObj(lock) || !lock.refillId) continue;
        lockedIds.add(lock.refillId);
        const rr = await val(`refill_requests/${lock.refillId}`);
        if (!rr || rr.status !== "open") continue;
        const order = lock.orderId ? await val(`orders/${lock.orderId}`) : null;
        const orderIsOurs = !!order && order.productId === pid && engine.encodeSizeKey(order.size) === sizeKey && order.createdAt === lock.orderCreatedAt;
        const have = Math.max(0, Number(stock[dest]?.[pid]?.[sizeKey]?.qty) || 0);
        const row = { dest, pid, sizeKey, name: nameOf(pid), refillId: lock.refillId, orderId: orderIsOurs ? lock.orderId : null,
          source: lock.source || rr.createdFrom?.source || null, qty: rr.qty, createdAt: rr.createdAt, onHand: have, runId: rr.createdFrom?.runId || null };
        const why = pickInProgress(rr) ? "a picker has claimed it" : (Number(rr.sentQty) || 0) > 0 ? `partly sent (${rr.sentQty})`
          : orderIsOurs && (order.clothingRefillStatus != null || order.clothingPlanGen != null) ? "its order is being fulfilled" : null;
        if (why) leftAlone.push({ ...row, why }); else cancels.push({ ...row, lock, rr, order: orderIsOurs ? order : null });
      }
    }
  }
  const since = "2026-10-16T17:00:00.000Z";   // the #729 data step finished 17:12Z; nothing of ours is older
  const recent = (await db.ref("refill_requests").orderByChild("createdAt").startAt(since).once("value")).val() || {};
  for (const [id, r] of Object.entries(recent)) {
    if (r?.status === "open" && pids.includes(r.productId) && !lockedIds.has(id)) {
      leftAlone.push({ refillId: id, dest: r.requestingLocation, qty: r.qty, createdAt: r.createdAt, name: nameOf(r.productId), why: "no engine lock (not an engine request) — left as it is" });
    }
  }
  log(`\n2. CANCEL — ${cancels.length} open engine paper-bag requests raised under the new policy (${leftAlone.length} left alone)`);
  for (const c of cancels) { log(`   ${c.refillId}  ${c.dest.padEnd(11)} ← ${String(c.source).padEnd(7)} x${String(c.qty).padEnd(3)} on hand ${String(c.onHand).padEnd(3)} ${c.name}`); note("cancel", `refill_requests/${c.refillId}`, { status: "open", qty: c.qty, dest: c.dest, source: c.source }, { status: "cancelled", cancelReason: CANCEL_REASON }, "cancel", { orderId: c.orderId, lockPath: `refill_engine/open/${c.dest}/${c.pid}/${c.sizeKey}` }); }
  for (const c of leftAlone) { log(`   LEFT  ${c.refillId}  ${c.dest} x${c.qty} — ${c.why} — ${c.name}`); note("cancel", `refill_requests/${c.refillId}`, { status: "open", qty: c.qty }, null, "left", { why: c.why }); }
  let cancelled = 0;
  if (EXECUTE) {
    const startedAt = new Date(serverNowMs()).toISOString();
    for (const c of cancels) {
      // The engine's close sequence (refill-scan.cjs "apply closes"), in order:
      // claimed → keep; the ORDER transaction decides; the request transaction;
      // then the lock — only if it is still this request's.
      const fresh = await val(`refill_requests/${c.refillId}`);
      if (!fresh || fresh.status !== "open" || pickInProgress(fresh)) { log(`   ! ${c.refillId} changed — skipped`); continue; }
      if (c.orderId) {
        const res = await db.ref(`orders/${c.orderId}`).transaction((cur) => {
          if (!cur) return null;
          if (cur.clothingRefillStatus != null || cur.clothingPlanGen != null || !cur.autoRefill) return;
          return null;
        });
        if (!res.committed) { log(`   ! ${c.refillId} order ${c.orderId} touched — skipped`); continue; }
      }
      const close = { dest: c.dest, pid: c.pid, sizeKey: c.sizeKey, refillId: c.refillId, reason: CANCEL_REASON, cancelReason: CANCEL_REASON, rrStatus: "cancelled" };
      const res = await db.ref(`refill_requests/${c.refillId}`).transaction((cur) => closeRequestTxn(cur, close, startedAt));
      if (!(res && res.committed) || res.snapshot.val()?.status !== "cancelled") {
        if (c.orderId && c.order) {
          const back = await db.ref(`orders/${c.orderId}`).transaction((cur) => (cur === null ? c.order : undefined));
          log(`   ! ${c.refillId} request did not cancel — lock kept, order ${back.committed ? "restored" : "NOT restored (slot taken)"}`);
        } else log(`   ! ${c.refillId} request did not cancel — lock kept`);
        continue;
      }
      const lockPath = `refill_engine/open/${c.dest}/${c.pid}/${c.sizeKey}`;
      const lr = await db.ref(lockPath).transaction((cur) => (cur === null ? null : cur.refillId === c.refillId ? null : undefined));
      if (!lr.committed) log(`   ! ${c.refillId} lock now belongs to another request — left`);
      undo.push({ path: `refill_requests/${c.refillId}`, was: c.rr, lock: c.lock, lockPath, orderId: c.orderId, order: c.order });
      applied.push({ path: `refill_requests/${c.refillId}`, value: { status: "cancelled", cancelReason: CANCEL_REASON } });
      saveUndo();
      cancelled++;
    }
    log(`   ✓ ${cancelled}/${cancels.length} cancelled (cancelReason ${CANCEL_REASON})`);
  }

  // ── 3. POLICY ──────────────────────────────────────────────────────────────
  const policyLive = await val(`${writer.POLICY_PATH}/${KEY}`);
  log(`\n3. POLICY — ${writer.POLICY_PATH}/${KEY}: ${policyLive === null ? "already absent — nothing to do" : `remove ${JSON.stringify(policyLive)} (did not exist before 16 Oct)`}`);
  note("policy", `${writer.POLICY_PATH}/${KEY}`, policyLive, null, policyLive === null ? "done" : "remove");
  if (policyLive !== null) {
    const r = await writer.applyCategoryPolicy({ db, callerEmail: RUNNER, adminEmail: RUNNER, callerUid: null, nowMs: serverNowMs(),
      data: { categoryKey: KEY, policy: null, expectedBefore: policyLive, dryRun: !EXECUTE } });
    if (EXECUTE) {
      const after = await val(`${writer.POLICY_PATH}/${KEY}`);
      if (after !== null) throw new Error(`policy still reads ${JSON.stringify(after)}`);
      undo.push({ path: `${writer.POLICY_PATH}/${KEY}`, was: policyLive, historyId: r.historyId }); applied.push({ path: `${writer.POLICY_PATH}/${KEY}`, value: null }); saveUndo();
      log(`   ✓ un-armed through the Engine Policy writer — history ${r.historyId}`);
    } else log(`   dry run through the writer: ${r.changes.length} leg changes, modelled requests ${r.preview?.before?.totalRequests} → ${r.preview?.after?.totalRequests}`);
  }

  // ── 4. RE-KEY ──────────────────────────────────────────────────────────────
  log(`\n4. RE-KEY — ${before.categoryKeys.length} products back to their previous key`);
  let rekeyed = 0, rekeyDone = 0, rekeyConflict = 0;
  for (const { pid, prev } of before.categoryKeys) {
    const p = `products/${pid}/categoryKey`;
    const cur = products[pid]?.categoryKey ?? null;
    if (cur === prev) { rekeyDone++; note("rekey", p, cur, prev, "done"); continue; }
    if (cur !== KEY) { rekeyConflict++; note("rekey", p, cur, prev, "conflict", { why: "key changed since #729; left alone" }); log(`   CONFLICT ${pid} is "${cur}" — ${nameOf(pid)}`); continue; }
    note("rekey", p, cur, prev, "restore");
    log(`   ${pid}  ${KEY} → ${String(prev).padEnd(10)} ${nameOf(pid)}`);
    if (EXECUTE) {
      if (await guardedWrite(p, KEY, prev)) rekeyed++; else log(`   ! ${pid} not re-keyed — moved while writing`);
    }
  }
  log(`   ${before.categoryKeys.length - rekeyDone - rekeyConflict} to restore, ${rekeyDone} already as before, ${rekeyConflict} conflicts${EXECUTE ? ` — ✓ ${rekeyed} written` : ""}`);

  // ── 5. TAXONOMY ────────────────────────────────────────────────────────────
  const taxPath = `settings/productTaxonomy/cats/${KEY}`;
  const taxLive = await val(taxPath);
  const taxIsOurs = same(taxLive, TAXONOMY_CREATED);
  const stillKeyed = (await Promise.all(pids.map((pid) => val(`products/${pid}/categoryKey`)))).filter((k) => k === KEY).length;
  log(`\n5. TAXONOMY — ${taxPath}: ${taxLive === null ? "already absent" : taxIsOurs ? "remove (byte-identical to what #729 created)" : "CONFLICT — edited since #729, left alone"}`);
  note("taxonomy", taxPath, taxLive, null, taxLive === null ? "done" : taxIsOurs ? "remove" : "conflict");
  if (EXECUTE && taxLive !== null && taxIsOurs) {
    if (stillKeyed) log(`   ! ${stillKeyed} products still keyed ${KEY} — the entry stays until they are re-keyed`);
    else if (await guardedWrite(taxPath, taxLive, null)) log("   ✓ removed"); else log("   ! moved while writing — left");
  }

  // ── 6. MODEL — what the next scan raises for each paper bag ────────────────
  const mProducts = {}, mTargets = {}, mOpen = {}, mRr = {}, mOrders = {};
  for (const pid of pids) mProducts[pid] = { ...products[pid], categoryKey: before.categoryKeys.find((c) => c.pid === pid)?.prev ?? products[pid].categoryKey };
  for (const l of rowLocs) mTargets[l] = {};
  for (const pid of pids) for (const l of rowLocs) {
    const live = { ...((await val(`stock_targets/${l}/${pid}`)) || {}) };
    if (!EXECUTE) for (const w of rowWrites) if (w.loc === l && w.pid === pid) { if (w.want) live[w.sizeKey] = w.want; else delete live[w.sizeKey]; }
    if (Object.keys(live).length) mTargets[l][pid] = live;
  }
  const cancelledIds = new Set(cancels.map((c) => c.refillId));
  for (const l of rowLocs) for (const pid of pids) {
    const locks = await val(`refill_engine/open/${l}/${pid}`);
    for (const [k, lock] of Object.entries(locks || {})) {
      if (!isObj(lock) || cancelledIds.has(lock.refillId)) continue;
      const rr = lock.refillId ? await val(`refill_requests/${lock.refillId}`) : null;
      if (!rr || rr.status !== "open") continue;
      ((mOpen[l] ||= {})[pid] ||= {})[k] = lock; mRr[lock.refillId] = rr;
      if (lock.orderId) { const o = await val(`orders/${lock.orderId}`); if (o) mOrders[lock.orderId] = o; }
    }
  }
  const mConfig = { ...(config || {}), categoryPolicy: { ...(config?.categoryPolicy || {}) }, maxIntentsPerRun: 1000 };
  delete mConfig.categoryPolicy[KEY];
  const plan = engine.computeRefillPlan({
    nowMs: serverNowMs(), config: mConfig, products: mProducts, targets: mTargets, stock,
    openIndex: mOpen, refillRequests: mRr, orders: mOrders, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {}, heldLines: {}, network,
  });
  const byPid = {};
  for (const i of plan.intents) (byPid[i.productId] ||= []).push(`${i.dest} ← ${i.source} x${i.qty}`);
  for (const r of plan.resizes) (byPid[r.pid] ||= []).push(`${r.dest} open request ${r.from} → ${r.to}`);
  const q = (l, pid) => { const c = stock[l]?.[pid]; if (!c) return "–"; return Object.entries(c).map(([k, v]) => (k === "_" ? "" : `${k}:`) + (v?.qty ?? "?")).join(","); };
  log(`\n6. MODEL — the next scan under the restored policy (pre-16-Oct engine; rejection cooldowns not modelled):`);
  log(`   ${plan.intents.length} requests, ${plan.intents.reduce((t, i) => t + i.qty, 0)} units`);
  const model = [];
  for (const pid of pids.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
    const line = byPid[pid] || ["nothing"];
    log(`   ${nameOf(pid).slice(0, 44).padEnd(44)} C=${q("central", pid).padEnd(6)} H2=${q("hub2", pid).padEnd(5)} PE=${q("marathon-pe", pid).padEnd(4)} T=${q("trophy", pid).padEnd(4)} → ${line.join("; ")}`);
    model.push({ pid, name: nameOf(pid), central: q("central", pid), hub2: q("hub2", pid), pe: q("marathon-pe", pid), trophy: q("trophy", pid), next: line });
  }

  const out = `paper-bag-revert-${EXECUTE ? "applied" : "dry-run"}-${STAMP}.json`;
  const summary = {
    mode: EXECUTE ? "execute" : "dry-run", at: new Date().toISOString(),
    counts: { rowsRestored, rowsDone, rowsConflict, cancels: cancels.length, cancelled: EXECUTE ? cancelled : null, leftAlone: leftAlone.length,
      policy: policyLive === null ? "absent" : "removed", rekey: before.categoryKeys.length - rekeyDone - rekeyConflict, rekeyDone, rekeyConflict, taxonomy: taxLive === null ? "absent" : taxIsOurs ? "removed" : "conflict" },
    diff, leftAlone, model: { requests: plan.intents.length, units: plan.intents.reduce((t, i) => t + i.qty, 0), rows: model },
    ...(EXECUTE ? { applied } : {}),
  };
  fs.writeFileSync(out, JSON.stringify(summary, null, 1));
  log(`\nReport: ${out}`);
  if (EXECUTE) { saveUndo(); log(`Undo file: ${UNDO_FILE}`); }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e?.message || e, e?.details ? JSON.stringify(e.details) : ""); process.exit(1); });
