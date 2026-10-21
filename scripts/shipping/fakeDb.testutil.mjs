// A tiny in-memory stand-in for the firebase-admin RTDB API the shipping
// scripts use: ref(path).get/set/update/remove. Paths are "/"-joined keys.
export function fakeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const writes = [];
  const parts = (p) => String(p).split("/").filter(Boolean);
  const read = (p) => parts(p).reduce((n, k) => (n == null ? n : n[k]), root);
  const write = (p, v) => {
    const ks = parts(p);
    let n = root;
    for (const k of ks.slice(0, -1)) n = n[k] ??= {};
    if (v === null || v === undefined) delete n[ks[ks.length - 1]];
    else n[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v));
  };
  return {
    root, writes,
    ref: (path) => ({
      get: async () => { const v = read(path); return { exists: () => v != null, val: () => (v == null ? null : JSON.parse(JSON.stringify(v))) }; },
      set: async (v) => { writes.push({ op: "set", path, v }); write(path, v); },
      update: async (obj) => { writes.push({ op: "update", path, v: obj }); for (const [k, v] of Object.entries(obj)) write(`${path}/${k}`, v); },
      remove: async () => { writes.push({ op: "remove", path }); write(path, null); },
    }),
  };
}
