// ─── READING A WHOLE NODE WITHOUT ASKING FOR A WHOLE NODE ────────────────────
// One helper, used by the Order alerts card to read /users and
// /push_assignments.
//
// ── WHY THIS EXISTS AND A PLAIN get(ref(node)) DOES NOT ──────────────────────
// `get(ref(db, "users"))` asks the server for every child in one response. It
// works today because /users holds 35 accounts and 12 KB. It is still the wrong
// shape: the request carries no upper bound, so its cost is whatever the node
// happens to grow to, and live bandwidth is the largest line on this project's
// bill. The same one-line call is what makes /stock a 5.36 MB read.
//
// So the read is PAGED and BOUNDED: orderByKey + limitToFirst, then
// startAfter(last key) for the next page. Ordering by key needs no .indexOn —
// keys are always indexed — so this adds no rule and no index. Each request has
// a hard ceiling, and the loop itself has a hard ceiling, which means there is
// no node size that can turn this into an unbounded fetch.
//
// ── TRUNCATION IS REPORTED, NEVER SWALLOWED ─────────────────────────────────
// If the page budget runs out the caller gets `complete: false` and the rows it
// did get. A partial roster presented as the whole roster is the same class of
// lie as an empty list presented as "nobody": the admin would decide who gets
// woken up at night from a list missing people, with nothing on screen saying
// so. The card puts a banner up instead.
//
// ── THE ACCUMULATOR HAS NO PROTOTYPE ────────────────────────────────────────
// `data` is Object.create(null), not {}. A child key is a uid, and RTDB is
// perfectly happy to hold one called "__proto__". On a plain object
// `data["__proto__"] = rec` sets the accumulator's prototype instead of an own
// property, and the record then does not appear in Object.keys at all — so
// that account would vanish from the Order alerts screen silently, with no
// row, no count and no banner, which is the exact "shown as missing, never
// omitted" promise this feature is built on. Same trap as the attribute
// extractor's MAP["__proto__"].
//
// ── ORDER COMES FROM forEach, NOT FROM Object.keys ──────────────────────────
// snap.val() on a query result loses the query's ordering, and RTDB will hand
// back an ARRAY rather than an object when the keys look like small integers.
// DataSnapshot.forEach preserves query order and always yields child keys as
// strings, so the cursor for the next page is correct for any key shape.
//
// ── startAt, NOT startAfter: startAfter SILENTLY SHORTENS EVERY PAGE ────────
//
// `startAfter(cursor) + limitToFirst(n)` returns n-1 children, always. The
// limit is applied by the server, which counts the cursor's own row; the SDK
// then drops that row on the way back. Measured against production on
// 2026-09-20, asking for 500 four times: 500, 499, 499, 499.
//
// A pager that ends on "a page came back short" therefore ends on its SECOND
// request, and reports `complete: true` while holding a fraction of the node.
// That is not a hypothetical: this helper was used to read /insights_log
// (112,968 rows) and returned 19,999 of them, with every all-time figure on
// three screens computed from the fraction and nothing on screen to say so.
//
// So the bound is startAt — INCLUSIVE — and the cursor's own row is skipped
// here, where it can be counted. Completeness is decided on the number of
// children the SERVER sent, not on how many survived the skip.

import { get, limitToFirst, orderByKey, query, startAt } from "firebase/database";

/** Children per request. Small enough to bound one response, large enough that
 *  a 35-account roster is a single round trip. One slot of every page after the
 *  first is spent re-reading the cursor's own row — see the header. */
export const PAGE_SIZE = 200;

/** Requests per read. PAGE_SIZE × MAX_PAGES is the ceiling on how much this
 *  helper will ever pull: 5,000 children. A staff roster that exceeds that is
 *  not a paging problem, it is a "this screen needs a different design" problem,
 *  and the caller is told rather than quietly served a slice. */
export const MAX_PAGES = 25;

/**
 * Read every child of a node in bounded pages, ordered by key.
 *
 * @param {import("firebase/database").DatabaseReference} node
 * @param {{pageSize?: number, maxPages?: number}} [opts]
 * @returns {Promise<{data: Record<string, any>, complete: boolean, pages: number, lastKey: string|null}>}
 *   `data` is key → value; `complete` is false only when the page budget ran out
 *   with more children still to come; `lastKey` is the highest key read, which
 *   is what a caller needs to follow the node forward from here (the insights
 *   log's all-time reader tails from it) and is null for an empty node.
 */
export async function readByKeyPages(node, opts = {}) {
  const pageSize = opts.pageSize || PAGE_SIZE;
  const maxPages = opts.maxPages || MAX_PAGES;

  const data = Object.create(null);
  let cursor = null;
  let pages = 0;

  while (pages < maxPages) {
    const constraints = cursor === null
      ? [orderByKey(), limitToFirst(pageSize)]
      : [orderByKey(), startAt(cursor), limitToFirst(pageSize)];

    const snap = await get(query(node, ...constraints));
    pages += 1;

    let sent = 0;                 // children the SERVER returned
    let seen = 0;                 // children that were new to us
    let last = cursor;
    // forEach, not val(): see the header. Returning nothing keeps the walk going.
    snap.forEach((child) => {
      const key = child.key;
      if (typeof key !== "string") return;
      sent += 1;
      // The inclusive lower bound re-sends the cursor's own row. It is already
      // in `data`; counting it again would be harmless, but treating it as
      // progress would not be.
      if (key === cursor) return;
      data[key] = child.val();
      last = key;
      seen += 1;
    });

    // A page the SERVER sent short is the last page. Judging this on `seen`
    // would end the walk one request in, because the first row of every page
    // after the first is the cursor being re-sent.
    if (sent < pageSize) return { data, complete: true, pages, lastKey: last };
    // A page that did not move the cursor FORWARD would loop forever. With an
    // inclusive bound a correct server only ever returns keys >= cursor, so
    // "did not move forward" is the whole misbehaviour test, and it covers the
    // alternating case a plain `last === cursor` check does not.
    if (seen === 0 || (cursor !== null && !(last > cursor))) {
      return { data, complete: true, pages, lastKey: last };
    }
    cursor = last;
  }

  return { data, complete: false, pages, lastKey: cursor };
}
