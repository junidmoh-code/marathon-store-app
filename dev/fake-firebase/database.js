// DEV ONLY — firebase/database stand-in for the sky app harness
// (dev/vite.harness.config.mjs aliases the real SDK to this file). It answers
// every read from the synthetic tree in ./fixture.js, applies the query
// constraints the app uses (orderByChild/Key, equalTo, start/end, limit), and
// records writes on window.__fakeWrites without applying them, so a screen
// behaves as it would on a live read and nothing ever reaches a database.
// The RTDB REST ?shallow=true reads (shopifyPublishStore) are answered here
// too, by wrapping fetch for the database host only.
import { FIXTURE } from "./fixture.js";

const DB = { __fake: true };
const norm = (p) => String(p || "").split("/").filter(Boolean).join("/");
const at = (path) => {
  let v = FIXTURE;
  for (const seg of norm(path).split("/").filter(Boolean)) { if (v == null || typeof v !== "object") return null; v = v[seg]; }
  return v === undefined ? null : v;
};
const log = (op, path, value) => { if (typeof window !== "undefined") (window.__fakeWrites ||= []).push({ op, path, value }); };

export function getDatabase(app) { if (app) DB.app = app; return DB; }
export function ref(_db, path = "") { const p = norm(path); return { __ref: true, path: p, key: p.split("/").pop() || null, toString: () => p }; }
export function child(r, p) { return ref(DB, `${r.path}/${p}`); }
export function query(r, ...constraints) { return { ...r, constraints: [...(r.constraints || []), ...constraints] }; }
export const orderByChild = (k) => ({ t: "orderBy", k });
export const orderByKey = () => ({ t: "orderBy", k: null });
export const equalTo = (v) => ({ t: "eq", v });
export const startAt = (v) => ({ t: "ge", v });
export const startAfter = (v) => ({ t: "gt", v });
export const endAt = (v) => ({ t: "le", v });
export const endBefore = (v) => ({ t: "lt", v });
export const limitToLast = (n) => ({ t: "last", n });
export const limitToFirst = (n) => ({ t: "first", n });
export const serverTimestamp = () => ({ ".sv": "timestamp" });
export const increment = (n) => ({ ".sv": { increment: n } });

function entriesOf(val, constraints = []) {
  if (val == null || typeof val !== "object") return null;
  const ob = constraints.find((c) => c.t === "orderBy");
  const keyOf = ([k, v]) => (ob && ob.k ? (v && typeof v === "object" ? v[ob.k] : undefined) : k);
  let rows = Object.entries(val);
  if (ob) rows.sort((a, b) => { const x = keyOf(a), y = keyOf(b); return x === y ? (a[0] < b[0] ? -1 : 1) : x == null ? -1 : y == null ? 1 : x < y ? -1 : 1; });
  for (const c of constraints) {
    if (c.t === "eq") rows = rows.filter((e) => keyOf(e) === c.v);
    if (c.t === "ge") rows = rows.filter((e) => keyOf(e) != null && keyOf(e) >= c.v);
    if (c.t === "gt") rows = rows.filter((e) => keyOf(e) != null && keyOf(e) > c.v);
    if (c.t === "le") rows = rows.filter((e) => keyOf(e) != null && keyOf(e) <= c.v);
    if (c.t === "lt") rows = rows.filter((e) => keyOf(e) != null && keyOf(e) < c.v);
  }
  for (const c of constraints) {
    if (c.t === "last") rows = rows.slice(-c.n);
    if (c.t === "first") rows = rows.slice(0, c.n);
  }
  return rows;
}

function snap(path, val, constraints) {
  const rows = constraints && constraints.length ? entriesOf(val, constraints) : null;
  const v = rows ? (rows.length ? Object.fromEntries(rows) : null) : val;
  const list = rows || (v && typeof v === "object" ? Object.entries(v) : []);
  return {
    key: norm(path).split("/").pop() || null,
    ref: ref(DB, path),
    val: () => (v === undefined ? null : structuredClone(v)),
    exportVal: () => structuredClone(v ?? null),
    exists: () => v != null,
    hasChildren: () => list.length > 0,
    numChildren: () => list.length,
    get size() { return list.length; },
    child: (p) => snap(`${path}/${p}`, at(`${path}/${p}`)),
    hasChild: (p) => at(`${path}/${p}`) != null,
    forEach: (fn) => { for (const [k, cv] of list) { if (fn(snap(`${path}/${k}`, cv)) === true) return true; } return false; },
  };
}

export async function get(r) { return snap(r.path, at(r.path), r.constraints); }
export function onValue(r, cb, errOrOpts, maybeOpts) {
  const t = setTimeout(() => cb(snap(r.path, at(r.path), r.constraints)), 0);
  void errOrOpts; void maybeOpts;
  return () => clearTimeout(t);
}
export function onChildAdded(r, cb) {
  const t = setTimeout(() => { for (const [k, v] of entriesOf(at(r.path), r.constraints) || []) cb(snap(`${r.path}/${k}`, v)); }, 0);
  return () => clearTimeout(t);
}
export async function set(r, value) { log("set", r.path, value); }
export async function update(r, value) { log("update", r.path, value); }
export async function remove(r) { log("remove", r.path); }
let pushN = 0;
export function push(r, value) {
  const k = `-harness${(pushN++).toString(36)}`;
  const c = ref(DB, `${r.path}/${k}`);
  if (value !== undefined) log("push", c.path, value);
  const p = Promise.resolve(c);
  return Object.assign(c, { then: p.then.bind(p), catch: p.catch.bind(p) });
}
export async function runTransaction(r, fn) {
  const next = fn(structuredClone(at(r.path)));
  log("transaction", r.path, next);
  return { committed: next !== undefined, snapshot: snap(r.path, next ?? at(r.path)) };
}
export function onDisconnect() { return { set: async () => {}, update: async () => {}, remove: async () => {}, cancel: async () => {} }; }
export function goOffline() {}
export function goOnline() {}

// The REST shallow reads: answered from the fixture, never sent.
if (typeof window !== "undefined" && !window.__fakeFetch) {
  window.__fakeFetch = true;
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input?.url || "");
    const m = url.match(/^https:\/\/[^/]*firebasedatabase\.app\/(.*?)\.json(\?.*)?$/);
    if (m) {
      const v = at(decodeURIComponent(m[1]));
      const body = /shallow=true/.test(m[2] || "") && v && typeof v === "object" ? Object.fromEntries(Object.keys(v).map((k) => [k, true])) : v;
      return new Response(JSON.stringify(body ?? null), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (/googleapis\.com|firebaseio\.com|firebasedatabase\.app|cloudfunctions\.net|firebasestorage/.test(url)) {
      return new Response("null", { status: 200 });
    }
    return real(input, init);
  };
}
