// ─── A FAKE RTDB THAT BEHAVES LIKE THE REAL ONE WHERE IT HURTS ──────────────
// The bugs this project keeps meeting are not in the queries, they are in what
// RTDB does to the DATA:
//   · an empty array or object is not stored at all — the key DISAPPEARS;
//   · null and undefined delete;
//   · an array is stored as an object keyed "0","1",… and comes back as an
//     array only while more than half of its integer slots are filled —
//     otherwise as an object;
//   · a transaction's first call can see a cold-cache NULL and must return a
//     value, not abort, for the real value to be tried.
// This fake does all four. Queries implemented: orderByKey/orderByChild,
// equalTo, startAt, limitToLast, once("value"), set, update (multi-path),
// transaction, push().key.
"use strict";

function clean(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) v = Object.fromEntries(v.map((x, i) => [String(i), x]));
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const c = clean(x);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}

// RTDB's own array heuristic on the way out.
function present(v) {
  if (v === undefined) return null;
  if (v === null || typeof v !== "object") return v;
  const keys = Object.keys(v);
  const ints = keys.every((k) => /^(0|[1-9]\d*)$/.test(k));
  if (ints && keys.length) {
    const max = Math.max(...keys.map(Number));
    if (keys.length * 2 > max + 1) {
      const arr = new Array(max + 1).fill(null);
      for (const k of keys) arr[Number(k)] = present(v[k]);
      return arr;
    }
  }
  const out = {};
  for (const k of keys) out[k] = present(v[k]);
  return out;
}

const split = (p) => String(p || "").split("/").filter(Boolean);

class FakeRtdb {
  constructor(initial = {}, { coldTransactions = true } = {}) {
    this.root = clean(initial) || {};
    this.coldTransactions = coldTransactions;
    this.reads = [];
    this._push = 0;
  }
  _get(parts) {
    let cur = this.root;
    for (const k of parts) {
      if (!cur || typeof cur !== "object" || !(k in cur)) return undefined;
      cur = cur[k];
    }
    return cur;
  }
  _set(parts, value) {
    const v = clean(value);
    if (!parts.length) { this.root = v || {}; return; }
    let cur = this.root;
    const chain = [];
    for (const k of parts.slice(0, -1)) {
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      chain.push([cur, k]);
      cur = cur[k];
    }
    const last = parts[parts.length - 1];
    if (v === undefined) delete cur[last]; else cur[last] = v;
    // An emptied parent disappears too.
    for (let i = chain.length - 1; i >= 0; i--) {
      const [obj, k] = chain[i];
      if (obj[k] && typeof obj[k] === "object" && !Object.keys(obj[k]).length) delete obj[k];
    }
  }
  ref(path = "") { return new FakeRef(this, split(path)); }
}

class FakeQuery {
  constructor(db, parts, q = {}) { this.db = db; this.parts = parts; this.q = q; }
  orderByKey() { return new FakeQuery(this.db, this.parts, { ...this.q, by: "$key" }); }
  orderByChild(c) { return new FakeQuery(this.db, this.parts, { ...this.q, by: c }); }
  equalTo(v) { return new FakeQuery(this.db, this.parts, { ...this.q, eq: v }); }
  startAt(v) { return new FakeQuery(this.db, this.parts, { ...this.q, start: v }); }
  limitToLast(n) { return new FakeQuery(this.db, this.parts, { ...this.q, last: n }); }
  async once() {
    const path = this.parts.join("/");
    this.db.reads.push({ path, query: { ...this.q } });
    let raw = this.db._get(this.parts);
    if (this.q.by && raw && typeof raw === "object") {
      const keyOf = (k) => (this.q.by === "$key" ? k : raw[k] && raw[k][this.q.by]);
      let keys = Object.keys(raw).sort((a, b) => {
        const x = keyOf(a), y = keyOf(b);
        return x === y ? (a < b ? -1 : 1) : (x < y ? -1 : 1);
      });
      if (this.q.eq !== undefined) keys = keys.filter((k) => keyOf(k) === this.q.eq);
      if (this.q.start !== undefined) keys = keys.filter((k) => keyOf(k) >= this.q.start);
      if (this.q.last) keys = keys.slice(-this.q.last);
      raw = keys.length ? Object.fromEntries(keys.map((k) => [k, raw[k]])) : undefined;
    }
    const val = present(raw);
    return { val: () => (val === undefined ? null : val), exists: () => raw !== undefined };
  }
}

class FakeRef extends FakeQuery {
  constructor(db, parts) { super(db, parts); this.key = parts[parts.length - 1] || null; }
  child(p) { return new FakeRef(this.db, [...this.parts, ...split(p)]); }
  async set(v) { this.db._set(this.parts, JSON.parse(JSON.stringify(v === undefined ? null : v))); }
  async update(map) {
    for (const [k, v] of Object.entries(map || {})) {
      this.db._set([...this.parts, ...split(k)], v === undefined ? null : JSON.parse(JSON.stringify(v)));
    }
  }
  async remove() { this.db._set(this.parts, null); }
  push() {
    const key = `-Fake${String(Date.now()).padStart(13, "0")}${String(++this.db._push).padStart(5, "0")}`;
    return new FakeRef(this.db, [...this.parts, key]);
  }
  async transaction(fn) {
    if (this.db.coldTransactions) {
      const guess = fn(null);
      // Aborting on the cold-cache null is the bug; the real client would
      // never try the real value.
      if (guess === undefined) {
        const val = present(this.db._get(this.parts));
        return { committed: false, snapshot: { val: () => (val === undefined ? null : val) } };
      }
    }
    const cur = present(this.db._get(this.parts));
    const next = fn(cur === undefined ? null : JSON.parse(JSON.stringify(cur)));
    if (next === undefined) {
      return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
    }
    this.db._set(this.parts, JSON.parse(JSON.stringify(next)));
    const after = present(this.db._get(this.parts));
    return { committed: true, snapshot: { val: () => (after === undefined ? null : after) } };
  }
}

module.exports = { FakeRtdb, clean, present };
