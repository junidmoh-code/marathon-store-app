#!/usr/bin/env node
// ─── PAPER BAGS: apply the one category policy (Junid, 16 Oct 2026) ─────────
//
//   node scripts/apply-paper-bag-policy.mjs              # DRY RUN — writes nothing
//   node scripts/apply-paper-bag-policy.mjs --execute    # apply
//
// Scoped to paper bags ONLY: products the engine's own isPaperBag names (keyed
// "paper-bags", or named paper bag / paperbag and filed under Bags or
// Packaging). Idempotent — every step reads the live state first and does
// only what is still missing, so a second run reports "nothing to do".
//
//   A. Taxonomy   /settings/productTaxonomy/cats/paper-bags, if absent. One
//                 size; legacy fields byte-identical to Bags, so the POS,
//                 Display Checks and the size heuristic see no difference.
//   B. Re-key     products/{pid}/categoryKey → "paper-bags" (that field only,
//                 the same write the Assign Categories screen makes), each in a
//                 transaction that refuses if the key moved since it was read.
//   C. Policy     /config/refillEngine/categoryPolicy/paper-bags through the
//                 Engine Policy writer (history entry, one-tap revert):
//                   1. keep 50 / ask at 10 at Hub 2, Marathon PE and Trophy —
//                      the writer scopes every new leg to carried products;
//                   2. Hub 2's leg widened to EVERY paper bag (a second edit on
//                      an armed leg — the writer's documented widening path),
//                      so a new paper bag flows to Hub 2 the day it exists.
//                 The shops stay scoped: "every location that carries paper
//                 bags". No other location holds a paper bag.
//   D. Rows       Every product row on a paper bag is cleared so the category
//                 rules (Engine Policy writer, setProductTargets, one history
//                 entry per product and location). EXCEPTION, the 7 legacy
//                 Packaging bags whose only size is "L" or "3": a one-size
//                 entry speaks for "_" alone, so they keep a row AT the
//                 category numbers (50 / 25 / ask 10) where the policy would
//                 arm them (Hub 2; a shop that carries them) and none elsewhere.
//   E. Cancel     Every open ENGINE paper-bag request, through the engine's own
//                 close sequence (refill-scan.cjs): claimed? → order transaction
//                 decides → request cancelled with a cancelReason (the engine's
//                 self-withdrawal shape: no cooldown, no strike) → lock removed.
//                 A request mid-pick or partly sent is left alone and listed.
//   F. Model      The engine's computeRefillPlan on the paper bags alone, after
//                 A–E: what the next scan raises for each.
//
// Reads are scoped (per product / per path), except the catalogue, which is
// read in pages exactly as the Engine Policy writer reads it. Never a whole
// /stock or /refill_requests read.
//
// Writes a JSON report (and, on --execute, a rollback file) beside the cwd.
import { createRequire } from "module";
import fs from "fs";
import { adminRequire } from "./adminRequire.mjs";

const local = createRequire(import.meta.url);
const networkRegistry = local("../functions/lib/network-registry.cjs");
const admin = adminRequire(import.meta.url)("firebase-admin");
const engine = local("../functions/lib/refill-engine.cjs");
const writer = local("../functions/lib/category-policy-write.cjs");
const { pickInProgress } = local("../functions/lib/shop-source-rule.cjs");
const { loadNetwork } = local("../functions/lib/network-load.cjs");
const closeRequestTxn = local("../functions/refill-scan.cjs")._closeRequestTxn;

const EXECUTE = process.argv.includes("--execute");
const RUNNER = "paper-bag-policy-runner";
const KEY = engine.PAPER_BAG_KEY;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const CANCEL_REASON = "paper_bag_policy_reset";
const SHOPS = ["marathon-pe", "trophy"];
const NUMBERS = { target: 50, minQty: 25, reorderPoint: 10 };
const POLICY_SCOPED = { hub2: { ...NUMBERS }, "marathon-pe": { ...NUMBERS }, trophy: { ...NUMBERS } };
const POLICY_FINAL = { hub2: { ...NUMBERS }, "marathon-pe": { ...NUMBERS, carriedOnly: true }, trophy: { ...NUMBERS, carriedOnly: true } };

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}
const db = admin.database();
const val = (p) => db.ref(p).once("value").then((s) => s.val());
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const report = { mode: EXECUTE ? "execute" : "dry-run", at: new Date().toISOString(), steps: {} };
const rollback = { at: report.at, categoryKeys: [], policyBefore: undefined, rows: [], cancelled: [] };
const log = (...a) => console.log(...a);
// Written after every step that changed something, so a failure part-way
// still leaves the record of what had already been done.
const ROLLBACK_FILE = `paper-bag-policy-rollback-${STAMP}.json`;
const saveRollback = () => { if (EXECUTE) fs.writeFileSync(ROLLBACK_FILE, JSON.stringify(rollback, null, 1)); };
const oneSize = (p) => { const s = (p?.sizes || []).map(String); return s.length === 0 || (s.length === 1 && s[0] === "_"); };
const callWriter = (data) => writer.applyCategoryPolicy({ db, callerEmail: RUNNER, adminEmail: RUNNER, callerUid: null, data, nowMs: Date.now() });

async function main() {
  log("═".repeat(88));
  log(`PAPER BAGS — ${EXECUTE ? "EXECUTE" : "DRY RUN (nothing is written)"} — ${report.at}`);
  log("═".repeat(88));

  const [config, cats, locationsNode] = await Promise.all([val("config/refillEngine"), val("settings/productTaxonomy/cats"), val("locations")]);
  const knownLocations = Object.keys(locationsNode || {});
  const products = await writer.readMapPaged(db, "products");
  const bags = Object.keys(products).filter((pid) => engine.isPaperBag(products[pid])).sort((a, b) => (products[a].name || "").localeCompare(products[b].name || ""));
  log(`\n${bags.length} paper bags in a catalogue of ${Object.keys(products).length}.`);
  report.paperBags = bags.map((pid) => ({ pid, name: products[pid].name, categoryKey: products[pid].categoryKey ?? null, sizes: products[pid].sizes || [] }));

  // Scoped per-product reads: every stock cell, row and lock for each paper bag.
  const stockLocs = [...new Set([...knownLocations, "central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine"])];
  const network = await loadNetwork(db);
  const rowLocs = writer.rowLocationsFor(config || {}, network);
  const stock = {}, targets = {}, locks = {};
  for (const l of stockLocs) stock[l] = {};
  for (const l of rowLocs) { targets[l] = {}; locks[l] = {}; }
  await Promise.all(bags.map(async (pid) => {
    await Promise.all(stockLocs.map(async (l) => { const v = await val(`stock/${l}/${pid}`); if (v) stock[l][pid] = v; }));
    await Promise.all(rowLocs.map(async (l) => {
      const [t, k] = await Promise.all([val(`stock_targets/${l}/${pid}`), val(`refill_engine/open/${l}/${pid}`)]);
      if (t) targets[l][pid] = t;
      if (k) locks[l][pid] = k;
    }));
  }));

  // ── ROUTING GUARD — re-keying must not move a paper bag to another hub ────
  // The registry routes back stock per category (backStockFor). Paper bags
  // leave "bags" for "paper-bags"; if any store routes Bags (or Packaging)
  // somewhere other than where paper-bags would resolve, stop before writing.
  const routeDrift = [];
  for (const store of Object.keys(network?.backStock || {})) {
    const now = networkRegistry.backStockFor(network, store, KEY, null);
    for (const was of ["bags", "packaging"]) {
      const before = networkRegistry.backStockFor(network, store, was, null);
      if (before !== now) routeDrift.push({ store, from: was, before, after: now });
    }
  }
  log(`\nROUTING — ${routeDrift.length ? `CHANGES: ${JSON.stringify(routeDrift)}` : "every store's paper-bag back stock stays where Bags/Packaging resolved it"}`);
  report.steps.routing = routeDrift;
  if (routeDrift.length && EXECUTE) throw new Error("re-keying would change a store's back-stock hub — stopped before any write");

  // ── A. TAXONOMY ────────────────────────────────────────────────────────────
  const bagsCat = cats?.bags || {};
  const haveCat = isObj(cats?.[KEY]);
  const catEntry = {
    key: KEY, label: "Paper Bags", top: bagsCat.top || "clothing",
    order: Math.max(0, ...Object.values(cats || {}).map((c) => Number(c?.order) || 0)) + 1,
    sizeMode: "one", sizes: ["_"],
    legacy: { category: "Accessories", subcategory: "Bags", productType: "clothing" },
    flags: { displayChecks: "unset", oneSize: "unset", refillManaged: "unset" },
    active: true,
  };
  log(`\nA. TAXONOMY — ${haveCat ? "paper-bags already exists, nothing to do" : `create settings/productTaxonomy/cats/${KEY}`}`);
  if (!haveCat) log(`   ${JSON.stringify(catEntry)}`);
  report.steps.taxonomy = haveCat ? { noChange: true } : { create: catEntry };
  if (EXECUTE && !haveCat) {
    const r = await db.ref(`settings/productTaxonomy/cats/${KEY}`).transaction((cur) => (cur === null ? catEntry : undefined));
    if (!r.committed && !isObj(r.snapshot.val())) throw new Error("taxonomy write did not land");
    log("   ✓ written");
  }

  // ── B. RE-KEY ──────────────────────────────────────────────────────────────
  const rekey = bags.filter((pid) => products[pid].categoryKey !== KEY);
  log(`\nB. RE-KEY — ${rekey.length} of ${bags.length} to "${KEY}"`);
  for (const pid of rekey) log(`   ${pid}  ${String(products[pid].categoryKey ?? "(none)").padEnd(10)} → ${KEY}   ${products[pid].name}`);
  report.steps.rekey = rekey.map((pid) => ({ pid, name: products[pid].name, from: products[pid].categoryKey ?? null }));
  if (EXECUTE) {
    let done = 0;
    for (const pid of rekey) {
      const prev = products[pid].categoryKey ?? null;
      // Null-tolerant (#199): a cold first pass sees null; returning null there
      // probes, and a real value re-runs the callback with the truth.
      const r = await db.ref(`products/${pid}/categoryKey`).transaction((cur) => (cur === prev ? KEY : cur === null ? null : undefined));
      if (r.committed && r.snapshot.val() === KEY) { done++; rollback.categoryKeys.push({ pid, prev }); }
      else log(`   ! ${pid} not re-keyed — key is now ${JSON.stringify(r.snapshot.val())}`);
    }
    saveRollback();
    log(`   ✓ ${done} re-keyed`);
  }

  // ── C. POLICY ──────────────────────────────────────────────────────────────
  const policyBefore = config?.categoryPolicy?.[KEY] ?? null;
  rollback.policyBefore = policyBefore;
  const policyDone = writer.sameValue(policyBefore, POLICY_FINAL);
  const scopedDone = writer.sameValue(policyBefore, { hub2: { ...NUMBERS, carriedOnly: true }, "marathon-pe": { ...NUMBERS, carriedOnly: true }, trophy: { ...NUMBERS, carriedOnly: true } });
  log(`\nC. POLICY — before ${JSON.stringify(policyBefore)}`);
  log(`   after  ${JSON.stringify(POLICY_FINAL)}${policyDone ? "   (already live — nothing to do)" : ""}`);
  report.steps.policy = { before: policyBefore, after: POLICY_FINAL, noChange: policyDone };
  if (EXECUTE && !policyDone) {
    if (!scopedDone) {
      const r1 = await callWriter({ categoryKey: KEY, policy: POLICY_SCOPED, expectedBefore: policyBefore });
      log(`   ✓ 1/2 armed (scoped by the writer: ${JSON.stringify(r1.seatedOnlyLocations)}) history ${r1.historyId}`);
      report.steps.policy.history1 = r1.historyId;
    }
    const live = await val(`config/refillEngine/categoryPolicy/${KEY}`);
    const r2 = await callWriter({ categoryKey: KEY, policy: { ...live, hub2: { ...NUMBERS } }, expectedBefore: live });
    log(`   ✓ 2/2 Hub 2 widened to every paper bag — history ${r2.historyId}`);
    report.steps.policy.history2 = r2.historyId;
    const final = await val(`config/refillEngine/categoryPolicy/${KEY}`);
    if (!writer.sameValue(final, POLICY_FINAL)) throw new Error(`policy reads back as ${JSON.stringify(final)}`);
  }

  // ── D. ROWS ────────────────────────────────────────────────────────────────
  const rowPlan = [], kept = [];
  for (const pid of bags) {
    const p = products[pid];
    for (const loc of rowLocs) {
      const live = isObj(targets[loc][pid]) ? targets[loc][pid] : {};
      let desired = {};
      if (!oneSize(p)) {
        const eligible = loc === "hub2" || (SHOPS.includes(loc) && !!stock[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0);
        if (eligible) for (const s of p.sizes.map(String)) desired[engine.encodeSizeKey(s)] = { ...NUMBERS };
      }
      // AN EXPLICIT 0 IS KEPT. It is Junid's "not at this shop" — the location
      // does not carry that bag, which is exactly what the policy's own scope
      // ("every location that carries paper bags") leaves out. Clearing it would
      // re-arm the shop: on a sized legacy bag the size run takes over, on a
      // one-size bag the moment a cell appears.
      const rows = [], remove = [], expected = {};
      for (const [k, cur] of Object.entries(live)) if (isObj(cur) && cur.target === 0) kept.push({ pid, name: p.name, loc, sizeKey: k, row: cur });
      for (const [k, want] of Object.entries(desired)) {
        const cur = isObj(live[k]) ? live[k] : null;
        if (cur && cur.target === 0) continue;
        if (cur && cur.target === want.target && cur.minQty === want.minQty && cur.reorderPoint === want.reorderPoint) continue;
        rows.push({ sizeKey: k, ...want });
        expected[k] = cur;
      }
      for (const [k, cur] of Object.entries(live)) {
        if (k in desired || !isObj(cur) || cur.target === 0) continue;
        remove.push(k);
        expected[k] = cur;
      }
      if (rows.length || remove.length) rowPlan.push({ pid, name: p.name, loc, rows, remove, expected });
    }
  }
  const fmtRow = (r) => (r ? `${r.target}/${r.reorderPoint ?? "–"} (${r.source || "?"})` : "none");
  log(`\nD. PRODUCT ROWS — ${rowPlan.length} product × location edits (${rowPlan.reduce((n, e) => n + e.remove.length, 0)} rows cleared, ${rowPlan.reduce((n, e) => n + e.rows.length, 0)} set to 50/ask 10)`);
  for (const e of rowPlan) {
    for (const k of e.remove) log(`   clear ${e.loc.padEnd(11)} ${k.padEnd(2)} ${fmtRow(e.expected[k]).padEnd(32)} ${e.name}`);
    for (const r of e.rows) log(`   set   ${e.loc.padEnd(11)} ${r.sizeKey.padEnd(2)} ${fmtRow(e.expected[r.sizeKey]).padEnd(20)} → 50/10   ${e.name}`);
  }
  for (const k of kept) log(`   keep  ${k.loc.padEnd(11)} ${k.sizeKey.padEnd(2)} 0 ("not at this shop")              ${k.name}`);
  report.steps.keptSwitchOffs = kept;
  report.steps.rows = rowPlan.map(({ pid, name, loc, rows, remove, expected }) => ({ pid, name, loc, rows, remove, before: expected }));
  if (EXECUTE) {
    let ok = 0;
    for (const e of rowPlan) {
      const r = await callWriter({ action: "setProductTargets", loc: e.loc, pid: e.pid, rows: e.rows, remove: e.remove, expected: e.expected, allowRemoveForeign: true });
      if (r.ok) { ok++; rollback.rows.push({ loc: e.loc, pid: e.pid, before: e.expected, historyId: r.historyId || null }); saveRollback(); }
    }
    saveRollback();
    log(`   ✓ ${ok}/${rowPlan.length} applied, one history entry each`);
  }

  // ── E. CANCEL ──────────────────────────────────────────────────────────────
  const cancels = [], leftAlone = [];
  for (const dest of rowLocs) {
    for (const pid of Object.keys(locks[dest])) {
      for (const [sizeKey, lock] of Object.entries(locks[dest][pid] || {})) {
        if (!isObj(lock) || !lock.refillId) continue;
        const rr = await val(`refill_requests/${lock.refillId}`);
        if (!rr || rr.status !== "open") continue;
        const order = lock.orderId ? await val(`orders/${lock.orderId}`) : null;
        const orderIsOurs = !!order && order.productId === pid && engine.encodeSizeKey(order.size) === sizeKey && order.createdAt === lock.orderCreatedAt;
        const have = Math.max(0, Number(stock[dest]?.[pid]?.[sizeKey]?.qty) || 0);
        const row = {
          dest, pid, sizeKey, name: products[pid].name, refillId: lock.refillId, orderId: orderIsOurs ? lock.orderId : null,
          source: lock.source || rr.createdFrom?.source || null, qty: rr.qty, createdAt: rr.createdAt, onHand: have,
          newRule: have <= NUMBERS.reorderPoint ? `${NUMBERS.target - have} (full top-up)` : "nothing (above ask at 10)",
        };
        const why = pickInProgress(rr) ? "a picker has claimed it" : (Number(rr.sentQty) || 0) > 0 ? `partly sent (${rr.sentQty})`
          : orderIsOurs && (order.clothingRefillStatus != null || order.clothingPlanGen != null) ? "its order is being fulfilled" : null;
        if (why) leftAlone.push({ ...row, why }); else cancels.push({ ...row, lock, rr, order: orderIsOurs ? order : null });
      }
    }
  }
  // Lock-less open paper-bag requests (not raised by the engine's lock table —
  // a first batch, a hold, a manual ask): listed, never cancelled here. An
  // indexed createdAt window, not a whole-node read.
  const lockedIds = new Set(rowLocs.flatMap((l) => Object.values(locks[l]).flatMap((bySize) => Object.values(bySize || {}).map((x) => x?.refillId))).filter(Boolean));
  const since = new Date(Date.now() - 21 * 864e5).toISOString();
  const recent = (await db.ref("refill_requests").orderByChild("createdAt").startAt(since).once("value")).val() || {};
  const lockless = Object.entries(recent).filter(([id, r]) => r?.status === "open" && bags.includes(r.productId) && !lockedIds.has(id))
    .map(([id, r]) => ({ refillId: id, dest: r.requestingLocation, qty: r.qty, createdAt: r.createdAt, name: products[r.productId]?.name, engine: !!r.createdFrom?.engine }));
  for (const l of lockless) leftAlone.push({ ...l, why: "no engine lock (not an engine request) — left as it is" });
  log(`\nE. CANCEL — ${cancels.length} open engine paper-bag requests (${leftAlone.length} left alone)`);
  for (const c of cancels) log(`   ${c.refillId}  ${c.dest.padEnd(11)} ← ${String(c.source).padEnd(7)} x${String(c.qty).padEnd(3)} on hand ${String(c.onHand).padEnd(3)} new rule: ${c.newRule.padEnd(26)} ${c.name}`);
  for (const c of leftAlone) log(`   LEFT  ${c.refillId}  ${c.dest} x${c.qty} — ${c.why} — ${c.name}`);
  report.steps.cancel = { cancelled: cancels.map(({ lock, rr, order, ...c }) => c), leftAlone };
  if (EXECUTE) {
    const startedAt = new Date().toISOString();
    let done = 0;
    for (const c of cancels) {
      // The engine's close sequence (refill-scan.cjs "apply closes"), verbatim
      // in order: claimed → keep; the ORDER transaction decides; the request
      // transaction; then the lock — only if it is still this request's.
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
      if (!(res && res.committed) || res.snapshot.val()?.status !== "cancelled") { log(`   ! ${c.refillId} request did not cancel — lock kept`); continue; }
      const lockPath = `refill_engine/open/${c.dest}/${c.pid}/${c.sizeKey}`;
      const lr = await db.ref(lockPath).transaction((cur) => (cur === null ? null : cur.refillId === c.refillId ? null : undefined));
      if (!lr.committed) log(`   ! ${c.refillId} lock now belongs to another request — left`);
      rollback.cancelled.push({ refillId: c.refillId, rr: c.rr, lock: c.lock, lockPath, orderId: c.orderId, order: c.order });
      saveRollback();
      done++;
    }
    log(`   ✓ ${done}/${cancels.length} cancelled (cancelReason ${CANCEL_REASON})`);
  }

  // ── F. MODEL — what the next scan raises for each paper bag ────────────────
  const mProducts = {}; for (const pid of bags) mProducts[pid] = { ...products[pid], categoryKey: KEY };
  const mTargets = {}; for (const l of rowLocs) mTargets[l] = {};
  for (const pid of bags) for (const l of rowLocs) {
    const e = rowPlan.find((x) => x.pid === pid && x.loc === l);
    const live = { ...(targets[l][pid] || {}) };
    if (e) { for (const k of e.remove) delete live[k]; for (const r of e.rows) live[r.sizeKey] = { target: r.target, minQty: r.minQty, reorderPoint: r.reorderPoint }; }
    if (Object.keys(live).length) mTargets[l][pid] = live;
  }
  const cancelled = new Set(cancels.map((c) => c.refillId));
  const mOpen = {}, mRr = {}, mOrders = {};
  for (const l of rowLocs) for (const pid of Object.keys(locks[l])) for (const [k, lock] of Object.entries(locks[l][pid] || {})) {
    if (!isObj(lock) || cancelled.has(lock.refillId)) continue;
    const rr = lock.refillId ? await val(`refill_requests/${lock.refillId}`) : null;
    if (!rr || rr.status !== "open") continue;
    ((mOpen[l] ||= {})[pid] ||= {})[k] = lock; mRr[lock.refillId] = rr;
    if (lock.orderId) { const o = await val(`orders/${lock.orderId}`); if (o) mOrders[lock.orderId] = o; }
  }
  const mConfig = { ...(config || {}), categoryPolicy: { [KEY]: POLICY_FINAL }, policyGroups: {}, maxIntentsPerRun: 1000 };
  const plan = engine.computeRefillPlan({
    nowMs: Date.now(), config: mConfig, products: mProducts, targets: mTargets, stock,
    openIndex: mOpen, refillRequests: mRr, orders: mOrders, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {}, heldLines: {},
    network,
  });
  const byPid = {};
  for (const i of plan.intents) (byPid[i.productId] ||= []).push(`${i.dest} ← ${i.source} x${i.qty}`);
  for (const r of plan.resizes) (byPid[r.pid] ||= []).push(`${r.dest} open request ${r.from} → ${r.to}`);
  log(`\nF. MODEL — the next scan (engine's computeRefillPlan on paper bags only; rejection cooldowns not modelled):`);
  log(`   ${plan.intents.length} requests, ${plan.intents.reduce((t, i) => t + i.qty, 0)} units`);
  const q = (l, pid) => { const c = stock[l]?.[pid]; if (!c) return "–"; return Object.entries(c).map(([k, v]) => (k === "_" ? "" : `${k}:`) + (v?.qty ?? "?")).join(","); };
  report.steps.model = [];
  for (const pid of bags) {
    const line = byPid[pid] || ["nothing"];
    log(`   ${products[pid].name.slice(0, 44).padEnd(44)} C=${q("central", pid).padEnd(6)} H2=${q("hub2", pid).padEnd(5)} PE=${q("marathon-pe", pid).padEnd(4)} T=${q("trophy", pid).padEnd(4)} → ${line.join("; ")}`);
    report.steps.model.push({ pid, name: products[pid].name, central: q("central", pid), hub2: q("hub2", pid), pe: q("marathon-pe", pid), trophy: q("trophy", pid), next: line });
  }

  const out = `paper-bag-policy-${report.mode}-${STAMP}.json`;
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  log(`\nReport: ${out}`);
  if (EXECUTE) { saveRollback(); log(`Rollback: ${ROLLBACK_FILE}`); }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e?.message || e, e?.details ? JSON.stringify(e.details) : ""); process.exit(1); });
