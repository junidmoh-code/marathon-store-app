// ─── OFFLINE MIRROR — RTDB's own ordering, and pages that keep it ────────────
//
// WHY THIS FILE EXISTS (the #624 fleet download loop, 2026-09-21) ────────────
//
// `snap.val()` on a query result does NOT come back in the query's order. The
// SDK builds a plain object, and the object enumerates in KEY order — worse,
// in JavaScript's key order, which puts integer-looking keys first. The mirror
// took "the last entry of the page" as its next cursor, and on the live
// /stock_movements page that started at srcoh_2026-07-13::115_0 the
// alphabetically-last key WAS that starting row ("srcoh_" sorts after "-Ox…"
// push keys and "sold:…" keys). The cursor could not move, the stuck guard
// threw, setup retried, and fifteen devices downloaded the same 670,547-byte
// page 319 times in a morning.
//
// The same assumption sat under every paged leg:
//   - orderByKey legs took the max key by JS string comparison. RTDB sorts
//     integer-looking keys FIRST and NUMERICALLY ("9" < "10" < "abc"), and
//     /customers and /orders have exactly those keys — a page of customers
//     "1".."500" named "99" as its end, the next page re-read 100..500, and the
//     swap then held fewer rows than it had staged ("did-not-land").
//   - the change feed took its cursor the same way.
//
// So there are two rules here, and every paged reader in src/offline uses both:
//
//   1. A PAGE IS READ WITH snap.forEach, which is the only accessor that walks
//      children in query order. It comes back as a Map, whose iteration order
//      is insertion order for EVERY key shape (a plain object would re-sort
//      integer keys to the front and undo the whole point).
//   2. A CURSOR IS THE MAXIMUM OF THE PAGE BY RTDB's COMPARATOR, never "the last
//      entry". Rule 1 makes the last entry correct; rule 2 means a page that
//      arrives in any order at all — a fake, an older adapter, a future SDK —
//      still yields the right cursor. Defence in depth, because rule 1 alone
//      was what failed.
//
// The comparators are the SDK's own (@firebase/database: nameCompare,
// tryParseInt, LeafNode.compareTo), copied rather than imported because they
// are not public API.

// RTDB treats a key as an integer when it matches this AND fits in 32 bits.
// Leading zeros are allowed: "001" is the integer 1, sorted among integers,
// with the shorter spelling first on a tie.
const INTEGER_KEY = /^-?(0*)\d{1,10}$/;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export function keyAsInt(key) {
  if (typeof key !== "string" || !INTEGER_KEY.test(key)) return null;
  const n = Number(key);
  return n >= INT32_MIN && n <= INT32_MAX ? n : null;
}

/** RTDB key order: integer keys first, numerically; then strings, by code unit. */
export function compareKeys(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  const xi = keyAsInt(x);
  const yi = keyAsInt(y);
  if (xi !== null) {
    if (yi !== null) return xi - yi === 0 ? x.length - y.length : xi - yi;
    return -1;
  }
  if (yi !== null) return 1;
  return x < y ? -1 : 1;
}

// orderByChild ranks values by type before comparing them:
// absent < booleans < numbers < strings < objects.
const rank = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "string") return 3;
  return 4;
};

/** RTDB's order for two child-field values, ignoring the key. */
export function compareChildValues(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0 || ra === 4) return 0;            // absent / objects tie; the key decides
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** RTDB's orderByChild order for two { value, key } positions: value, then key. */
export function compareChildOrder(a, b) {
  return compareChildValues(a.value, b.value) || compareKeys(a.key, b.key);
}

/** The largest key in `keys` by RTDB key order, or null for none. */
export function maxKey(keys) {
  let best = null;
  for (const k of keys) if (best === null || compareKeys(k, best) > 0) best = k;
  return best;
}

/**
 * A page as [key, value] pairs, whatever shape it arrived in.
 *
 * The adapter returns a Map (see rule 1). A plain object is still accepted —
 * every test fake returns one, and so did the adapter before this file — and
 * its order is NOT trusted by anything downstream (rule 2). Absent and null
 * children are dropped: RTDB never stores a null child, so one here is an
 * array-coercion hole, never a row. `keepNull` hands them back for a caller
 * that names what it refuses (the change feed's "malformed").
 */
export function pageEntries(page, { keepNull = false } = {}) {
  if (page === null || page === undefined) return [];
  const pairs = page instanceof Map ? [...page.entries()] : Object.entries(page);
  return keepNull ? pairs : pairs.filter(([, v]) => v !== null && v !== undefined);
}

/** A page's children, in query order, as a Map — built with forEach. */
export function orderedChildren(snap) {
  const out = new Map();
  if (!snap || !snap.exists()) return out;
  snap.forEach((child) => {
    out.set(String(child.key), child.val());
  });
  return out;
}
