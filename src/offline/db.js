// ─── OFFLINE MIRROR — IndexedDB schema + access layer ────────────────────────
//
// A local copy of the RTDB nodes this app reads WHOLE (docs/store-offline-mirror.md
// §3). Ported from marathon-pos-app/src/offline/db.js, which has been live on
// the tills since 2026-09; the transaction discipline, the page-commit contract
// and the schema gate below are its, and the comments explaining WHY are kept
// because every one of them is a live incident someone paid for.
//
// What differs from the POS copy:
//   - the object stores come from the node registry (nodes.js), not a literal,
//   - `sales` is gone and `movements` carries the ts index instead,
//   - a `docs` store holds the small whole-node documents.
//
// This is a READ mirror. Nothing a person typed lives here — outgoing writes
// live in the outbox (outboxDb.js), a separate database — so purging this is
// always safe and never loses work.
//
// Why IndexedDB and not localStorage: a localStorage read-modify-write loses a
// write when two tabs race, and a shop tablet has the app open in more than one
// tab more often than anyone admits. IndexedDB readwrite transactions serialize
// across every tab in the profile.
//
// Versioning:
//   - The IDB structural version is FIXED at 1. Bumping it fires versionchange
//     and is blocked by any other open tab; we never do.
//   - MIRROR_SCHEMA_VERSION is the hand-maintained record-shape version, baked
//     into the bundle and compared against meta on open. A mismatch purges the
//     data stores and drops every cursor (full re-setup). Bump it ONLY on an
//     incompatible local shape change.
//   - __BUILD_VERSION__ is recorded as provenance only. It embeds Date.now()
//     per rebuild, so keying a purge to it would re-download the mirror on
//     every deploy — which is the $400/month failure, not the fix for it.

import { MIRROR_STORES, STORE_INDEXES } from "./nodes";
import { SNAPSHOT_META_PREFIXES } from "./health";

export const MIRROR_DB_NAME = "marathon-store-mirror";
export const MIRROR_SCHEMA_VERSION = 1;

export const DATA_STORES = Object.freeze([...MIRROR_STORES]);

// Meta keys the schema purge drops along with the rows they describe. A purge
// that left a health record standing would leave a leg vouching for an object
// store it had just emptied — the exact failure health.js exists to close.
const PURGED_META_PREFIXES = Object.freeze([
  "cursor.", "lastSyncAt.", ...SNAPSHOT_META_PREFIXES,
]);
const ALL_STORES = Object.freeze([...DATA_STORES, "meta"]);

const asError = (target, fallback) =>
  (target && target.error) || new Error(fallback);

export function isQuotaError(err) {
  return !!err && (err.name === "QuotaExceededError" ||
    (typeof err.message === "string" && err.message.includes("QuotaExceeded")));
}

// Open (creating on first run) and return a handle. `indexedDBFactory` is
// injected so tests run against fake-indexeddb; production passes nothing.
export function openMirrorDb({
  indexedDBFactory = globalThis.indexedDB,
  dbName = MIRROR_DB_NAME,
} = {}) {
  const open = () => openConnection(indexedDBFactory, dbName);
  return open().then((conn) => wrap(conn, open));
}

function openConnection(indexedDBFactory, dbName) {
  return new Promise((resolve, reject) => {
    if (!indexedDBFactory) { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDBFactory.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ALL_STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name);
          for (const ix of STORE_INDEXES[name] ?? []) {
            store.createIndex(ix.name, ix.keyPath);
          }
        }
      }
    };
    req.onerror = () => reject(asError(req, "mirror db open failed"));
    req.onsuccess = () => resolve(req.result);
  });
}

// ─── A CONNECTION THE BROWSER CLOSED IS REOPENED, NOT MOURNED ────────────────
//
// A phone that freezes a backgrounded page — iOS Safari especially, Chrome on
// Android too — may close the page's IndexedDB connection underneath it. The
// rows are all still on disk; only the handle is dead, and every
// `db.transaction()` on it throws InvalidStateError for the rest of the
// session.
//
// Measured 22 Sep 2026 (cost watch, Mike's iPhone and his shop Android): on
// every wake, every mirrored screen fell back to a WHOLE-NODE live read —
// /products, /orders, /stock, /returns_log, ~15 MB — for the 20–26 seconds
// until the next pass succeeded. The mirror was complete the whole time; the
// device just could not open a transaction on it.
//
// So a transaction that cannot be opened, or a connection the browser has
// announced it closed, gets ONE fresh connection and one retry. Never more: a
// device whose IndexedDB is genuinely gone must fail loudly, so the callers
// fall back to live reads rather than wait on a store that will never answer.
class TxnOpenFailed extends Error {
  constructor(cause) { super("mirror db transaction could not open"); this.cause = cause; }
}
const isClosedConnectionError = (err) =>
  err?.name === "InvalidStateError" || /closing|closed|connection.*lost/i.test(String(err?.message ?? ""));

function wrap(initial, reopen = null) {
  let db = initial;
  let closed = false;
  let reopening = null;
  const watch = (conn) => {
    // The browser tells us, when it can. A tab that is upgrading the schema
    // elsewhere asks us to close; we do, and reopen on the next transaction.
    try {
      conn.onclose = () => { if (conn === db) closed = true; };
      conn.onversionchange = () => { try { conn.close(); } catch { /* ignore */ } if (conn === db) closed = true; };
    } catch { /* a fake without these properties */ }
  };
  watch(db);
  async function freshConnection() {
    if (!reopen) throw new Error("mirror db connection closed");
    if (!reopening) {
      reopening = reopen().then((conn) => { db = conn; closed = false; watch(conn); return conn; })
        .finally(() => { reopening = null; });
    }
    return reopening;
  }

  // Every method funnels through txn() so a failure anywhere in a batch aborts
  // the WHOLE transaction — that atomicity is what "interrupted mid-write
  // leaves the store consistent" rests on.
  async function txn(storeNames, mode, body) {
    if (closed && reopen) await freshConnection();
    try {
      return await txnOn(db, storeNames, mode, body, { retryable: !!reopen });
    } catch (err) {
      if (!(err instanceof TxnOpenFailed)) throw err;
      await freshConnection();
      return txnOn(db, storeNames, mode, body, { retryable: false });
    }
  }
  function txnOn(conn, storeNames, mode, body, { retryable }) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = conn.transaction(storeNames, mode); }
      catch (err) {
        // Only a failure to OPEN the transaction is retried: nothing has run,
        // so running the body again cannot apply anything twice.
        if (retryable && isClosedConnectionError(err)) reject(new TxnOpenFailed(err));
        else reject(err);
        return;
      }
      const stores = {};
      for (const n of Array.isArray(storeNames) ? storeNames : [storeNames]) {
        stores[n] = tx.objectStore(n);
      }
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(asError(tx, "mirror txn aborted"));
      tx.onerror = () => {}; // surfaced via onabort
      try {
        const out = body(stores, tx);
        if (out && typeof out.then === "function") {
          out.then((v) => { result = v; }, (err) => { try { tx.abort(); } catch { /* already done */ } reject(err); });
        } else {
          result = out;
        }
      } catch (err) {
        try { tx.abort(); } catch { /* already done */ }
        reject(err);
      }
    });
  }

  const reqValue = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(asError(req, "request failed"));
  });

  // Everything under `node + "/"`. U+FFFF is the largest code unit, so it
  // sorts after every child key and before any sibling node whose name merely
  // begins with this one.
  const childKeyRange = (node) => IDBKeyRange.bound(`${node}/`, `${node}/\uffff`);

  // The two ranges one node owns in the shared `docs` store: its own key, and
  // its children. See replacePrefixed.
  const countNode = async (store, node) => {
    const own = await reqValue(store.count(node));
    const kids = await reqValue(store.count(childKeyRange(node)));
    return own + kids;
  };

  const handle = {
    // ── meta ──
    getMeta(key) {
      return txn("meta", "readonly", (s) => reqValue(s.meta.get(key)));
    },
    setMeta(key, value) {
      return txn("meta", "readwrite", (s) => { s.meta.put(value, key); });
    },
    // Atomic read-modify-write on one meta key: the read and the write share a
    // single readwrite transaction, so two tabs mutating the same key serialize
    // instead of clobbering.
    updateMeta(key, fn) {
      return txn("meta", "readwrite", (s) => new Promise((res, rej) => {
        const readReq = s.meta.get(key);
        readReq.onsuccess = () => {
          try {
            const next = fn(readReq.result);
            s.meta.put(next, key);
            res(next);
          } catch (err) { rej(err); }
        };
        readReq.onerror = () => rej(asError(readReq, "updateMeta read failed"));
      }));
    },
    // `deleteKeys` ride the SAME transaction as the puts. A leg that swaps its
    // staged download in has to drop the staging keys in the very act of
    // adopting them: two transactions would leave a window where the rows are
    // live AND the staging that produced them is still on disk, and a resume in
    // that window would re-adopt a download that had already landed.
    setMetaMany(entries, { deleteKeys = [] } = {}) {
      return txn("meta", "readwrite", (s) => {
        for (const [k, v] of Object.entries(entries)) s.meta.put(v, k);
        for (const k of deleteKeys) s.meta.delete(k);
      });
    },
    deleteMetaMany(keys) {
      return txn("meta", "readwrite", (s) => {
        for (const k of keys) s.meta.delete(k);
      });
    },

    // ── generic reads ──
    get(storeName, key) {
      return txn(storeName, "readonly", (s) => reqValue(s[storeName].get(key)));
    },
    count(storeName) {
      return txn(storeName, "readonly", (s) => reqValue(s[storeName].count()));
    },
    getAllKeys(storeName) {
      return txn(storeName, "readonly", (s) => reqValue(s[storeName].getAllKeys()));
    },
    getAll(storeName) {
      return txn(storeName, "readonly", (s) => reqValue(s[storeName].getAll()));
    },
    // getAll() alone loses the out-of-line key (these stores have no keyPath,
    // same as the raw RTDB record). A reader that has to rebuild the node's
    // SHAPE — /stock as { loc: { pid: … } }, /restock_log as { date: … } —
    // needs the key, not just the value. One cursor pass, one transaction, so a
    // concurrent replaceAll() from another tab cannot straddle two separate
    // getAllKeys()/getAll() calls and pair the wrong key with the wrong value.
    getAllEntries(storeName) {
      return txn(storeName, "readonly", (s) => new Promise((res, rej) => {
        const out = [];
        const req = s[storeName].openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) { res(out); return; }
          out.push({ key: c.key, value: c.value });
          c.continue();
        };
        req.onerror = () => rej(asError(req, "getAllEntries cursor failed"));
      }));
    },
    // Entries whose KEY falls in [lower, upper]. The insights leg's local
    // window uses it: push keys sort as time, so a key range is a time range,
    // exactly as it is on the server (insightsLogRange.js).
    getEntriesInKeyRange(storeName, lower, upper) {
      return txn(storeName, "readonly", (s) => new Promise((res, rej) => {
        let range = null;
        try {
          if (lower != null && upper != null) range = IDBKeyRange.bound(lower, upper);
          else if (lower != null) range = IDBKeyRange.lowerBound(lower);
          else if (upper != null) range = IDBKeyRange.upperBound(upper);
        } catch (err) { rej(err); return; }
        const out = [];
        const req = s[storeName].openCursor(range);
        req.onsuccess = () => {
          const c = req.result;
          if (!c) { res(out); return; }
          out.push({ key: c.key, value: c.value });
          c.continue();
        };
        req.onerror = () => rej(asError(req, "key range cursor failed"));
      }));
    },
    // Entries whose INDEXED field falls in [lower, upper]. The movements leg's
    // 90-day window uses it against the `ts` index; without the index that read
    // walks all 90,922 rows on every mount, which is the cost this mirror
    // exists to remove, moved from the network onto the device.
    getEntriesInIndexRange(storeName, indexName, lower, upper) {
      return txn(storeName, "readonly", (s) => new Promise((res, rej) => {
        let range = null;
        try {
          if (lower != null && upper != null) range = IDBKeyRange.bound(lower, upper);
          else if (lower != null) range = IDBKeyRange.lowerBound(lower);
          else if (upper != null) range = IDBKeyRange.upperBound(upper);
        } catch (err) { rej(err); return; }
        const out = [];
        const req = s[storeName].index(indexName).openCursor(range);
        req.onsuccess = () => {
          const c = req.result;
          if (!c) { res(out); return; }
          out.push({ key: c.primaryKey, value: c.value });
          c.continue();
        };
        req.onerror = () => rej(asError(req, "index range cursor failed"));
      }));
    },

    // ── page commit: records + cursor advance in ONE transaction ──
    // The cursor only moves if every record in the page landed, so an
    // interrupted sync resumes from the last COMMITTED page and re-fetches
    // anything uncommitted — upserts make the overlap idempotent. The cursor
    // write is monotonic (compared inside the same txn), so two tabs syncing
    // concurrently can only advance it, never rewind it.
    //
    // `metaEntries` ride the cursor's OWN monotonic guard, not merely the same
    // transaction. Writing them unconditionally would let the slower of two
    // racing tabs rewind a progress marker below the cursor that actually
    // stands, and a marker that disagrees with its cursor is worse than none.
    putPage(storeName, records, { cursorKey, cursorValue, isAfter, metaEntries, deleteKeys = [] } = {}) {
      return txn([storeName, "meta"], "readwrite", (s) => {
        for (const { key, value } of records) s[storeName].put(value, key);
        // A change feed carries DELETES as well as writes — a product removed
        // upstream must go locally, or the mirror answers from a record RTDB
        // no longer has. They ride the same transaction as the cursor for the
        // same reason the puts do.
        for (const k of deleteKeys) s[storeName].delete(k);
        const putMeta = () => {
          if (!metaEntries) return;
          for (const [k, v] of Object.entries(metaEntries)) s.meta.put(v, k);
        };
        if (cursorKey === undefined) { putMeta(); return; }
        const readReq = s.meta.get(cursorKey);
        readReq.onsuccess = () => {
          const existing = readReq.result;
          const ahead = existing === undefined ||
            (isAfter ? isAfter(cursorValue, existing) : cursorValue > existing);
          if (!ahead) return;
          s.meta.put(cursorValue, cursorKey);
          putMeta();
        };
      });
    },

    // ── atomic snapshot swap (the setup download) ──
    // Clear + repopulate + stamp meta in one transaction: a crash mid-swap
    // leaves the PREVIOUS complete snapshot, never an empty or half store.
    // Returns how many rows the store HOLDS once the swap has landed, counted
    // inside the same transaction — so "the record says 4,945" and "the store
    // holds 4,945" are two independently established facts, not one restated.
    replaceAll(storeName, records, metaEntries = {}, { deleteMetaKeys = [] } = {}) {
      return txn([storeName, "meta"], "readwrite", (s) => {
        s[storeName].clear();
        for (const { key, value } of records) s[storeName].put(value, key);
        for (const [k, v] of Object.entries(metaEntries)) s.meta.put(v, k);
        for (const k of deleteMetaKeys) s.meta.delete(k);
        return reqValue(s[storeName].count());
      });
    },

    // The `docs` store holds several legs at once, so one leg's snapshot swap
    // must clear ITS keys and no one else's — a clear() there would drop the
    // taxonomy every time the locations registry re-synced.
    //
    // A NODE IS NOT A STRING PREFIX. `settings/stockHold` is a string prefix of
    // `settings/stockHoldExtra`, so a naive bound(node, node + "\uffff") clears
    // a DIFFERENT leg's rows every time this one re-syncs — and silently, since
    // that leg's health record would go on vouching for rows deleted underneath
    // it. A node owns exactly two kinds of key: itself (a depth-0 document) and
    // its children, which all begin `node + "/"`. So it is two ranges, never a
    // prefix.
    replacePrefixed(storeName, node, records, metaEntries = {}, { deleteMetaKeys = [] } = {}) {
      return txn([storeName, "meta"], "readwrite", (s) => new Promise((res, rej) => {
        let childRange;
        try { childRange = childKeyRange(node); }
        catch (err) { rej(err); return; }
        const store = s[storeName];
        store.delete(node);
        const cur = store.openCursor(childRange);
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { c.delete(); c.continue(); return; }
          for (const { key, value } of records) store.put(value, key);
          for (const [k, v] of Object.entries(metaEntries)) s.meta.put(v, k);
          for (const k of deleteMetaKeys) s.meta.delete(k);
          countNode(store, node).then(res, rej);
        };
        cur.onerror = () => rej(asError(cur, "node clear cursor failed"));
      }));
    },

    // How many rows a node holds in the shared `docs` store — its answer to
    // count(). Same two ranges, for the same reason.
    countPrefixed(storeName, node) {
      return txn(storeName, "readonly", (s) => countNode(s[storeName], node));
    },

    // ── schema gate ──
    // Compare the baked-in shape version against meta; on mismatch purge every
    // DATA store and drop every cursor/lastSync meta key in the SAME
    // transaction, then stamp the new version. Fixed IDB version ⇒ no
    // versionchange ⇒ never blocked by another open tab.
    async ensureSchema({ buildVersion = null, schemaVersion = MIRROR_SCHEMA_VERSION } = {}) {
      const stored = await handle.getMeta("schemaVersion");
      if (stored === schemaVersion) {
        if (buildVersion) await handle.setMeta("lastWrittenByBuild", buildVersion);
        return { purged: false };
      }
      await txn([...ALL_STORES], "readwrite", (s) => {
        for (const name of DATA_STORES) s[name].clear();
        const metaReq = s.meta.getAllKeys();
        metaReq.onsuccess = () => {
          for (const k of metaReq.result) {
            if (PURGED_META_PREFIXES.some((p) => String(k).startsWith(p))) {
              s.meta.delete(k);
            }
          }
          s.meta.put(schemaVersion, "schemaVersion");
          if (buildVersion) s.meta.put(buildVersion, "lastWrittenByBuild");
        };
      });
      return { purged: stored !== undefined };
    },

    // ── the DELIBERATE delete ────────────────────────────────────────────
    //
    // "Stop using the local copy" and "delete the local copy" are two different
    // decisions. Stopping keeps the download, so turning it back on resumes
    // from disk plus a catch-up rather than pulling 104 MB over a shop line.
    // Deleting is for a device being handed on, or a copy that is genuinely
    // wrong, and it is the only thing that clears data.
    //
    // Everything a snapshot describes goes with it: the rows, the cursors, the
    // health records, the staging. A health record that outlived its rows would
    // vouch for an empty store. The photo BLOBS live in Cache Storage and are
    // dropped by the caller (photoCache.clearPhotoCache) — this handle never
    // opens that API.
    async purgeEverything() {
      const removed = {};
      for (const name of DATA_STORES) {
        try { removed[name] = await handle.count(name); } catch { removed[name] = null; }
      }
      await txn([...ALL_STORES], "readwrite", (s) => {
        for (const name of DATA_STORES) s[name].clear();
        const metaReq = s.meta.getAllKeys();
        metaReq.onsuccess = () => {
          for (const k of metaReq.result) {
            const key = String(k);
            // schemaVersion and the build stamp DELIBERATELY survive: they
            // describe the store's shape, not its contents, and dropping the
            // version would make the very next open purge again for nothing.
            if (key === "schemaVersion" || key === "lastWrittenByBuild") continue;
            if (PURGED_META_PREFIXES.some((pfx) => key.startsWith(pfx))
              || key.startsWith("photoCache.")) {
              s.meta.delete(k);
            }
          }
        };
      });
      return removed;
    },

    close() { reopen = null; closed = true; db.close(); },
  };
  return handle;
}
