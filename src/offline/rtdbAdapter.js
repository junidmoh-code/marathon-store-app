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
  ref, get, set, query, orderByKey, orderByChild, startAfter, startAt, endAt,
  limitToFirst, limitToLast, onValue, onChildAdded,
} from "firebase/database";
import { database } from "../firebase";
import { withTimeout, READ_TIMEOUT_MS, BIG_READ_TIMEOUT_MS } from "./bounded";
import { orderedChildren } from "./rtdbOrder";

// ─── THE QUERY SHAPES, NAMED ────────────────────────────────────────────────
//
// WHY THIS EXISTS. Every sync test runs against a FAKE adapter, and a fake
// re-implements the query semantics it is standing in for. That is fine until
// the two disagree — and the disagreement that matters here is one character:
//
//   readChildPage uses startAt (INCLUSIVE) because /stock_movements `ts` is not
//   unique — one transfer writes several movements with an identical ISO
//   string — so startAfter would keep the movement that set the cursor and
//   silently lose every other one sharing its timestamp.
//
// A mutation audit found exactly that: flipping startAt to startAfter here left
// all 206 tests green, because the fake implements inclusivity independently.
// The test named "the ts cursor is INCLUSIVE" was proving the fake.
//
// So the builders are pure, exported, and pinned by
// __tests__/adapterQueryShapes.test.js against the constraint NAMES. The
// functions below are the only callers.
export function keyPageConstraints({ after = null, limit = 500 }) {
  const parts = [orderByKey()];
  // EXCLUSIVE IN EFFECT, INCLUSIVE ON THE WIRE. A change-log key or a push key
  // is unique and the one the cursor names is already consumed, so the page
  // the caller gets never contains it — but the QUERY is startAt, asking for
  // one extra child, and readKeyPage drops the cursor's own row itself.
  //
  // Because startAfter + limitToFirst(n) comes back SHORT on this database:
  // the server counts the cursor's row against the limit and the SDK then
  // drops it. Measured live 2026-09-21 on /insights_log, /mirror_changes and
  // /customers (5 asked, 4 returned) and on /stock (1 asked, ZERO returned).
  // Every leg that ends its walk on "a page came back short" therefore ended
  // it on page two — /displaySlots, /restockLog and /orders all drifted from
  // the census across the fleet — and /stock's page of one location came back
  // empty. src/push/pagedRead.js found the same thing a day earlier.
  if (after !== null && after !== undefined) {
    parts.push(startAt(after));
    parts.push(limitToFirst(limit + 1));
  } else {
    parts.push(limitToFirst(limit));
  }
  return parts;
}

// ── THE COMPOUND CURSOR, AND WHY THE SIMPLE ONE WAS EXPENSIVE ──────────────
//
// `startAt(ts)` alone is inclusive, which it must be — /stock_movements `ts` is
// not unique, and an exclusive bound loses every movement of a multi-size
// transfer but one. But inclusive-on-ts-alone means every pass re-reads EVERY
// row sharing the newest timestamp, for ever. After a bulk transfer of fifty
// movements written at one ISO string, that is fifty rows × ~350 bytes × 1,440
// passes a day — about 25 MB per device per day, against a budget of 267 KB.
// (Fable-vs-spec review, PR #618.)
//
// RTDB's two-argument `startAt(value, key)` is exactly the fix: it starts at
// that (value, key) pair in the node's own ordering, so a cursor carrying both
// resumes at the last row consumed and re-reads ONE row instead of a
// timestamp's worth. The duplicate is an upsert and costs nothing.
export function childPageConstraints(field, { from = null, fromKey = null, limit = 500 }) {
  const parts = [orderByChild(field)];
  if (from !== null && from !== undefined) {
    // INCLUSIVE, still — see above. The key narrows WHERE inside the
    // timestamp we resume, never whether the timestamp is included.
    parts.push(fromKey ? startAt(from, fromKey) : startAt(from));
  }
  parts.push(limitToFirst(limit));
  return parts;
}

// What a constraint is, for a test that must name it. The SDK's own
// `_QueryConstraint` carries `type`; reading it here keeps the assertion about
// the real object rather than about a string we chose.
export const constraintNames = (parts) => parts.map((p) => p.type ?? String(p));

// ── HOW MANY BYTES DID THIS DEVICE ACTUALLY READ? ───────────────────────────
//
// The mirror's whole claim is a number, and a number nobody measures is a
// number nobody believes. Every read that returns a value is weighed here, at
// the one place every read passes through, and the count is what the fleet
// screen reports as "bytes today".
//
// It is the JSON length of the value, which is what RTDB put on the wire
// (uncompressed — reference_rtdb_read_costs_measured: RTDB REST does NOT
// gzip). It is not free: stringifying a 500-row page costs a few milliseconds.
// It is measured rather than estimated because the estimate is the thing under
// test, and the pages are paged precisely so that none of them is large.
export function measureBytes(value) {
  if (value === null || value === undefined) return 4;   // RTDB answers "null"
  // A page is a Map (rtdbOrder.js), which JSON.stringify writes as "{}". It is
  // weighed as the object it was on the wire: the braces, and per child its
  // quoted key, a colon, its value and a comma between.
  if (value instanceof Map) {
    if (value.size === 0) return 4;
    let n = 2 + (value.size - 1);
    try {
      for (const [k, v] of value) n += JSON.stringify(k).length + 1 + JSON.stringify(v ?? null).length;
    } catch { return 0; }
    return n;
  }
  try { return JSON.stringify(value).length; } catch { return 0; }
}

// A whole node, or a child of one. Used by the setup download and by the
// per-row re-read the change feed does.
//
// `onBytes` is optional and defaults to nothing, so every existing caller and
// every test is unchanged by its presence.
export function createRtdbAdapter({ db = database, onBytes = null } = {}) {
  const weigh = (value) => {
    if (onBytes) { try { onBytes(measureBytes(value)); } catch { /* never breaks a read */ } }
    return value;
  };
  return {
    // One path, whole. `big` raises the budget for the setup download's large
    // nodes — /insights_log is 35.8 MB and a shop line is a shop line.
    async readPath(path, { big = false } = {}) {
      const snap = await withTimeout(get(ref(db, path)), {
        ms: big ? BIG_READ_TIMEOUT_MS : READ_TIMEOUT_MS,
        label: `/${path}`,
      });
      return weigh(snap.exists() ? snap.val() : null);
    },

    // A page of children by key, exclusive of `after`. The change feed and the
    // /insights_log feed both use it; neither needs an index, because key
    // order is free.
    //
    // The page is a Map in query order (rtdbOrder.js), never snap.val(). The
    // cursor's own row, which the inclusive bound re-sends, is dropped here;
    // at most `limit` rows come back, so "shorter than the limit" still means
    // "this was the last page".
    async readKeyPage(path, { after = null, limit = 500, big = false } = {}) {
      const parts = keyPageConstraints({ after, limit });
      const snap = await withTimeout(get(query(ref(db, path), ...parts)), {
        ms: big ? BIG_READ_TIMEOUT_MS : READ_TIMEOUT_MS,
        label: `/${path} (key page)`,
      });
      const all = weigh(orderedChildren(snap));
      const page = new Map();
      for (const [k, v] of all) {
        if (after !== null && after !== undefined && k === String(after)) continue;
        if (page.size >= limit) break;
        page.set(k, v);
      }
      return page.size ? page : null;
    },

    // A page of children by an INDEXED child field, inclusive of `from`. The
    // /stock_movements feed uses it against the live `.indexOn: ["ts"]`. The
    // inclusivity argument, and the mutation that proved it was untested, are
    // in this file's header.
    async readChildPage(path, field, { from = null, fromKey = null, limit = 500, big = false } = {}) {
      const parts = childPageConstraints(field, { from, fromKey, limit });
      const snap = await withTimeout(get(query(ref(db, path), ...parts)), {
        ms: big ? BIG_READ_TIMEOUT_MS : READ_TIMEOUT_MS,
        label: `/${path} (${field} page)`,
      });
      // forEach, NOT val(). val() is in key order, and taking its last entry
      // as the cursor is the #624 fleet download loop — see rtdbOrder.js.
      const page = weigh(orderedChildren(snap));
      return page.size ? page : null;
    },

    // The oldest key a node still holds. The change feed asks it to tell
    // "nothing has happened" from "everything that happened has been swept".
    async firstKey(path) {
      const snap = await withTimeout(
        get(query(ref(db, path), orderByKey(), limitToFirst(1))),
        { ms: READ_TIMEOUT_MS, label: `/${path} (first key)` },
      );
      const keys = [...weigh(orderedChildren(snap)).keys()];
      return keys.length ? keys[0] : null;
    },

    // The NEWEST key a node holds. The change feed asks it once, at the start
    // of a setup download, to know where its cursor begins.
    async lastKey(path) {
      const snap = await withTimeout(
        get(query(ref(db, path), orderByKey(), limitToLast(1))),
        { ms: READ_TIMEOUT_MS, label: `/${path} (last key)` },
      );
      const keys = [...weigh(orderedChildren(snap)).keys()];
      return keys.length ? keys[keys.length - 1] : null;
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
      const page = weigh(orderedChildren(snap));
      return page.size ? page : null;
    },

    // ── A LIVE SIGNAL, WITHOUT A LIVE NODE ──────────────────────────────
    //
    // Polling the change log on a cadence makes every screen as stale as the
    // cadence. At 60 seconds that is a minute between one device's write and
    // another device's screen — where today an onValue is instant — and
    // "screens display exactly what they display today" does not survive it.
    // (Fable-vs-spec review, PR #618.)
    //
    // So the cadence keeps its place as a floor, and this sits on top: an
    // onChildAdded over the change log FROM THE CURSOR. It streams only the
    // records themselves — about 60 bytes each — never a node, and it is what
    // turns "up to a minute" into "as fast as the trigger fires".
    //
    // It is a SIGNAL, not a source. The callback does not carry the record
    // into the mirror; it asks the engine to run a pass, which reads the page
    // properly and commits it with its cursor. One path applies changes, and
    // it is the tested one.
    subscribeNewChanges(path, after, onSignal) {
      const parts = [orderByKey()];
      if (after !== null && after !== undefined) parts.push(startAfter(after));
      return onChildAdded(
        query(ref(db, path), ...parts),
        (snap) => onSignal(snap.key),
        (err) => console.warn(`offline mirror: change signal on /${path} failed:`, err),
      );
    },

    // THE ONE WRITE THIS ADAPTER DOES: the device's own health record. Bounded
    // like every read here, because a write that never settles in a `finally`-
    // scheduled loop stops the loop just as surely as a read does.
    async writePath(path, value) {
      await withTimeout(set(ref(db, path), value), {
        ms: READ_TIMEOUT_MS, label: `/${path} (write)`,
      });
      return true;
    },

    // `.info/connected` — the only honest answer to "is the database
    // answering". Never navigator.onLine, which says "some network exists".
    subscribeConnected(cb) {
      return onValue(ref(db, ".info/connected"), (snap) => cb(snap.val() === true));
    },
  };
}
