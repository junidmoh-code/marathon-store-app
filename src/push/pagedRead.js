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

import { get, limitToFirst, orderByKey, query, startAfter } from "firebase/database";

/** Children per request. Small enough to bound one response, large enough that
 *  a 35-account roster is a single round trip. */
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
 * @returns {Promise<{data: Record<string, any>, complete: boolean, pages: number}>}
 *   `data` is key → value; `complete` is false only when the page budget ran out
 *   with more children still to come.
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
      : [orderByKey(), startAfter(cursor), limitToFirst(pageSize)];

    const snap = await get(query(node, ...constraints));
    pages += 1;

    let seen = 0;
    let last = cursor;
    // forEach, not val(): see the header. Returning nothing keeps the walk going.
    snap.forEach((child) => {
      const key = child.key;
      if (typeof key === "string") { data[key] = child.val(); last = key; seen += 1; }
    });

    // A short page is the last page. This is the ONLY exit that means "read it
    // all" — falling out of the loop below means the budget ran out.
    if (seen < pageSize) return { data, complete: true, pages };
    // A full page that advanced nothing would loop forever; treat it as done.
    if (last === cursor) return { data, complete: true, pages };
    cursor = last;
  }

  return { data, complete: false, pages };
}
