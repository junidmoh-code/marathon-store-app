// What a value looks like after a write to, and a read from, the REAL Realtime
// Database — which is not what was written:
//   • null/undefined children are deleted;
//   • an EMPTY array or object is deleted (RTDB cannot store one), and a
//     parent left empty by that disappears too;
//   • an object's keys come back SORTED (a comparison that depends on the
//     order a value was built in sees a change that is not there);
//   • a container whose keys are all small integers comes back as an ARRAY
//     when more than half of 0..max are present (holes read as null), and as
//     an OBJECT keyed "0","2",… otherwise.
// A test fake that skips this lets code believe in nodes the server has
// already dropped (see feedback_fake_rtdb_null_holes in the session notes).
export function rtdbRoundTrip(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  const out = {};
  for (const [k, x] of entries) {
    const r = rtdbRoundTrip(x);
    if (r !== null) out[k] = r;
  }
  const keys = Object.keys(out);
  if (!keys.length) return null;
  if (keys.every((k) => /^(0|[1-9]\d*)$/.test(k))) {
    const max = Math.max(...keys.map(Number));
    if (keys.length * 2 > max + 1) {
      const arr = [];
      for (let i = 0; i <= max; i++) arr.push(out[i] ?? null);
      return arr;
    }
  }
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}
