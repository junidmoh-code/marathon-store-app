// ─── STOCK AUDIT — the daily pass's I/O contract (node --test) ───────────────
// The one thing this feature promised is that it costs the refill scan nothing
// it was not already paying. These tests are that promise, written down: a fake
// db records EVERY path the pass touches, and each case asserts the exact read
// set — not "few reads", the exact list, so a future read added by accident
// fails here rather than on the bandwidth bill.
//
// Also covered: the kill switch, the once-a-day date claim, the claim-before-
// work ordering, and the two failures that must not cost anything else (a store
// that throws, and display keys that cannot be read).

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const pass = require("../stockAudit/dailyPass.cjs");

const DUE = Date.parse("2026-09-07T05:10:00.000Z");   // Mon 07:10 SAST — a rotation day
const EARLY = Date.parse("2026-09-07T04:00:00.000Z"); // Mon 06:00 SAST

// ── a recording fake ─────────────────────────────────────────────────────────
// REAL RTDB DELETES EMPTY CHILDREN, so the fake's `set` drops an empty object
// exactly as the database would — a fake that stored `{}` where the database
// stores nothing would let a "the node exists" assumption pass here and fail
// live.
function makeDb(data = {}) {
  const reads = [], writes = [], txns = [];
  const at = (path) => path.split("/").reduce((o, k) => (o == null ? undefined : o[k]), data);
  const put = (path, v) => {
    const parts = path.split("/");
    let o = data;
    for (const k of parts.slice(0, -1)) o = (o[k] = o[k] && typeof o[k] === "object" ? o[k] : {});
    const last = parts[parts.length - 1];
    const empty = v === null || v === undefined || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);
    if (empty) delete o[last]; else o[last] = v;
  };
  const db = {
    ref(path = "") {
      return {
        once: async () => { reads.push(path); return { val: () => { const v = at(path); return v === undefined ? null : v; }, exists: () => at(path) !== undefined }; },
        transaction: async (fn) => {
          txns.push(path);
          const cur = at(path);
          const next = fn(cur === undefined ? null : cur);
          if (next === undefined) return { committed: false, snapshot: { val: () => cur, exists: () => cur !== undefined } };
          put(path, next);
          return { committed: true, snapshot: { val: () => next, exists: () => next !== null } };
        },
      };
    },
    _reads: reads, _writes: writes, _txns: txns, _data: data,
  };
  db._setFn = async (_db, path, value) => { writes.push(path); put(path, value); return true; };
  db._updFn = async (_db, upd) => { for (const [k, v] of Object.entries(upd)) { writes.push(k); put(k, v); } return true; };
  return db;
}

const PRODUCTS = {
  a: { name: "Tee", productType: "clothing" },
  b: { name: "Hoodie", productType: "clothing" },
  s1: { name: "Air Force 1", category: "Footwear" },
};
const STOCK = {
  "marathon-pe": { a: { M: { qty: 3 } }, b: { M: { qty: 2 } } },
  trophy: { a: { L: { qty: 2 } } },
  hub1: { s1: { 9: { qty: 2 } } },
};
const ORDERS = {
  "1": { productType: "sneaker", placedAtHub: "hub1", productId: "s1", productName: "Air Force 1",
         size: "9", status: "out_of_stock", outOfStockAt: new Date(DUE - 3600e3).toISOString() },
};
const SNAPSHOT = { stock: STOCK, products: PRODUCTS, orders: ORDERS, movements: [] };
const QUIET = { error: () => {}, warn: () => {}, log: () => {} };

const run = (db, over = {}) => pass.runStockAuditPass({
  db, app: {}, nowMs: DUE, ...SNAPSHOT,
  setFn: db._setFn, updFn: db._updFn, log: QUIET,
  shallowKeys: async () => [], ...over,
});

// ── the kill switch ──────────────────────────────────────────────────────────
test("absent config = today's behaviour: ONE read, no writes, no computation", async () => {
  const db = makeDb({});
  const res = await run(db);
  assert.deepEqual(res, { skipped: "disabled" });
  assert.deepEqual(db._reads, ["settings/stockAudit/config"]);
  assert.deepEqual(db._writes, []);
  assert.deepEqual(db._txns, []);
});

test("enabled:false is off, and only `true` is on", async () => {
  for (const v of [false, "true", 1, null]) {
    const db = makeDb({ settings: { stockAudit: { config: { enabled: v } } } });
    assert.equal((await run(db)).skipped, "disabled");
    assert.deepEqual(db._reads, ["settings/stockAudit/config"]);
  }
});

// ── the hour gate is free ────────────────────────────────────────────────────
test("before the pass hour: the date node is not even read", async () => {
  const db = makeDb({ settings: { stockAudit: { config: { enabled: true } } } });
  const res = await pass.runStockAuditPass({
    db, app: {}, nowMs: EARLY, ...SNAPSHOT,
    setFn: db._setFn, updFn: db._updFn, log: QUIET, shallowKeys: async () => [],
  });
  assert.equal(res.skipped, "before_pass_hour");
  assert.deepEqual(db._reads, ["settings/stockAudit/config"]);
  assert.deepEqual(db._writes, []);
});

test("already ran today: two tiny reads, nothing else", async () => {
  const db = makeDb({ settings: { stockAudit: { config: { enabled: true }, state: { lastPassDate: "2026-09-07" } } } });
  const res = await run(db);
  assert.equal(res.skipped, "already_ran_today");
  assert.deepEqual(db._reads, ["settings/stockAudit/config", "settings/stockAudit/state"]);
  assert.deepEqual(db._writes, []);
  assert.deepEqual(db._txns, []);
});

// ── THE COST CONTRACT ────────────────────────────────────────────────────────
test("the due pass reads EXACTLY its own state — nothing the scan already read", async () => {
  const db = makeDb({ settings: { stockAudit: { config: { enabled: true } } } });
  const shallow = [];
  const res = await run(db, { shallowKeys: async (_app, p) => { shallow.push(p); return []; } });
  assert.equal(res.saDate, "2026-09-07");
  assert.deepEqual(res.wrote, ["hub1", "hub2", "marathon-pe", "trophy"]);

  // The hub lists cost NOTHING to read: /orders, /stock and /products are all
  // already in the scan's memory. Only the shops' own rotation stamps are read.
  assert.deepEqual(db._reads, [
    "settings/stockAudit/config",
    "settings/stockAudit/state",
    "settings/stockAudit/rotation/marathon-pe",
    "settings/stockAudit/rotation/trophy",
  ]);
  // The expensive nodes — the whole reason this pass rides on the scan.
  for (const forbidden of ["stock", "products", "stock_movements", "refill_requests",
                           "insights_log", "orders", "stock_targets", "displayChecks_active"]) {
    assert.equal(db._reads.some((r) => r === forbidden || r.startsWith(`${forbidden}/`)), false,
      `the pass must never read /${forbidden} — the scan already holds it`);
  }
  // The ONLY shallow reads left are the results-node prunes. The 1.8 MB
  // display-registration read this feature once needed is gone with the
  // clothing half of Tab A.
  assert.deepEqual(shallow, [
    "settings/stockAudit/hub/hub1/results",
    "settings/stockAudit/hub/hub2/results",
    "settings/stockAudit/marathon-pe/results",
    "settings/stockAudit/trophy/results",
  ]);
  assert.equal(shallow.some((p) => p.startsWith("displayChecks")), false);
});

test("the day is claimed BEFORE the work, so a crash costs one day and not a loop", async () => {
  const db = makeDb({ settings: { stockAudit: { config: { enabled: true } } } });
  await run(db, { shallowKeys: async () => { throw new Error("boom"); }, setFn: async () => { throw new Error("boom"); } });
  assert.equal(db._data.settings.stockAudit.state.lastPassDate, "2026-09-07");
  assert.deepEqual(db._txns, ["settings/stockAudit/state/lastPassDate"]);
  // and the next run of the same day does nothing at all
  const before = db._reads.length;
  assert.equal((await run(db)).skipped, "already_ran_today");
  assert.equal(db._reads.length - before, 2);
});

test("a concurrent writer that already claimed today wins; we do no work", async () => {
  const db = makeDb({ settings: { stockAudit: { config: { enabled: true } } } });
  // state read returns nothing, but the node is claimed before our transaction
  const realRef = db.ref.bind(db);
  db.ref = (p) => {
    const r = realRef(p);
    if (p === "settings/stockAudit/state") return { ...r, once: async () => { db._reads.push(p); return { val: () => null }; } };
    return r;
  };
  db._data.settings.stockAudit.state = { lastPassDate: "2026-09-07" };
  const res = await run(db);
  assert.equal(res.skipped, "claimed_elsewhere");
  assert.deepEqual(db._writes, []);
});

// ── what the pass writes ─────────────────────────────────────────────────────
test("one snapshot per hub and per shop, and the batch is remembered", async () => {
  const db = makeDb({ settings: { stockAudit: { config: { enabled: true } } } });
  await run(db);
  assert.deepEqual(db._writes, [
    "settings/stockAudit/hub/hub1/latest",
    "settings/stockAudit/hub/hub2/latest",
    "settings/stockAudit/marathon-pe/latest",
    "settings/stockAudit/state/batch/marathon-pe",
    "settings/stockAudit/trophy/latest",
    "settings/stockAudit/state/batch/trophy",
  ]);
  // the hub that turned a customer away, against a cell it still believes has two
  const hub = db._data.settings.stockAudit.hub.hub1.latest;
  assert.equal(hub.hub, "hub1");
  assert.deepEqual(hub.oos.rows.map((r) => [r.k, r.r, r.q]), [["s1__9__hub1", "out_of_stock", 2]]);
  // a hub with nothing to check still gets a list, so the card is never blank
  assert.deepEqual(db._data.settings.stockAudit.hub.hub2.latest.oos.rows, []);

  const shop = db._data.settings.stockAudit["marathon-pe"].latest;
  assert.equal(shop.store, "marathon-pe");
  assert.equal(shop.saDate, "2026-09-07");
  assert.equal(shop.oos, undefined, "a shop carries no hub tab");
  assert.deepEqual(db._data.settings.stockAudit.state.batch["marathon-pe"].pids, shop.rotation.rows.map((r) => r.p));
});

test("one list failing does not cost any of the others", async () => {
  const db = makeDb({ settings: { stockAudit: { config: { enabled: true } } } });
  let n = 0;
  // the FIRST hub write throws; every later list must still land
  await run(db, { setFn: async (d, p, v) => { if (++n === 1) throw new Error("boom"); return db._setFn(d, p, v); } });
  assert.equal(db._data.settings.stockAudit.hub.hub1, undefined);
  assert.equal(db._data.settings.stockAudit.hub.hub2.latest.hub, "hub2");
  assert.equal(db._data.settings.stockAudit["marathon-pe"].latest.store, "marathon-pe");
  assert.equal(db._data.settings.stockAudit.trophy.latest.store, "trophy");
});

// ── results pruning ──────────────────────────────────────────────────────────
test("result day nodes are pruned past the keep window, and only those", () => {
  const keys = ["2026-09-07", "2026-09-01", "2026-07-08", "2026-07-09", "2026-01-01", "latest", "not-a-date"];
  const gone = pass.prunableResultDays(keys, "2026-09-07", 60);
  assert.deepEqual(gone.sort(), ["2026-01-01", "2026-07-08"]);
  // exactly 60 days back survives; 61 does not
  assert.deepEqual(pass.prunableResultDays(["2026-07-09"], "2026-09-07", 60), []);
  assert.deepEqual(pass.prunableResultDays([], "2026-09-07", 60), []);
});

test("the pass deletes the pruned day nodes and nothing adjacent", async () => {
  const db = makeDb({ settings: { stockAudit: { config: { enabled: true } } } });
  await run(db, { shallowKeys: async (_a, p) => (p.endsWith("/results") ? ["2026-01-01", "2026-09-06"] : []) });
  assert.ok(db._writes.includes("settings/stockAudit/marathon-pe/results/2026-01-01"));
  assert.equal(db._writes.includes("settings/stockAudit/marathon-pe/results/2026-09-06"), false);
  // hubs are pruned on the same rule
  assert.ok(db._writes.includes("settings/stockAudit/hub/hub1/results/2026-01-01"));
  assert.equal(db._writes.includes("settings/stockAudit/hub/hub1/results/2026-09-06"), false);
});

// ── the batch carries over, and rotates on rotation days ─────────────────────
test("the standing batch is carried on a non-rotation day and re-minted on one", async () => {
  const TUE = Date.parse("2026-09-08T05:10:00.000Z");
  const db = makeDb({ settings: { stockAudit: {
    config: { enabled: true, batchSize: 1 },
    state: { lastPassDate: "2026-09-07", batch: { "marathon-pe": { date: "2026-09-07", pids: ["b"] } } },
  } } });
  await run(db, { nowMs: TUE });
  const snap = db._data.settings.stockAudit["marathon-pe"].latest;
  assert.equal(snap.rotation.refreshed, false);
  assert.deepEqual(snap.rotation.rows.map((r) => r.p), ["b"]);

  const WED = Date.parse("2026-09-09T05:10:00.000Z");
  db._data.settings.stockAudit.rotation = { "marathon-pe": { b: { at: TUE, o: "present" } } };
  await run(db, { nowMs: WED });
  const snap2 = db._data.settings.stockAudit["marathon-pe"].latest;
  assert.equal(snap2.rotation.refreshed, true);
  assert.deepEqual(snap2.rotation.rows.map((r) => r.p), ["a"], "the checked product goes to the back");
});

// ── the one call that is not the Admin SDK ───────────────────────────────────
test("the shallow read is BOUNDED — a stalled fetch must not hold the scan's run lock", async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, signal: opts?.signal });
    return { ok: true, json: async () => ({ "a__M": true, "b__L": true }) };
  };
  try {
    const app = { options: { databaseURL: "https://db.example.com", credential: { getAccessToken: async () => ({ access_token: "t" }) } } };
    const keys = await pass.restShallowKeys(app, "displayChecks_active/trophy");
    assert.deepEqual(keys, ["a__M", "b__L"]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\?shallow=true$/);
    // The token travels in the header, never the query string (logs).
    assert.equal(calls[0].url.includes("t"), calls[0].url.includes("t"));
    assert.equal(/access_token|auth=/.test(calls[0].url), false);
    // AN ABORT SIGNAL IS PRESENT AND ARMED. `fetch` has no default timeout, and
    // this runs inside refillHealthScan while it holds the engine's exclusive
    // run lock — a hang would let the 10-minute steal fire under a live run.
    assert.ok(calls[0].signal, "no AbortSignal was passed to fetch");
    assert.equal(typeof calls[0].signal.aborted, "boolean");
    assert.ok(pass.SHALLOW_TIMEOUT_MS > 0 && pass.SHALLOW_TIMEOUT_MS <= 60e3);
  } finally { global.fetch = realFetch; }
});

test("a non-OK shallow response is an error, not an empty key list", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    const app = { options: { databaseURL: "https://db.example.com", credential: { getAccessToken: async () => ({ access_token: "t" }) } } };
    await assert.rejects(() => pass.restShallowKeys(app, "displayChecks_active/trophy"), /403/);
  } finally { global.fetch = realFetch; }
});
