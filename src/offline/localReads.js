// ─── OFFLINE MIRROR — reading a node from the local copy ─────────────────────
//
// ONE function answers every screen: `readMirroredPath(db, path)` returns
// EXACTLY what `get(ref(database, path)).val()` would have returned, rebuilt
// from IndexedDB.
//
// That shape is the whole design. The constraint on this work is that every
// screen must display exactly what it displays today, and the cheapest way to
// guarantee that is to change WHERE a value comes from without changing WHAT
// it is. A hook that used to call onValue on "stock/hub1" and decode size keys
// keeps its decoding, its memoisation, its null handling and its empty-node
// behaviour, and only its source moves. Nothing downstream can tell.
//
// ── THE THREE THINGS IT HAS TO GET RIGHT ────────────────────────────────────
//
// 1. RTDB ANSWERS null FOR AN EMPTY NODE, never {}. It cannot store an empty
//    object or an empty array — writing one removes the key — so a node with
//    no children reads back null. A mirror that answered {} would turn every
//    `if (!data) return []` in this app into a different branch.
//
// 2. A ROW IS RETURNED WHOLE AT ITS OWN DEPTH. `stock/hub1/p1` is one row and
//    comes back as the record; `stock/hub1` is a map of them; `stock` is a map
//    of maps. Same tree, entered at different heights.
//
// 3. THE DEVICE'S OWN RECENT WRITES ARE INCLUDED. See pendingWrites.js: a
//    local read that omitted them would show someone the number they had just
//    changed, unchanged, for as long as the change feed takes to come round.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
//
// A path no leg covers returns MISS, not null. Those are different answers —
// null means "the database has nothing there", MISS means "this copy cannot
// say" — and conflating them is how a screen would render an empty list for a
// node that is merely not mirrored. The caller falls back to a live read.

import { MIRROR_LEGS, LEG_BY_NAME, rowKeySegments, storeKey } from "./nodes";
import { applyPending } from "./pendingWrites";

// Distinguishable from null, undefined and every legitimate RTDB value.
export const MISS = Symbol("offline-mirror-miss");

const segsOf = (path) => String(path).replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

/**
 * The leg covering `path`, and how far below its node the path reaches.
 * Returns null when no leg covers it.
 *
 * The LONGEST matching node wins. No two mirrored nodes are ancestors of each
 * other today (nodes.test.js asserts it), so this is unambiguous — but asking
 * for the longest match is the answer that stays correct if that ever changes.
 */
export function legFor(path) {
  const segs = segsOf(path);
  let best = null;
  for (const leg of MIRROR_LEGS) {
    const legSegs = segsOf(leg.node);
    if (legSegs.length > segs.length) continue;
    if (legSegs.some((s, i) => segs[i] !== s)) continue;
    if (!best || legSegs.length > segsOf(best.node).length) best = leg;
  }
  if (!best) return null;
  return { leg: best, below: segs.slice(segsOf(best.node).length) };
}

/**
 * What `get(ref(database, path)).val()` would have returned.
 *
 * `usePending: false` is for the mirror's own internal checks, which must see
 * what is actually on disk rather than what a screen should be shown.
 */
export async function readMirroredPath(db, path, { usePending = true, now = Date.now } = {}) {
  const match = legFor(path);
  if (!match) return MISS;
  const { leg, below } = match;

  let value;
  if (below.length >= leg.depth) {
    // At or past a row's own depth: fetch the one row and walk into it.
    const rowSegs = below.slice(0, leg.depth);
    const key = leg.depth === 0 ? "" : rowSegs.join("|");
    const row = await db.get(leg.store, storeKey(leg, key));
    value = descend(row === undefined ? null : row, below.slice(leg.depth));
  } else {
    value = await rebuild(db, leg, below);
  }

  // An empty object is not a thing RTDB can hold, so it is not a thing this
  // may return. Applied BEFORE the pending overlay, which may legitimately put
  // children back into it.
  value = emptyToNull(value);
  if (usePending) value = emptyToNull(applyPending(path, value, { now }));
  return value;
}

function descend(value, segments) {
  let node = value;
  for (const s of segments) {
    if (node === null || node === undefined || typeof node !== "object") return null;
    node = node[s];
  }
  return node === undefined ? null : node;
}

// Rebuild the subtree at `below` from the leg's rows.
async function rebuild(db, leg, below) {
  const entries = leg.store === "docs"
    ? (await db.getAllEntries("docs"))
      .filter((e) => e.key === leg.node || String(e.key).startsWith(`${leg.node}/`))
      .map((e) => ({
        key: e.key === leg.node ? "" : String(e.key).slice(leg.node.length + 1).split("/").join("|"),
        value: e.value,
      }))
    : await db.getAllEntries(leg.store);

  const out = {};
  for (const { key, value } of entries) {
    const segs = key === "" ? [] : rowKeySegments(key);
    if (segs.length !== leg.depth) continue;
    if (below.some((s, i) => segs[i] !== s)) continue;
    place(out, segs.slice(below.length), value);
  }
  return out;
}

function place(root, segments, value) {
  if (segments.length === 0) return;
  let node = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const k = segments[i];
    if (node[k] === null || node[k] === undefined || typeof node[k] !== "object") node[k] = {};
    node = node[k];
  }
  node[segments[segments.length - 1]] = value;
}

function emptyToNull(v) {
  if (v === undefined) return null;
  if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return null;
  return v;
}

// ─── THE TWO WINDOWED READS ─────────────────────────────────────────────────
//
// Two screens read a RANGE of an append-only node rather than the whole of it,
// and both already do so against the server today. Reading the whole store and
// filtering in JavaScript would work and would be wrong: /insights_log is
// 112,968 rows and /stock_movements 90,922, and walking them on every mount is
// the cost this mirror exists to remove, moved from the network onto the
// device. Both go through an IndexedDB range instead.

/**
 * /insights_log from `startKey` forward — App.jsx's useInsightsLogRecentDays.
 *
 * The key range is the same server-side pre-filter the live query uses, for
 * the same reason (push keys encode write time), and callers still filter on
 * `timestamp` afterwards exactly as they do today. So this can change what is
 * SCANNED and never what is rendered.
 */
export async function readInsightsFromKey(db, startKey) {
  const entries = await db.getEntriesInKeyRange("insights", startKey ?? null, null);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.map((e) => [e.key, e.value]));
}

/**
 * /stock_movements with `ts >= startIso` — App.jsx's useClothingSoldMovements.
 * Uses the `ts` index, which is the local twin of the live `.indexOn: ["ts"]`.
 */
export async function readMovementsFromTs(db, startIso) {
  const entries = await db.getEntriesInIndexRange("movements", "ts", startIso ?? null, null);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.map((e) => [e.key, e.value]));
}

// The full node, for a caller that wants everything — /insights_log's three
// whole-node consumers (Insights, Customers, the customer detail line).
export async function readWholeLeg(db, legName) {
  const leg = LEG_BY_NAME[legName];
  if (!leg) return MISS;
  return readMirroredPath(db, leg.node);
}
