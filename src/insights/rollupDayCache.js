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

export const ROLLUP_DB_NAME = "marathon-store.insightsRollup";
export const ROLLUP_DB_VERSION = 1;
const STORE = "days";

/** What a day was saved under: its index entry, exactly. `undefined` (a day
 *  the index does not list) is never a signature — such a day is not kept. */
export function daySignature(indexEntry) {
  if (indexEntry === undefined || indexEntry === null) return null;
  try { return JSON.stringify(indexEntry); } catch { return null; }
}

const idb = () => (typeof indexedDB !== "undefined" ? indexedDB : null);

let dbPromise = null;
function openDb() {
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
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
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
      if (!row || !want.has(row.date) || row.node === undefined || row.node === null) continue;
      const sig = daySignature(index ? index[row.date] : undefined);
      if (sig !== null && row.sig === sig) out.set(row.date, row.node);
    }
  } catch (err) {
    console.warn("insights rollup: kept days unreadable, fetching them instead —", err);
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
    if (sig === null || node === undefined || node === null) continue;
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
    return 0;
  }
}

export async function _clearKeptDaysForTests() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  } catch { /* nothing kept */ }
}
export function _closeKeptDaysDbForTests() {
  const p = dbPromise;
  dbPromise = null;
  return p ? p.then((db) => { try { db.close(); } catch { /* closed */ } }, () => {}) : Promise.resolve();
}
