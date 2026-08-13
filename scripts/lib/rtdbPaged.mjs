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
    if (keys.length < pageSize) break;
  }
  return out;
}
