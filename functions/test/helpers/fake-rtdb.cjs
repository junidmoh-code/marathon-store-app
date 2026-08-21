// ─── A FAKE RTDB THAT DELETES THE WAY THE REAL ONE DOES ───────────────────────
// Enough of the Admin SDK's database surface to run the write paths in this
// repo against an in-memory tree: ref().once/set/update/push, and the
// orderByKey().limitToFirst().startAt() cursor the paged readers use.
//
// THE DELETE SEMANTICS ARE THE POINT. RTDB has no concept of an empty
// container: writing null, {} or [] REMOVES the node, and a parent left holding
// nothing is removed too, all the way up. A fake that keeps `{}` around lets a
// test pass on a tree the real database can never be in — which is how a
// "clears the entry" assertion ends up proving nothing. Reproduced here so the
// off switch (set the category entry to null) is tested against real behaviour.
//
// Undefined is a THROW, not a silent drop, because that is what the SDK does —
// and it is the exact failure that took the engine down for 26h when a write
// object carried an absent field (see the retryState note in refill-engine.cjs).

function isEmptyContainer(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).length === 0;
  if (typeof v === "object") return Object.keys(v).filter((k) => v[k] !== null && v[k] !== undefined).length === 0;
  return false;
}

// Strip nulls/empties depth-first — the shape RTDB would actually store.
function normalize(v) {
  if (v === undefined) throw new Error("set/update failed: value argument contains undefined");
  if (v === null) return null;
  if (Array.isArray(v) || typeof v !== "object") {
    if (Array.isArray(v)) {
      const kept = v.map(normalize).filter((x) => x !== null);
      return kept.length ? kept : null;
    }
    return v;
  }
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (raw === undefined) throw new Error(`set/update failed: value argument contains undefined in property '${k}'`);
    const n = normalize(raw);
    if (n !== null) out[k] = n;
  }
  return isEmptyContainer(out) ? null : out;
}

const parts = (p) => String(p).split("/").filter(Boolean);

function readAt(root, path) {
  let cur = root;
  for (const k of parts(path)) {
    if (cur === null || typeof cur !== "object") return null;
    cur = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : null;
  }
  return cur === undefined ? null : cur;
}

function writeAt(root, path, value) {
  const ks = parts(path);
  const v = normalize(value);
  if (!ks.length) return v === null ? {} : v;
  const walk = (node, i) => {
    const k = ks[i];
    const base = node && typeof node === "object" && !Array.isArray(node) ? { ...node } : {};
    if (i === ks.length - 1) {
      if (v === null) delete base[k]; else base[k] = v;
    } else {
      const child = walk(base[k], i + 1);
      if (child === null) delete base[k]; else base[k] = child;
    }
    // A parent left holding nothing does not exist in RTDB either.
    return isEmptyContainer(base) ? null : base;
  };
  const next = walk(root, 0);
  return next === null ? {} : next;
}

let pushCounter = 0;

// Reads hand back a COPY, never a live reference into the tree. The real SDK
// deserializes fresh objects every time, and the difference is not cosmetic: a
// fake that returns references makes a drift check untestable, because the
// "before" snapshot silently follows the very change it is supposed to catch.
const clone = (v) => (v === null || typeof v !== "object" ? v : structuredClone(v));

function makeSnapshot(key, value) {
  return {
    key,
    val: () => (value === undefined ? null : clone(value)),
    exists: () => value !== null && value !== undefined,
    child: (k) => makeSnapshot(k, value && typeof value === "object" ? (value[k] ?? null) : null),
    forEach: (fn) => {
      if (!value || typeof value !== "object") return false;
      // RTDB orders integer-parseable keys numerically BEFORE string keys.
      // Reproduced so a cursor bug that only shows on numeric keys can be
      // caught here rather than in production.
      const keys = Object.keys(value).sort((a, b) => {
        const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
        if (na && nb) return Number(a) - Number(b);
        if (na) return -1;
        if (nb) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const k of keys) if (fn(makeSnapshot(k, value[k])) === true) return true;
      return false;
    },
  };
}

// `hooks.beforeRead(path)` / `hooks.afterWrite(path, value)` let a test move the
// world between two reads — which is the only way to exercise a drift check.
function makeFakeDb(initial = {}, hooks = {}) {
  const state = { root: normalize(initial) || {} };
  const api = {
    state,
    ref(path = "") {
      const self = {
        path,
        key: parts(path).pop() || null,
        async once() {
          if (hooks.beforeRead) await hooks.beforeRead(path, state);
          return makeSnapshot(self.key, readAt(state.root, path));
        },
        async set(v) {
          state.root = writeAt(state.root, path, v);
          if (hooks.afterWrite) await hooks.afterWrite(path, v, state);
          return undefined;
        },
        async update(patch) {
          for (const [k, v] of Object.entries(patch || {})) {
            state.root = writeAt(state.root, `${path}/${k}`, v);
          }
          if (hooks.afterWrite) await hooks.afterWrite(path, patch, state);
          return undefined;
        },
        child(k) { return api.ref(`${path}/${k}`); },
        push() {
          pushCounter += 1;
          const key = `-fake${String(pushCounter).padStart(6, "0")}`;
          const child = api.ref(`${path}/${key}`);
          child.key = key;
          return child;
        },
        // Query surface — only what readMapPaged uses.
        orderByKey() { return self; },
        limitToFirst(n) { return { ...self, async once() {
          // The read hook fires on QUERIES too. A drift test has to be able to
          // move the world during the paged catalogue read, because that is the
          // slow part and therefore the real window.
          if (hooks.beforeRead) await hooks.beforeRead(path, state);
          const v = readAt(state.root, path);
          if (!v || typeof v !== "object") return makeSnapshot(self.key, null);
          const keys = Object.keys(v).sort();
          const from = self._startAt ? keys.filter((k) => k >= self._startAt) : keys;
          return makeSnapshot(self.key, Object.fromEntries(from.slice(0, n).map((k) => [k, v[k]])));
        }, startAt(k) { self._startAt = k; return this; } }; },
        startAt(k) { self._startAt = k; return self; },
      };
      return self;
    },
  };
  return api;
}

module.exports = { makeFakeDb, normalize, isEmptyContainer, readAt };
