// ─── A PAGE IN THE WRONG ORDER MUST NOT MOVE THE CURSOR WRONG ────────────────
//
// THE INCIDENT (2026-09-21). Fifteen devices downloaded the same 670,547-byte
// page of /stock_movements 319 times in a morning. readChildPage returned
// snap.val(), which the SDK builds in KEY order, and runRangeLeg took the last
// entry as the next cursor. On the live page starting at
// srcoh_2026-07-13::115_0 the alphabetically-last key WAS that starting row,
// so the cursor stood still, the stuck guard threw, setup retried, and the
// same page came down again, for ever.
//
// Every test that existed passed, because the fake adapter handed its pages
// back already sorted in query order — it could not produce the one shape the
// real SDK produces. So this file has two fakes that can:
//
//   1. a KEY-ORDER adapter: the ordinary fake, with every page re-built the
//      way snap.val() builds it. It drives the ENGINE and proves the cursor is
//      taken as a maximum, not a position.
//   2. a fake FIREBASE SDK (vi.mock of firebase/database) that answers like
//      the live server measured on 2026-09-21: val() in key order, forEach in
//      query order, and startAfter + limitToFirst(n) coming back n-1 (on
//      /stock, 1 asked → ZERO returned). It drives the REAL rtdbAdapter and the
//      REAL startOfflineMirror, to completion, over mixed keyspaces.
//
// The server's ordering in the fake SDK is written here independently of
// src/offline/rtdbOrder.js, so the two can disagree and a test can see it.
import { describe, test, expect, beforeEach, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const state = {
    tree: {},
    // "the server does not honour the bound on this path" — every page is the
    // first page. Used to prove a stuck leg is benched and its bytes bounded.
    ignoreBoundOn: null,
    reads: [],            // { path, rows, bytes }
  };
  const INT = /^-?(0*)\d{1,10}$/;
  const asInt = (k) => (INT.test(k) && Math.abs(Number(k)) <= 2147483647 ? Number(k) : null);
  const keyCmp = (a, b) => {
    if (a === b) return 0;
    const ai = asInt(a); const bi = asInt(b);
    if (ai !== null && bi !== null) return ai - bi || a.length - b.length;
    if (ai !== null) return -1;
    if (bi !== null) return 1;
    return a < b ? -1 : 1;
  };
  const typeRank = (v) => (v == null ? 0 : typeof v === "boolean" ? 1 : typeof v === "number" ? 2
    : typeof v === "string" ? 3 : 4);
  const valCmp = (a, b) => {
    const d = typeRank(a) - typeRank(b);
    if (d) return d;
    if (a == null || typeof a === "object" || a === b) return 0;
    return a < b ? -1 : 1;
  };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const at = (path) => {
    let n = state.tree;
    for (const s of String(path).split("/").filter(Boolean)) {
      if (n == null || typeof n !== "object") return undefined;
      n = n[s];
    }
    return n;
  };
  const write = (path, value) => {
    const segs = String(path).split("/").filter(Boolean);
    const last = segs.pop();
    let n = state.tree;
    for (const s of segs) { if (n[s] == null || typeof n[s] !== "object") n[s] = {}; n = n[s]; }
    if (value == null) delete n[last]; else n[last] = clone(value);
  };

  // A snapshot as the SDK gives it: val() in KEY order, forEach in QUERY order.
  const snapOf = (entries) => ({
    exists: () => entries.length > 0,
    val: () => {
      if (!entries.length) return null;
      const o = {};
      for (const [k, v] of [...entries].sort((a, b) => keyCmp(a[0], b[0]))) o[k] = clone(v);
      return o;
    },
    forEach: (cb) => {
      for (const [k, v] of entries) if (cb({ key: k, val: () => clone(v) }) === true) return true;
      return false;
    },
  });
  const valueSnap = (v) => ({
    exists: () => v !== undefined && v !== null,
    val: () => (v === undefined ? null : clone(v)),
    forEach: () => false,
  });

  function run(q) {
    const node = at(q.path);
    if (!node || typeof node !== "object") return [];
    const ob = q.cons.find((c) => c.type === "orderByKey" || c.type === "orderByChild");
    const byChild = ob?.type === "orderByChild";
    const pos = ([k, v]) => ({ key: k, value: byChild ? (v && typeof v === "object" ? v[ob.field] : null) : null });
    const cmp = (a, b) => (byChild ? valCmp(a.value, b.value) || keyCmp(a.key, b.key) : keyCmp(a.key, b.key));
    let entries = Object.entries(node).filter(([, v]) => v != null);
    entries.sort((a, b) => cmp(pos(a), pos(b)));
    const sa = q.cons.find((c) => c.type === "startAt");
    const saf = q.cons.find((c) => c.type === "startAfter");
    const bound = sa ?? saf;
    if (bound && state.ignoreBoundOn !== q.path) {
      entries = entries.filter((e) => {
        const p = pos(e);
        if (!byChild) return keyCmp(p.key, String(bound.value)) >= 0;
        const c = valCmp(p.value, bound.value);
        if (c !== 0) return c > 0;
        return bound.key == null || keyCmp(p.key, String(bound.key)) >= 0;
      });
    }
    const lf = q.cons.find((c) => c.type === "limitToFirst");
    const ll = q.cons.find((c) => c.type === "limitToLast");
    if (lf) entries = entries.slice(0, lf._limit);
    if (ll) entries = entries.slice(-ll._limit);
    // MEASURED LIVE: the server counts the startAfter row against the limit
    // and the SDK drops it, so the page comes back one short.
    if (saf) entries = entries.filter(([k]) => k !== String(saf.value));
    return entries;
  }

  const c = (type, extra) => ({ type, ...extra });
  const module = {
    ref: (_db, path = "") => ({ path }),
    query: (r, ...cons) => ({ path: r.path, cons }),
    orderByKey: () => c("orderByKey"),
    orderByChild: (field) => c("orderByChild", { field }),
    startAt: (value = null, key) => c("startAt", { value, key }),
    startAfter: (value = null, key) => c("startAfter", { value, key }),
    endAt: (value = null, key) => c("endAt", { value, key }),
    limitToFirst: (n) => c("limitToFirst", { _limit: n }),
    limitToLast: (n) => c("limitToLast", { _limit: n }),
    async get(q) {
      if (!q.cons) {
        const v = at(q.path);
        state.reads.push({ path: q.path, rows: null, bytes: JSON.stringify(v ?? null).length });
        return valueSnap(v);
      }
      const entries = run(q);
      state.reads.push({
        path: q.path, rows: entries.length,
        bytes: JSON.stringify(Object.fromEntries(entries)).length,
      });
      return snapOf(entries);
    },
    async set(r, value) { write(r.path, value); },
    onValue(r, cb) { cb(valueSnap(r.path === ".info/connected" ? true : at(r.path))); return () => {}; },
    onChildAdded() { return () => {}; },
  };
  return { state, module, write, keyCmp };
});

vi.mock("firebase/database", () => sdk.module);
vi.mock("../../firebase", () => ({ database: {}, auth: {}, storage: {} }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (auth, cb) => { cb({ uid: "u1", isAnonymous: false }); return () => {}; },
}));
vi.mock("../../update/updateChecker", () => ({
  setForcedUpdateMode: () => {}, setUpdateBusy: () => {},
}));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import {
  createSyncEngine, CURSOR_META, SETUP_META_PREFIX, LEG_MAX_ATTEMPTS, LEG_RETRY_BASE_MS,
  LEG_RETRY_MAX_MS,
} from "../sync";
import { FEED_CURSOR_META } from "../changeFeed";
import { createRtdbAdapter } from "../rtdbAdapter";
import { startOfflineMirror } from "../bootstrap";
import { MIRROR_LEGS } from "../nodes";
import { isLegUsable, getLegHealth, recordLegFailed } from "../health";
import { setMirrorSwitchValue, _resetMirrorSwitchForTests } from "../killSwitch";
import { _resetServingForTests, isLegServing } from "../serving";
import { _resetMirrorSignalForTests } from "../mirrorSignal";
import {
  compareKeys, compareChildOrder, maxKey, keyAsInt, pageEntries,
} from "../rtdbOrder";

const T0 = 1_790_000_000_000;
const ISO = (i) => new Date(Date.UTC(2026, 6, 1) + i * 60_000).toISOString();

// ── THE KEYSPACES ────────────────────────────────────────────────────────────

// /stock_movements, shaped like the live node: push keys, "sold:" keys and
// "srcoh_" keys, with ts interleaved across all three. ONE srcoh_ key, at
// position 1500 of 4,500: it is the alphabetically-largest key of page one
// AND of the page that starts from it — the live incident, exactly.
function mixedMovements(n = 4500) {
  const out = {};
  for (let i = 0; i < n; i += 1) {
    let key;
    if (i === 1500) key = "srcoh_2026-07-13::115_0";
    else if (i % 7 === 3) key = `sold:${String(n - i).padStart(6, "0")}`;
    else key = pushKeyForMs(T0 - (n - i) * 5000, String(i).padStart(12, "A"));
    out[key] = { ts: ISO(i), type: i % 7 === 3 ? "sold" : "transfer_out", productId: `p${i % 50}`, qty: 1 };
  }
  return out;
}

// A second shape: many rows sharing ONE ts, so the key alone orders them.
function sharedTsMovements() {
  const out = {};
  for (let i = 0; i < 2600; i += 1) {
    const key = i % 3 === 0 ? `srcoh_${String(i).padStart(5, "0")}` : `-Ox${String(i).padStart(6, "0")}`;
    out[key] = { ts: i < 2400 ? ISO(0) : ISO(i), type: "received" };
  }
  return out;
}

const intKeyed = (n, value) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [String(i + 1), value(i)]));

function fullTree({ movements = mixedMovements() } = {}) {
  const products = Object.fromEntries(Array.from({ length: 1200 }, (_, i) =>
    [`p${String(i).padStart(4, "0")}`, { id: `p${String(i).padStart(4, "0")}`, name: `shoe ${i}` }]));
  const stockAt = (q) => ({ p0001: { 9: { qty: q } }, p0002: { 10: { qty: q + 1 } } });
  return {
    mirror_switch: { enabled: true },
    locations: { hub1: { id: "hub1" }, "marathon-pe": { id: "marathon-pe" } },
    users: { u1: { name: "Zee" } },
    products,
    // pageSize 1: on the live server startAfter(limit 1) answered NOTHING.
    stock: { base: stockAt(1), hub1: stockAt(2), "marathon-pe": stockAt(3), trophy: stockAt(4) },
    // "001".."650": RTDB reads these as INTEGERS (leading zeros allowed).
    orders: Object.fromEntries(Array.from({ length: 650 }, (_, i) => {
      const id = String(i + 1).padStart(3, "0");
      return [id, { id, destShop: "marathon-pe" }];
    })),
    // Integer keys and string keys together: ints first, numerically.
    customers: { ...intKeyed(1200, (i) => ({ name: `c${i}` })), c_walkin: { name: "walk-in" }, zz: { name: "z" } },
    refill_requests: Object.fromEntries(Array.from({ length: 30 }, (_, i) =>
      [pushKeyForMs(T0 - i * 1000, "R".repeat(12)), { status: "open" }])),
    // depth 2, pageSize 2: five stores is three pages.
    settings: {
      displaySlots: Object.fromEntries(["base", "hub1", "hub2", "marathon-pe", "trophy"].map((s) =>
        [s, { p0001: { slot: 1 }, p0002: { slot: 2 } }])),
    },
    // depth 2, pageSize 20: 45 days is three pages.
    restock_log: Object.fromEntries(Array.from({ length: 45 }, (_, i) =>
      [`2026-08-${String((i % 28) + 1).padStart(2, "0")}_${i}`, { a: { pid: "p1" } }])),
    insights_log: Object.fromEntries(Array.from({ length: 4500 }, (_, i) =>
      [pushKeyForMs(T0 - (4500 - i) * 1000, String(i).padStart(12, "A")), { timestamp: i, type: "sale" }])),
    stock_movements: movements,
  };
}

// What the census would say, counted from the tree by each leg's DEPTH alone —
// independently of flattenPage — exactly as functions/mirrorChanges counts.
function census(tree, at) {
  const nodeAt = (p) => p.split("/").reduce((n, s) => (n == null ? n : n[s]), tree);
  const count = (v, depth) => {
    if (v == null) return 0;
    if (depth === 0) return 1;
    if (typeof v !== "object") return 0;
    return Object.values(v).reduce((n, c) => n + count(c, depth - 1), 0);
  };
  return Object.fromEntries(MIRROR_LEGS.map((l) => [l.name, { rows: count(nodeAt(l.node), l.depth), at }]));
}

// ── FAKE 1: THE ORDINARY FAKE, WITH EVERY PAGE BUILT THE WAY snap.val() IS ────
function keyOrdered(page) {
  if (!page) return page;
  const o = {};
  for (const [k, v] of Object.entries(page).sort((a, b) => sdk.keyCmp(a[0], b[0]))) o[k] = v;
  return o;
}
function keyOrderWorld(tree) {
  const w = createFakeRtdb(tree);
  const real = { ...w.adapter };
  w.adapter.readChildPage = async (...a) => keyOrdered(await real.readChildPage(...a));
  w.adapter.readKeyPage = async (...a) => keyOrdered(await real.readKeyPage(...a));
  return w;
}

beforeEach(() => {
  store.clear();
  sdk.state.tree = {};
  sdk.state.ignoreBoundOn = null;
  sdk.state.reads = [];
  _resetMirrorSwitchForTests();
  _resetServingForTests();
  _resetMirrorSignalForTests();
  setMirrorSwitchValue(true);
});

describe("RTDB's ordering, as the comparators see it", () => {
  test("keys: integers first and numerically, then strings by code unit", () => {
    const keys = ["srcoh_2026-07-13::115_0", "sold:000001", "-Oxa6OS_dncbsTC1LRBS", "123", "27", "1", "001", "abc"];
    expect([...keys].sort(compareKeys))
      .toEqual(["1", "001", "27", "123", "-Oxa6OS_dncbsTC1LRBS", "abc", "sold:000001", "srcoh_2026-07-13::115_0"]);
    // …and it agrees with the fake server's independent copy on every pair.
    for (const a of keys) for (const b of keys) {
      expect(Math.sign(compareKeys(a, b))).toBe(Math.sign(sdk.keyCmp(a, b)));
    }
  });

  test("integer keys: 32-bit only, leading zeros allowed", () => {
    expect(keyAsInt("001")).toBe(1);
    expect(keyAsInt("2147483647")).toBe(2147483647);
    expect(keyAsInt("2147483648")).toBe(null);
    expect(keyAsInt("-Ox1")).toBe(null);
    expect(maxKey(["99", "123", "1"])).toBe("123");      // a string max says "99"
  });

  test("child order: absent < boolean < number < string < object, then key", () => {
    const rows = [
      { value: "2026-07-14T06:59:28.120Z", key: "srcoh_2026-07-13::115_0" },
      { value: "2026-07-15T14:10:44.343Z", key: "-Oxa6OS_dncbsTC1LRBS" },
      { value: 5, key: "z" }, { value: null, key: "zz" }, { value: true, key: "a" },
      { value: "2026-07-14T06:59:28.120Z", key: "-Oa" },
    ];
    const sorted = [...rows].sort(compareChildOrder).map((r) => r.key);
    expect(sorted).toEqual(["zz", "a", "z", "-Oa", "srcoh_2026-07-13::115_0", "-Oxa6OS_dncbsTC1LRBS"]);
  });

  test("a Map page and an object page read the same; Object.entries of a Map is the trap", () => {
    const m = new Map([["b", 1], ["a", 2]]);
    expect(pageEntries(m)).toEqual([["b", 1], ["a", 2]]);
    expect(pageEntries({ a: 2, b: 1 })).toEqual([["a", 2], ["b", 1]]);
    expect(Object.entries(m)).toEqual([]);                 // why pageEntries exists
  });
});

describe("the ENGINE, given pages in KEY order (the #624 fleet loop)", () => {
  test("the movements walk reaches the end of a mixed keyspace — it never stands still", async () => {
    const db = await freshMirrorDb();
    const tree = fullTree();
    const w = keyOrderWorld(tree);
    const e = createSyncEngine({ db, adapter: w.adapter, now: () => T0, buildVersion: "b1" });
    const leg = MIRROR_LEGS.find((l) => l.name === "movements");

    const res = await e.runRangeLeg(leg);
    expect(res.rows).toBe(4500);
    // The cursor is the TRUE last row by (ts, key), not the page's last key.
    const cursor = await db.getMeta(CURSOR_META("movements"));
    const last = Object.entries(tree.stock_movements)
      .sort((a, b) => a[1].ts.localeCompare(b[1].ts) || sdk.keyCmp(a[0], b[0])).at(-1);
    expect(cursor).toEqual({ ts: last[1].ts, key: last[0] });
    // Three pages of 2,000 — not a page read over and over.
    expect(w.calls.readChildPage.length).toBe(3);
  });

  test("the SAME walk resumes from the stuck cursor the fleet is holding, and moves", async () => {
    const db = await freshMirrorDb();
    const w = keyOrderWorld(fullTree());
    await db.setMeta(CURSOR_META("movements"), { ts: ISO(1500), key: "srcoh_2026-07-13::115_0" });
    const e = createSyncEngine({ db, adapter: w.adapter, now: () => T0, buildVersion: "b1" });
    await e.runRangeLeg(MIRROR_LEGS.find((l) => l.name === "movements"));
    expect(await db.count("movements")).toBe(3000);          // rows 1500..4499
    expect((await db.getMeta(CURSOR_META("movements"))).ts).toBe(ISO(4499));
  });

  test("rows sharing one ts are ordered by key, and none is lost", async () => {
    const db = await freshMirrorDb();
    const w = keyOrderWorld(fullTree({ movements: sharedTsMovements() }));
    const e = createSyncEngine({ db, adapter: w.adapter, now: () => T0, buildVersion: "b1" });
    await e.runRangeLeg(MIRROR_LEGS.find((l) => l.name === "movements"));
    expect(await db.count("movements")).toBe(2600);
  });

  test("integer-keyed customers land whole — no overlapping pages, no did-not-land", async () => {
    const db = await freshMirrorDb();
    const w = keyOrderWorld(fullTree());
    const e = createSyncEngine({ db, adapter: w.adapter, now: () => T0, buildVersion: "b1" });
    const res = await e.downloadSnapshotLeg(MIRROR_LEGS.find((l) => l.name === "customers"));
    expect(res.rows).toBe(1202);
    // 1,202 rows at 500 a page is three pages. A string max ("99") re-read
    // most of page one as page two.
    expect(w.calls.readKeyPage.filter((c) => c.path === "customers").length).toBe(3);
  });
});

describe("the REAL adapter against a server that answers like the live one", () => {
  test("readChildPage is built with forEach: its last entry IS the query's last row", async () => {
    sdk.state.tree = fullTree();
    const a = createRtdbAdapter({ db: {} });
    const page = await a.readChildPage("stock_movements", "ts", {
      from: ISO(1500), fromKey: "srcoh_2026-07-13::115_0", limit: 2000,
    });
    const keys = [...page.keys()];
    expect(keys[0]).toBe("srcoh_2026-07-13::115_0");
    expect(page.get(keys.at(-1)).ts).toBe(ISO(3499));
    // snap.val()'s last key, for contrast, is the row the page started on.
    const val = Object.keys((await sdk.module.get(sdk.module.query(
      sdk.module.ref(null, "stock_movements"), sdk.module.orderByChild("ts"),
      sdk.module.startAt(ISO(1500), "srcoh_2026-07-13::115_0"), sdk.module.limitToFirst(2000)))).val());
    expect(val.at(-1)).toBe("srcoh_2026-07-13::115_0");
  });

  test("readKeyPage is never short: startAt + one extra, cursor row dropped", async () => {
    sdk.state.tree = fullTree();
    const a = createRtdbAdapter({ db: {} });
    const p1 = await a.readKeyPage("stock", { limit: 1 });
    expect([...p1.keys()]).toEqual(["base"]);
    const p2 = await a.readKeyPage("stock", { after: "base", limit: 1 });
    expect([...p2.keys()]).toEqual(["hub1"]);          // startAfter answered NOTHING here
    const c = await a.readKeyPage("customers", { after: "99", limit: 5 });
    expect([...c.keys()]).toEqual(["100", "101", "102", "103", "104"]);
  });

  test("a page is weighed as the JSON it was on the wire", async () => {
    sdk.state.tree = fullTree();
    let bytes = 0;
    const a = createRtdbAdapter({ db: {}, onBytes: (n) => { bytes += n; } });
    const page = await a.readKeyPage("orders", { limit: 50 });
    expect(bytes).toBe(JSON.stringify(Object.fromEntries(page)).length);
  });
});

// A controllable clock that ADVANCES when a timer fires, so a backoff is real.
function clockAndTimers() {
  let now = T0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeoutFn: (fn, ms) => { seq += 1; pending.set(seq, { fn, due: now + ms }); return seq; },
    clearTimeoutFn: (id) => { pending.delete(id); },
    async fireNext() {
      const next = [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) return false;
      pending.delete(next[0]);
      now = Math.max(now, next[1].due);
      await next[1].fn();
      await new Promise((r) => setImmediate(r));
      return true;
    },
    pending: () => pending.size,
  };
}

// Waits for `promise`, firing the fake timers it is waiting on. IndexedDB work
// is REAL async work, so between timers this yields real time rather than
// giving up the moment no timer is pending.
async function settle(promise, t, maxTimers = 50) {
  let done = false;
  let value;
  let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  const deadline = Date.now() + 20_000;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
    if (done) break;
    // Quiet for a moment and a timer is pending: that is what it waits on.
    if (t.pending() > 0 && maxTimers > 0) {
      await new Promise((r) => setTimeout(r, 20));
      if (!done) { maxTimers -= 1; await t.fireNext(); }
    }
  }
  if (error) throw error;
  return { done, value };
}

async function startReal(t, db) {
  return startOfflineMirror({
    auth: { currentUser: { uid: "u1", isAnonymous: false } },
    storage: null,
    buildVersion: "test",
    now: t.now,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    openDb: async () => db,
    makeAdapter: (opts) => createRtdbAdapter({ db: {}, ...opts }),
  });
}

describe("END TO END: the real start function, the real adapter, to COMPLETION", () => {
  test("every leg lands, the census agrees with every count, and every leg serves", async () => {
    const tree = fullTree();
    tree.mirror_counts = census(tree, T0);
    sdk.state.tree = tree;
    const db = await freshMirrorDb();
    const t = clockAndTimers();
    const rt = await startReal(t, db);
    await rt.consentAndDownload();
    const { done } = await settle(rt.downloadInBackground(), t);
    expect(done).toBe(true);

    const setup = await rt.setupState();
    expect(setup.legs.filter((l) => !l.ready)).toEqual([]);
    expect(setup.done).toBe(true);
    expect(rt.state.setupError).toBe(null);
    expect(rt.state.setupCensus.drifted).toEqual([]);
    expect(rt.state.setupCensus.checked.length).toBe(MIRROR_LEGS.length);
    expect(await db.count("movements")).toBe(4500);
    expect(await db.count("insights")).toBe(4500);
    expect(await db.count("customers")).toBe(1202);
    expect(await db.count("orders")).toBe(650);
    expect(await db.count("products")).toBe(1200);
    expect(await db.count("stock")).toBe(8);                 // 4 locations × 2 products
    expect(await db.count("displaySlots")).toBe(10);
    expect(await db.count("restockLog")).toBe(45);
    for (const name of ["products", "movements", "customers", "orders", "insights"]) {
      expect(isLegServing(name)).toBe(true);
    }

    // BOUNDED: no page of /stock_movements was read twice. 4,500 rows at
    // 2,000 a page is exactly three reads.
    const mv = sdk.state.reads.filter((r) => r.path === "stock_movements");
    expect(mv.length).toBe(3);
    rt.stop();
  });

  test("the device's report names the pager, and a copy the old pager took is retired", async () => {
    const tree = fullTree();
    tree.mirror_counts = census(tree, T0);
    sdk.state.tree = tree;
    const db = await freshMirrorDb();
    // A device holding a products copy stamped by the old pager (no `pager`).
    const t0 = clockAndTimers();
    const first = await startReal(t0, db);
    await first.consentAndDownload();
    await settle(first.downloadInBackground(), t0);
    first.stop();
    await db.setMeta(`${SETUP_META_PREFIX}products`, { at: T0, rows: 1200 });

    const t = clockAndTimers();
    const rt = await startReal(t, db);
    // Retired at START, before anything trusts the old serving hint.
    expect(await isLegUsable(db, "products")).toBe(false);
    expect((await getLegHealth(db, "products")).reason).toBe("re-paging");
    expect(isLegServing("products")).toBe(false);
    await rt.resume();
    await settle(rt.downloadInBackground(), t);
    expect(await isLegUsable(db, "products")).toBe(true);
    expect((await db.getMeta(`${SETUP_META_PREFIX}products`)).pager).toBe(2);
    rt.stop();
  });
});

describe("a leg that cannot advance is BENCHED, and costs a bounded number of bytes", () => {
  test("three attempts a session, backed off, reported, and then the download stops", async () => {
    const tree = fullTree();
    tree.mirror_counts = census(tree, T0);
    sdk.state.tree = tree;
    // The server stops honouring the bound on this path: every page is page 1.
    sdk.state.ignoreBoundOn = "stock_movements";
    const db = await freshMirrorDb();
    const t = clockAndTimers();
    const rt = await startReal(t, db);
    await rt.consentAndDownload();
    const { done } = await settle(rt.downloadInBackground(), t, 200);
    expect(done).toBe(true);

    // Every OTHER leg finished: one failing leg no longer holds the rest back.
    const notReady = (await rt.setupState()).legs.filter((l) => !l.ready).map((l) => l.leg);
    expect(notReady).toEqual(["movements"]);
    expect(rt.state.downloading).toBe(false);
    expect(rt.state.setupError.gaveUp).toEqual(["movements"]);

    // THE BYTE BOUND: page one (which lands, and moves the cursor), then one
    // page per failed attempt — never a restart from the beginning.
    const mv = sdk.state.reads.filter((r) => r.path === "stock_movements");
    expect(mv.length).toBe(1 + LEG_MAX_ATTEMPTS);
    // Every one of those reads was THE SAME first page (the server ignores the
    // bound), so the whole leg cost exactly (1 + attempts) × one page.
    const onePage = JSON.stringify(Object.fromEntries(Object.entries(tree.stock_movements)
      .sort((a, b) => a[1].ts.localeCompare(b[1].ts) || sdk.keyCmp(a[0], b[0])).slice(0, 2000))).length;
    expect(mv.every((r) => r.bytes === onePage)).toBe(true);
    expect(mv.reduce((n, r) => n + r.bytes, 0)).toBe((1 + LEG_MAX_ATTEMPTS) * onePage);

    // …and nothing more, however long the app stays open.
    for (let i = 0; i < 30; i += 1) if (!(await t.fireNext())) break;
    expect(sdk.state.reads.filter((r) => r.path === "stock_movements").length).toBe(1 + LEG_MAX_ATTEMPTS);

    // The fleet screen can SEE it: /mirror_devices names the leg.
    const devices = Object.values(sdk.state.tree.mirror_devices ?? {});
    expect(devices).toHaveLength(1);
    const rec = devices[0];
    expect(rec.failing).toEqual([
      { leg: "movements", attempts: LEG_MAX_ATTEMPTS, reason: "MirrorCursorStuckError", benched: true },
    ]);
    expect(rec.guard.leg).toBe("movements");
    expect(rec.guard.reason).toBe("gave-up");
    expect(rec.complete).toBe(false);
    // …and no copy is served on the strength of a download that did not finish.
    expect(isLegServing("movements")).toBe(false);
    // The legs that DID land were censused and are served, and the pass loop
    // keeps them current — a give-up does not freeze the rest of the device.
    expect(rt.state.setupCensus.drifted).toEqual([]);
    expect(isLegServing("products")).toBe(true);
    expect(rt.state.lastPass).not.toBe(null);
    rt.stop();
  });

  test("attempts are spaced by the backoff, not back to back", async () => {
    const tree = fullTree();
    sdk.state.tree = tree;
    sdk.state.ignoreBoundOn = "stock_movements";
    const db = await freshMirrorDb();
    let now = T0;
    const e = createSyncEngine({
      db, adapter: createRtdbAdapter({ db: {} }), now: () => now, buildVersion: "b1",
    });
    const leg = MIRROR_LEGS.find((l) => l.name === "movements");
    await expect(e.runSetup()).rejects.toThrow(/cannot advance/);
    const readsAfterFirst = sdk.state.reads.filter((r) => r.path === "stock_movements").length;
    // Straight away again: the leg is backing off, so it is NOT read.
    await expect(e.runSetup()).rejects.toThrow();
    expect(sdk.state.reads.filter((r) => r.path === "stock_movements").length).toBe(readsAfterFirst);
    expect(e.legFailures()).toEqual([expect.objectContaining({ leg: leg.name, attempts: 1, benched: false })]);
    now += LEG_RETRY_BASE_MS;
    await expect(e.runSetup()).rejects.toThrow(/cannot advance/);
    expect(e.legFailures()[0].attempts).toBe(2);
  });
});

describe("a change feed that cannot advance is benched too, and serves nothing stale", () => {
  test("three stuck pages, then no more feed reads this session and the change-fed legs read live", async () => {
    const tree = fullTree();
    tree.mirror_counts = census(tree, T0);
    sdk.state.tree = tree;
    const db = await freshMirrorDb();
    let now = T0;
    const e = createSyncEngine({ db, adapter: createRtdbAdapter({ db: {} }), now: () => now, buildVersion: "b1" });
    await e.runSetup();
    expect(await isLegUsable(db, "products")).toBe(true);

    // A leg already failing for its OWN reason, still serving its last good
    // copy (a refused shrink does exactly this).
    await recordLegFailed(db, "customers", {
      path: "customers", reason: "shrank", at: now, state: "failed", retryable: false, heldRows: 1202,
    });
    expect(await isLegUsable(db, "customers")).toBe(true);

    // A cursor, then a log whose every key sorts BEFORE it, and a server that
    // ignores the bound: every page is one that cannot move the cursor.
    const cursor = pushKeyForMs(now, "zzzzzzzzzzzz");
    await db.setMeta(FEED_CURSOR_META, cursor);
    sdk.state.tree.mirror_changes = Object.fromEntries(Array.from({ length: 3 }, (_, i) =>
      [pushKeyForMs(now - 60_000 + i, "A".repeat(12)), { n: "products", k: "p0001" }]));
    sdk.state.ignoreBoundOn = "mirror_changes";
    const before = sdk.state.reads.filter((r) => r.path === "mirror_changes").length;
    const feedReads = () => sdk.state.reads.filter((r) => r.path === "mirror_changes").length - before;

    for (let i = 0; i < 6; i += 1) {
      const rep = await e.runPass();
      if (i === 0) expect(rep.errors[0]).toMatchObject({ where: "feed", reason: "FeedCursorStuckError" });
      now += LEG_RETRY_MAX_MS;                      // past any backoff
    }
    expect(feedReads()).toBe(LEG_MAX_ATTEMPTS);
    expect(e.legFailures().find((f) => f.leg === "changeFeed")).toMatchObject({ attempts: LEG_MAX_ATTEMPTS, benched: true });
    // Nothing keeps the change-fed legs current now, so none is served…
    expect(await isLegUsable(db, "products")).toBe(false);
    expect((await getLegHealth(db, "products")).reason).toBe("feed-stuck");
    expect(await isLegUsable(db, "customers")).toBe(false);
    expect((await getLegHealth(db, "customers")).reason).toBe("shrank");
    // …and none is re-downloaded to make up for it.
    expect(await e.legIsSetUp(MIRROR_LEGS.find((l) => l.name === "products"))).toBe(true);

    // NEXT OPEN: a new session (fresh ledger), and the feed works again. The
    // legs it had stopped serving are vouched for again — not left live for ever.
    sdk.state.ignoreBoundOn = null;
    sdk.state.tree.mirror_changes = {
      [pushKeyForMs(now, "zzzzzzzzzzzz")]: { n: "products", k: "p0001" },
      [pushKeyForMs(now + 1, "A".repeat(12))]: { n: "products", k: "p0002" },
    };
    await db.setMeta(FEED_CURSOR_META, pushKeyForMs(now, "zzzzzzzzzzzz"));
    const next = createSyncEngine({ db, adapter: createRtdbAdapter({ db: {} }), now: () => now, buildVersion: "b1" });
    const rep = await next.runPass();
    expect(rep.feed.applied).toBeGreaterThan(0);
    expect(await isLegUsable(db, "products")).toBe(true);
    // The shrink-refused leg was unserved too, and gets its OWN vouch back
    // with its own reason intact — it is not stranded.
    expect(await isLegUsable(db, "customers")).toBe(true);
    expect((await getLegHealth(db, "customers")).reason).toBe("shrank");
  });
});

describe("a range leg benched in the steady state stops being served", () => {
  test("its history is missing today, so screens read it live — and it is not retried", async () => {
    const tree = fullTree();
    sdk.state.tree = tree;
    const db = await freshMirrorDb();
    let now = T0;
    const e = createSyncEngine({ db, adapter: createRtdbAdapter({ db: {} }), now: () => now, buildVersion: "b1" });
    await e.runSetup();
    expect(await isLegUsable(db, "movements")).toBe(true);

    sdk.state.ignoreBoundOn = "stock_movements";      // every page is page one now
    const before = sdk.state.reads.filter((r) => r.path === "stock_movements").length;
    for (let i = 0; i < 6; i += 1) { await e.runPass(); now += LEG_RETRY_MAX_MS; }
    expect(sdk.state.reads.filter((r) => r.path === "stock_movements").length - before).toBe(LEG_MAX_ATTEMPTS);
    expect(await isLegUsable(db, "movements")).toBe(false);
    expect((await getLegHealth(db, "movements")).reason).toBe("gave-up");
    // A snapshot leg is unaffected: the feed keeps it current.
    expect(await isLegUsable(db, "products")).toBe(true);
  });
});
