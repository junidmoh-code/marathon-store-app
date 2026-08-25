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
