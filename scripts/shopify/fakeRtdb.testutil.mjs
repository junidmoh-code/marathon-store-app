// ── A fake RTDB that behaves like one where it matters here ─────────────────
// RTDB stores no empty objects. Removing the last child of a node removes the
// node, and writing null deletes. A fake that kept `{ shopifyReviewHidden: {} }`
// would let a test believe a node exists that the server has already dropped.
// The transaction models the cold-cache null-first pass (see inventorySync.test).
export function fakeDb(store) {
  const writes = [];
  const parts = (path) => path.split("/").filter(Boolean);
  const at = (path) => {
    let n = store;
    for (const p of parts(path)) { n = n?.[p]; if (n === undefined) return null; }
    return n === undefined ? null : n;
  };
  const prune = (path) => {
    const ps = parts(path);
    for (let i = ps.length - 1; i >= 1; i--) {
      const parent = at(ps.slice(0, i).join("/"));
      const k = ps[i - 1];
      if (parent && typeof parent === "object" && Object.keys(parent).length === 0) {
        const gp = i - 1 === 0 ? store : at(ps.slice(0, i - 1).join("/"));
        delete gp[k];
      }
    }
  };
  const setAt = (path, value) => {
    const ps = parts(path);
    if (value === null || value === undefined) {
      const parent = at(ps.slice(0, -1).join("/"));
      if (parent && typeof parent === "object") delete parent[ps.at(-1)];
      prune(ps.slice(0, -1).join("/") + "/x");
      return;
    }
    let n = store;
    for (const p of ps.slice(0, -1)) { if (typeof n[p] !== "object" || n[p] === null) n[p] = {}; n = n[p]; }
    n[ps.at(-1)] = value;
  };
  const db = {
    ref: (path) => ({
      get: async () => ({ val: () => at(path) }),
      set: async (v) => { writes.push(["set", path, v]); setAt(path, v); },
      remove: async () => { writes.push(["remove", path]); setAt(path, null); },
      update: async (obj) => {
        writes.push(["update", path, obj]);
        for (const [k, v] of Object.entries(obj)) setAt(`${path}/${k}`, v);
      },
      transaction: async (updater) => {
        const optimistic = updater(null);
        if (optimistic === undefined) return { committed: false, snapshot: { val: () => null } };
        const next = updater(at(path));
        if (next !== undefined) { writes.push(["txn", path, next]); setAt(path, next); }
        return { committed: next !== undefined, snapshot: { val: () => at(path) } };
      },
    }),
  };
  return { db, writes, store };
}

