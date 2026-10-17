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
//     restore    live still holds what #729 wrote        → put the before-value back
//     done       live already holds the before-value     → nothing to do
//     conflict   live holds something else (a later edit) → LEFT ALONE and listed
//
// Steps, in this order. The policy goes FIRST so that from the first write on,
// no scan can raise another request under the 16 Oct numbers (Sonnet architect
// review: with the rows first there was a window of a few minutes in which the
// hourly scan could still raise 50/ask-10 requests this run would never see).
//   1. POLICY    /config/refillEngine/categoryPolicy/paper-bags did not exist
//                before 16 Oct. Removed through the Engine Policy writer with
//                policy: null — its documented off switch — so the history
//                shows the un-arming with a one-tap revert. Only if it still
//                reads exactly what #729 wrote; an edited policy is a conflict.
//                Runs while the taxonomy entry still exists (the writer checks
//                the key against the taxonomy).
//   2. RE-KEY    products/{pid}/categoryKey → its previous key (52 "bags",
//                7 "packaging"), each in a transaction that refuses unless the
//                key still reads "paper-bags".
//   3. ROWS      /stock_targets/{loc}/{pid}/{sizeKey}: 81 product × location
//                edits. A cell #729 cleared gets its exact old row back (all
//                fields, byte for byte); a cell #729 set gets its exact old row
//                back, or is removed where there was none. One
//                /engine_policy_history entry per edit (kind "targets", the
//                shape the Engine Policy card reads), by paper-bag-revert-runner.
//   4. CANCEL    every OPEN engine paper-bag request RAISED UNDER THE NEW POLICY
//                — createdAt between 16 Oct 17:07Z (the policy was armed) and
//                the moment step 1 removed it — that nobody has picked or sent,
//                through the engine's own close sequence (refill-scan.cjs):
//                order transaction decides → request cancelled (cancelReason
//                paper_bag_policy_revert — the engine's self-withdrawal shape:
//                no cooldown, no strike) → lock removed. Claimed or partly-sent
//                requests are left alone and listed. Requests the RESTORED
//                engine raises after step 1 are outside the window and are
//                never touched, so a re-run cancels nothing new. The 30
//                requests #729 cancelled are NOT resurrected: the next scan
//                re-raises whatever the restored policy asks for.
//   5. TAXONOMY  /settings/productTaxonomy/cats/paper-bags did not exist before
//                16 Oct. Removed only if it is still byte-identical to what
//                #729 created AND no product in the catalogue is still keyed to
//                it; otherwise it is a conflict and stays.
//   6. MODEL     the restored engine's computeRefillPlan on the paper bags alone,
//                after 1–5: a CEILING for what the next scan raises for each
//                (uncapped, paper bags only, cooldowns not modelled).
//
// Reads are per product / per path. The exceptions, each the same read the
// Engine Policy writer makes: the writer's own preview pages the catalogue, and
// step 5 pages it once more to be sure nothing is still keyed paper-bags. The
// refill_requests read is an indexed createdAt window, never the node.
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
// The 16 Oct policy, exactly as #729 left it (its execute report, step C "after").
const NUMBERS = { target: 50, minQty: 25, reorderPoint: 10 };
const POLICY_729 = { hub2: { ...NUMBERS }, "marathon-pe": { ...NUMBERS, carriedOnly: true }, trophy: { ...NUMBERS, carriedOnly: true } };
// The policy was armed at 17:08:03Z on 16 Oct (history -P44fvJieYCNoZJvP7Hs); the first
// request under it could not exist before this.
const NEW_POLICY_FROM = "2026-10-16T17:07:00.000Z";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEFORE_FILE = path.join(HERE, "data", "paper-bag-policy-before-state-2026-10-16.json");
const EXECUTE_REPORT = path.join(HERE, "data", "paper-bag-policy-execute-report-2026-10-16.json");

const before = JSON.parse(fs.readFileSync(BEFORE_FILE, "utf8"));
const appliedReport = JSON.parse(fs.readFileSync(EXECUTE_REPORT, "utf8"));
const TAXONOMY_CREATED = appliedReport.steps?.taxonomy?.create;
if (!TAXONOMY_CREATED || before.policyBefore !== null) throw new Error("before-state file is not the 16 Oct rollback file");
if (!writer.sameValue(appliedReport.steps?.policy?.after, POLICY_729)) throw new Error("execute report's policy does not match POLICY_729");

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
const undo = [];       // --execute: { path, was } for every write, so this run can itself be undone by hand
const UNDO_FILE = `paper-bag-revert-undo-${STAMP}.json`;
const saveUndo = () => { if (EXECUTE) fs.writeFileSync(UNDO_FILE, JSON.stringify({ at: new Date().toISOString(), undo, applied }, null, 1)); };
const note = (step, p, current, restored, action, extra) => diff.push({ step, path: p, current: current ?? null, restored: restored ?? null, action, ...(extra || {}) });

// Write `next` at `p` only if the live value still equals `expect` (null = absent).
// Every call site read the path moments before, so `expect` is a value it saw.
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

// When did the 16 Oct policy stop applying? On the run that removes it, the
// moment of removal; on a re-run, the writer's own history entry for it
// (categoryKey paper-bags, after null). Keys after "-P44" = entries since 16 Oct.
async function policyRemovedAtMs() {
  const hist = (await db.ref(writer.HISTORY_PATH).orderByKey().startAt("-P44").once("value")).val() || {};
  const hits = Object.values(hist).filter((h) => h?.categoryKey === KEY && !h.kind && h.after === null && h.status === "applied" && typeof h.at === "number");
  return hits.length ? Math.min(...hits.map((h) => h.at)) : null;
}

async function main() {
  log("═".repeat(88));
  log(`PAPER BAGS — REVERT TO PRE-16-OCT — ${EXECUTE ? "EXECUTE" : "DRY RUN (nothing is written)"} — ${new Date().toISOString()}`);
  log("═".repeat(88));
  serverOffsetMs = Number(await val(".info/serverTimeOffset")) || 0;

  const pids = before.categoryKeys.map((c) => c.pid);
  const prevKeyOf = Object.fromEntries(before.categoryKeys.map((c) => [c.pid, c.prev]));
  const [config, locationsNode] = await Promise.all([val("config/refillEngine"), val("locations")]);
  const knownLocations = Object.keys(locationsNode || {});
  const network = await loadNetwork(db);
  // Destinations whose locks are checked: the writer's row locations PLUS every
  // location the before-state names PLUS every known location — rowLocationsFor
  // reads the config, and after step 1 the paper-bags legs are gone from it.
  const lockLocs = [...new Set([...writer.rowLocationsFor(config || {}, network), ...before.rows.map((e) => e.loc), ...knownLocations])];
  const products = {};
  await Promise.all(pids.map(async (pid) => { products[pid] = (await val(`products/${pid}`)) || {}; }));
  const nameOf = (pid) => products[pid]?.name || pid;
  log(`\n${pids.length} paper bags named by the before-state file; lock locations ${lockLocs.join(", ")}.`);

  // ── 1. POLICY ──────────────────────────────────────────────────────────────
  const policyPath = `${writer.POLICY_PATH}/${KEY}`;
  const policyLive = await val(policyPath);
  const policyIs729 = same(policyLive, POLICY_729);
  let policyRemovedAt = null;
  log(`\n1. POLICY — ${policyPath}: ${policyLive === null ? "already absent — nothing to do" : policyIs729 ? `remove ${JSON.stringify(policyLive)} (did not exist before 16 Oct)` : `CONFLICT — edited since #729 (${JSON.stringify(policyLive)}), left alone`}`);
  note("policy", policyPath, policyLive, null, policyLive === null ? "done" : policyIs729 ? "remove" : "conflict");
  if (policyLive !== null && policyIs729) {
    const r = await writer.applyCategoryPolicy({ db, callerEmail: RUNNER, adminEmail: RUNNER, callerUid: null, nowMs: serverNowMs(),
      data: { categoryKey: KEY, policy: null, expectedBefore: policyLive, dryRun: !EXECUTE } });
    if (EXECUTE) {
      const after = await val(policyPath);
      if (after !== null) throw new Error(`policy still reads ${JSON.stringify(after)}`);
      policyRemovedAt = serverNowMs();
      undo.push({ path: policyPath, was: policyLive, historyId: r.historyId }); applied.push({ path: policyPath, value: null }); saveUndo();
      log(`   ✓ un-armed through the Engine Policy writer — history ${r.historyId}`);
    } else log(`   dry run through the writer: ${r.changes.length} leg changes, modelled requests ${r.preview?.before?.totalRequests} → ${r.preview?.after?.totalRequests}`);
  }
  // Dry run with the policy still live: the removal would happen now, so the
  // window closes now. A conflict (edited policy) leaves it unknown → no cancels.
  if (policyRemovedAt === null) policyRemovedAt = !EXECUTE && policyLive !== null && policyIs729 ? serverNowMs() : await policyRemovedAtMs();

  // ── 2. RE-KEY ──────────────────────────────────────────────────────────────
  log(`\n2. RE-KEY — ${before.categoryKeys.length} products back to their previous key`);
  let rekeyed = 0, rekeyDone = 0, rekeyConflict = 0;
  const rekeyConflicts = new Set();
  for (const { pid, prev } of before.categoryKeys) {
    const p = `products/${pid}/categoryKey`;
    const cur = products[pid]?.categoryKey ?? null;
    if (cur === prev) { rekeyDone++; note("rekey", p, cur, prev, "done"); continue; }
    if (cur !== KEY) { rekeyConflict++; rekeyConflicts.add(pid); note("rekey", p, cur, prev, "conflict", { why: "key changed since #729; left alone" }); log(`   CONFLICT ${pid} is "${cur}" — ${nameOf(pid)}`); continue; }
    note("rekey", p, cur, prev, "restore");
    log(`   ${pid}  ${KEY} → ${String(prev).padEnd(10)} ${nameOf(pid)}`);
    if (EXECUTE) {
      if (await guardedWrite(p, KEY, prev)) rekeyed++; else log(`   ! ${pid} not re-keyed — moved while writing`);
    }
  }
  log(`   ${before.categoryKeys.length - rekeyDone - rekeyConflict} to restore, ${rekeyDone} already as before, ${rekeyConflict} conflicts${EXECUTE ? ` — ✓ ${rekeyed} written` : ""}`);

  // ── 3. ROWS ────────────────────────────────────────────────────────────────
  log(`\n3. ROWS — ${before.rows.length} product × location edits from #729`);
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
      const action = want === null ? "remove" : isClearedBy729 ? "restore (cell currently empty)" : "restore";
      note("rows", p, cur, want, want === null ? "remove" : "restore", isClearedBy729 ? { cellCurrentlyEmpty: true } : undefined);
      rowWrites.push({ loc: e.loc, pid: e.pid, sizeKey, path: p, cur, want });
      log(`   ${action.padEnd(30)} ${e.loc.padEnd(11)} ${sizeKey.padEnd(2)} ${want ? `${want.target}/${want.reorderPoint ?? "–"} (${want.source || "?"})` : "no row"}`.padEnd(84) + nameOf(e.pid));
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
        kind: "targets", loc, pid, productName: nameOf(pid), categoryKey: rekeyConflicts.has(pid) ? (products[pid]?.categoryKey ?? null) : prevKeyOf[pid],
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

  // ── 4. CANCEL ──────────────────────────────────────────────────────────────
  const stock = {};
  for (const l of [...new Set([...knownLocations, "central", "hub2", "marathon-pe", "trophy"])]) stock[l] = {};
  await Promise.all(pids.map(async (pid) => {
    await Promise.all(Object.keys(stock).map(async (l) => { const v = await val(`stock/${l}/${pid}`); if (v) stock[l][pid] = v; }));
  }));
  const windowTo = policyRemovedAt === null ? null : new Date(policyRemovedAt).toISOString();
  const inWindow = (rr) => typeof rr?.createdAt === "string" && rr.createdAt >= NEW_POLICY_FROM && windowTo !== null && rr.createdAt <= windowTo;
  const cancels = [], leftAlone = [];
  const lockedIds = new Set();
  for (const dest of lockLocs) {
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
        const why = !inWindow(rr) ? (windowTo === null ? "the policy's removal time is unknown — nothing is cancelled" : `raised outside the new-policy window (${rr.createdAt})`)
          : pickInProgress(rr) ? "a picker has claimed it" : (Number(rr.sentQty) || 0) > 0 ? `partly sent (${rr.sentQty})`
          : orderIsOurs && (order.clothingRefillStatus != null || order.clothingPlanGen != null) ? "its order is being fulfilled" : null;
        if (why) leftAlone.push({ ...row, why }); else cancels.push({ ...row, lock, rr, order: orderIsOurs ? order : null });
      }
    }
  }
  const recent = (await db.ref("refill_requests").orderByChild("createdAt").startAt(NEW_POLICY_FROM).once("value")).val() || {};
  for (const [id, r] of Object.entries(recent)) {
    if (r?.status === "open" && pids.includes(r.productId) && !lockedIds.has(id)) {
      leftAlone.push({ refillId: id, dest: r.requestingLocation, qty: r.qty, createdAt: r.createdAt, name: nameOf(r.productId), why: "no engine lock (not an engine request) — left as it is" });
    }
  }
  log(`\n4. CANCEL — window ${NEW_POLICY_FROM} → ${windowTo || "UNKNOWN"}: ${cancels.length} open engine paper-bag requests raised under the new policy (${leftAlone.length} left alone)`);
  for (const c of cancels) { log(`   ${c.refillId}  ${c.dest.padEnd(11)} ← ${String(c.source).padEnd(7)} x${String(c.qty).padEnd(3)} on hand ${String(c.onHand).padEnd(3)} ${c.createdAt.slice(0, 16)} ${c.name}`); note("cancel", `refill_requests/${c.refillId}`, { status: "open", qty: c.qty, dest: c.dest, source: c.source, createdAt: c.createdAt }, { status: "cancelled", cancelReason: CANCEL_REASON }, "cancel", { orderId: c.orderId, lockPath: `refill_engine/open/${c.dest}/${c.pid}/${c.sizeKey}` }); }
  for (const c of leftAlone) { log(`   LEFT  ${c.refillId}  ${c.dest} x${c.qty} — ${c.why} — ${c.name}`); note("cancel", `refill_requests/${c.refillId}`, { status: "open", qty: c.qty, createdAt: c.createdAt }, null, "left", { why: c.why }); }
  const cancelledIds = new Set();
  if (EXECUTE) {
    const startedAt = new Date(serverNowMs()).toISOString();
    for (const c of cancels) {
      // The engine's close sequence (refill-scan.cjs "apply closes"), in order:
      // claimed or touched → keep; the ORDER transaction decides; the request
      // transaction (requireUntouched: a send that landed since the listing
      // wins); then the lock — only if it is still this request's.
      const fresh = await val(`refill_requests/${c.refillId}`);
      if (!fresh || fresh.status !== "open" || pickInProgress(fresh) || (Number(fresh.sentQty) || 0) > 0) { log(`   ! ${c.refillId} changed — skipped`); continue; }
      if (c.orderId) {
        const res = await db.ref(`orders/${c.orderId}`).transaction((cur) => {
          if (!cur) return null;
          if (cur.clothingRefillStatus != null || cur.clothingPlanGen != null || !cur.autoRefill) return;
          return null;
        });
        if (!res.committed) { log(`   ! ${c.refillId} order ${c.orderId} touched — skipped`); continue; }
      }
      const close = { dest: c.dest, pid: c.pid, sizeKey: c.sizeKey, refillId: c.refillId, reason: CANCEL_REASON, cancelReason: CANCEL_REASON, rrStatus: "cancelled", requireUntouched: true };
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
      cancelledIds.add(c.refillId);
    }
    log(`   ✓ ${cancelledIds.size}/${cancels.length} cancelled (cancelReason ${CANCEL_REASON})`);
  } else for (const c of cancels) cancelledIds.add(c.refillId);

  // ── 5. TAXONOMY ────────────────────────────────────────────────────────────
  const taxPath = `settings/productTaxonomy/cats/${KEY}`;
  const taxLive = await val(taxPath);
  const taxIsOurs = same(taxLive, TAXONOMY_CREATED);
  // Anything in the WHOLE catalogue still keyed paper-bags (a bag added or
  // re-keyed since 16 Oct would be invisible to the 59-product list). The same
  // paged read the Engine Policy writer makes; once.
  let stillKeyed = [];
  if (taxLive !== null) {
    const catalogue = await writer.readMapPaged(db, "products");
    // On a dry run the 59 are still keyed paper-bags because step 2 wrote nothing; those about to be re-keyed do not count.
    const aboutToBeRekeyed = (pid) => !EXECUTE && pids.includes(pid) && !rekeyConflicts.has(pid);
    stillKeyed = Object.entries(catalogue).filter(([pid, p]) => p?.categoryKey === KEY && !aboutToBeRekeyed(pid)).map(([pid, p]) => ({ pid, name: p?.name }));
  }
  const taxAction = taxLive === null ? "done" : !taxIsOurs ? "conflict" : stillKeyed.length ? "conflict" : "remove";
  log(`\n5. TAXONOMY — ${taxPath}: ${taxLive === null ? "already absent" : taxAction === "remove" ? "remove (byte-identical to what #729 created; nothing keyed to it)" : !taxIsOurs ? "CONFLICT — edited since #729, left alone" : `CONFLICT — ${stillKeyed.length} products still keyed ${KEY}, left alone: ${stillKeyed.map((x) => `${x.pid} ${x.name}`).join("; ")}`}`);
  note("taxonomy", taxPath, taxLive, null, taxAction, stillKeyed.length ? { stillKeyed } : undefined);
  if (EXECUTE && taxAction === "remove") {
    if (await guardedWrite(taxPath, taxLive, null)) log("   ✓ removed"); else log("   ! moved while writing — left");
  }

  // ── 6. MODEL — a ceiling for what the next scan raises for each paper bag ──
  const mProducts = {}, mTargets = {}, mOpen = {}, mRr = {}, mOrders = {};
  for (const pid of pids) mProducts[pid] = { ...products[pid], categoryKey: rekeyConflicts.has(pid) ? products[pid].categoryKey : prevKeyOf[pid] };
  for (const l of lockLocs) mTargets[l] = {};
  for (const pid of pids) for (const l of lockLocs) {
    const live = { ...((await val(`stock_targets/${l}/${pid}`)) || {}) };
    if (!EXECUTE) for (const w of rowWrites) if (w.loc === l && w.pid === pid) { if (w.want) live[w.sizeKey] = w.want; else delete live[w.sizeKey]; }
    if (Object.keys(live).length) mTargets[l][pid] = live;
  }
  for (const l of lockLocs) for (const pid of pids) {
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
  log(`\n6. MODEL — CEILING for the next scan under the restored policy (pre-16-Oct engine; paper bags alone, per-run cap lifted, rejection cooldowns not modelled):`);
  log(`   ${plan.intents.length} requests, ${plan.intents.reduce((t, i) => t + i.qty, 0)} units`);
  const model = [];
  for (const pid of [...pids].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
    const line = byPid[pid] || ["nothing"];
    log(`   ${nameOf(pid).slice(0, 44).padEnd(44)} C=${q("central", pid).padEnd(6)} H2=${q("hub2", pid).padEnd(5)} PE=${q("marathon-pe", pid).padEnd(4)} T=${q("trophy", pid).padEnd(4)} → ${line.join("; ")}`);
    model.push({ pid, name: nameOf(pid), central: q("central", pid), hub2: q("hub2", pid), pe: q("marathon-pe", pid), trophy: q("trophy", pid), next: line });
  }

  const out = `paper-bag-revert-${EXECUTE ? "applied" : "dry-run"}-${STAMP}.json`;
  const summary = {
    mode: EXECUTE ? "execute" : "dry-run", at: new Date().toISOString(), cancelWindow: { from: NEW_POLICY_FROM, to: windowTo },
    counts: { policy: policyLive === null ? "absent" : policyIs729 ? "removed" : "conflict", rekey: before.categoryKeys.length - rekeyDone - rekeyConflict, rekeyDone, rekeyConflict,
      rowsRestored, rowsDone, rowsConflict, cancels: cancels.length, cancelled: EXECUTE ? cancelledIds.size : null, leftAlone: leftAlone.length, taxonomy: taxAction },
    diff, leftAlone, model: { ceiling: true, requests: plan.intents.length, units: plan.intents.reduce((t, i) => t + i.qty, 0), rows: model },
    ...(EXECUTE ? { applied } : {}),
  };
  fs.writeFileSync(out, JSON.stringify(summary, null, 1));
  log(`\nReport: ${out}`);
  if (EXECUTE) { saveUndo(); log(`Undo file: ${UNDO_FILE}`); }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e?.message || e, e?.details ? JSON.stringify(e.details) : ""); process.exit(1); });
