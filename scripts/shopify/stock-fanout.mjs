#!/usr/bin/env node
// ── Cross-store stock fan-out (Mac mini, one process per store) ──────────────
// See stockFanoutCore.mjs for the why. Long-lived: launchd keeps it alive
// (com.marathon.stockfanout.<store>.plist, KeepAlive). Runs at ALL hours —
// website orders come in overnight too, and the reconcile tick sleeps then.
//
//   SHOPIFY_STORE=concrete node scripts/shopify/stock-fanout.mjs
//   SHOPIFY_STORE=marathon node scripts/shopify/stock-fanout.mjs
//
// With a store's credentials absent it logs "<store>: credentials missing"
// once and idles (an hour), then exits 0 so launchd re-checks. No Shopify call
// and no database write is made in that state.
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import "./env.mjs";
import { STORE, STORES, IS_MARATHON, PUBLISH_PATH, SYNC_PATH, storeNode, missingCredentials } from "./storeConfig.mjs";
import { graphql } from "./client.mjs";
import { serverNowMs } from "./publishNode.mjs";
import { syncProduct, clearMarker, locationNames, DIRTY_PATH } from "./inventorySync.mjs";
import { requireSingleLocation } from "./inventory.mjs";
import {
  PENDING_PATH, PENDING_MAX_AGE_MS, ORDER_LOOKBACK_MS, ORDER_POLL_MS,
  isLiveOn, pendingLinesFor, pendingForeignFor, makeResolver, lagLine,
} from "./stockFanoutCore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(resolve(HERE, "../.."), "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, `stock-fanout-${STORE.key}.log`);
const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });
const log = (line) => { const l = `${stamp()}  ${line}`; console.log(l); try { appendFileSync(LOG_FILE, l + "\n"); } catch { /* stdout has it */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const missing = missingCredentials(STORE);
if (missing.length) {
  log(`${STORE.key}: credentials missing (${missing.join(", ")}) — fan-out idle; add them to the repo .env on the Mac mini`);
  await sleep(60 * 60 * 1000);
  process.exit(0);
}

const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const get = async (p) => (await db.ref(p).get()).val();
const OTHERS = Object.values(STORES).filter((s) => s.key !== STORE.key);

// ── Which products are live on this store AND on another one ────────────────
let dual = new Set();
let ownLive = new Set();
async function refreshDual() {
  const liveOf = async (path) => new Set(Object.entries((await db.ref(path).orderByChild("state").equalTo("live").get()).val() || {})
    .filter(([, n]) => isLiveOn(n)).map(([p]) => p));
  ownLive = await liveOf(PUBLISH_PATH);
  const other = new Set();
  for (const s of OTHERS) for (const p of await liveOf(s.publishPath)) other.add(p);
  dual = new Set([...ownLive].filter((p) => other.has(p)));
}

let locationId = null;
let locNames = null;
async function pushOne(pid, { revision = null, reason = "stock", startedAt = Date.now(), saleAt = null } = {}) {
  locationId ||= await requireSingleLocation(graphql);
  locNames ||= await locationNames(db);
  const pending = (await get(PENDING_PATH)) || {};
  const now = await serverNowMs(db);
  const pendingForeign = await pendingForeignFor(pending, pid, STORE.key, async (id) => (await get(`online_orders/${id}/status`)) != null, now);
  const r = await syncProduct(db, graphql, pid, { commit: true, locationId, locNames, pendingForeign });
  const done = Date.now();
  log(`pushed ${pid} (${reason})${pendingForeign ? ` · minus pending ${JSON.stringify(pendingForeign)}` : ""} → ${r.ok === false ? `FAILED ${r.error || r.skipped || ""}` : (r.skipped ? `skipped: ${r.skipped}` : `${r.changed || 0} size(s) corrected`)} · ${lagLine("marker→push", pid, done - startedAt)}${saleAt ? ` · ${lagLine("sale→other-store", pid, done - saleAt)}` : ""}`);
  if (saleAt) {
    await db.ref(`shopify_fanout_stats/${STORE.key}/${done}`).set({ pid, saleToPushMs: done - saleAt, markerToPushMs: done - startedAt });
  }
  // Only THIS store's own marker is ever cleared, and only by the Concrete
  // process — Marathon's marker stays for Marathon's reconcile tick as before.
  if (!IS_MARATHON && revision != null && r.ok !== false) await clearMarker(db, pid, revision, DIRTY_PATH);
  return r;
}

// ── 1. Listen to this store's dirty node ────────────────────────────────────
const queue = new Map(); // pid → { revision, startedAt, saleAt }
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.size) {
      const [pid, job] = queue.entries().next().value;
      queue.delete(pid);
      try {
        if (IS_MARATHON) {
          if (!dual.has(pid)) continue;          // Marathon-only: the reconcile tick, unchanged
          await pushOne(pid, { reason: "dual-listed", ...job, revision: null });
        } else if (ownLive.has(pid) || isLiveOn(await get(`${PUBLISH_PATH}/${pid}`))) {
          await pushOne(pid, { reason: "concrete", ...job });
        } else if (job.revision != null) {
          await clearMarker(db, pid, job.revision, DIRTY_PATH);   // not live here — nothing to push
        }
      } catch (e) {
        log(`✗ ${pid}: ${String(e?.message || e)} — the reconcile tick retries`);
      }
    }
  } finally { draining = false; }
}
const onMarker = (snap) => {
  const prev = queue.get(snap.key);
  queue.set(snap.key, { revision: snap.val(), startedAt: prev?.startedAt ?? Date.now(), saleAt: prev?.saleAt ?? saleSeen.get(snap.key) ?? null });
  saleSeen.delete(snap.key);
  drain();
};
const saleSeen = new Map(); // pid → the other store's sale time, for the lag line

await refreshDual();
log(`${STORE.key}: fan-out started — ${ownLive.size} live here, ${dual.size} also live on ${OTHERS.map((s) => s.label).join("/")}`);
db.ref(DIRTY_PATH).on("child_added", onMarker);
db.ref(DIRTY_PATH).on("child_changed", onMarker);
// Pending sales written by the other store's process: the lag clock starts at
// the SALE, so the logged number is the true sale → other-store figure.
for (const s of OTHERS) {
  db.ref(`${PENDING_PATH}/${s.key}`).on("child_added", (snap) => {
    const entry = snap.val();
    for (const pid of Object.keys(entry?.lines || {})) saleSeen.set(pid, Number(entry.saleAt) || Date.now());
  });
}

// ── 2. Poll this store's own newest orders ──────────────────────────────────
const resolveVariant = makeResolver(get, SYNC_PATH);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
let lastDualRefresh = Date.now();
for (;;) {
  try {
    if (Date.now() - lastDualRefresh > 5 * 60 * 1000) { await refreshDual(); lastDualRefresh = Date.now(); }
    const now = await serverNowMs(db);
    if (dual.size) {
      const data = await graphql(`query ($q: String!) { orders(first: 25, sortKey: CREATED_AT, reverse: true, query: $q) {
        nodes { legacyResourceId createdAt cancelledAt lineItems(first: 100) { nodes { quantity currentQuantity variant { id product { id } } } } } } }`,
        { q: `created_at:>='${iso(now - ORDER_LOOKBACK_MS)}'` });
      for (const order of data.orders?.nodes || []) {
        const id = String(order.legacyResourceId);
        const path = `${PENDING_PATH}/${STORE.key}/${id}`;
        if ((await get(`online_orders/${id}/status`)) != null) continue;   // ingested — holds own it
        if ((await get(path)) != null) continue;                          // already announced
        const lines = await pendingLinesFor(order, { dualPids: dual, resolve: resolveVariant });
        if (!Object.keys(lines).length) continue;
        const saleAt = Date.parse(order.createdAt) || now;
        await db.ref(path).set({ at: now, saleAt, lines });
        for (const pid of Object.keys(lines)) {
          for (const s of OTHERS) await db.ref(`${storeNode("shopify_inventory_dirty", s)}/${pid}`).set(admin.database.ServerValue.increment(1));
        }
        log(`sale on ${STORE.label} order ${id} for ${Object.keys(lines).join(", ")} — ${OTHERS.map((s) => s.label).join("/")} told (${((now - saleAt) / 1000).toFixed(0)} s after the sale)`);
      }
    }
    // Housekeeping: drop pending entries the app has ingested, or that are old.
    const mine = (await get(`${PENDING_PATH}/${STORE.key}`)) || {};
    for (const [id, entry] of Object.entries(mine)) {
      if (now - (Number(entry?.at) || 0) > PENDING_MAX_AGE_MS || (await get(`online_orders/${id}/status`)) != null) {
        await db.ref(`${PENDING_PATH}/${STORE.key}/${id}`).set(null);
      }
    }
  } catch (e) {
    log(`⚠ order poll: ${String(e?.message || e)}`);
  }
  await sleep(ORDER_POLL_MS);
}
