// ─── OFFLINE MIRROR — reading /mirror_changes ────────────────────────────────
//
// After a device's one setup download, THIS is how eighteen of the twenty
// mirrored nodes stay true. A Cloud Function appends a pointer record for every
// write (functions/mirrorChanges/), and this reads them forward from a stored
// cursor:
//
//     /mirror_changes/{pushKey} = { n: "<node>", k: "<row key>", t: <ms> }
//
// Push keys sort as time, so `orderByKey().startAfter(cursor)` is a complete
// forward feed needing no index. For each record the row's ONE child is
// re-read and upserted; a child that reads back null was deleted upstream and
// is deleted locally.
//
// ── THE FOUR THINGS THIS FILE IS CAREFUL ABOUT ──────────────────────────────
//
// 1. A PAGE COMMITS WITH ITS CURSOR, OR NOT AT ALL. The rows and the cursor
//    advance in one IndexedDB transaction (db.putPage). An interruption
//    anywhere re-reads that page next time, and an upsert makes the overlap
//    free. The alternative — cursor first, rows after — loses a change for
//    ever on a reload, silently.
//
// 2. COALESCING. A refill run writes hundreds of rows in a burst, and the same
//    row is often written several times in one page. Re-reading a child once
//    per RECORD would multiply the traffic this exists to remove, so records
//    are collapsed to a SET of (node, row) before anything is fetched. The
//    burst then costs one read per distinct row.
//
// 3. A CURSOR THAT HAS FALLEN OFF THE BACK OF RETENTION IS NOT RESUMABLE, and
//    must not pretend to be. The server keeps thirty days; a device whose
//    cursor is older than that may have missed records that no longer exist.
//    It raises CursorExpiredError, the leg records a failure, and the setup
//    download runs again for that leg. This is the ONLY route back to a whole-
//    node read after setup, and it is deliberate and visible.
//
// 4. A FAILED ROW READ DOES NOT ADVANCE THE CURSOR PAST IT. If any row in a
//    page cannot be fetched the whole page is abandoned — cursor unmoved — so
//    the next pass tries again. Advancing over a row we could not read would
//    leave the local copy permanently wrong about it with nothing to say so.
//
// ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
// It never reads a whole node. It never deletes local rows because a read came
// back short. It has no cadence of its own — the engine calls it.

import { LEG_BY_NODE, rowPath, storeKey, rowKeySegments } from "./nodes";
import { isCanonicalLocationId } from "./locationIds";

export const CHANGES_ROOT = "mirror_changes";
export const COUNTS_ROOT = "mirror_counts";

// Must equal CHANGE_RETENTION_MS in functions/mirrorChanges/legs.cjs. Pinned by
// __tests__/changeLegsMatch.test.js, which reads both files.
export const CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// How much of the retention window a cursor must stay inside. A cursor at 29
// days is technically still resumable, but a device that is about to take a
// 104 MB download should not discover it needs one in the middle of a trading
// day. The margin turns the wall into a slope.
export const CURSOR_SAFETY_MS = 24 * 60 * 60 * 1000;

export const FEED_CURSOR_META = "feedCursor.changes";

// Records per page. Small enough that a page commits quickly on a tablet,
// large enough that a burst of several hundred writes clears in a pass or two.
export const CHANGE_PAGE_SIZE = 500;

// Distinct rows fetched at once. The cost of a child read is round-trip
// latency, not bytes, so a handful in parallel cuts wall-clock by about that
// factor without saturating anything.
export const ROW_CONCURRENCY = 8;

const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

// The epoch milliseconds a push key encodes, from its first 8 characters. The
// inverse of pushKeyForMs in insightsLogRange.js and in the functions' lib.cjs;
// all three are pinned against each other.
export function msFromPushKey(key) {
  if (typeof key !== "string" || key.length < 8) return null;
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    const d = PUSH_CHARS.indexOf(key[i]);
    if (d < 0) return null;
    n = n * 64 + d;
  }
  return n;
}

export class CursorExpiredError extends Error {
  constructor(cursor, cursorMs, nowMs) {
    const days = Number.isFinite(cursorMs) ? Math.round((nowMs - cursorMs) / 86400000) : null;
    super(
      `offline mirror: the change cursor "${cursor}" is ${days ?? "an unknown number of"} days old, ` +
      "past the 30 days of change records the server keeps. Changes may have been swept that this " +
      "device never saw, so the feed CANNOT be resumed — the affected legs must download again.",
    );
    this.name = "CursorExpiredError";
    this.cursor = cursor;
    this.cursorMs = cursorMs;
  }
}

/**
 * Is a stored cursor still inside the window the server retains?
 *
 * A cursor with no encodable time is treated as expired: it is either corrupt
 * or from a key format this build does not understand, and in both cases
 * resuming from it would skip an unknown amount. The honest answer is to
 * download again.
 */
export function cursorIsResumable(cursor, nowMs, {
  retentionMs = CHANGE_RETENTION_MS, safetyMs = CURSOR_SAFETY_MS,
} = {}) {
  if (cursor === null || cursor === undefined) return true;   // nothing consumed yet
  const ms = msFromPushKey(cursor);
  if (!Number.isFinite(ms)) return false;
  return ms >= nowMs - retentionMs + safetyMs;
}

/**
 * Collapse a page of change records to the distinct rows it touches.
 *
 * Returns [{ leg, key }], in first-seen order, and drops:
 *   - records naming a node this build does not mirror (a leg added on the
 *     server before a device has the bundle that reads it — harmless, and the
 *     census will not be checking it either),
 *   - /stock rows naming a location this app does not know. Storing one under
 *     a guessed path is exactly the failure locationIds.js exists to refuse.
 *
 * `skipped` names what was dropped and why, so a pass can record it rather
 * than discard it silently.
 */
export function rowsFromChangePage(page) {
  const seen = new Set();
  const rows = [];
  const skipped = [];
  for (const [changeKey, rec] of Object.entries(page ?? {})) {
    if (!rec || typeof rec !== "object") { skipped.push({ changeKey, why: "malformed" }); continue; }
    const leg = LEG_BY_NODE[rec.n];
    if (!leg) { skipped.push({ changeKey, why: "unknown-node", node: rec.n }); continue; }
    const key = typeof rec.k === "string" ? rec.k : null;
    if (key === null) { skipped.push({ changeKey, why: "no-row-key", node: rec.n }); continue; }
    if (leg.depth > 0 && key === "") { skipped.push({ changeKey, why: "no-row-key", node: rec.n }); continue; }
    if (leg.name === "stock") {
      const [loc] = rowKeySegments(key);
      // STRICTLY canonical, not "canonicalisable". A change record carries the
      // RTDB key verbatim, and /stock's keys ARE the canonical ids — so a "pe"
      // here means something has written /stock/pe, the very path the POS
      // mirror read for weeks and got nothing from. Translating it to
      // marathon-pe would file those cells over the real ones. It is skipped
      // and named instead.
      if (!isCanonicalLocationId(loc)) {
        skipped.push({ changeKey, why: "unknown-location", node: rec.n, location: loc });
        continue;
      }
    }
    const dedupe = `${leg.name}\u0000${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({ leg, key });
  }
  return { rows, skipped };
}

// Run `fn` over `items` with at most `limit` in flight. Order of results
// matches order of items; the first rejection rejects the whole batch, which
// is what "a failed row read abandons the page" rests on.
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Read one page of the change feed and apply it.
 *
 * Returns { applied, deleted, cursor, done, skipped }. `done` is true when the
 * page came back shorter than the page size, which is the only honest
 * "caught up" signal a forward key walk has.
 *
 * NOTHING HERE TREATS A SHORT PAGE AS A REASON TO DELETE. A short page means
 * "no more records right now" and nothing else; the rows it did carry are
 * applied and the cursor advances to the last record SEEN, not to some
 * imagined end.
 */
export async function runChangeFeedPage({
  db, adapter, now = Date.now, pageSize = CHANGE_PAGE_SIZE, concurrency = ROW_CONCURRENCY,
}) {
  const cursor = (await db.getMeta(FEED_CURSOR_META)) ?? null;
  const nowMs = now();
  if (!cursorIsResumable(cursor, nowMs)) {
    throw new CursorExpiredError(cursor, msFromPushKey(cursor), nowMs);
  }

  const page = await adapter.readKeyPage(CHANGES_ROOT, { after: cursor, limit: pageSize });
  const changeKeys = Object.keys(page ?? {});
  if (changeKeys.length === 0) {
    return { applied: 0, deleted: 0, cursor, done: true, skipped: [] };
  }
  // Key order, not object order. Object key order for push keys happens to be
  // insertion order today, but the cursor must be the LARGEST key in the page
  // by RTDB ordering, and that is a property to establish rather than inherit.
  const lastKey = changeKeys.reduce((a, b) => (b > a ? b : a));

  const { rows, skipped } = rowsFromChangePage(page);

  // Every row's current value, fetched once each however many records named
  // it. A rejection here abandons the page WITHOUT moving the cursor.
  const values = await mapWithLimit(rows, concurrency, ({ leg, key }) =>
    adapter.readPath(rowPath(leg, key)));

  // Group by object store so each store commits its rows and the shared cursor
  // in one transaction.
  const byStore = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const { leg, key } = rows[i];
    const value = values[i];
    const bucket = byStore.get(leg.store) ?? { records: [], deleteKeys: [] };
    const k = storeKey(leg, key);
    if (value === null || value === undefined) bucket.deleteKeys.push(k);
    else bucket.records.push({ key: k, value });
    byStore.set(leg.store, bucket);
  }

  let applied = 0;
  let deleted = 0;
  const stores = [...byStore.entries()];
  for (let i = 0; i < stores.length; i += 1) {
    const [store, bucket] = stores[i];
    // THE CURSOR RIDES THE LAST STORE'S TRANSACTION, not the first. If a later
    // store's write fails, the cursor has not moved and the whole page is
    // retried; if it rode the first, everything after a mid-page failure would
    // be skipped for ever.
    const isLast = i === stores.length - 1;
    await db.putPage(store, bucket.records, {
      deleteKeys: bucket.deleteKeys,
      ...(isLast ? { cursorKey: FEED_CURSOR_META, cursorValue: lastKey } : {}),
    });
    applied += bucket.records.length;
    deleted += bucket.deleteKeys.length;
  }
  // A page of records that ALL got skipped touches no store, so nothing above
  // moved the cursor and the next pass would read the same page for ever.
  if (stores.length === 0) {
    await db.setMeta(FEED_CURSOR_META, lastKey);
  }

  return {
    applied, deleted, cursor: lastKey, done: changeKeys.length < pageSize, skipped,
    // The RTDB paths this page brought up to date. The pending-write echo is
    // dropped for them (pendingWrites.confirmPending): the feed has now
    // carried the same fact, so keeping the echo past this point is how it
    // would start hiding somebody else's later change.
    paths: rows.map(({ leg, key }) => rowPath(leg, key)),
  };
}

/**
 * The cursor a device that has just finished its setup download should start
 * from: the newest change record at the moment the download began.
 *
 * WHY THE MOMENT IT BEGAN AND NOT THE MOMENT IT FINISHED. A 104 MB download
 * takes minutes, and anything written during it may or may not be in what was
 * read. Starting from the newest record at the START means those writes are
 * replayed — an upsert of a value already correct, which costs one read — and
 * starting from the end means they are skipped, which is silent and permanent.
 * Re-read what you might already have; never skip what you might not.
 */
export async function changeCursorAtSetupStart({ adapter }) {
  // An EMPTY log is a real state — a fresh database, or a quiet thirty days —
  // and the honest cursor for it is null, meaning "consume everything from the
  // beginning". It is NOT a reason to fail.
  return (await adapter.lastKey(CHANGES_ROOT)) ?? null;
}
