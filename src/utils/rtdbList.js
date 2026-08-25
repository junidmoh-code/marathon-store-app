// ─── RTDB LISTS — THE ONE COERCION ───────────────────────────────────────────
// Realtime Database cannot store an empty array. Writing `[]` does not store an
// empty list, it DELETES the key; removing the last child of a list does the
// same. So a field the code calls an array reads back one of four ways:
//
//   [a, b]            a real array          — the happy case
//   undefined         the key was never written
//   null              the key was deleted, or the last child was removed
//   { "0": a, "2": b } an object-keyed map  — RTDB returns this instead of an
//                     array whenever the keys are sparse or non-numeric, which
//                     is what a partial delete inside a list produces
//
// Every one of the last three throws on `.some` / `.map` / `.length`. That is
// not hypothetical: `posts.some(...)` on a null took the whole Social card down
// to the screen error boundary in production ("null is not an object
// (evaluating 's.some')", PR #441), and every one of the six live style
// references has its `tags` key ABSENT because `parseTags("")` returned `[]`.
//
// ── THE CONTRACT ─────────────────────────────────────────────────────────────
// READ:  asList() at the boundary — the snapshot handler, the hook, the
//        selector — so nothing downstream ever sees anything but an array.
//        NOT at each crash site: guarding the fiftieth `.map` is how the
//        forty-ninth gets missed.
// WRITE: storedList() before the value goes into an update(). It returns null
//        for an empty list, DELIBERATELY and visibly, instead of letting `[]`
//        be silently dropped by the database.
//
// ── WHY NOT A SENTINEL ───────────────────────────────────────────────────────
// The tempting fix is to store something for "empty" — a marker row, a
// `{empty: true}` flag. That invents a SECOND shape, and every reader would
// have to learn it: this app, scripts/social/publish.mjs on the Mac mini,
// reel-media.mjs, and the Cloud Functions. They already all guard with
// `|| []`, which reads a missing key correctly and a sentinel row as one item
// of garbage. A sentinel would turn a null-safety bug into a data bug, on the
// machine that posts to the shop's live Instagram. So: no sentinel. The empty
// list is the absent key, that is written down, and every read coerces.

/**
 * Anything RTDB can hand back where an array was expected → a real array.
 * Never returns null, never returns the input by reference when it wasn't one,
 * and never throws.
 *
 * Object-keyed maps are ordered by NUMERIC key where the keys are numeric —
 * `{ "10": x, "2": y }` is [y, x], not [x, y], because RTDB sorts object keys
 * as strings and "10" < "2". Getting that backwards silently reorders a post's
 * media, which is the order the pictures appear in on Instagram.
 */
export function asList(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null);
  if (value === null || value === undefined) return [];
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const allNumeric = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
    const ordered = allNumeric ? keys.sort((a, b) => Number(a) - Number(b)) : keys.sort();
    return ordered.map((k) => value[k]).filter((v) => v !== undefined && v !== null);
  }
  // A scalar where a list was expected is a malformed record, not a one-item
  // list. Say empty rather than inventing a row nobody wrote.
  return [];
}

/** Is this value already a usable list with something in it? */
export const hasItems = (value) => asList(value).length > 0;

/**
 * A list on its way INTO an update(). Empty becomes an explicit null so the
 * deletion is a decision in the source rather than a side-effect of the
 * database. Non-list input is coerced through asList first, so a caller can
 * never store an object-map by accident.
 */
export function storedList(value) {
  const list = asList(value);
  return list.length ? list : null;
}

/**
 * The same idea for a keyed map that a write may empty — `results`, whose keys
 * are platform names. update({results: {}}) DELETES the whole subtree, which on
 * a post means losing an "ok" result and re-sending to a live account. Empty
 * therefore becomes an explicit null and the caller must mean it.
 */
export function storedMap(value) {
  if (!value || typeof value !== "object") return null;
  return Object.keys(value).length ? value : null;
}
