// ─── OFFLINE MIRROR — the RTDB transport ─────────────────────────────────────
//
// The ONLY place in the mirror that imports firebase/database. Everything else
// — the sync engine, the change feed, the setup run — takes an `adapter` and is
// therefore testable against a plain object with no SDK, no emulator and no
// network. That is the insightsLogStore.js precedent in this repo, and the
// sync.js precedent on the tills.
//
// EVERY READ HERE IS BOUNDED. The firebase SDKs do not fail fast offline: a
// `get()` is queued against a connection that may return, and the caller waits
// for ever. A sync pass that hangs stops the whole engine, because the next
// pass is only scheduled in this one's `.finally`. So every method goes through
// withTimeout and the answer is always a value or an honest failure — never
// silence. See bounded.js.

import {
  ref, get, query, orderByKey, orderByChild, startAfter, startAt, endAt,
  limitToFirst, limitToLast, onValue,
} from "firebase/database";
import { database } from "../firebase";
import { withTimeout, READ_TIMEOUT_MS, BIG_READ_TIMEOUT_MS } from "./bounded";

// A whole node, or a child of one. Used by the setup download and by the
// per-row re-read the change feed does.
export function createRtdbAdapter({ db = database } = {}) {
  return {
    // One path, whole. `big` raises the budget for the setup download's large
    // nodes — /insights_log is 35.8 MB and a shop line is a shop line.
    async readPath(path, { big = false } = {}) {
      const snap = await withTimeout(get(ref(db, path)), {
        ms: big ? BIG_READ_TIMEOUT_MS : READ_TIMEOUT_MS,
        label: `/${path}`,
      });
      return snap.exists() ? snap.val() : null;
    },

    // A page of children by key, exclusive of `after`. The change feed and the
    // /insights_log feed both use it; neither needs an index, because key
    // order is free.
    async readKeyPage(path, { after = null, limit = 500, big = false } = {}) {
      const parts = [orderByKey()];
      if (after !== null && after !== undefined) parts.push(startAfter(after));
      parts.push(limitToFirst(limit));
      const snap = await withTimeout(get(query(ref(db, path), ...parts)), {
        ms: big ? BIG_READ_TIMEOUT_MS : READ_TIMEOUT_MS,
        label: `/${path} (key page)`,
      });
      return snap.exists() ? snap.val() : null;
    },

    // A page of children by an INDEXED child field, inclusive of `from`. The
    // /stock_movements feed uses it against the live `.indexOn: ["ts"]`.
    //
    // INCLUSIVE, deliberately. `ts` is not unique — a single transfer writes
    // several movements with the identical ISO string — so an exclusive bound
    // would skip every movement sharing the cursor's timestamp but for the one
    // that set it. The overlap is re-read instead, and an upsert makes that
    // free; missing a movement is not.
    async readChildPage(path, field, { from = null, limit = 500, big = false } = {}) {
      const parts = [orderByChild(field)];
      if (from !== null && from !== undefined) parts.push(startAt(from));
      parts.push(limitToFirst(limit));
      const snap = await withTimeout(get(query(ref(db, path), ...parts)), {
        ms: big ? BIG_READ_TIMEOUT_MS : READ_TIMEOUT_MS,
        label: `/${path} (${field} page)`,
      });
      return snap.exists() ? snap.val() : null;
    },

    // The oldest key a node still holds. The change feed asks it to tell
    // "nothing has happened" from "everything that happened has been swept".
    async firstKey(path) {
      const snap = await withTimeout(
        get(query(ref(db, path), orderByKey(), limitToFirst(1))),
        { ms: READ_TIMEOUT_MS, label: `/${path} (first key)` },
      );
      if (!snap.exists()) return null;
      const val = snap.val();
      const keys = Object.keys(val || {});
      return keys.length ? keys[0] : null;
    },

    // The NEWEST key a node holds. The change feed asks it once, at the start
    // of a setup download, to know where its cursor begins.
    async lastKey(path) {
      const snap = await withTimeout(
        get(query(ref(db, path), orderByKey(), limitToLast(1))),
        { ms: READ_TIMEOUT_MS, label: `/${path} (last key)` },
      );
      if (!snap.exists()) return null;
      const keys = Object.keys(snap.val() || {});
      return keys.length ? keys[0] : null;
    },

    // A bounded key range, for the setup download's paged walk of a big
    // append-only node.
    async readKeyRange(path, { from = null, to = null, limit = 500 } = {}) {
      const parts = [orderByKey()];
      if (from !== null) parts.push(startAt(from));
      if (to !== null) parts.push(endAt(to));
      parts.push(limitToFirst(limit));
      const snap = await withTimeout(get(query(ref(db, path), ...parts)),
        { ms: BIG_READ_TIMEOUT_MS, label: `/${path} (range)` });
      return snap.exists() ? snap.val() : null;
    },

    // `.info/connected` — the only honest answer to "is the database
    // answering". Never navigator.onLine, which says "some network exists".
    subscribeConnected(cb) {
      return onValue(ref(db, ".info/connected"), (snap) => cb(snap.val() === true));
    },
  };
}
