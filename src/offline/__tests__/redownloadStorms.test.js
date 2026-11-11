// ─── NO LEG IS DOWNLOADED AGAIN AND AGAIN ────────────────────────────────────
//
// The fleet read 21 GB on 30 Oct 2026 and 6.5 GB on 10 Nov (the devices' own
// byte counters), against 0.1–0.7 GB on an ordinary day. Every test below is
// one link of the chain that did it, or one of the two smaller leaks the same
// profiler captures showed:
//
//   · a day-old census compared with a live count        → "the stale census"
//   · the same census sending the same leg back for ever → "one repair per census"
//   · a backlog compared before it was applied           → "a copy still catching up"
//   · a whole-leg walk where a handful of rows would do  → "repaired by its keys"
//   · nothing counting downloads that SUCCEED            → "the daily bound"
//   · an expired cursor that expired again every pass    → "the expired-cursor trap"
import { describe, test, expect } from "vitest";
import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import {
  createSyncEngine, SETUP_DONE_META, SETUP_META_PREFIX, CENSUS_CHECK_MS, FEED_PAGES_PER_PASS,
  KEYDIFF_SAMPLE, KEYDIFF_MAX_LOCAL_KEYS, SIGNAL_RANGE_EVERY_MS, PARKED_CENSUS_EVERY_MS,
} from "../sync";
import { LEG_BY_NAME, MIRROR_LEGS, isAppendOnly } from "../nodes";
import { getLegHealth, isLegUsable } from "../health";
import {
  COUNTS_ROOT, CHANGES_ROOT, FEED_CURSOR_META, CHANGE_PAGE_SIZE, CHANGE_RETENTION_MS,
} from "../changeFeed";
import { createDownloadLedger, LEG_DOWNLOADS_PER_DAY, DOWNLOAD_WINDOW_MS } from "../downloadLedger";
import { TOUCHED_META } from "../censusJournal";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// 04:15 SAST on a trading day — when the census is counted.
const CENSUS_AT = Date.UTC(2026, 10, 10, 2, 15);

const SLOTS = "settings/displaySlots";

function slots(n, store = "marathon-pe") {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${String(i).padStart(5, "0")}`, { slot: i, store }]));
}

function world(extra = {}) {
  return createFakeRtdb({
    locations: { hub1: { id: "hub1" }, "marathon-pe": { id: "marathon-pe" } },
    users: { u1: { name: "Zee" } },
    products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
    stock: { hub1: { p1: { 9: { qty: 3 } } }, "marathon-pe": { p1: { 9: { qty: 1 } } } },
    orders: { "001": { id: "001", destShop: "marathon-pe" } },
    customers: { c1: { name: "Ndu" } },
    refill_requests: { r1: { status: "open" } },
    ...extra,
  });
}

function clock(start) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

function sharedStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}

const engine = (db, w, c, opts = {}) => createSyncEngine({
  db, adapter: w.adapter, now: c.now, buildVersion: "b1",
  downloadLedger: createDownloadLedger({ now: c.now, storage: sharedStorage() }),
  ...opts,
});

// A world whose adapter has no keys-only read — an older browser, or a device
// where the REST read is refused. Repairs fall back to the walk.
function withoutKeyRead(w) { delete w.adapter.shallowKeys; return w; }

// How many times a leg's walk was STARTED from its first page.
const wholeWalks = (w, node) => w.calls.readKeyPage.filter((c) => c.path === node && c.after === null).length;

let seq = 0;
// A write that the trigger recorded: the row changes AND a change record lands.
function change(w, node, key, value, at) {
  const leg = MIRROR_LEGS.find((l) => l.node === node);
  w.write(`${node}/${key.split("|").join("/")}`, value);
  seq += 1;
  w.write(`${CHANGES_ROOT}/${pushKeyForMs(at, String(seq).padStart(12, "0"))}`, { n: leg.node, k: key, t: at });
}

const census = (w, at, counts) => w.write(COUNTS_ROOT,
  Object.fromEntries(Object.entries(counts).map(([leg, rows]) => [leg, { rows, at }])));

describe("the stale census — a day-old count against a live one", () => {
  // 10 Nov 2026, exactly: the census counted 1,757 display slots at 04:15 and
  // by 16:00 a display re-check had written 700 of them. Tolerance: 35.
  test("a leg the feed has moved further than the tolerance is NOT called a drift", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);                     // set up the evening before
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { displaySlots: 1000 });

    // The trading day: 100 NEW slots, every one with its change record — four
    // times the 25-row tolerance — and 400 edits of slots already there.
    c.set(CENSUS_AT + 5 * HOUR);
    for (let i = 0; i < 100; i += 1) {
      change(w, SLOTS, `marathon-pe|n${String(i).padStart(4, "0")}`, { slot: 2000 + i }, CENSUS_AT + 4 * HOUR + i * 1000);
    }
    for (let i = 0; i < 400; i += 1) {
      change(w, SLOTS, `marathon-pe|p${String(i).padStart(5, "0")}`, { slot: i, edited: true }, CENSUS_AT + 4 * HOUR + (100 + i) * 1000);
    }
    const walksAfterSetup = wholeWalks(w, SLOTS);
    const report = await e.runPass();

    expect(report.feed.applied).toBe(500);
    expect(await db.count("displaySlots")).toBe(1100);         // 100 over a census of 1,000
    // The allowance came from the journal the FEED kept as it applied the
    // page — the change log was read once, to apply it, and not a second time
    // to work out what had changed.
    const journal = await db.getMeta(TOUCHED_META);
    // Only the 100 rows that are NEW: an edit does not change the count.
    expect(Object.values(journal.legs.displaySlots).reduce((a, b) => a + b, 0)).toBe(100);
    expect(w.calls.readKeyPage.filter((x) => x.path === CHANGES_ROOT).length).toBe(2);
    expect(report.census.checked).toContain("displaySlots");
    expect(report.census.drifted).toEqual([]);                 // …and it is not a drift
    expect(report.repaired).toBeNull();
    expect(wholeWalks(w, SLOTS)).toBe(walksAfterSetup);
    expect(await isLegUsable(db, "displaySlots")).toBe(true);
  });

  test("…and the same is true of mass DELETES, in the other direction", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { displaySlots: 1000 });
    c.set(CENSUS_AT + 5 * HOUR);
    for (let i = 0; i < 100; i += 1) {
      change(w, SLOTS, `marathon-pe|p${String(i).padStart(5, "0")}`, null, CENSUS_AT + 4 * HOUR + i * 1000);
    }
    const report = await e.runPass();
    expect(await db.count("displaySlots")).toBe(900);
    expect(report.census.drifted).toEqual([]);
    expect(await isLegUsable(db, "displaySlots")).toBe(true);
  });

  test("a device shut all night files last night's changes under last night", async () => {
    // The journal is keyed by when a change was RECORDED, not when this device
    // read it. 300 rows written BEFORE the census are in the census; replaying
    // them this morning must not widen today's allowance and hide a real hole.
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 20 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    for (let i = 0; i < 300; i += 1) {
      change(w, SLOTS, `marathon-pe|n${String(i).padStart(4, "0")}`, { slot: 2000 + i }, CENSUS_AT - 12 * HOUR + i * 1000);
    }
    // 100 more rows reached the server with NO change record: a real hole.
    for (let i = 0; i < 100; i += 1) w.write(`${SLOTS}/marathon-pe/hole${i}`, { slot: 9000 + i });
    census(w, CENSUS_AT, { displaySlots: 1400 });

    c.set(CENSUS_AT + 5 * HOUR);
    const report = await e.runPass();
    expect(report.feed.applied).toBe(300);
    expect(await db.count("displaySlots")).toBe(1400);         // repaired within the same pass…
    expect(report.census.drifted).toEqual([
      { leg: "displaySlots", held: 1300, census: 1400, allowed: 28 },   // …because 100 > 28: last night's 300 widened nothing
    ]);
  });

  test("a first setup at midday rebuilds the allowance from the change log's keys", async () => {
    // A new device has no journal: its feed starts from the head of the log,
    // hours after the census. What changed in between is read from the log —
    // pointer records only — so the forced check after setup is still fair.
    const c = clock(CENSUS_AT - 30 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    census(w, CENSUS_AT, { displaySlots: 1000 });
    for (let i = 0; i < 100; i += 1) {
      change(w, SLOTS, `marathon-pe|n${String(i).padStart(4, "0")}`, { slot: 2000 + i }, CENSUS_AT + 2 * HOUR + i * 1000);
    }
    c.set(CENSUS_AT + 6 * HOUR);
    const db = await freshMirrorDb();
    const e = engine(db, w, c);
    await e.runSetup();
    const rowReads = w.calls.readPath.length;
    const res = await e.checkCensus({ force: true });
    expect(res.checked).toContain("displaySlots");
    expect(res.drifted).toEqual([]);
    // Keys only: the one whole-path read is the census itself.
    expect(w.calls.readPath.slice(rowReads)).toEqual([COUNTS_ROOT]);
  });

  test("with NO journal and no way to rebuild one, the census is not evidence", async () => {
    const c = clock(CENSUS_AT + 6 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    const db = await freshMirrorDb();
    const e = engine(db, w, c);
    await e.runSetup();
    c.advance(2 * HOUR);                                       // not a copy that has JUST been downloaded
    census(w, CENSUS_AT, { displaySlots: 5000 });
    const real = w.adapter.readKeyPage;
    await db.setMeta(FEED_CURSOR_META, pushKeyForMs(c.now(), "zzzzzzzzzzzz"));
    w.adapter.readKeyPage = async (path, opts) => {
      if (path === CHANGES_ROOT) throw new Error("the log is unreachable");
      return real(path, opts);
    };
    const res = await e.checkCensus({ force: true });
    expect(res.unjudged).toContain("displaySlots");
    expect(res.drifted).toEqual([]);
    expect(await e.legIsSetUp(LEG_BY_NAME.displaySlots)).toBe(true);
  });
});

describe("the allowance cannot grow until it hides a leg that has LOST rows", () => {
  // The census exists to catch lost rows. An allowance that counted every row
  // the feed touched reached 40% of /settings/displaySlots on a busy day.
  test("edits — however many — leave the tolerance exactly where it was", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    // Every slot edited, half of them twice: 1,500 records, not one row added or removed.
    for (let i = 0; i < 1500; i += 1) {
      change(w, SLOTS, `marathon-pe|p${String(i % 1000).padStart(5, "0")}`, { slot: i, edited: i }, CENSUS_AT + HOUR + i * 1000);
    }
    // …and 60 rows the server holds that no record ever announced.
    for (let i = 0; i < 60; i += 1) w.write(`${SLOTS}/marathon-pe/hole${i}`, { slot: 9000 + i });
    census(w, CENSUS_AT, { displaySlots: 1060 });
    c.set(CENSUS_AT + 5 * HOUR);
    const report = await e.runPass();
    expect(report.feed.applied).toBe(1500);
    expect((await db.getMeta(TOUCHED_META)).legs.displaySlots).toBeUndefined();
    expect(report.census.drifted).toEqual([{ leg: "displaySlots", held: 1000, census: 1060, allowed: 25 }]);
  });

  test("a 15% truncation on the busiest of days is still caught: the churn allowance stops at a tenth of the leg", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(2000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { displaySlots: 2000 });
    // A day that swaps out a third of the node: 700 added, 700 removed.
    for (let i = 0; i < 700; i += 1) {
      change(w, SLOTS, `marathon-pe|n${String(i).padStart(4, "0")}`, { slot: 5000 + i }, CENSUS_AT + HOUR + i * 1000);
      change(w, SLOTS, `marathon-pe|p${String(i).padStart(5, "0")}`, null, CENSUS_AT + HOUR + i * 1000 + 1);
    }
    c.set(CENSUS_AT + 5 * HOUR);
    await e.runPass();
    expect(await db.count("displaySlots")).toBe(2000);
    // Now this device's copy loses 15% of its rows underneath it.
    const gone = (await db.getAllKeys("displaySlots")).slice(0, 300);
    await db.putPage("displaySlots", [], { deleteKeys: gone });
    const res = await e.checkCensus({ force: true, feedCaughtUp: true });
    // 2% (40) + a capped 10% (200), not 2% + 1,400.
    expect(res.drifted).toEqual([{ leg: "displaySlots", held: 1700, census: 2000, allowed: 240 }]);
  });

  test("a truncated FIRST download on a day too busy to journal is still caught", async () => {
    // More than 15,000 change records since the census: the journal cannot be
    // rebuilt inside its page budget. "Not judged" would serve this copy.
    const c = clock(CENSUS_AT + 6 * HOUR);
    const products = Object.fromEntries(Array.from({ length: 4654 }, (_, i) => [`p${String(i).padStart(5, "0")}`, { id: i }]));
    const w = world({ products });
    for (let i = 0; i < 15200; i += 1) {
      const at = CENSUS_AT + HOUR + i * 1000;
      w.write(`${CHANGES_ROOT}/${pushKeyForMs(at, String(i).padStart(12, "0"))}`, { n: "stock", k: `hub1|x${i}`, t: at });
    }
    census(w, CENSUS_AT, { products: 4654 });
    // The pager stops short: this device reads 799 of them.
    const real = w.adapter.readKeyPage;
    w.adapter.readKeyPage = async (path, opts) => {
      if (path !== "products") return real(path, opts);
      const page = await real(path, { ...opts, limit: 799 });
      return opts.after === null ? page : null;
    };
    const db = await freshMirrorDb();
    const e = engine(db, w, c);
    await e.runSetup();
    expect(await db.count("products")).toBe(799);
    const res = await e.checkCensus({ force: true });
    expect(res.drifted).toEqual([{ leg: "products", held: 799, census: 4654, allowed: 93 }]);
    expect(await isLegUsable(db, "products")).toBe(false);
  });
});

describe("the two histories: rows newer than the census are counted, not guessed", () => {
  // /insights_log gains a row per sale and /stock_movements several. A device
  // that has kept up holds every row written since 04:15 — more than the 5%
  // tolerance on a small or a busy shop — and that was "count-drift" too.
  function histories(n, endAt) {
    const insights = {};
    const movements = {};
    for (let i = 0; i < n; i += 1) {
      const at = endAt - (n - i) * 1000;
      insights[pushKeyForMs(at, String(i).padStart(12, "0"))] = { n: i };
      movements[`m${String(i).padStart(6, "0")}`] = { ts: new Date(at).toISOString(), n: i };
    }
    return { insights_log: insights, stock_movements: movements };
  }

  test("a day's new sales are not a drift, however many there are", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world(histories(1000, CENSUS_AT - 7 * HOUR));
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { insights: 1000, movements: 1000 });
    // 400 of each during the day: 40% over, against a tolerance of 5%.
    for (let i = 0; i < 400; i += 1) {
      const at = CENSUS_AT + HOUR + i * 1000;
      w.write(`insights_log/${pushKeyForMs(at, String(i).padStart(12, "0"))}`, { n: i });
      w.write(`stock_movements/n${String(i).padStart(6, "0")}`, { ts: new Date(at).toISOString(), n: i });
    }
    c.set(CENSUS_AT + 5 * HOUR);
    const report = await e.runPass();
    expect(await db.count("insights")).toBe(1400);
    expect(await db.count("movements")).toBe(1400);
    expect(report.census.checked).toEqual(expect.arrayContaining(["insights", "movements"]));
    expect(report.census.drifted).toEqual([]);
  });

  test("rows missing from BEFORE the census are still a drift — the allowance is only the new ones", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world(histories(1000, CENSUS_AT - 7 * HOUR));
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { insights: 1300 });                  // the server holds 300 this device never read
    for (let i = 0; i < 400; i += 1) {
      w.write(`insights_log/${pushKeyForMs(CENSUS_AT + HOUR + i * 1000, String(i).padStart(12, "0"))}`, { n: i });
    }
    c.set(CENSUS_AT + 5 * HOUR);
    const report = await e.runPass();
    // Held 1,400 against 1,300 looks CLOSER than it is; with the 400 new rows
    // taken off, this device has 1,000 of the census's 1,300.
    expect(report.census.drifted).toEqual([{ leg: "insights", held: 1000, census: 1300, allowed: 65 }]);
  });

  test("a history is NEVER key-diffed: its key list alone is megabytes, and it keeps its own forward walk", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const all = histories(1000, CENSUS_AT - 7 * HOUR).insights_log;
    const w = world({ insights_log: all });
    const e = engine(db, w, c);
    await e.runSetup();
    // This device somehow lacks 80 rows from the middle of the history.
    const lost = Object.keys(all).slice(400, 480);
    await db.putPage("insights", [], { deleteKeys: lost });
    census(w, CENSUS_AT, { insights: 1000 });
    c.set(CENSUS_AT + 5 * HOUR);
    w.calls.readKeyPage.length = 0;
    const report = await e.runPass();
    expect(report.census.drifted.map((d) => d.leg)).toEqual(["insights"]);
    expect(report.repaired).toEqual({ leg: "insights", rows: 920 });      // the forward walk, from its cursor
    // Not one keys-only read of the history — /insights_log is ~160,000 keys.
    expect(w.calls.shallowKeys).toEqual([]);
    // The only pages of the history read are the forward walk's, from its cursor.
    expect(w.calls.readKeyPage.filter((x) => x.path === "insights_log" && x.after === null)).toEqual([]);
    expect(await isLegUsable(db, "insights")).toBe(true);
  });

  test("a history the census still disagrees with stays SERVED — its repair never re-reads it", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT + 5 * HOUR);
    const w = withoutKeyRead(world(histories(1000, CENSUS_AT - 7 * HOUR)));
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { insights: 1300 });                  // nothing this device can do about it
    await e.checkCensus({ force: true });
    w.calls.readKeyPage.length = 0;
    for (let i = 0; i < 10; i += 1) { c.advance(60_000); await e.runPass(); }
    expect(await isLegUsable(db, "insights")).toBe(true);
    expect((await e.setupState()).done).toBe(true);
    expect(w.calls.readKeyPage.filter((x) => x.path === "insights_log" && x.after === null)).toEqual([]);
  });

  test("a history still walking forward is not judged until its walk reaches the end", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 30 * HOUR);
    const w = world(histories(100, CENSUS_AT - 31 * HOUR));
    const e = engine(db, w, c);
    await e.runSetup();
    // 5,000 sales while the device was shut — more than a pass walks.
    for (let i = 0; i < 5000; i += 1) {
      w.write(`insights_log/${pushKeyForMs(CENSUS_AT - 20 * HOUR + i * 1000, String(i).padStart(12, "0"))}`, { n: i });
    }
    census(w, CENSUS_AT, { insights: 5100 });
    c.set(CENSUS_AT + 4 * HOUR);
    const first = await e.runPass();
    expect(first.census.unjudged).toContain("insights");
    expect(await e.legIsSetUp(LEG_BY_NAME.insights)).toBe(true);
  });
});

describe("a copy still catching up is not compared", () => {
  test("a scheduled census waits for the pass that reaches the end of the feed", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 30 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(100) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    // More backlog than one pass reads, all of it BEFORE the census — so the
    // census includes it and the journal allows nothing for it.
    const backlog = FEED_PAGES_PER_PASS * CHANGE_PAGE_SIZE + 300;
    for (let i = 0; i < backlog; i += 1) {
      change(w, SLOTS, `marathon-pe|n${String(i).padStart(5, "0")}`, { slot: i }, CENSUS_AT - 20 * HOUR + i * 1000);
    }
    census(w, CENSUS_AT, { displaySlots: 100 + backlog });

    c.set(CENSUS_AT + 4 * HOUR);
    const first = await e.runPass();
    expect(first.census).toEqual({ skipped: "feed-behind" });
    expect(w.calls.readPath).not.toContain(COUNTS_ROOT);       // not even read
    expect(await e.legIsSetUp(LEG_BY_NAME.displaySlots)).toBe(true);

    const second = await e.runPass();                          // catches up
    expect(second.census.checked).toContain("displaySlots");
    expect(second.census.drifted).toEqual([]);
  });
});

describe("a FORCED census on a device with a backlog allows for what it has not applied", () => {
  // Every open that has to finish a download forces a census before anything
  // is served — it cannot wait for the feed. A tablet opened in the morning
  // holds legs that are missing a night of changes, all of them IN the 04:15
  // census.
  test("yesterday evening's writes, still in the backlog, are not a drift", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 20 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    for (let i = 0; i < 100; i += 1) {
      change(w, SLOTS, `marathon-pe|n${String(i).padStart(4, "0")}`, { slot: 2000 + i }, CENSUS_AT - 10 * HOUR + i * 1000);
    }
    census(w, CENSUS_AT, { displaySlots: 1100 });
    c.set(CENSUS_AT + 4 * HOUR);

    const rowReads = w.calls.readPath.length;
    const res = await e.checkCensus({ force: true });          // before any pass has run
    expect(await db.count("displaySlots")).toBe(1000);         // 100 behind the census…
    expect(res.checked).toContain("displaySlots");
    expect(res.drifted).toEqual([]);                           // …and every one of them is in the backlog
    // It read the backlog's pointer records, never a row.
    expect(w.calls.readPath.slice(rowReads)).toEqual([COUNTS_ROOT]);
    expect(await e.legIsSetUp(LEG_BY_NAME.displaySlots)).toBe(true);
  });

  test("a hole the backlog does NOT explain is still found", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 20 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    for (let i = 0; i < 20; i += 1) {
      change(w, SLOTS, `marathon-pe|n${String(i).padStart(4, "0")}`, { slot: 2000 + i }, CENSUS_AT - 10 * HOUR + i * 1000);
    }
    census(w, CENSUS_AT, { displaySlots: 1300 });              // 280 nobody recorded
    c.set(CENSUS_AT + 4 * HOUR);
    const res = await e.checkCensus({ force: true });
    expect(res.drifted).toEqual([{ leg: "displaySlots", held: 1000, census: 1300, allowed: 46 }]);
  });

  test("a backlog too long to count means the copy is too far behind to judge", async () => {
    const { pendingTouched } = await import("../censusJournal");
    const w = world();
    for (let i = 0; i < 700; i += 1) change(w, "products", `p${i}`, { id: `p${i}` }, CENSUS_AT + i * 1000);
    const opts = { feedCursor: null, changesRoot: CHANGES_ROOT, pageSize: 100 };
    expect(await pendingTouched(w.adapter, { ...opts, maxPages: 3 })).toBeNull();
    expect(await pendingTouched(w.adapter, { ...opts, maxPages: 10 })).toEqual({ products: 700 });
    // No cursor at all: there is no "since" to count from.
    expect(await pendingTouched(w.adapter, { ...opts, feedCursor: undefined })).toBeNull();
  });
});

describe("one repair per leg per census", () => {
  test("a census that still disagrees after the repair does NOT send the leg again", async () => {
    // The exact storm: the census says 1,000, the server really holds 1,400
    // and no change record explains it. Before, the leg was downloaded on
    // every pass until the next census. Now: once.
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT + 5 * HOUR);
    const w = withoutKeyRead(world({ settings: { displaySlots: { "marathon-pe": slots(1400) } } }));
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { displaySlots: 1000 });

    await e.checkCensus({ force: true });
    expect((await getLegHealth(db, "displaySlots")).reason).toBe("count-drift");
    const before = wholeWalks(w, SLOTS);

    for (let pass = 0; pass < 30; pass += 1) {
      c.advance(60_000);
      await e.runPass();
    }
    // …and across the six-hourly scheduled checks of the rest of the day.
    for (let i = 0; i < 3; i += 1) {
      c.advance(CENSUS_CHECK_MS + 1);
      await e.runPass();
    }
    expect(wholeWalks(w, SLOTS) - before).toBe(1);
    // It holds MORE than the census counted, so it is not a truncated copy:
    // it is what the server sent, and it is served.
    expect(await isLegUsable(db, "displaySlots")).toBe(true);
    expect((await e.setupState()).done).toBe(true);
  });

  test("…and that survives a reload: the fact is on disk, not in memory", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT + 5 * HOUR);
    const storage = sharedStorage();
    const w = withoutKeyRead(world({ settings: { displaySlots: { "marathon-pe": slots(1400) } } }));
    const open = () => createSyncEngine({
      db, adapter: w.adapter, now: c.now, buildVersion: "b1",
      downloadLedger: createDownloadLedger({ now: c.now, storage }),
    });
    await open().runSetup();
    census(w, CENSUS_AT, { displaySlots: 1000 });
    const before = wholeWalks(w, SLOTS);
    for (let reload = 0; reload < 12; reload += 1) {
      const e = open();                                        // a fresh engine every time
      await e.checkCensus({ force: true });                    // what every open does
      c.advance(60_000);
      await e.runPass();
      await e.runSetup().catch(() => {});
    }
    expect(wholeWalks(w, SLOTS) - before).toBe(1);
  });

  test("a NEWER census may send it once more — the bound is per census, not for ever", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT + 5 * HOUR);
    const w = withoutKeyRead(world({ settings: { displaySlots: { "marathon-pe": slots(1400) } } }));
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { displaySlots: 1000 });
    await e.checkCensus({ force: true });
    await e.runPass();
    const afterFirst = wholeWalks(w, SLOTS);

    c.set(CENSUS_AT + DAY + 5 * HOUR);
    census(w, CENSUS_AT + DAY, { displaySlots: 1000 });        // tomorrow's census, still wrong
    await e.runPass();                                         // flags it once more
    await e.runPass();                                         // repairs it once more
    for (let i = 0; i < 10; i += 1) { c.advance(60_000); await e.runPass(); }
    expect(wholeWalks(w, SLOTS) - afterFirst).toBe(1);
  });

  test("a copy still SHORT of the census after its repair is not served, and not downloaded again", async () => {
    // The POS incident's shape: 799 read where the server holds 4,654. A
    // second download reads 799 again. It must not become "complete", must not
    // be served, and must not be read a third time for the same census.
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT + 5 * HOUR);
    const products = Object.fromEntries(Array.from({ length: 799 }, (_, i) => [`p${i}`, { id: `p${i}` }]));
    const w = withoutKeyRead(world({ products }));
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { products: 4654 });
    await e.checkCensus({ force: true });
    const before = wholeWalks(w, "products");

    for (let pass = 0; pass < 20; pass += 1) { c.advance(60_000); await e.runPass(); }
    await e.runSetup().catch(() => {});                        // …nor by the next open's setup run
    expect(wholeWalks(w, "products") - before).toBe(1);
    expect(await isLegUsable(db, "products")).toBe(false);
    expect((await e.setupState()).done).toBe(false);
    expect(await db.getMeta(SETUP_DONE_META)).toBeUndefined();
    expect(await e.parkedLegs()).toEqual(["products"]);
    expect(await db.count("products")).toBe(799);              // nothing deleted, as ever

    // The next census agrees (the catalogue really is 799): it comes back by
    // itself, with no download.
    c.set(CENSUS_AT + DAY + 5 * HOUR);
    census(w, CENSUS_AT + DAY, { products: 799 });
    await e.runPass();
    await e.runPass();
    expect(wholeWalks(w, "products") - before).toBe(1);
    expect(await isLegUsable(db, "products")).toBe(true);
    expect((await e.setupState()).done).toBe(true);
  });
});

describe("a count is repaired by its keys, not by reading the leg", () => {
  async function drifted({ extraOnServer = 0, goneFromServer = 0, n = 1000 } = {}) {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(n / 2), trophy: slots(n / 2, "trophy") } } });
    const e = engine(db, w, c);
    await e.runSetup();
    // Writes that reached the server with NO change record.
    for (let i = 0; i < extraOnServer; i += 1) w.write(`${SLOTS}/trophy/hole${i}`, { slot: 9000 + i });
    for (let i = 0; i < goneFromServer; i += 1) w.write(`${SLOTS}/marathon-pe/p${String(i).padStart(5, "0")}`, null);
    census(w, CENSUS_AT, { displaySlots: n + extraOnServer - goneFromServer });
    c.set(CENSUS_AT + 5 * HOUR);
    return { db, c, w, e };
  }

  test("rows the device never heard of are fetched one by one — no page of the leg is read", async () => {
    const { db, w, e } = await drifted({ extraOnServer: 60 });
    const pagesBefore = w.calls.readKeyPage.filter((x) => x.path === SLOTS).length;
    const report = await e.runPass();

    expect(report.census.drifted.map((d) => d.leg)).toEqual(["displaySlots"]);
    expect(report.repaired).toEqual({ leg: "displaySlots", rows: 1060, via: "key-diff", added: 60, removed: 0 });
    expect(w.calls.readKeyPage.filter((x) => x.path === SLOTS).length).toBe(pagesBefore);
    // One key read for the node, one per store.
    expect(w.calls.shallowKeys).toEqual([SLOTS, `${SLOTS}/marathon-pe`, `${SLOTS}/trophy`]);
    expect(await db.get("displaySlots", "trophy|hole7")).toEqual({ slot: 9007 });
    expect(await isLegUsable(db, "displaySlots")).toBe(true);
    expect((await e.setupState()).done).toBe(true);
  });

  test("a row the server no longer has is deleted ONLY because its own read says null", async () => {
    const { db, w, e } = await drifted({ goneFromServer: 40 });
    const report = await e.runPass();
    expect(report.repaired).toMatchObject({ leg: "displaySlots", rows: 960, via: "key-diff", removed: 40 });
    expect(await db.get("displaySlots", "marathon-pe|p00003")).toBeUndefined();
    // Each of the forty was READ before it was deleted.
    const deleted = new Set(Array.from({ length: 40 }, (_, i) => `${SLOTS}/marathon-pe/p${String(i).padStart(5, "0")}`));
    expect(new Set(w.calls.readPath.filter((p) => deleted.has(p)))).toEqual(deleted);
  });

  test("a key list that comes back SHORT costs reads, never rows", async () => {
    // The key read is wrong about a whole store. Every row it failed to name
    // is read by its own path, found to exist, and kept.
    const { db, w, e } = await drifted({ extraOnServer: 60, n: 400 });
    const real = w.adapter.shallowKeys;
    w.adapter.shallowKeys = async (path) => (path === `${SLOTS}/marathon-pe` ? (await real(path)).slice(0, 180) : real(path));
    const report = await e.runPass();
    expect(report.repaired.via).toBe("key-diff");
    expect(report.repaired.removed).toBe(0);
    expect(await db.count("displaySlots")).toBe(460);
  });

  test("a leg too DIFFERENT for a diff falls back to the walk", async () => {
    const { w, e } = await drifted({ extraOnServer: 600 });
    const before = wholeWalks(w, SLOTS);
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "displaySlots", rows: 1600 });
    expect(wholeWalks(w, SLOTS) - before).toBe(1);
  });

  test("a device with no keys-only read falls back to the walk", async () => {
    const { w, e } = await drifted({ extraOnServer: 60 });
    delete w.adapter.shallowKeys;
    const before = wholeWalks(w, SLOTS);
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "displaySlots", rows: 1060 });
    expect(wholeWalks(w, SLOTS) - before).toBe(1);
  });

  test("a key read the RULES refuse is an answer: the leg takes the walk in the same pass", async () => {
    const { w, e } = await drifted({ extraOnServer: 60 });
    w.adapter.shallowKeys = async () => { throw Object.assign(new Error("refused (401)"), { code: "PERMISSION_DENIED" }); };
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "displaySlots", rows: 1060 });
    expect(report.errors).toEqual([]);
  });

  test("a key read that THROWS (a timeout, a dropped line) is asked again next pass — it does not become a 6 MB walk", async () => {
    const { c, w, e } = await drifted({ extraOnServer: 60 });
    const real = w.adapter.shallowKeys;
    let fail = 2;
    w.adapter.shallowKeys = async (path) => {
      if (fail > 0) { fail -= 1; throw new Error("/settings (keys) did not answer within 90000 ms"); }
      return real(path);
    };
    const before = wholeWalks(w, SLOTS);
    expect((await e.runPass()).repaired).toBeNull();
    c.advance(60_000);
    expect((await e.runPass()).repaired).toBeNull();
    expect(wholeWalks(w, SLOTS)).toBe(before);                 // two failures, and not one page of the leg
    c.advance(60_000);
    expect((await e.runPass()).repaired).toMatchObject({ leg: "displaySlots", via: "key-diff", added: 60 });
    expect(wholeWalks(w, SLOTS)).toBe(before);
  });

  test("…but a key read that NEVER answers is not asked for ever: after three tries the leg takes the walk", async () => {
    const { c, w, e } = await drifted({ extraOnServer: 60 });
    let asked = 0;
    w.adapter.shallowKeys = async () => { asked += 1; throw new Error("did not answer"); };
    const repaired = [];
    for (let i = 0; i < 6; i += 1) { repaired.push((await e.runPass()).repaired); c.advance(60_000); }
    expect(asked).toBe(3);
    expect(repaired.filter(Boolean)).toEqual([{ leg: "displaySlots", rows: 1060 }]);
  });

  test("a census that lands in the middle of a burst: the repair WAITS for the feed, it does not sample a backlog or walk", async () => {
    // The feed is a page behind when the census is forced (as after a
    // download). Rows still in the backlog would look "missing" to a key
    // comparison and "stale" to its sample — and they are neither.
    const { db, c, w, e } = await drifted({ extraOnServer: 60 });
    const backlog = FEED_PAGES_PER_PASS * CHANGE_PAGE_SIZE + 200;
    for (let i = 0; i < backlog; i += 1) {
      change(w, SLOTS, `marathon-pe|p${String(i % 500).padStart(5, "0")}`, { slot: i, edited: i }, c.now() - backlog * 1000 + i * 1000);
    }
    await e.checkCensus({ force: true, feedCaughtUp: true });  // the 60-row hole was flagged before the burst
    expect((await getLegHealth(db, "displaySlots")).reason).toBe("count-drift");
    const before = wholeWalks(w, SLOTS);
    const first = await e.runPass();                           // four pages applied; one still to come
    expect(first.repaired).toBeNull();
    expect(w.calls.shallowKeys).toEqual([]);
    expect(wholeWalks(w, SLOTS)).toBe(before);
    c.advance(1000);
    const second = await e.runPass();                          // caught up: now it is repaired, by keys
    expect(second.repaired).toMatchObject({ leg: "displaySlots", via: "key-diff", added: 60 });
    expect(second.repaired.refreshed).toBeUndefined();         // nothing in the sample was stale
    expect(wholeWalks(w, SLOTS)).toBe(before);
  });

  test("a leg with too many parents to list is not diffed (one request per date is not cheap)", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const dates = Object.fromEntries(Array.from({ length: 90 }, (_, d) => [
      `2026-08-${String(d).padStart(3, "0")}`,
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, { n: i }])),
    ]));
    const w = world({ [LEG_BY_NAME.restockLog.node]: dates });
    const e = engine(db, w, c);
    await e.runSetup();
    for (let i = 0; i < 80; i += 1) w.write(`${LEG_BY_NAME.restockLog.node}/2026-08-000/hole${i}`, { n: i });
    census(w, CENSUS_AT, { restockLog: 530 });
    c.set(CENSUS_AT + 5 * HOUR);
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "restockLog", rows: 530 });       // by the walk
    expect(w.calls.shallowKeys.length).toBeLessThanOrEqual(61);
  });

  test("a copy whose keys were compared AFTER the census was taken is not judged by it", async () => {
    // The census is wrong (or older than a burst nothing journaled). The key
    // comparison found the copy already matches the server. An older count has
    // nothing to add, and the leg is served.
    const { db, c, w, e } = await drifted({ n: 400 });
    census(w, CENSUS_AT, { displaySlots: 900 });               // the server does NOT hold 900
    const first = await e.runPass();
    expect(first.census.drifted.map((d) => d.leg)).toEqual(["displaySlots"]);
    expect(first.repaired).toMatchObject({ via: "key-diff", added: 0, removed: 0, rows: 400 });
    expect(await isLegUsable(db, "displaySlots")).toBe(true);
    c.advance(CENSUS_CHECK_MS + 1);
    const later = await e.runPass();
    expect(later.census.checked).not.toContain("displaySlots");
    expect(await isLegUsable(db, "displaySlots")).toBe(true);
    expect(wholeWalks(w, SLOTS)).toBe(1);                      // setup, and never again
  });
});

describe("a key comparison cannot see a stale VALUE — so it samples some", () => {
  async function driftedWithStale(staleCount) {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(30) } } });
    // Every row both sides hold is in a sample of 20 from 30 with this `random`
    // only by luck, so the sample is made the whole leg: 20 rows.
    w.write(`${SLOTS}/marathon-pe`, slots(20));
    const e = engine(db, w, c);
    await e.runSetup();
    // Edits whose change records were lost: the server moved on, the device did not.
    for (let i = 0; i < staleCount; i += 1) w.write(`${SLOTS}/marathon-pe/p${String(i).padStart(5, "0")}/slot`, 7000 + i);
    for (let i = 0; i < 40; i += 1) w.write(`${SLOTS}/marathon-pe/hole${i}`, { slot: 9000 + i });
    census(w, CENSUS_AT, { displaySlots: 60 });
    c.set(CENSUS_AT + 5 * HOUR);
    return { db, c, w, e };
  }

  test("a couple of stale rows are put right by the repair itself", async () => {
    const { db, w, e } = await driftedWithStale(2);
    const before = wholeWalks(w, SLOTS);
    const report = await e.runPass();
    expect(report.repaired).toMatchObject({ leg: "displaySlots", via: "key-diff", added: 40, rows: 60 });
    expect((await db.get("displaySlots", "marathon-pe|p00001")).slot).toBe(7001);
    expect(wholeWalks(w, SLOTS)).toBe(before);
  });

  test("more than a couple means the VALUES cannot be trusted: the leg takes the (budgeted) walk", async () => {
    const { db, w, e } = await driftedWithStale(6);
    const before = wholeWalks(w, SLOTS);
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "displaySlots", rows: 60 });
    expect(wholeWalks(w, SLOTS) - before).toBe(1);
    expect((await db.get("displaySlots", "marathon-pe|p00005")).slot).toBe(7005);
  });

  test("the sample is bounded: never more than KEYDIFF_SAMPLE rows, whatever the leg's size", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(3000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    for (let i = 0; i < 100; i += 1) w.write(`${SLOTS}/marathon-pe/hole${i}`, { slot: 9000 + i });
    census(w, CENSUS_AT, { displaySlots: 3100 });
    c.set(CENSUS_AT + 5 * HOUR);
    w.calls.readPath.length = 0;
    await e.runPass();
    const rowReads = w.calls.readPath.filter((p) => p.startsWith(`${SLOTS}/`));
    expect(rowReads.length).toBe(100 + KEYDIFF_SAMPLE);
  });
});

describe("a leg too big for its key list to be cheap is not diffed", () => {
  test("more than KEYDIFF_MAX_LOCAL_KEYS rows held: no key read at all, the walk", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const customers = Object.fromEntries(Array.from({ length: KEYDIFF_MAX_LOCAL_KEYS + 500 }, (_, i) => [`c${i}`, { n: i }]));
    const w = world({ customers });
    const e = engine(db, w, c);
    await e.runSetup();
    for (let i = 0; i < 600; i += 1) w.write(`customers/hole${i}`, { n: i });
    census(w, CENSUS_AT, { customers: KEYDIFF_MAX_LOCAL_KEYS + 1100 });
    c.set(CENSUS_AT + 5 * HOUR);
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "customers", rows: KEYDIFF_MAX_LOCAL_KEYS + 1100 });
    expect(w.calls.shallowKeys).toEqual([]);
  }, 60_000);
});

describe("an expired cursor and a leg already waiting for a count repair", () => {
  test("the leg takes the WALK — a key repair would leave every value changed in the gap stale", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT - 6 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(1000) } } });
    const e = engine(db, w, c);
    await e.runSetup();
    for (let i = 0; i < 60; i += 1) w.write(`${SLOTS}/marathon-pe/hole${i}`, { slot: 9000 + i });
    census(w, CENSUS_AT, { displaySlots: 1060 });
    c.set(CENSUS_AT + 5 * HOUR);
    await e.checkCensus({ force: true, feedCaughtUp: true });   // count-drift: marker dropped, repair pending
    expect((await getLegHealth(db, "displaySlots")).reason).toBe("count-drift");
    expect(await db.getMeta(`${SETUP_META_PREFIX}displaySlots`)).toBeUndefined();

    // Before the repair runs, the cursor turns out to be past retention — and
    // an edit was made in the gap that no record this device will read names.
    w.write(`${SLOTS}/marathon-pe/p00500/slot`, 4242);
    await db.setMeta(FEED_CURSOR_META, pushKeyForMs(c.now() - CHANGE_RETENTION_MS - DAY, "A"));
    const before = wholeWalks(w, SLOTS);
    const first = await e.runPass();
    expect(first.errors).toEqual([{ where: "feed", reason: "cursor-expired" }]);
    expect((await getLegHealth(db, "displaySlots"))?.reason ?? "repaired").not.toBe("count-drift");
    for (let i = 0; i < 25; i += 1) { c.advance(60_000); await e.runPass(); }
    expect(wholeWalks(w, SLOTS) - before).toBe(1);
    expect(w.calls.shallowKeys).toEqual([]);
    expect((await db.get("displaySlots", "marathon-pe|p00500")).slot).toBe(4242);
    expect((await e.setupState()).done).toBe(true);
  });
});

describe("a signal pass is for the change feed", () => {
  function sale(w, i, at) {
    w.write(`insights_log/${pushKeyForMs(at, String(i).padStart(12, "0"))}`, { n: i });
    w.write(`stock_movements/s${String(i).padStart(6, "0")}`, { ts: new Date(at).toISOString(), n: i });
  }
  async function ready() {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const w = world();
    sale(w, 0, CENSUS_AT - HOUR);
    const e = engine(db, w, c);
    await e.runSetup();
    await e.runPass();                                         // a floor pass: histories walked
    w.calls.readKeyPage.length = 0;
    w.calls.readChildPage.length = 0;
    return { db, c, w, e };
  }
  const historyReads = (w) => w.calls.readKeyPage.filter((x) => x.path === "insights_log").length + w.calls.readChildPage.length;

  test("a burst of signal passes for OTHER nodes walks the histories once a minute, not once a pass", async () => {
    const { c, w, e } = await ready();
    for (let i = 0; i < 200; i += 1) {
      c.advance(1000);
      change(w, "products", "p1", { id: "p1", price: 1000 + i }, c.now() - 1);
      const report = await e.runPass({ signal: true });
      expect(report.feed.applied).toBe(1);                     // the feed is read on every one
    }
    // 200 seconds of continuous signals: the 60-second floor these signals
    // would have starved is kept for them — three walks of two legs, not 200.
    expect(historyReads(w)).toBe(6);
  });

  test("a SALE is on screen at once: a signal pass whose feed applied a /stock row walks both histories", async () => {
    // Clothing Sold ("sold, refill it"), Movement History and Insights read
    // the histories. A sale writes its stock row, its movement and its
    // insights row together; the stock row's change record is the signal.
    const { db, c, w, e } = await ready();
    for (let i = 1; i <= 5; i += 1) {
      c.advance(2000);                                         // two seconds apart: a busy till
      sale(w, i, c.now() - 500);
      change(w, "stock", "hub1|p1", { 9: { qty: 10 - i } }, c.now() - 400);
      const report = await e.runPass({ signal: true });
      expect(report.rangeSkipped).toBeUndefined();
      expect(await db.count("insights")).toBe(1 + i);
      expect(await db.count("movements")).toBe(1 + i);
    }
  });

  test("a signal pass whose feed applied NOTHING leaves them for the five-minute rule", async () => {
    const { c, w, e } = await ready();
    for (let i = 0; i < 4; i += 1) {
      c.advance(70_000);                                       // past the 60 s floor each time
      expect((await e.runPass({ signal: true })).rangeSkipped).toBe("signal");
    }
    expect(historyReads(w)).toBe(0);
    c.advance(70_000);                                         // 350 s: five minutes have gone by
    expect((await e.runPass({ signal: true })).rangeSkipped).toBeUndefined();
  });

  test("…but they ARE walked once five minutes have gone by, and on every floor pass", async () => {
    const { db, c, w, e } = await ready();
    sale(w, 1, c.now() + 1000);
    c.advance(SIGNAL_RANGE_EVERY_MS - 1000);
    expect((await e.runPass({ signal: true })).rangeSkipped).toBe("signal");
    expect(await db.count("insights")).toBe(1);
    c.advance(1000);
    const due = await e.runPass({ signal: true });
    expect(due.rangeSkipped).toBeUndefined();
    expect(due.range.map((r) => r.leg).sort()).toEqual(["insights", "movements"]);
    expect(await db.count("insights")).toBe(2);
    expect(await db.count("movements")).toBe(2);

    sale(w, 2, c.now() + 1);
    c.advance(1000);
    await e.runPass();                                         // the 60-second floor: always
    expect(await db.count("insights")).toBe(3);
  });
});

describe("a parked leg: un-parked by its keys, and not censused on every open", () => {
  async function parked() {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT + 5 * HOUR);
    const w = world({ settings: { displaySlots: { "marathon-pe": slots(800) } } });
    const keyRead = w.adapter.shallowKeys;
    delete w.adapter.shallowKeys;                              // the key read is refused, for now
    const e = engine(db, w, c);
    await e.runSetup();
    census(w, CENSUS_AT, { displaySlots: 1000 });              // the census is simply wrong
    await e.checkCensus({ force: true });
    for (let i = 0; i < 5; i += 1) { c.advance(60_000); await e.runPass(); }
    expect(await e.parkedLegs()).toEqual(["displaySlots"]);
    return { db, c, w, e, keyRead };
  }

  test("a successful key comparison is stricter than the census, and serves the leg again", async () => {
    const { db, c, w, e, keyRead } = await parked();
    expect(await isLegUsable(db, "displaySlots")).toBe(false);
    w.adapter.shallowKeys = keyRead;                           // the key read works on the next open
    const again = engine(db, w, c);
    c.advance(60_000);
    const report = await again.runPass();
    expect(report.repaired).toMatchObject({ leg: "displaySlots", via: "key-diff", rows: 800, added: 0, removed: 0 });
    expect(await again.parkedLegs()).toEqual([]);
    expect(await isLegUsable(db, "displaySlots")).toBe(true);
    expect((await again.setupState()).done).toBe(true);
    void e;
  });

  test("a parked leg that cannot be diffed is asked for its keys ONCE, not on every pass", async () => {
    const { c, w, e } = await parked();
    let asked = 0;
    w.adapter.shallowKeys = async () => { asked += 1; throw Object.assign(new Error("refused (403)"), { code: "PERMISSION_DENIED" }); };
    for (let i = 0; i < 20; i += 1) { c.advance(60_000); await e.runPass(); }
    expect(asked).toBe(1);
    expect(await e.parkedLegs()).toEqual(["displaySlots"]);
  });

  test("…but the census that verifies a download that has JUST finished always runs", async () => {
    const { db, c, w } = await parked();
    w.calls.readPath.length = 0;
    c.advance(60_000);
    const res = await engine(db, w, c).checkCensus({ force: true, afterDownload: true });
    expect(res.skipped).toBeUndefined();
    expect(w.calls.readPath.filter((p) => p === COUNTS_ROOT).length).toBe(1);
  });

  test("the forced census of every app open is asked at most once in 30 minutes", async () => {
    const { db, c, w } = await parked();
    w.calls.readPath.length = 0;
    for (let open = 0; open < 10; open += 1) {
      c.advance(60_000);
      await engine(db, w, c).checkCensus({ force: true });     // what every open of a not-complete device does
    }
    expect(w.calls.readPath.filter((p) => p === COUNTS_ROOT).length).toBe(0);
    c.advance(PARKED_CENSUS_EVERY_MS);
    await engine(db, w, c).checkCensus({ force: true });
    expect(w.calls.readPath.filter((p) => p === COUNTS_ROOT).length).toBe(1);
  });
});

describe("the daily bound on whole downloads", () => {
  test("a leg starts from page one at most LEG_DOWNLOADS_PER_DAY times in 24 hours — whatever asks", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const storage = sharedStorage();
    const w = world();
    const open = () => createSyncEngine({
      db, adapter: w.adapter, now: c.now, buildVersion: "b1",
      downloadLedger: createDownloadLedger({ now: c.now, storage }),
    });
    await open().runSetup();                                   // download 1
    // Something keeps dropping the marker — and a reload gives a fresh engine
    // with an empty in-memory failure ledger every single time.
    for (let i = 0; i < 20; i += 1) {
      c.advance(60_000);
      await db.deleteMetaMany([`${SETUP_META_PREFIX}products`, SETUP_DONE_META]);
      await open().runPass();
    }
    expect(wholeWalks(w, "products")).toBe(LEG_DOWNLOADS_PER_DAY);
    const health = await getLegHealth(db, "products");
    expect(health.reason).toBe("download-budget");
    // The last good copy is still vouched for and still served.
    expect(await isLegUsable(db, "products")).toBe(true);

    // The window moves on: one more is allowed, with no reload.
    const e = open();
    await e.runPass();
    expect(e.legFailures().find((f) => f.leg === "products")).toMatchObject({ benched: true });
    c.advance(DOWNLOAD_WINDOW_MS);
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "products", rows: 1 });
    expect(wholeWalks(w, "products")).toBe(LEG_DOWNLOADS_PER_DAY + 1);
  });

  test("a refused leg reads NOTHING — not one page", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const w = world();
    const ledger = createDownloadLedger({ now: c.now, storage: sharedStorage() });
    const e = createSyncEngine({ db, adapter: w.adapter, now: c.now, buildVersion: "b1", downloadLedger: ledger });
    await e.runSetup();
    while (ledger.consume("products")) { /* spend the rest */ }
    await db.deleteMetaMany([`${SETUP_META_PREFIX}products`, SETUP_DONE_META]);
    const pages = w.calls.readKeyPage.filter((x) => x.path === "products").length;
    const report = await e.runPass();
    expect(report.errors.some((x) => x.where === "repair" && x.reason === "MirrorDownloadBudgetError")).toBe(true);
    expect(w.calls.readKeyPage.filter((x) => x.path === "products").length).toBe(pages);
  });

  test("a walk RESUMED from staging is the same download, not a new one", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const products = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`p${String(i).padStart(4, "0")}`, { id: i }]));
    const w = world({ products });
    const ledger = createDownloadLedger({ now: c.now, storage: sharedStorage() });
    const e = createSyncEngine({ db, adapter: w.adapter, now: c.now, buildVersion: "b1", downloadLedger: ledger });
    const real = w.adapter.readKeyPage;
    let fail = true;
    w.adapter.readKeyPage = async (path, opts) => {
      if (path === "products" && opts.after !== null && fail) { fail = false; throw new Error("line dropped"); }
      return real(path, opts);
    };
    await expect(e.downloadSnapshotLeg(LEG_BY_NAME.products)).rejects.toThrow("line dropped");
    await e.downloadSnapshotLeg(LEG_BY_NAME.products);         // resumes from page two
    expect(await db.count("products")).toBe(1000);
    expect(ledger.snapshot().products.length).toBe(1);
  });

  test("a read the rules refuse spends nothing (a shop account asks for /orders on every start)", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const w = world();
    const ledger = createDownloadLedger({ now: c.now, storage: sharedStorage() });
    const real = w.adapter.readKeyPage;
    w.adapter.readKeyPage = async (path, opts) => {
      if (path === "orders") throw Object.assign(new Error("Permission denied"), { code: "PERMISSION_DENIED" });
      return real(path, opts);
    };
    for (let start = 0; start < 10; start += 1) {
      const e = createSyncEngine({ db, adapter: w.adapter, now: c.now, buildVersion: "b1", downloadLedger: ledger });
      await e.clearNotPermitted();
      await e.runSetup();
      c.advance(60_000);
    }
    expect(ledger.snapshot().orders).toBeUndefined();
    expect((await getLegHealth(db, "orders")).reason).toBe("not-permitted");
  });

  test("a history read from NO cursor is a whole download too; a walk from its cursor is not", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const insights = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [pushKeyForMs(CENSUS_AT - DAY + i, "AAAAAAAAAAAA"), { n: i }]));
    const w = world({ insights_log: insights });
    const ledger = createDownloadLedger({ now: c.now, storage: sharedStorage() });
    const e = createSyncEngine({ db, adapter: w.adapter, now: c.now, buildVersion: "b1", downloadLedger: ledger });
    await e.runSetup();
    for (let i = 0; i < 10; i += 1) { c.advance(60_000); await e.runPass(); }
    expect(ledger.snapshot().insights.length).toBe(1);
    // An EMPTY history (movements here) is asked from nothing on every pass
    // and never spends a slot.
    expect(ledger.snapshot().movements).toBeUndefined();
  });
});

describe("the expired-cursor trap", () => {
  // Thirty days of change log, as the server keeps it.
  function logOfThirtyDays(w, now, perDay = 40) {
    for (let d = 30; d >= 1; d -= 1) {
      for (let i = 0; i < perDay; i += 1) {
        const at = now - d * DAY + i * 60_000;
        w.write(`${CHANGES_ROOT}/${pushKeyForMs(at, String(i).padStart(12, "0"))}`, { n: "products", k: "p1", t: at });
      }
    }
  }

  test("an expired cursor is replaced by the HEAD of the log, at once", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const w = world();
    const e = engine(db, w, c);
    await e.runSetup();
    logOfThirtyDays(w, c.now());
    const head = await w.adapter.lastKey(CHANGES_ROOT);
    await db.setMeta(FEED_CURSOR_META, pushKeyForMs(c.now() - CHANGE_RETENTION_MS - DAY, "A"));

    const report = await e.runPass();
    expect(report.errors).toEqual([{ where: "feed", reason: "cursor-expired" }]);
    expect(await db.getMeta(FEED_CURSOR_META)).toBe(head);
    expect((await getLegHealth(db, "products")).reason).toBe("cursor-expired");
  });

  test("it expires ONCE: every leg comes back, each downloaded exactly once, and the log is never replayed", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const w = world();
    const e = engine(db, w, c);
    await e.runSetup();
    logOfThirtyDays(w, c.now());
    await db.setMeta(FEED_CURSOR_META, pushKeyForMs(c.now() - CHANGE_RETENTION_MS - DAY, "A"));
    const snapshotLegs = MIRROR_LEGS.filter((l) => !isAppendOnly(l));
    const walksBefore = Object.fromEntries(snapshotLegs.filter((l) => l.depth > 0).map((l) => [l.name, wholeWalks(w, l.node)]));
    w.calls.readKeyPage.length = 0;

    const reasons = [];
    for (let pass = 0; pass < 60; pass += 1) {
      c.advance(60_000);
      const report = await e.runPass();
      reasons.push(...report.errors.map((x) => x.reason));
    }
    // Before: "cursor-expired" on every second pass, for ever, with one leg
    // (always the first) repaired per lap and the device never whole again.
    expect(reasons).toEqual(["cursor-expired"]);
    expect((await e.setupState()).done).toBe(true);
    for (const leg of snapshotLegs.filter((l) => l.depth > 0)) {
      expect(wholeWalks(w, leg.node), leg.name).toBe(1);
      expect(walksBefore[leg.name]).toBe(1);
    }
    // Not one page of the change log was read from its first record.
    expect(w.calls.readKeyPage.filter((x) => x.path === CHANGES_ROOT && x.after === null)).toEqual([]);
  });

  test("a device with NO cursor at all (the old build dropped it) takes the head — it does not replay thirty days", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const w = world();
    const e = engine(db, w, c);
    await e.runSetup();
    logOfThirtyDays(w, c.now());
    const head = await w.adapter.lastKey(CHANGES_ROOT);
    await db.deleteMetaMany([FEED_CURSOR_META]);               // the state the old build left behind
    w.calls.readKeyPage.length = 0;
    w.calls.readPath.length = 0;

    const report = await e.runPass();
    expect(report.errors).toEqual([{ where: "feed", reason: "cursor-lost" }]);
    expect(await db.getMeta(FEED_CURSOR_META)).toBe(head);
    expect(w.calls.readKeyPage.filter((x) => x.path === CHANGES_ROOT && x.after === null)).toEqual([]);
    // …and not one of the 1,200 logged rows was re-read.
    expect(w.calls.readPath.filter((p) => p === "products/p1")).toEqual([]);
    expect((await getLegHealth(db, "products")).reason).toBe("cursor-lost");
  });

  test("a brand-new device repaired by the pass loop takes the head too, and marks nothing", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const w = world();
    logOfThirtyDays(w, c.now());
    const head = await w.adapter.lastKey(CHANGES_ROOT);
    const e = engine(db, w, c);
    const report = await e.runPass();                          // no runSetup first
    expect(report.errors).toEqual([]);
    expect(await db.getMeta(FEED_CURSOR_META)).toBe(head);
    expect(w.calls.readKeyPage.filter((x) => x.path === CHANGES_ROOT && x.after === null)).toEqual([]);
  });

  test("a log that cannot be reached changes NOTHING — no marker dropped without a new cursor", async () => {
    const db = await freshMirrorDb();
    const c = clock(CENSUS_AT);
    const w = world();
    const e = engine(db, w, c);
    await e.runSetup();
    const expired = pushKeyForMs(c.now() - CHANGE_RETENTION_MS - DAY, "A");
    await db.setMeta(FEED_CURSOR_META, expired);
    w.adapter.lastKey = async () => { throw new Error("office unreachable"); };
    const report = await e.runPass();
    expect(report.errors[0]).toMatchObject({ where: "feed", message: "office unreachable" });
    expect(await db.getMeta(FEED_CURSOR_META)).toBe(expired);
    expect(await e.legIsSetUp(LEG_BY_NAME.products)).toBe(true);
  });
});
