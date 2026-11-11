// The journal of what the change feed has carried since the census, and the
// rebuild of a missing stretch from the change log's keys. See censusJournal.js
// for the storm it exists to end.
import { describe, test, expect } from "vitest";
import { createRequire } from "node:module";
import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import {
  noteTouched, touchedSince, coverSince, pushKeyPrefixForMs,
  TOUCHED_META, TOUCHED_KEEP_MS, CENSUS_CLOCK_MARGIN_MS, BACKFILL_PAGE_SIZE,
} from "../censusJournal";
import { msFromPushKey, CHANGES_ROOT } from "../changeFeed";
import { LEG_BY_NAME } from "../nodes";

const HOUR = 3600_000;
const T = Date.UTC(2026, 10, 10, 2, 15);          // the census
const rows = (leg, n) => Array.from({ length: n }, (_, i) => ({ leg: LEG_BY_NAME[leg], key: `k${i}` }));
const key = (ms, s = "AAAAAAAAAAAA") => pushKeyForMs(ms, s);

describe("the push-key prefix for a millisecond", () => {
  test("is the inverse of the feed's own key clock, and of the server's", () => {
    const lib = createRequire(import.meta.url)("../../../functions/mirrorChanges/lib.cjs");
    for (const ms of [0, 1, 63, 64, T, T + 123456789, Date.UTC(2031, 0, 1)]) {
      expect(msFromPushKey(pushKeyPrefixForMs(ms) + "AAAAAAAAAAAA")).toBe(ms);
      expect(pushKeyPrefixForMs(ms)).toBe(lib.pushKeyForMs(ms));
    }
  });

  test("sorts before every key minted in that millisecond and after the one before", () => {
    expect(pushKeyPrefixForMs(T) < key(T, "-00000000000")).toBe(true);
    expect(pushKeyPrefixForMs(T) > key(T - 1, "zzzzzzzzzzzz")).toBe(true);
  });
});

describe("what the feed has carried", () => {
  test("is filed by when the change was RECORDED, not when it was read", async () => {
    const db = await freshMirrorDb();
    const now = () => T + 30 * HOUR;                         // read much later
    await noteTouched(db, { cursor: key(T - 9 * HOUR), lastKey: key(T - 8 * HOUR), rows: rows("displaySlots", 300), now });
    await noteTouched(db, { cursor: key(T - 8 * HOUR), lastKey: key(T + 3 * HOUR), rows: rows("displaySlots", 40), now });
    const j = await db.getMeta(TOUCHED_META);
    expect(touchedSince(j, "displaySlots", T)).toBe(40);       // last night's 300 are IN the census
    expect(touchedSince(j, "displaySlots", T - 10 * HOUR)).toBe(340);
    expect(touchedSince(j, "products", T)).toBe(0);
    expect(j.from).toBe(T - 9 * HOUR);
  });

  test("counts the hour the census falls in, and the margin before it — never less", async () => {
    const db = await freshMirrorDb();
    const now = () => T + HOUR;
    await noteTouched(db, { cursor: key(T - 3 * HOUR), lastKey: key(T - CENSUS_CLOCK_MARGIN_MS + 1000), rows: rows("orders", 7), now });
    expect(touchedSince(await db.getMeta(TOUCHED_META), "orders", T)).toBe(7);
  });

  test("a page read twice is counted twice (wider, never narrower)", async () => {
    const db = await freshMirrorDb();
    const now = () => T + 2 * HOUR;
    const page = { cursor: key(T), lastKey: key(T + HOUR), rows: rows("stock", 10), now };
    await noteTouched(db, page);
    await noteTouched(db, page);                               // the commit failed; the page was re-read
    const j = await db.getMeta(TOUCHED_META);
    expect(touchedSince(j, "stock", T)).toBe(20);
    expect(j.from).toBe(T);                                    // …and the journal did not restart
  });

  test("a cursor that JUMPED ahead starts a new journal — it does not claim the gap", async () => {
    const db = await freshMirrorDb();
    const now = () => T + 20 * HOUR;
    await noteTouched(db, { cursor: key(T), lastKey: key(T + HOUR), rows: rows("stock", 10), now });
    await noteTouched(db, { cursor: key(T + 12 * HOUR), lastKey: key(T + 13 * HOUR), rows: rows("stock", 3), now });
    const j = await db.getMeta(TOUCHED_META);
    expect(j.from).toBe(T + 12 * HOUR);
    expect(touchedSince(j, "stock", T)).toBe(3);
  });

  test("forgets what is older than any census it will be asked about, and says so", async () => {
    const db = await freshMirrorDb();
    await noteTouched(db, { cursor: key(T), lastKey: key(T + HOUR), rows: rows("stock", 10), now: () => T + 2 * HOUR });
    const later = T + TOUCHED_KEEP_MS + 5 * HOUR;
    await noteTouched(db, { cursor: key(T + HOUR), lastKey: key(later - HOUR), rows: rows("stock", 1), now: () => later });
    const j = await db.getMeta(TOUCHED_META);
    expect(Object.values(j.legs.stock).reduce((a, b) => a + b, 0)).toBe(1);
    expect(j.from).toBe(later - TOUCHED_KEEP_MS);
  });
});

describe("covering a census the journal does not reach back to", () => {
  function logged(w, from, n, node = "settings/displaySlots", stepMs = 1000) {
    for (let i = 0; i < n; i += 1) {
      w.write(`${CHANGES_ROOT}/${key(from + i * stepMs, String(i).padStart(12, "0"))}`, { n: node, k: `marathon-pe|p${i}`, t: from + i * stepMs });
    }
  }

  test("a journal that already reaches back is returned as it is, and nothing is read", async () => {
    const db = await freshMirrorDb();
    const w = createFakeRtdb({});
    const now = () => T + 5 * HOUR;
    await noteTouched(db, { cursor: key(T - 2 * HOUR), lastKey: key(T + HOUR), rows: rows("stock", 4), now });
    const j = await coverSince(db, w.adapter, { censusAt: T, feedCursor: key(T + HOUR), changesRoot: CHANGES_ROOT, now });
    expect(touchedSince(j, "stock", T)).toBe(4);
    expect(w.calls.readKeyPage).toEqual([]);
  });

  test("a first setup at midday: the stretch from the census to the feed cursor is rebuilt from KEYS", async () => {
    const db = await freshMirrorDb();
    const w = createFakeRtdb({});
    logged(w, T - 3 * HOUR, 50);                               // before the census: not counted
    logged(w, T + HOUR, 700);                                  // census → cursor: counted
    const cursor = key(T + 4 * HOUR);
    logged(w, T + 5 * HOUR, 30);                               // after the cursor: the feed will carry these itself
    const now = () => T + 6 * HOUR;
    const j = await coverSince(db, w.adapter, { censusAt: T, feedCursor: cursor, changesRoot: CHANGES_ROOT, now });
    expect(touchedSince(j, "displaySlots", T)).toBe(700);
    expect(j.from).toBe(T - CENSUS_CLOCK_MARGIN_MS);
    // Pages of the log only — never a row.
    expect(w.calls.readPath).toEqual([]);
    expect(w.calls.readKeyPage.every((c) => c.path === CHANGES_ROOT && c.limit === BACKFILL_PAGE_SIZE)).toBe(true);
    // …and it is kept: asking again reads nothing.
    const reads = w.calls.readKeyPage.length;
    await coverSince(db, w.adapter, { censusAt: T, feedCursor: cursor, changesRoot: CHANGES_ROOT, now });
    expect(w.calls.readKeyPage.length).toBe(reads);
  });

  test("the same row written many times is one row", async () => {
    const db = await freshMirrorDb();
    const w = createFakeRtdb({});
    for (let i = 0; i < 40; i += 1) {
      w.write(`${CHANGES_ROOT}/${key(T + HOUR + i, String(i).padStart(12, "0"))}`, { n: "products", k: "p1", t: T + HOUR + i });
    }
    const j = await coverSince(db, w.adapter, {
      censusAt: T, feedCursor: key(T + 2 * HOUR), changesRoot: CHANGES_ROOT, now: () => T + 3 * HOUR,
    });
    expect(touchedSince(j, "products", T)).toBe(1);
  });

  test("it joins on to a journal that began later, without counting that journal's rows twice", async () => {
    const db = await freshMirrorDb();
    const w = createFakeRtdb({});
    logged(w, T + HOUR, 100);
    const now = () => T + 6 * HOUR;
    // The device's own journal starts at T+3h (it upgraded to this build then).
    logged(w, T + 3 * HOUR + 1000, 20, "products");
    await noteTouched(db, { cursor: key(T + 3 * HOUR), lastKey: key(T + 4 * HOUR), rows: rows("products", 20), now });
    const j = await coverSince(db, w.adapter, { censusAt: T, feedCursor: key(T + 4 * HOUR), changesRoot: CHANGES_ROOT, now });
    expect(touchedSince(j, "displaySlots", T)).toBe(100);
    expect(touchedSince(j, "products", T)).toBe(20);
  });

  test("a stretch too long to rebuild inside its page budget is NOT half-rebuilt", async () => {
    const db = await freshMirrorDb();
    const w = createFakeRtdb({});
    logged(w, T + 1000, 1200);
    const j = await coverSince(db, w.adapter, {
      censusAt: T, feedCursor: key(T + 10 * HOUR), changesRoot: CHANGES_ROOT, now: () => T + 11 * HOUR,
      pageSize: 100, maxPages: 3,
    });
    expect(j).toBeNull();
    expect(await db.getMeta(TOUCHED_META)).toBeUndefined();
    expect(w.calls.readKeyPage.length).toBe(3);                // bounded
  });

  test("a feed that has never taken a cursor has nothing to rebuild from", async () => {
    const db = await freshMirrorDb();
    const w = createFakeRtdb({});
    expect(await coverSince(db, w.adapter, {
      censusAt: T, feedCursor: undefined, changesRoot: CHANGES_ROOT, now: () => T + HOUR,
    })).toBeNull();
  });

  test("a null cursor reads the log from its first record: nothing is missing", async () => {
    const db = await freshMirrorDb();
    const w = createFakeRtdb({});
    const j = await coverSince(db, w.adapter, {
      censusAt: T, feedCursor: null, changesRoot: CHANGES_ROOT, now: () => T + HOUR,
    });
    expect(j.from).toBe(0);
    expect(w.calls.readKeyPage).toEqual([]);
  });
});
