// Fixtures for sweepUnguardedArrayOps.test.mjs. NOT application code — this
// file exists to be scanned, and every line is a shape the sweep must judge
// correctly. Do not "fix" the unguarded ones; they are the point.
export function optionalOnTheWrongHop(post) {
  // `?.` protects against a null `post` and says NOTHING about `media`, which
  // is exactly the field RTDB hands back as null. MUST be reported.
  return post?.media.map((m) => m.url);
}
export function optionalOnTheCallHop(post) {
  return post?.media?.map((m) => m.url);        // safe
}
export function orEmpty(post) {
  return (post.media || []).map((m) => m.url);  // safe
}
export function coerced(post, asList) {
  return asList(post.media).some(Boolean);      // safe
}
export function bare(post) {
  return post.media.some(Boolean);              // MUST be reported
}
export function optionalCallResult() {
  return getPosts()?.map((p) => p.id);          // safe — the call hop is optional
}
export function arrayLiteral() {
  return [1, 2].map((x) => x);                  // safe — a literal, not an index
}
export function indexedElement(rows, i) {
  // `rows[i]` is as able to be undefined as anything else. The sweep read the
  // closing bracket as an array literal and called this safe, which is a false
  // NEGATIVE — the direction that actually costs something. MUST be reported.
  return rows[i].some(Boolean);
}
