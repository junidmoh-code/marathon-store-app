// Paged whole-map read of a large RTDB node, shared by the customer census and
// the merge runner so both read /customers the same way (and neither issues a
// single whole-node read — live bandwidth is a real cost, pages keep each
// request bounded and resumable).
//
// The page cursor MUST come from the snapshot's own iteration order
// (snap.forEach), never Object.keys().sort(): RTDB orders integer-parseable
// keys (bare "813995333" phone keys) numerically BEFORE string keys, so a
// lexicographic sort can move the cursor backwards and loop forever.
// startAt is inclusive, so the overlap record is dropped on every page after
// the first.
// REST shallow read — the Admin SDK has no shallow, and a key-count must not
// cost the node's full weight. The OAuth token travels in an Authorization
// header, never the URL query string (query strings leak into logs).
export async function shallowKeys(adminApp, path) {
  const token = await adminApp.options.credential.getAccessToken();
  const base = adminApp.options.databaseURL;
  const res = await fetch(`${base}/${path}.json?shallow=true`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!res.ok) throw new Error(`shallow read of /${path} failed: ${res.status}`);
  const val = await res.json();
  return val ? Object.keys(val) : [];
}

export async function readMapPaged(db, path, { pageSize = 500, meter = () => {} } = {}) {
  const out = {};
  let lastKey = null;
  for (;;) {
    let q = db.ref(path).orderByKey().limitToFirst(pageSize + (lastKey ? 1 : 0));
    if (lastKey) q = q.startAt(lastKey);
    const snap = await q.once("value");
    meter(snap.val());
    const keys = [];
    snap.forEach((child) => { keys.push(child.key); });
    let added = 0;
    for (const k of keys) {
      if (k === lastKey) continue;
      out[k] = snap.child(k).val();
      added += 1;
    }
    if (added === 0) break;
    lastKey = keys[keys.length - 1];
    // Terminate on NEW records, not raw keys: later pages include the
    // inclusive cursor overlap, so a final page of pageSize-1 new records
    // holds pageSize keys and would trigger one redundant overlap-only read.
    if (added < pageSize) break;
  }
  return out;
}
