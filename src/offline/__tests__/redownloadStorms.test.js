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
} from "../sync";
import { LEG_BY_NAME, MIRROR_LEGS, isAppendOnly } from "../nodes";
import { getLegHealth, isLegUsable } from "../health";
import {
  COUNTS_ROOT, CHANGES_ROOT, FEED_CURSOR_META, CHANGE_PAGE_SIZE, CHANGE_RETENTION_MS,
} from "../changeFeed";
import { createDownloadLedger, LEG_DOWNLOADS_PER_DAY, DOWNLOAD_WINDOW_MS } from "../downloadLedger";

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

    // The trading day: 300 NEW slots, every one with its change record.
    c.set(CENSUS_AT + 5 * HOUR);
    for (let i = 0; i < 300; i += 1) {
      change(w, SLOTS, `marathon-pe|n${String(i).padStart(4, "0")}`, { slot: 2000 + i }, CENSUS_AT + 4 * HOUR + i * 1000);
    }
    const walksAfterSetup = wholeWalks(w, SLOTS);
    const report = await e.runPass();

    expect(report.feed.applied).toBe(300);
    expect(await db.count("displaySlots")).toBe(1300);         // 300 over a census of 1,000
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
    for (let i = 0; i < 200; i += 1) {
      change(w, SLOTS, `marathon-pe|p${String(i).padStart(5, "0")}`, null, CENSUS_AT + 4 * HOUR + i * 1000);
    }
    const report = await e.runPass();
    expect(await db.count("displaySlots")).toBe(800);
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
    for (let i = 0; i < 300; i += 1) {
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

  test("a hole in a history is filled by its KEYS — the 35 MB walk is not started again", async () => {
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
    expect(report.repaired).toEqual({ leg: "insights", rows: 1000, via: "key-diff", added: 80, removed: 0 });
    expect(await db.get("insights", lost[7])).toEqual(all[lost[7]]);
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
    expect(w.calls.readPath.filter((p) => p.startsWith(`${SLOTS}/marathon-pe/p000`)).length).toBe(40);
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

  test("a key read that FAILS falls back to the walk — it is never the only way", async () => {
    const { w, e } = await drifted({ extraOnServer: 60 });
    w.adapter.shallowKeys = async () => { throw new Error("401"); };
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "displaySlots", rows: 1060 });
    expect(report.errors).toEqual([]);
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
