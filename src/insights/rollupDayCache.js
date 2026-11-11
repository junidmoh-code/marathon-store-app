// ─── FINISHED ROLLUP DAYS, KEPT ON THE DEVICE ────────────────────────────────
//
// rollupStore.js caches day nodes for the SESSION, on the grounds that a
// finished day never changes. That is true across a reload as well — and the
// session cache dies with the page. Measured from the profiler, 11 Nov 2026:
// one phone on the all-time Insights view reloaded five times in seventy-five
// minutes and downloaded the same 22 MB of finished days each time (108 MB in
// three hours, one device).
//
// So the same nodes are also kept in IndexedDB, and a later page load reads
// the finished days from there and only the last couple from the network.
//
// ── WHEN A KEPT DAY IS USED ─────────────────────────────────────────────────
//
// Only when the day's entry in the rollup's own index (/meta/built/{date},
// which every window read fetches first, a few KB) is byte-for-byte the entry
// it was saved under. The sweep rewrites that entry whenever it rebuilds the
// day, and a rebuild that found a late row changes its counts — so a rebuilt
// day stops matching and is fetched again. That is a STRICTER test than the
// session cache applies.
//
// The volatile days (today and the two before it) are never kept and never
// served from here; rollupStore decides that, exactly as before.
//
// ── IT CAN ONLY EVER SAVE A READ ────────────────────────────────────────────
//
// Every failure — no IndexedDB, private browsing, a full disk, a blocked open —
// is swallowed and answers "nothing kept". The caller then fetches the day,
// which is what it did before this file existed. A device that may not read
// the rollup gets nothing from here either: with the index unreadable the plan
// holds no days to ask for.

import { ROLLUP_SHAPE } from "./rollupCodec";
import { onIdentityChange } from "../utils/identityChange";

/** Bump to throw away every day kept by an earlier build — for a change in
 *  what is kept or how it is validated that the index entry cannot show. */
export const KEEP_EPOCH = 1;

export const ROLLUP_DB_NAME = "marathon-store.insightsRollup";
export const ROLLUP_DB_VERSION = 1;
const STORE = "days";

/** What a day was saved under: this build's keep epoch, the node shape this
 *  build reads, and the day's index entry, exactly. `undefined` (a day the
 *  index does not list) is never a signature — such a day is not kept. */
export function daySignature(indexEntry) {
  if (indexEntry === undefined || indexEntry === null) return null;
  try { return `${KEEP_EPOCH}|${ROLLUP_SHAPE}|${JSON.stringify(indexEntry)}`; } catch { return null; }
}

/** A node this build can read: the current shape version, nothing else. A
 *  node of another shape would not expand, and a day that will not expand is
 *  read live — keeping it would only make that permanent. */
export const isCurrentShape = (node) => !!node && typeof node === "object" && node.v === ROLLUP_SHAPE;

const idb = () => (typeof indexedDB !== "undefined" ? indexedDB : null);

let dbPromise = null;
// A handle that failed mid-use (closed by the browser, a transaction aborted)
// is not reused: the next call opens a new one, with no reload needed.
function forgetDb() {
  const p = dbPromise;
  dbPromise = null;
  if (p) p.then((db) => { try { db.close(); } catch { /* closed */ } }, () => {});
}
let identityWired = false;
function openDb() {
  if (!identityWired) {
    identityWired = true;
    // What one signed-in person's Insights fetched is not left on the device
    // for the next (rollupStore clears its session copy the same way).
    try { onIdentityChange(() => { clearKeptDays(); }); } catch { /* no auth */ }
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const factory = idb();
    if (!factory) { reject(new Error("no indexedDB")); return; }
    const req = factory.open(ROLLUP_DB_NAME, ROLLUP_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "date" });
    };
    req.onsuccess = () => {
      const db = req.result;
      // A connection the browser closed (a frozen page) must not be reused.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch { /* closing */ } dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
  const mine = dbPromise;
  mine.catch(() => { if (dbPromise === mine) dbPromise = null; });
  return mine;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error("indexedDB transaction failed"));
  tx.onabort = () => reject(tx.error || new Error("indexedDB transaction aborted"));
});

/**
 * The kept nodes for `dates` whose saved signature still matches `index`.
 * @returns {Promise<Map<string, object>>} date -> compact day node
 */
export async function loadKeptDays(dates, index) {
  const out = new Map();
  if (!dates || dates.length === 0) return out;
  try {
    const db = await openDb();
    const sorted = dates.slice().sort();
    const want = new Set(sorted);
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll(IDBKeyRange.bound(sorted[0], sorted[sorted.length - 1]));
    const rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    for (const row of rows) {
      if (!row || !want.has(row.date) || !isCurrentShape(row.node)) continue;
      const sig = daySignature(index ? index[row.date] : undefined);
      if (sig !== null && row.sig === sig) out.set(row.date, row.node);
    }
  } catch (err) {
    console.warn("insights rollup: kept days unreadable, fetching them instead —", err);
    forgetDb();
    return new Map();
  }
  return out;
}

/**
 * Keep these day nodes. `entries` is [date, node] pairs; a day the index does
 * not list is skipped (nothing to validate it against later). Days older than
 * `pruneBefore` are dropped in the same transaction so the store cannot grow
 * without bound.
 */
export async function keepDays(entries, index, { pruneBefore = null } = {}) {
  const rows = [];
  for (const [date, node] of entries || []) {
    const sig = daySignature(index ? index[date] : undefined);
    if (sig === null || !isCurrentShape(node)) continue;
    rows.push({ date, sig, node });
  }
  if (rows.length === 0 && !pruneBefore) return 0;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const row of rows) store.put(row);
    if (pruneBefore) store.delete(IDBKeyRange.upperBound(pruneBefore, true));
    await done(tx);
    return rows.length;
  } catch (err) {
    console.warn("insights rollup: could not keep day nodes on this device —", err);
    forgetDb();
    return 0;
  }
}

/** Stop serving these days from the device (a kept node that would not expand). */
export async function forgetDays(dates) {
  if (!dates || dates.length === 0) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    for (const d of dates) tx.objectStore(STORE).delete(d);
    await done(tx);
  } catch (err) {
    console.warn("insights rollup: could not drop kept days —", err);
    forgetDb();
  }
}

/** Drop every kept day (the signed-in identity changed). */
export async function clearKeptDays() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  } catch { forgetDb(); }
}
export const _clearKeptDaysForTests = clearKeptDays;
export function _closeKeptDaysDbForTests() {
  const p = dbPromise;
  dbPromise = null;
  return p ? p.then((db) => { try { db.close(); } catch { /* closed */ } }, () => {}) : Promise.resolve();
}
