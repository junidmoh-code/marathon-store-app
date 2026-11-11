// ─── ONE DEVICE, ONE TRADING DAY, EVERY BYTE COUNTED ─────────────────────────
//
// THIS IS A SIMULATION, NOT A MEASUREMENT. It drives the real sync engine
// through a day of passes against the fake RTDB and weighs every value the
// adapter hands back, the way rtdbAdapter.measureBytes does on a device. What
// it can establish is what the ENGINE asks for; what a real tablet reads is
// measured on the fleet screen after deploy.
//
// The day is built from the fleet's own numbers:
//
//   · leg sizes are the live node sizes and /mirror_counts of 11 Nov 2026
//     (rows × bytes-per-row chosen to land on the measured megabytes);
//   · the change traffic is the /mirror_changes record count of a real day,
//     by node — 8 Nov (2,730 records, ordinary) and 10 Nov (6,188 records, the
//     display re-check that set off the storm: 700 displaySlots rows, 448
//     displayRows, 272 register rows, 1,316 refill rows);
//   · the device is open from 08:00 to 18:00 SAST and passes once a minute,
//     which is the floor cadence; it is reloaded once, at 13:00.
//
// The two big histories are seeded with a short tail only: their first
// download is not part of a steady day, and a forward walk costs the same
// whatever is behind it.
//
// SIZE. By default the five big legs nothing in the day's story turns on
// (/stock, /customers, the refill and restock nodes) are built at a tenth of
// their live row count, so the suite stays quick; the legs the storm ran
// through — /products and the three settings legs — are always full size.
// `MIRROR_SIM_FULL=1 npx vitest run src/offline/__tests__/simulatedDay.test.js`
// builds everything at its live size; the figures quoted in the docs are from
// that run. A day's bytes are the same either way to within a rounding (they
// are the day's traffic); only the setup download and the expired-cursor
// re-download scale.
//
// WHAT RUNS WHEN. The three 600-pass days run in the everyday suite (about
// ten seconds each). The ~5,000-pass signal-driven day, run twice, takes a
// minute and runs with MIRROR_SIM_FULL=1.
//
// ON THE BUILD BEFORE THIS ONE the "10 Nov" day below, run from this same file
// at full size, read 1,295 MB: from its 14:00 census check to 18:00 it walked
// displaySlots, displayRows, displayRegister and the refill-request leg 60
// times each. The fleet's measured figures for the real day are in
// docs/store-offline-mirror.md §12a.
import { describe, test, expect } from "vitest";
import "./helpers";                      // installs the IDBKeyRange global
import { IDBFactory } from "fake-indexeddb";
import { openMirrorDb } from "../db";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import { createSyncEngine } from "../sync";
import { LEG_BY_NAME, MIRROR_LEGS, isAppendOnly } from "../nodes";
import { COUNTS_ROOT, CHANGES_ROOT, FEED_CURSOR_META, CHANGE_RETENTION_MS } from "../changeFeed";
import { CANONICAL_LOCATION_IDS } from "../locationIds";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;
// 10 Nov 2026, SAST = UTC+2.
const sast = (h, m = 0) => Date.UTC(2026, 10, 10, h - 2, m);
const SETUP_AT = sast(0) - 4 * HOUR;          // 20:00 the evening before
const CENSUS_AT = sast(4, 15);
const OPEN_AT = sast(8);
const CLOSE_AT = sast(18);
const RELOAD_AT = sast(13);

const FULL = typeof process !== "undefined" && process.env?.MIRROR_SIM_FULL === "1";
const big = (n) => (FULL ? n : Math.ceil(n / 10));
const pad = (n) => "x".repeat(Math.max(0, n));
const row = (id, bytes) => ({ id, pad: pad(bytes - 24 - String(id).length) });
const id = (prefix, i, width = 6) => `${prefix}${String(i).padStart(width, "0")}`;

// ── the shop, at its live size ───────────────────────────────────────────────
const N = (leg) => LEG_BY_NAME[leg].node;
const STORES = [...CANONICAL_LOCATION_IDS].slice(0, 10);
const HUBS = STORES.slice(0, 4);

function buildTree() {
  const tree = {
    locations: Object.fromEntries(STORES.map((s) => [s, { id: s, name: s }])),
    users: Object.fromEntries(Array.from({ length: 39 }, (_, i) => [id("u", i, 3), row(id("u", i, 3), 300)])),
    products: {}, stock: {}, orders: {}, customers: {},
    settings: { displaySlots: {}, displayRows: {}, hubSneakerCount: { register: {} } },
    insights_log: {}, stock_movements: {},
  };
  const put = (leg, segs, value) => {
    let node = tree;
    const path = [...N(leg).split("/"), ...segs];
    for (const s of path.slice(0, -1)) node = node[s] ?? (node[s] = {});
    node[path[path.length - 1]] = value;
  };
  for (let i = 0; i < 6092; i += 1) put("products", [id("p", i)], row(id("p", i), 970));          // 5.9 MB
  for (let i = 0; i < big(16715); i += 1) put("stock", [STORES[i % 10], id("p", Math.floor(i / 10))], row(i, 500));   // 8.4 MB
  for (let i = 0; i < 3584; i += 1) put("orders", [id("", i, 5)], { ...row(i, 400), destShop: "marathon-pe" });
  for (let i = 0; i < big(12661); i += 1) put("customers", [id("c", i)], row(i, 170));
  for (let i = 0; i < 1757; i += 1) put("displaySlots", [STORES[i % 9], id("p", Math.floor(i / 9))], row(i, 420));   // 0.74 MB
  for (let i = 0; i < 2160; i += 1) put("displayRows", [STORES[i % 3], id("p", Math.floor(i / 9)), id("r", i % 3 + 3 * (Math.floor(i / 3) % 3), 2)], row(i, 1170));   // 2.5 MB
  for (let i = 0; i < 1563; i += 1) put("displayRegister", [HUBS[i % 4], id("p", Math.floor(i / 4))], row(i, 650));   // 1.0 MB
  for (let i = 0; i < big(42310); i += 1) put("refills", [id("r", i)], row(i, 355));                    // 15 MB
  for (let i = 0; i < big(8327); i += 1) put("restockRequests", [id("2026-10-", i % 30, 2), id("k", i)], row(i, 300));
  for (let i = 0; i < big(20143); i += 1) put("restockLog", [id("2026-10-", i % 30, 2), id("k", i)], row(i, 420));   // 8.5 MB
  for (let i = 0; i < 2803; i += 1) put("returnsLog", [id("x", i)], row(i, 300));
  for (let i = 0; i < 2000; i += 1) {
    const at = SETUP_AT - DAY + i * 30_000;
    tree.insights_log[pushKeyForMs(at, id("", i, 12))] = row(i, 225);
    tree.stock_movements[id("m", i, 7)] = { ...row(i, 250), ts: new Date(at).toISOString() };
  }
  return tree;
}

// ── every byte the adapter hands back, by what asked for it ─────────────────
function meter(w) {
  const bytes = {};
  const reads = {};
  const add = (kind, value) => {
    const n = value === null || value === undefined ? 4 : JSON.stringify(value).length;
    bytes[kind] = (bytes[kind] ?? 0) + n;
    reads[kind] = (reads[kind] ?? 0) + 1;
  };
  const legNodes = new Set(MIRROR_LEGS.map((l) => l.node));
  const a = w.adapter;
  const { readPath, readKeyPage, readChildPage, shallowKeys, lastKey } = a;
  a.readPath = async (path, opts) => {
    const v = await readPath(path, opts);
    add(path === COUNTS_ROOT ? "census" : legNodes.has(path) ? "WHOLE LEG" : "changed rows", v);
    return v;
  };
  a.readKeyPage = async (path, opts) => {
    const v = await readKeyPage(path, opts);
    const kind = path === CHANGES_ROOT ? "change log pages"
      : path === N("insights") ? "history pages" : "WHOLE LEG";
    add(kind, v);
    // ON THE WIRE the cursor's own row comes back too (the inclusive bound,
    // rtdbAdapter.keyPageConstraints) and the adapter drops it. The fake does
    // not send it, so it is weighed here.
    if (opts?.after !== null && opts?.after !== undefined) {
      const own = w.read(`${path}/${opts.after}`);
      if (own !== null) { bytes[kind] += JSON.stringify(own).length + String(opts.after).length + 4; }
    }
    return v;
  };
  a.readChildPage = async (path, field, opts) => { const v = await readChildPage(path, field, opts); add("history pages", v); return v; };
  a.shallowKeys = async (path) => {
    const keys = await shallowKeys(path);
    add("key lists", Object.fromEntries(keys.map((k) => [k, true])));
    return keys;
  };
  a.lastKey = async (path) => { const k = await lastKey(path); add("change log pages", k ? { [k]: w.read(`${path}/${k}`) } : null); return k; };
  return {
    bytes, reads,
    // The live signal delivers each new change record once (limitToLast(1)).
    signal: (record) => add("live signal", record),
    total: () => Object.values(bytes).reduce((x, y) => x + y, 0),
    reset: () => { for (const k of Object.keys(bytes)) { delete bytes[k]; delete reads[k]; } },
  };
}

// ── a day's writes, from a real day's change-record counts ──────────────────
//
// { leg: [records, new rows, deleted rows] } — the rest are edits of rows that
// exist. `displayHours` is where the display work falls (the 10 Nov re-check
// ran 12:00–16:00); everything else is spread across the open day.
const ORDINARY = {     // 8 Nov 2026: 2,730 records
  stock: [1161, 0, 0], orders: [598, 120, 100], refills: [571, 300, 0], customers: [131, 40, 0],
  products: [129, 0, 0], restockLog: [86, 86, 0], displaySlots: [31, 8, 4], displayRows: [23, 6, 2],
};
const MASS_EDIT = {    // 10 Nov 2026: 6,188 records
  refills: [1636, 1000, 0], stock: [1388, 0, 0], orders: [1076, 300, 100], displaySlots: [741, 300, 100],
  displayRows: [455, 200, 50], products: [277, 0, 0], displayRegister: [272, 150, 20],
  customers: [225, 100, 0], restockLog: [118, 118, 0],
};
const HISTORY = { insights: 3000, movements: 1500 };

function schedule(profile) {
  const minutes = (CLOSE_AT - OPEN_AT) / MIN;
  const events = Array.from({ length: minutes }, () => []);
  for (const [leg, [records, added, deleted]] of Object.entries(profile)) {
    const display = leg.startsWith("display");
    const from = display ? (sast(12) - OPEN_AT) / MIN : 0;
    const span = display ? (sast(16) - sast(12)) / MIN : minutes;
    for (let i = 0; i < records; i += 1) {
      const op = i < added ? "add" : i < added + deleted ? "delete" : "edit";
      events[from + Math.floor((i * span) / records)].push({ leg, op, i });
    }
  }
  for (const [leg, n] of Object.entries(HISTORY)) {
    for (let i = 0; i < n; i += 1) events[Math.floor((i * minutes) / n)].push({ leg, op: "append", i });
  }
  return events;
}

function existingKeys(tree, leg) {
  const out = [];
  const walk = (node, segs, depth) => {
    if (depth === 0) { out.push(segs); return; }
    for (const [k, v] of Object.entries(node ?? {})) walk(v, [...segs, k], depth - 1);
  };
  let node = tree;
  for (const s of N(leg).split("/")) node = node?.[s];
  walk(node, [], LEG_BY_NAME[leg].depth);
  return out;
}

const SIZE = {
  products: 970, stock: 500, orders: 400, customers: 170, displaySlots: 420, displayRows: 1170,
  displayRegister: 650, refills: 355, restockLog: 420,
};
const NEW_PARENT = {
  stock: [STORES[0]], displaySlots: [STORES[0]], displayRows: [STORES[0], "p900000"],
  displayRegister: [STORES[0]], restockLog: ["2026-11-10"],
};

// `signalPasses` — how many passes a minute the live signal asks for, at most
// (one per group of that minute's change records). 0 is the floor cadence
// alone: one pass a minute. `signalFlag: false` runs the very same passes
// WITHOUT telling the engine they were signal passes — what every pass cost
// before a signal pass stopped walking the two histories.
let simDbs = 0;
async function runDay({ profile, hole = 0, expireCursorAt = null, signalPasses = 0, signalFlag = true }) {
  const w = createFakeRtdb(buildTree());
  const m = meter(w);
  // Its own factory, so the test can reach the fake's transaction list: the
  // fake keeps every FINISHED transaction for ever and scans the whole list to
  // schedule each new one, which makes a 5,000-pass day quadratic (a pass went
  // from 25 ms to 700 ms). Nothing to do with the engine; pruned as we go.
  simDbs += 1;
  const factory = new IDBFactory();
  const dbName = `mirror-sim-${simDbs}`;
  const db = await openMirrorDb({ indexedDBFactory: factory, dbName });
  await db.ensureSchema({ buildVersion: "test" });
  const pruneFake = () => {
    const raw = factory._databases?.get(dbName);
    if (raw?.transactions) raw.transactions = raw.transactions.filter((tx) => tx._state !== "finished");
  };
  let t = SETUP_AT;
  const now = () => t;
  // The per-device download bound, shared across the reload exactly as
  // localStorage shares it on a device. Absent on the build before this one.
  const ledgerModule = await import("../downloadLedger").catch(() => null);
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  const open = () => createSyncEngine({
    db, adapter: w.adapter, now, buildVersion: "b1",
    ...(ledgerModule ? { downloadLedger: ledgerModule.createDownloadLedger({ now, storage }) } : {}),
  });

  // The evening before: the one setup download. Not part of the day.
  let engine = open();
  await engine.runSetup();
  const setupBytes = m.total();
  m.reset();

  // Overnight, `hole` products reach the server with NO change record — a
  // trigger that never ran. The 04:15 census counts them; this device cannot
  // know. That is the disagreement the census exists to catch.
  for (let i = 0; i < hole; i += 1) w.write(`${N("products")}/${id("hole", i)}`, row(id("hole", i), 970));
  const counts = {};
  for (const leg of MIRROR_LEGS) {
    counts[leg.name] = { rows: leg.depth === 0 ? (w.read(leg.node) === null ? 0 : 1) : existingKeys(w.tree, leg.name).length, at: CENSUS_AT };
  }
  w.write(COUNTS_ROOT, counts);

  const keys = Object.fromEntries(Object.keys(SIZE).map((leg) => [leg, existingKeys(w.tree, leg)]));
  const events = schedule(profile);
  let seq = 0;
  const walks = {};
  const walksBefore = w.calls.readKeyPage.length;
  const drifts = [];
  const repairs = [];
  let expired = false;

  let passes = 0;
  const apply = (ev) => {
    const at = t - MIN + 1 + (seq % 50_000);
    if (ev.op === "append") {
      if (ev.leg === "insights") w.write(`${N("insights")}/${pushKeyForMs(at, id("", seq, 12))}`, row(seq, 225));
      else w.write(`${N("movements")}/${id("n", seq, 7)}`, { ...row(seq, 250), ts: new Date(at).toISOString() });
      seq += 1;
      return;
    }
    const pool = keys[ev.leg];
    let segs;
    if (ev.op === "add") segs = [...(NEW_PARENT[ev.leg] ?? []), id("new", ev.i)];
    else if (ev.op === "delete") segs = pool[(ev.i * 7) % pool.length];
    else segs = pool[pool.length - 1 - ((ev.i * 13) % Math.floor(pool.length / 2))];
    const value = ev.op === "delete" ? null : row(`${ev.op}${ev.i}`, SIZE[ev.leg]);
    w.write(`${N(ev.leg)}/${segs.join("/")}`, value);
    const record = { n: N(ev.leg), k: segs.join("|"), t: at };
    w.write(`${CHANGES_ROOT}/${pushKeyForMs(at, id("", seq, 12))}`, record);
    m.signal({ [pushKeyForMs(at, id("", seq, 12))]: record });
    seq += 1;
  };
  const pass = async (signal) => {
    passes += 1;
    if (passes % 50 === 0) pruneFake();
    const report = await engine.runPass(signal && signalFlag ? { signal: true } : undefined);
    for (const d of report.census?.drifted ?? []) drifts.push(`${new Date(t + 2 * HOUR).toISOString().slice(11, 16)} ${d.leg}`);
    if (report.repaired) repairs.push(`${report.repaired.leg}${report.repaired.via ? ` (${report.repaired.via})` : " (walk)"}`);
    if (report.errors.some((e) => e.reason === "cursor-expired")) expired = true;
  };

  for (let minute = 0; minute < events.length; minute += 1) {
    const minuteAt = OPEN_AT + minute * MIN;
    t = minuteAt;
    if (t === RELOAD_AT) engine = open();                                  // the app is reloaded
    if (expireCursorAt !== null && t === expireCursorAt) {
      // This device's cursor has fallen off the back of the 30 days kept.
      await db.setMeta(FEED_CURSOR_META, pushKeyForMs(t - CHANGE_RETENTION_MS - HOUR, "AAAAAAAAAAAA"));
    }
    const changes = events[minute].filter((ev) => ev.op !== "append");
    const appends = events[minute].filter((ev) => ev.op === "append");
    const groups = signalPasses > 0 ? Math.min(signalPasses, changes.length) : 0;
    if (groups === 0) {
      // The floor cadence: everything this minute brought, then one pass.
      for (const ev of events[minute]) apply(ev);
      await pass(false);
      continue;
    }
    for (let g = 0; g < groups; g += 1) {
      t = minuteAt + Math.floor((g * MIN) / groups);
      if (g === 0) for (const ev of appends) apply(ev);
      for (let i = g; i < changes.length; i += groups) apply(changes[i]);
      await pass(true);                                                    // the signal asked for this one
    }
  }
  for (const c of w.calls.readKeyPage.slice(walksBefore)) {
    if (c.after !== null || c.path === CHANGES_ROOT) continue;
    const leg = MIRROR_LEGS.find((l) => l.node === c.path);
    if (leg && !isAppendOnly(leg)) walks[leg.name] = (walks[leg.name] ?? 0) + 1;
  }
  // The local copy is the server's, row for row, at the end of the day.
  const mismatched = [];
  for (const leg of Object.keys(SIZE)) {
    if ((await db.count(LEG_BY_NAME[leg].store)) !== existingKeys(w.tree, leg).length) mismatched.push(leg);
  }
  return {
    setupMB: setupBytes / MB, dayMB: m.total() / MB, bytes: { ...m.bytes }, reads: { ...m.reads },
    walks, drifts, repairs, expired, mismatched, state: await engine.setupState(), changes: seq, passes,
  };
}

const table = (label, r) => {
  const lines = Object.entries(r.bytes).sort((a, b) => b[1] - a[1])
    .map(([k, b]) => `    ${k.padEnd(18)} ${(b / MB).toFixed(2).padStart(7)} MB  ${String(r.reads[k]).padStart(6)} reads`);
  // eslint-disable-next-line no-console
  console.log(`\nSIMULATED DAY — ${label}\n  setup download (the evening before, not counted): ${r.setupMB.toFixed(1)} MB\n`
    + `  THE DAY: ${r.dayMB.toFixed(2)} MB in ${r.passes} passes\n${lines.join("\n")}\n`
    + `  whole-leg walks started: ${JSON.stringify(r.walks)}\n  census drifts: ${JSON.stringify(r.drifts)}\n`
    + `  repairs: ${JSON.stringify(r.repairs)}\n`);
};

describe("one device, one simulated trading day", () => {
  test("an ordinary day (8 Nov's traffic) stays under 5 MB, and no leg is read whole", async () => {
    const r = await runDay({ profile: ORDINARY });
    table("ordinary day: 8 Nov 2026 traffic, open 08:00–18:00, one reload", r);
    expect(r.walks).toEqual({});
    expect(r.bytes["WHOLE LEG"] ?? 0).toBe(0);
    expect(r.drifts).toEqual([]);
    expect(r.repairs).toEqual([]);
    expect(r.mismatched).toEqual([]);
    expect(r.state.done).toBe(true);
    expect(r.dayMB).toBeLessThan(5);
  }, 240_000);

  test("the 10 Nov day — a mass display edit AND a real census disagreement — reads no leg whole", async () => {
    // The day that cost the fleet 6.5 GB. 700 display slots, 448 display rows
    // and 272 register rows rewritten in four hours; and, so that the census
    // has something true to say, 200 products the feed never told this device
    // about.
    const r = await runDay({ profile: MASS_EDIT, hole: 200 });
    table("10 Nov 2026 traffic (the storm day) + 200 products missed by the feed", r);
    // The ONE real disagreement is found, once, and repaired by its keys. And
    // so is the mass edit, ONCE: the allowance for churn stops at a tenth of a
    // leg (so that it can never hide a leg that has lost rows), and 300 new
    // display slots on 1,757 is more than that. It costs a key list and twenty
    // sample rows — the copy turns out to match the server exactly — and that
    // census never asks about the leg again. (At a tenth of its live size the
    // refill leg crosses the same line; at its live size it does not, and it
    // is too big to diff in any case.)
    expect(r.drifts).toEqual(FULL
      ? ["08:00 products", "14:00 displaySlots"]
      : ["08:00 products", "14:00 displaySlots", "14:00 refills"]);
    expect(r.repairs.every((x) => x.endsWith("(key-diff)"))).toBe(true);
    expect(r.repairs.length).toBe(r.drifts.length);
    // …and nothing — nothing — is downloaded whole.
    expect(r.walks).toEqual({});
    expect(r.bytes["WHOLE LEG"] ?? 0).toBe(0);
    expect(r.mismatched).toEqual([]);
    expect(r.state.done).toBe(true);
    // More than twice an ordinary day's writes, each one a row this device
    // must fetch: the day is bounded by the traffic, not by a loop.
    expect(r.dayMB).toBeLessThan(8);
  }, 240_000);

  // PRODUCTION PASSES ARE MOSTLY SIGNAL PASSES. The 600-pass days above are the
  // floor cadence alone; on a real afternoon the live signal asks for a pass
  // after every burst of writes. Here it asks up to nine times a minute.
  test.skipIf(!FULL)("the same 10 Nov day in ~5,000 signal-driven passes costs the traffic, not the passes", async () => {
    const r = await runDay({ profile: MASS_EDIT, hole: 200, signalPasses: 9 });
    table("10 Nov traffic, signal-driven passes", r);
    expect(r.passes).toBeGreaterThan(4500);
    expect(r.walks).toEqual({});
    expect(r.mismatched).toEqual([]);
    expect(r.state.done).toBe(true);
    // Eight times the passes of the 600-pass day, and no more megabytes: a
    // signal pass reads one page of the change log and the rows it names.
    expect(r.dayMB).toBeLessThan(8);
    // The two histories were walked about every five minutes, not on every pass.
    expect(r.reads["history pages"]).toBeLessThan(600);

    const before = await runDay({ profile: MASS_EDIT, hole: 200, signalPasses: 9, signalFlag: false });
    table("…and the same passes with BOTH histories walked on every one (as before)", before);
    expect(before.reads["history pages"]).toBeGreaterThan(9000);
    expect(before.bytes["history pages"]).toBeGreaterThan(r.bytes["history pages"] + 1.5 * MB);
  }, 900_000);

  test("…and with the change cursor expiring at 15:00, every held leg is downloaded exactly ONCE", async () => {
    const r = await runDay({ profile: MASS_EDIT, hole: 200, expireCursorAt: sast(15) });
    table("10 Nov traffic + missed products + the cursor expiring at 15:00", r);
    expect(r.expired).toBe(true);
    const paged = MIRROR_LEGS.filter((l) => !isAppendOnly(l) && l.depth > 0).map((l) => l.name);
    expect(Object.keys(r.walks).sort()).toEqual([...paged].sort());
    for (const leg of paged) expect(r.walks[leg], leg).toBe(1);
    expect(r.mismatched).toEqual([]);
    expect(r.state.done).toBe(true);
    // One copy of the change-fed legs (the setup download less the two
    // histories), plus the day. Never a second copy.
    expect(r.dayMB).toBeLessThan(r.setupMB + 8);
  }, 240_000);
});
