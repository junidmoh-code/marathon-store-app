// A fake Realtime Database for the layout-shift harness: the snapshot's nodes,
// listeners, and writes that land after a delay and echo to every listener —
// the way the real database behaves under the screen. Never talks to Firebase.
const store = { root: {} };
const listeners = new Map();   // path → Set(cb)
const split = (p) => String(p || "").split("/").filter(Boolean);
const at = (path) => { let n = store.root; for (const k of split(path)) { if (n == null || typeof n !== "object") return null; n = n[k]; } return n ?? null; };
const put = (path, v) => {
  const ks = split(path); let n = store.root;
  for (let i = 0; i < ks.length - 1; i++) { if (n[ks[i]] == null || typeof n[ks[i]] !== "object") n[ks[i]] = {}; n[ks[i]] = Array.isArray(n[ks[i]]) ? { ...n[ks[i]] } : { ...n[ks[i]] }; n = n[ks[i]]; }
  if (v === null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = v;
};
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const snap = (path, v) => ({ val: () => clone(v), exists: () => v != null, key: split(path).pop() || null, forEach: (fn) => { for (const [k, x] of Object.entries(v || {})) fn({ key: k, val: () => clone(x) }); } });
const notify = (written) => {
  for (const [p, cbs] of listeners) {
    if (!written.some((w) => w === p || w.startsWith(`${p}/`) || p.startsWith(`${w}/`) || p === "")) continue;
    // copy-on-write above keeps unchanged subtrees identical, as the SDK does
    for (const cb of cbs) cb(snap(p, at(p)));
  }
};
export const LATENCY = { ms: 250 };
export function seed(root) { store.root = root; }
export const getDatabase = () => ({ fake: true });
export const ref = (_db, path) => ({ path: path ?? "", key: split(path).pop() || null, toString: () => path });
export const child = (r, p) => ref(null, `${r.path}/${p}`);
const q = (name) => (...a) => ({ q: name, a });
export const query = (r, ...parts) => ({ ...r, parts });
export const orderByChild = q("orderByChild"); export const orderByKey = q("orderByKey"); export const equalTo = q("equalTo");
export const startAt = q("startAt"); export const endAt = q("endAt"); export const endBefore = q("endBefore");
export const limitToLast = q("limitToLast"); export const limitToFirst = q("limitToFirst");
const filtered = (r) => {
  const v = at(r.path);
  const eq = (r.parts || []).find((x) => x.q === "equalTo");
  const by = (r.parts || []).find((x) => x.q === "orderByChild");
  if (eq && by && v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x && x[by.a[0]] === eq.a[0]));
  return v;
};
export function onValue(r, cb, _err) {
  const s = listeners.get(r.path) || new Set(); listeners.set(r.path, s);
  const fn = r.parts ? (x) => cb(snap(r.path, filtered(r))) : cb;
  s.add(fn);
  setTimeout(() => fn(snap(r.path, filtered(r))), 30);
  return () => s.delete(fn);
}
export const onChildAdded = () => () => {};
export const get = (r) => new Promise((res) => setTimeout(() => res(snap(r.path, filtered(r))), 40));
export const update = (r, patch) => new Promise((res) => setTimeout(() => {
  const base = r.path ? `${r.path}/` : "";
  const written = [];
  for (const [k, v] of Object.entries(patch || {})) { put(base + k, clone(v)); written.push(base + k); }
  notify(written); res();
}, LATENCY.ms));
export const set = (r, v) => update(ref(null, split(r.path).slice(0, -1).join("/")), { [split(r.path).pop()]: v });
export const remove = (r) => set(r, null);
let n = 0;
export const push = (r) => ({ ...ref(null, `${r.path}/-H${Date.now().toString(36)}${(n++).toString(36)}`) });
export const runTransaction = (r, fn) => new Promise((res) => setTimeout(() => {
  const cur = clone(at(r.path)); const next = fn(cur);
  if (next !== undefined) { put(r.path, clone(next)); notify([r.path]); }
  res({ committed: next !== undefined, snapshot: snap(r.path, next === undefined ? cur : next) });
}, LATENCY.ms));
export const serverTimestamp = () => Date.now();
export const increment = (x) => x;
export const goOffline = () => {}; export const goOnline = () => {};
export const onDisconnect = () => ({ set: async () => {}, remove: async () => {}, cancel: async () => {} });
