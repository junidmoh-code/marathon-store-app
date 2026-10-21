// ── A fake RTDB faithful where the poller depends on it ─────────────────────
//   • nulls, empty objects and EMPTY ARRAYS are dropped, and a parent left
//     empty goes with them — what the real server does, and what a test must
//     see or it believes in nodes that do not exist;
//   • a transaction runs its update function on a COLD-CACHE null first (the
//     Admin SDK does, in a fresh process — every tick is one), then on the
//     server value; returning undefined aborts;
//   • orderByChild(...).equalTo(...) answers from the children, like an index;
//   • { ".sv": { increment: n } } resolves against the stored number.
// Every write is logged in `writes` as [op, path, value].
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const parts = (path) => String(path).split("/").filter(Boolean);

function normalize(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const out = v.map(normalize);
    if (out.every((x) => x === null)) return null;
    // Holes stay holes (RTDB keys them by index); trailing nulls go.
    while (out.length && out[out.length - 1] === null) out.pop();
    return out;
  }
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const n = normalize(x);
      if (n !== null) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  return v;
}

export function fakeDb(initial = {}, { failWritesUnder = null, missingIndexes = [] } = {}) {
  let root = normalize(clone(initial)) || {};
  const writes = [];
  let keySeq = 0;

  const at = (path) => {
    let n = root;
    for (const p of parts(path)) {
      if (n === null || typeof n !== "object") return null;
      n = n[p];
      if (n === undefined) return null;
    }
    return n === undefined ? null : clone(n);
  };
  const resolveSv = (path, v) => {
    if (v && typeof v === "object" && v[".sv"]?.increment !== undefined) {
      return (Number(at(path)) || 0) + v[".sv"].increment;
    }
    return v;
  };
  const setAt = (path, value) => {
    if (failWritesUnder && String(path).startsWith(failWritesUnder)) throw new Error(`PERMISSION_DENIED: ${path}`);
    const ps = parts(path);
    const v = normalize(clone(resolveSv(path, value)));
    if (!ps.length) { root = v || {}; return; }
    // Materialise the path as plain objects (an array parent becomes an
    // object keyed by index, which is how the server stores it anyway).
    const stack = [root];
    let n = root;
    for (const p of ps.slice(0, -1)) {
      if (n[p] === null || typeof n[p] !== "object") n[p] = {};
      n = n[p];
      stack.push(n);
    }
    if (v === null) delete n[ps.at(-1)];
    else n[ps.at(-1)] = v;
    root = normalize(root) || {};
  };

  const snap = (v, key) => ({ val: () => v, exists: () => v !== null, key });

  const ref = (path = "") => ({
    key: parts(path).at(-1) ?? null,
    get: async () => snap(at(path), parts(path).at(-1)),
    set: async (value) => { writes.push(["set", path, clone(value)]); setAt(path, value); },
    update: async (obj) => {
      writes.push(["update", path, clone(obj)]);
      // Multi-path: all or nothing, like the server.
      const before = clone(root);
      try {
        for (const [k, v] of Object.entries(obj)) setAt(`${path}/${k}`, v);
      } catch (e) { root = before; throw e; }
    },
    remove: async () => { writes.push(["remove", path, null]); setAt(path, null); },
    push: () => {
      const key = `-K${String(++keySeq).padStart(6, "0")}`;
      return { key, ...ref(`${path}/${key}`) };
    },
    transaction: async (fn) => {
      const cold = fn(null);
      const current = at(path);
      // The real SDK with no cached value: an update function that answers the
      // cold null pass with undefined ABORTS there — the server is never asked
      // (architect review, #777: closeHubOrders did this and never closed).
      if (cold === undefined) return { committed: false, snapshot: snap(current) };
      const next = current === null ? cold : fn(clone(current));
      if (next === undefined) return { committed: false, snapshot: snap(current) };
      writes.push(["txn", path, clone(next)]);
      setAt(path, next);
      return { committed: true, snapshot: snap(at(path)) };
    },
    orderByChild: (child) => ({
      equalTo: (value) => ({
        get: async () => {
          if (missingIndexes.includes(child)) throw new Error(`Index not defined, add ".indexOn": "${child}", for path "/${path}", to the rules`);
          const node = at(path) || {};
          const out = {};
          for (const [k, v] of Object.entries(node)) if (v && v[child] === value) out[k] = v;
          return snap(Object.keys(out).length ? out : null);
        },
      }),
    }),
  });

  return {
    db: { ref },
    writes,
    read: (path) => at(path),
    get root() { return root; },
  };
}

export const increment = (n) => ({ ".sv": { increment: n } });
