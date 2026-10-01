import { describe, test, expect } from "vitest";
import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import {
  createSyncEngine, flattenPage, MUST_NOT_BE_EMPTY, SETUP_DONE_META, CURSOR_META, LEG_RETRY_BASE_MS,
} from "../sync";
import { LEG_BY_NAME, MIRROR_LEGS, isAppendOnly } from "../nodes";
import { getLegHealth, healthKey, isLegUsable } from "../health";
import { EmptyMirrorReadError, MirrorSnapshotShrankError } from "../health";
import { COUNTS_ROOT, CHANGES_ROOT, FEED_CURSOR_META } from "../changeFeed";

const T0 = 1_780_000_000_000;

// A world with one of everything the setup download insists on finding, so a
// test can add only what it is actually about.
function fullWorld(extra = {}) {
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

const engineOn = (db, w, opts = {}) =>
  createSyncEngine({ db, adapter: w.adapter, now: () => T0, buildVersion: "b1", ...opts });

describe("the setup download", () => {
  test("downloads every leg once and marks the device set up", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    const res = await e.runSetup();
    expect(res.alreadyDone).toBe(false);
    expect((await e.setupState()).done).toBe(true);
    expect(await db.get("products", "p1")).toEqual({ id: "p1", name: "Nike Air", price: 1200 });
    expect(await db.get("stock", "hub1|p1")).toEqual({ 9: { qty: 3 } });
    expect(await db.get("docs", "locations")).toBeTruthy();
    expect(await db.get("docs", "users/u1")).toEqual({ name: "Zee" });
  });

  test("a second run downloads nothing", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    const reads = w.calls.readKeyPage.length + w.calls.readPath.length;
    const again = await e.runSetup();
    expect(again.alreadyDone).toBe(true);
    // Only the census read, at most — never a node.
    expect(w.calls.readKeyPage.length + w.calls.readPath.length).toBe(reads);
  });

  test("the change cursor is taken BEFORE any leg is read", async () => {
    // A write during the download must be replayed, not skipped.
    const db = await freshMirrorDb();
    const recs = { [pushKeyForMs(T0 - 5000, "A")]: { n: "products", k: "p0", t: T0 - 5000 } };
    const w = fullWorld({ [CHANGES_ROOT]: recs });
    await engineOn(db, w).runSetup();
    expect(await db.getMeta(FEED_CURSOR_META)).toBe(Object.keys(recs)[0]);
  });

  test("an empty change log is a real state, and the cursor is null", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    await engineOn(db, w).runSetup();
    expect(await db.getMeta(FEED_CURSOR_META)).toBeNull();
  });

  test("a running setup does NOT re-take a change cursor that already stands", async () => {
    // Re-taking it would rewind a working cursor to the head of the log and
    // skip everything in between — silently.
    const db = await freshMirrorDb();
    const w = fullWorld({ [CHANGES_ROOT]: { [pushKeyForMs(T0, "Z")]: { n: "products", k: "p9", t: T0 } } });
    await db.setMeta(FEED_CURSOR_META, "-OLDCURSOR");
    await engineOn(db, w).runSetup();
    expect(await db.getMeta(FEED_CURSOR_META)).toBe("-OLDCURSOR");
  });

  test("progress is reported per leg, so the screen can be honest", async () => {
    const db = await freshMirrorDb();
    const seen = [];
    await createSyncEngine({
      db, adapter: fullWorld().adapter, now: () => T0, buildVersion: "b1",
      onProgress: (p) => seen.push(p),
    }).runSetup();
    const setupEvents = seen.filter((p) => p.phase === "setup");
    expect(setupEvents.length).toBeGreaterThan(MIRROR_LEGS.length);
    expect(setupEvents.at(-1).done).toBe(setupEvents.at(-1).total);
  });
});

describe("empty is not success", () => {
  test("a node that cannot be empty reading empty is a FAILED leg, not an empty mirror", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    w.write("products", null);
    await expect(engineOn(db, w).runSetup()).rejects.toThrow(EmptyMirrorReadError);
    const health = await getLegHealth(db, "products");
    expect(health.ok).toBe(false);
    expect(health.reason).toBe("empty");
    expect(health.path).toBe("products");     // the single most useful fact
    expect(await db.getMeta(SETUP_DONE_META)).toBeUndefined();
  });

  test("an empty read never wipes the copy already held", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    expect(await db.count("products")).toBe(1);

    w.write("products", null);
    await expect(e.runSetup({ force: true })).rejects.toThrow(EmptyMirrorReadError);
    expect(await db.count("products")).toBe(1);
    // …and the rows stay READABLE, because the failure carries what the last
    // accepted swap put on disk.
    expect(await isLegUsable(db, "products")).toBe(true);
  });

  test("a node that CAN be empty is not a failure", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();                 // no /returns_log at all
    await engineOn(db, w).runSetup();
    const health = await getLegHealth(db, "returnsLog");
    expect(health.ok).toBe(true);
    expect(health.rows).toBe(0);
  });

  test("the legs that may not be empty are named, not inferred", () => {
    expect(MUST_NOT_BE_EMPTY).toContain("products");
    expect(MUST_NOT_BE_EMPTY).toContain("stock");
    expect(MUST_NOT_BE_EMPTY).toContain("locations");
    expect(MUST_NOT_BE_EMPTY).toContain("users");
    expect(MUST_NOT_BE_EMPTY).not.toContain("returnsLog");
    expect(MUST_NOT_BE_EMPTY).not.toContain("displayRows");
  });
});

describe("a snapshot may never shrink quietly", () => {
  test("the measured POS truncation is refused and the good copy is kept", async () => {
    const db = await freshMirrorDb();
    const many = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`p${i}`, { id: `p${i}`, name: "x" }]));
    const w = fullWorld({ products: many });
    const e = engineOn(db, w);
    await e.runSetup();
    expect(await db.count("products")).toBe(400);

    // A truncated read: the node now answers with a prefix.
    w.write("products", Object.fromEntries(Object.entries(many).slice(0, 20)));
    await expect(e.runSetup({ force: true })).rejects.toThrow(MirrorSnapshotShrankError);
    expect(await db.count("products")).toBe(400);
    expect(await isLegUsable(db, "products")).toBe(true);   // still selling from it
    expect((await getLegHealth(db, "products")).reason).toBe("shrank");
  });

  test("an ordinary deletion passes", async () => {
    const db = await freshMirrorDb();
    const many = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`p${i}`, { id: `p${i}` }]));
    const w = fullWorld({ products: many });
    const e = engineOn(db, w);
    await e.runSetup();
    w.write("products/p399", null);
    await e.runSetup({ force: true });
    expect(await db.count("products")).toBe(399);
  });
});

describe("a download is resumable, never a restart", () => {
  test("an interruption costs the pages not yet fetched, not the ones in hand", async () => {
    const db = await freshMirrorDb();
    const many = Object.fromEntries(
      Array.from({ length: 1200 }, (_, i) => [`p${String(i).padStart(4, "0")}`, { id: `p${i}` }]));
    const w = fullWorld({ products: many });
    let pages = 0;
    const real = w.adapter.readKeyPage;
    w.adapter.readKeyPage = async (path, opts) => {
      if (path === "products") {
        pages += 1;
        if (pages === 3) throw new Error("line dropped mid-download");
      }
      return real(path, opts);
    };
    // A clock that moves: a failed leg now backs off (LEG_RETRY_BASE_MS)
    // before the same session tries it again.
    let clock = T0;
    const e = engineOn(db, w, { now: () => clock });
    await expect(e.runSetup()).rejects.toThrow("line dropped");

    // Resume: the two pages that landed are staged, so only the rest is read.
    const pagesBefore = pages;
    w.adapter.readKeyPage = real;
    clock += LEG_RETRY_BASE_MS;
    await e.runSetup();
    expect(await db.count("products")).toBe(1200);
    // 400 per page, 1200 rows: 3 full pages plus the short one that ends it.
    // Two were already staged, so a restart would have cost 4 more reads.
    expect(pages - pagesBefore).toBeLessThanOrEqual(3);
  });
});

describe("the append-only legs", () => {
  test("/insights_log is walked forward by key and never read whole again", async () => {
    const db = await freshMirrorDb();
    const log = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [pushKeyForMs(T0 + i * 1000, String(i).padStart(12, "A")),
        { timestamp: T0 + i * 1000, type: "sale" }]));
    const w = fullWorld({ insights_log: log });
    const e = engineOn(db, w);
    await e.runSetup();
    expect(await db.count("insights")).toBe(30);
    const cursor = await db.getMeta(CURSOR_META("insights"));
    expect(cursor).toBe(Object.keys(log).sort().at(-1));

    // One new entry: exactly one more row, and no whole-node read.
    const k = pushKeyForMs(T0 + 99_000, "ZZZZZZZZZZZZ");
    w.write(`insights_log/${k}`, { timestamp: T0 + 99_000, type: "sale" });
    await e.runRangeLeg(LEG_BY_NAME.insights, { maxPages: 2 });
    expect(await db.count("insights")).toBe(31);
    expect(w.calls.readPath).not.toContain("insights_log");
  });

  test("/stock_movements is walked forward by its indexed ts", async () => {
    const db = await freshMirrorDb();
    const mv = {
      a: { ts: "2026-09-01T00:00:00.000Z", qty: 1 },
      b: { ts: "2026-09-02T00:00:00.000Z", qty: 2 },
    };
    const w = fullWorld({ stock_movements: mv });
    const e = engineOn(db, w);
    await e.runSetup();
    expect(await db.count("movements")).toBe(2);
    // A PAIR, not a bare timestamp: `ts` is not unique, and a bare ts cursor
    // makes every pass re-read every row sharing the newest one — about 25 MB
    // per device per day after a bulk transfer.
    expect(await db.getMeta(CURSOR_META("movements")))
      .toEqual({ ts: "2026-09-02T00:00:00.000Z", key: "b" });

    w.write("stock_movements/c", { ts: "2026-09-03T00:00:00.000Z", qty: 3 });
    await e.runRangeLeg(LEG_BY_NAME.movements, { maxPages: 2 });
    expect(await db.count("movements")).toBe(3);
  });

  test("the ts cursor is INCLUSIVE, so movements sharing a timestamp are not skipped", async () => {
    // One transfer writes several movements with an identical ISO string. An
    // exclusive bound would keep the one that set the cursor and lose the rest.
    const db = await freshMirrorDb();
    const same = "2026-09-02T00:00:00.000Z";
    const w = fullWorld({ stock_movements: { a: { ts: same, qty: 1 } } });
    const e = engineOn(db, w);
    await e.runSetup();
    w.write("stock_movements/b", { ts: same, qty: 2 });
    w.write("stock_movements/c", { ts: same, qty: 3 });
    await e.runRangeLeg(LEG_BY_NAME.movements, { maxPages: 2 });
    expect(await db.count("movements")).toBe(3);
  });

  test("MORE ROWS THAN A PAGE SHARING ONE TIMESTAMP still all arrive", async () => {
    // A bulk transfer writes every movement at one ISO string. With a bare ts
    // cursor this either loops for ever or skips; the compound (ts, key)
    // cursor walks through them a page at a time.
    const db = await freshMirrorDb();
    const same = "2026-09-02T00:00:00.000Z";
    const mv = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`m${i}`, { ts: same, qty: 1 }]));
    const w = fullWorld({ stock_movements: mv });
    const leg = { ...LEG_BY_NAME.movements, pageSize: 3 };
    const e = engineOn(db, w);
    await e.runRangeLeg(leg, { maxPages: 10 });
    expect(await db.count("movements")).toBe(7);
    expect(await db.getMeta(CURSOR_META("movements"))).toEqual({ ts: same, key: "m6" });
  });

  test("A CAUGHT-UP LEG RE-READS ONE ROW, NOT A WHOLE TIMESTAMP'S WORTH", async () => {
    // The cost this compound cursor exists for: 50 movements at one timestamp
    // × 1,440 passes a day was ~25 MB per device per day, against a budget of
    // 267 KB. (Fable-vs-spec review, PR #618.)
    const db = await freshMirrorDb();
    const same = "2026-09-02T00:00:00.000Z";
    const mv = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${String(i).padStart(2, "0")}`, { ts: same, qty: 1 }]));
    const w = fullWorld({ stock_movements: mv });
    const e = engineOn(db, w);
    await e.runRangeLeg(LEG_BY_NAME.movements, { maxPages: 10 });
    expect(await db.count("movements")).toBe(20);

    // A pass with nothing new: exactly one row comes back, and it is a row we
    // already hold.
    const res = await e.runRangeLeg(LEG_BY_NAME.movements, { maxPages: 1 });
    expect(res.added).toBe(0);
    const lastCall = w.calls.readChildPage.at(-1);
    expect(lastCall.fromKey).toBe("m19");
  });

  test("a cursor stored by an older build as a bare string still works", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld({
      stock_movements: {
        a: { ts: "2026-09-01T00:00:00.000Z" }, b: { ts: "2026-09-02T00:00:00.000Z" },
      },
    });
    await db.setMeta(CURSOR_META("movements"), "2026-09-01T00:00:00.000Z");
    const e = engineOn(db, w);
    await e.runRangeLeg(LEG_BY_NAME.movements, { maxPages: 5 });
    expect(await db.count("movements")).toBe(2);
    expect(await db.getMeta(CURSOR_META("movements"))).toEqual({
      ts: "2026-09-02T00:00:00.000Z", key: "b",
    });
  });
});

describe("flattening a page", () => {
  test("depth 2 gives loc|pid rows", () => {
    const { rows } = flattenPage(LEG_BY_NAME.stock, { hub1: { p1: { 9: { qty: 1 } } } });
    expect(rows).toEqual([{ key: "hub1|p1", value: { 9: { qty: 1 } } }]);
  });

  test("depth 3 gives store|pid|rowId rows", () => {
    const { rows } = flattenPage(LEG_BY_NAME.displayRows,
      { "marathon-pe": { p1: { r1: { open: true }, r2: { open: false } } } });
    expect(rows.map((r) => r.key)).toEqual(["marathon-pe|p1|r1", "marathon-pe|p1|r2"]);
  });

  test("an ARRAY-COERCED node's null holes are skipped, not walked", () => {
    // RTDB turns dense integer keys into an array with nulls in the gaps; 560
    // of 5,793 live /stock rows are shaped this way today.
    const arrayish = [null, { 9: { qty: 1 } }, null, { 10: { qty: 2 } }];
    const { rows } = flattenPage(LEG_BY_NAME.stock, { hub1: arrayish });
    expect(rows.map((r) => r.key)).toEqual(["hub1|1", "hub1|3"]);
  });

  test("a /stock location this app does not know is skipped and NAMED", () => {
    const { rows, skipped } = flattenPage(LEG_BY_NAME.stock, { pe: { p1: {} } });
    expect(rows).toHaveLength(0);
    expect(skipped[0].why).toBe("unknown-location");
  });

  test("a key containing the row-key separator is refused, never joined", () => {
    const { rows, skipped } = flattenPage(LEG_BY_NAME.stock, { hub1: { "p|1": {} } });
    expect(rows).toHaveLength(0);
    expect(skipped[0].why).toBe("unrepresentable-key");
  });

  test("a subtree shallower than its depth contributes no rows and no error", () => {
    const { rows, skipped } = flattenPage(LEG_BY_NAME.displayRows, { "marathon-pe": {} });
    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  test("depth 0 is one document keyed by its path", () => {
    const { rows } = flattenPage(LEG_BY_NAME.locations, { hub1: { id: "hub1" } });
    expect(rows).toEqual([{ key: "locations", value: { hub1: { id: "hub1" } } }]);
  });
});

describe("the census — the one check that is not local", () => {
  test("a leg whose count disagrees with the server is marked for re-download", async () => {
    const db = await freshMirrorDb();
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`p${i}`, { id: `p${i}` }]));
    const w = fullWorld({ products: many });
    const e = engineOn(db, w);
    await e.runSetup();

    // The server says 900. A change record was never written for 500 of them.
    w.write(COUNTS_ROOT, { products: { rows: 900, at: T0 - 3600_000 } });
    const res = await e.checkCensus({ force: true });
    expect(res.drifted).toEqual([{ leg: "products", held: 400, census: 900, allowed: 25 }]);
    expect((await getLegHealth(db, "products")).reason).toBe("count-drift");
    expect(await e.legIsSetUp(LEG_BY_NAME.products)).toBe(false);
  });

  test("ordinary churn since last night is inside tolerance", async () => {
    const db = await freshMirrorDb();
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`p${i}`, { id: `p${i}` }]));
    const w = fullWorld({ products: many });
    const e = engineOn(db, w);
    await e.runSetup();
    w.write(COUNTS_ROOT, { products: { rows: 415, at: T0 - 3600_000 } });
    expect((await e.checkCensus({ force: true })).drifted).toEqual([]);
  });

  test("NO census is not a verdict — it must not send the estate back to 104 MB", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    const res = await e.checkCensus({ force: true });
    expect(res.skipped).toBe("no-census");
    expect(await e.legIsSetUp(LEG_BY_NAME.products)).toBe(true);
  });

  test("a STALE census is not evidence about today's rows", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    w.write(COUNTS_ROOT, { products: { rows: 99999, at: T0 - 5 * 86400_000 } });
    const res = await e.checkCensus({ force: true });
    expect(res.drifted).toEqual([]);
    expect(res.checked).not.toContain("products");
  });

  test("/orders gets a wider tolerance, because its ids are recycled daily", async () => {
    const db = await freshMirrorDb();
    const orders = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`o${i}`, { id: `o${i}` }]));
    const w = fullWorld({ orders });
    const e = engineOn(db, w);
    await e.runSetup();
    // 60 rows over — 20%, which would fail every other leg.
    w.write(COUNTS_ROOT, { orders: { rows: 360, at: T0 - 3600_000 } });
    expect((await e.checkCensus({ force: true })).drifted).toEqual([]);
    expect(LEG_BY_NAME.orders.censusTolerance).toBe(0.25);
  });
});

describe("the steady-state pass", () => {
  test("applies the feed, walks both ranges, and reads no node whole", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();

    w.write("products/p1/price", 999);
    const k = pushKeyForMs(T0 + 1000, "BBBBBBBBBBBB");
    w.write(`${CHANGES_ROOT}/${k}`, { n: "products", k: "p1", t: T0 + 1000 });

    w.calls.readPath.length = 0;
    const report = await e.runPass();
    expect(report.feed.applied).toBe(1);
    expect((await db.get("products", "p1")).price).toBe(999);
    // The ONLY whole-path reads a pass may make are the /mirror_counts census
    // and the individual changed rows.
    for (const p of w.calls.readPath) {
      expect(p === COUNTS_ROOT || p.includes("/")).toBe(true);
    }
    expect(report.errors).toEqual([]);
  });

  test("an expired cursor marks every change-fed leg for a fresh download", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    await db.setMeta(FEED_CURSOR_META, pushKeyForMs(T0 - 40 * 86400_000, "A"));

    const report = await e.runPass();
    expect(report.errors[0]).toMatchObject({ where: "feed", reason: "cursor-expired" });
    expect(await e.legIsSetUp(LEG_BY_NAME.products)).toBe(false);
    // The append-only legs are untouched: their cursors cannot expire.
    expect(await e.legIsSetUp(LEG_BY_NAME.insights)).toBe(true);
    expect(await db.getMeta(FEED_CURSOR_META)).toBeUndefined();
  });

  test("one leg failing does not stop the others", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    const real = w.adapter.readChildPage;
    w.adapter.readChildPage = async () => { throw new Error("movements unreachable"); };
    const report = await e.runPass();
    expect(report.errors.some((x) => x.where === "movements")).toBe(true);
    expect(report.range.some((r) => r.leg === "insights")).toBe(true);
    w.adapter.readChildPage = real;
  });
});

describe("the guarantees the comments claim, checked rather than trusted", () => {
  test("a big node is read with the BIG budget, not the counter-facing one", async () => {
    // A 35.8 MB node on a shop line cannot answer inside READ_TIMEOUT_MS. If a
    // change here dropped `big: true` the setup download would time out on
    // every large leg — and until the fake recorded its options, nothing
    // could see it. (Opus test audit, PR #618.)
    const db = await freshMirrorDb();
    const w = fullWorld({
      insights_log: { "-A": { timestamp: 1 } },
      stock_movements: { m1: { ts: "2026-09-01T00:00:00.000Z" } },
    });
    await engineOn(db, w).runSetup();
    const bigPaths = w.calls.readKeyPage.filter((c) => c.big).map((c) => c.path);
    expect(bigPaths).toContain("products");
    expect(bigPaths).toContain("insights_log");
    expect(w.calls.readChildPage.every((c) => c.big)).toBe(true);
  });
});

describe("a leg that needs downloading again, downloads again", () => {
  test("a census drift is repaired BY THE PASS, not by a reload", async () => {
    // Before this, a drifted leg fell back to whole-node LIVE reads — the
    // expensive path this work exists to remove — and stayed there until
    // someone reloaded, which then blocked the whole app behind a 35 MB
    // download, possibly mid-trade. (Fable-vs-spec review, PR #618.)
    const db = await freshMirrorDb();
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`p${i}`, { id: `p${i}` }]));
    const w = fullWorld({ products: many });
    const e = engineOn(db, w);
    await e.runSetup();

    w.write(COUNTS_ROOT, { products: { rows: 900, at: T0 - 3600_000 } });
    await e.checkCensus({ force: true });
    expect(await e.legIsSetUp(LEG_BY_NAME.products)).toBe(false);

    // The server really does hold 900 now.
    for (let i = 400; i < 900; i += 1) w.write(`products/p${i}`, { id: `p${i}` });
    w.write(COUNTS_ROOT, { products: { rows: 900, at: T0 - 3600_000 } });
    const report = await e.runPass();
    expect(report.repaired).toEqual({ leg: "products", rows: 900 });
    expect(await db.count("products")).toBe(900);
    expect(await e.legIsSetUp(LEG_BY_NAME.products)).toBe(true);
  });

  test("ONE leg per pass — a repair cannot monopolise a device", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    await db.deleteMetaMany(["setup.products", "setup.customers", SETUP_DONE_META]);
    const first = await e.runPass();
    expect(first.repaired).toBeTruthy();
    const second = await e.runPass();
    expect(second.repaired).toBeTruthy();
    expect(second.repaired.leg).not.toBe(first.repaired.leg);
    expect(await e.runPass().then((r) => r.repaired)).toBeNull();
  });

  test("the whole-device marker comes back only when every leg is back", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    await db.deleteMetaMany(["setup.products", "setup.customers", SETUP_DONE_META]);
    await e.runPass();
    expect(await db.getMeta(SETUP_DONE_META)).toBeUndefined();   // one still missing
    await e.runPass();
    expect(await db.getMeta(SETUP_DONE_META)).toBeTruthy();
  });

  test("a repair that fails does not stop the rest of the pass", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld();
    const e = engineOn(db, w);
    await e.runSetup();
    await db.deleteMetaMany(["setup.products", SETUP_DONE_META]);
    w.write("products", null);            // the read now comes back empty
    const report = await e.runPass();
    expect(report.errors.some((x) => x.where === "repair")).toBe(true);
    expect(report.feed).toBeTruthy();
    // …and the rows that were already there are untouched and still usable.
    expect(await db.count("products")).toBe(1);
  });
});

describe("the setup bar does not count a leg done while it is downloading", () => {
  test("a paged leg reports `staged` per page and `rows` once", async () => {
    const db = await freshMirrorDb();
    const many = Object.fromEntries(
      Array.from({ length: 900 }, (_, i) => [`p${String(i).padStart(4, "0")}`, { id: `p${i}` }]));
    const w = fullWorld({ products: many });
    const seen = [];
    await createSyncEngine({
      db, adapter: w.adapter, now: () => T0, buildVersion: "b1",
      onProgress: (p) => { if (p.leg === "products") seen.push(p); },
    }).runSetup();
    const staged = seen.filter((p) => p.staged !== undefined);
    const finished = seen.filter((p) => p.rows !== undefined);
    expect(staged.length).toBeGreaterThan(1);       // several pages
    expect(finished).toHaveLength(1);               // one completion
    expect(finished[0].rows).toBe(900);
  });
});

describe("`added` means NEW rows, on both kinds of forward walk", () => {
  test("ONE new /insights_log row reports added: 1 — the signal every reader waits on", async () => {
    // The keyRange bound is EXCLUSIVE, so there is no overlap row to discount.
    // Subtracting one anyway made the commonest case /insights_log has — a
    // single append per sale — report zero, so bumpLegs never fired and a
    // screen sat on yesterday's total until a pass happened to bring two rows
    // at once. (Sonnet verification review, PR #618.)
    const db = await freshMirrorDb();
    const log = Object.fromEntries(Array.from({ length: 3 }, (_, i) =>
      [pushKeyForMs(T0 + i * 1000, String(i).padStart(12, "A")), { timestamp: T0 + i * 1000 }]));
    const w = fullWorld({ insights_log: log });
    const e = engineOn(db, w);
    await e.runSetup();

    w.write(`insights_log/${pushKeyForMs(T0 + 9000, "ZZZZZZZZZZZZ")}`, { timestamp: T0 + 9000 });
    const res = await e.runRangeLeg(LEG_BY_NAME.insights, { maxPages: 2 });
    expect(res.added).toBe(1);
    expect(await db.count("insights")).toBe(4);
  });

  test("a caught-up /insights_log leg reports added: 0", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld({ insights_log: { "-A": { timestamp: T0 } } });
    const e = engineOn(db, w);
    await e.runSetup();
    expect((await e.runRangeLeg(LEG_BY_NAME.insights, { maxPages: 2 })).added).toBe(0);
  });

  test("ONE new /stock_movements row also reports added: 1, overlap discounted", async () => {
    // The tsRange bound IS inclusive, so its resumed page carries the cursor's
    // own row plus the new one — two records, one of them new.
    const db = await freshMirrorDb();
    const w = fullWorld({ stock_movements: { a: { ts: "2026-09-01T00:00:00.000Z" } } });
    const e = engineOn(db, w);
    await e.runSetup();
    w.write("stock_movements/b", { ts: "2026-09-02T00:00:00.000Z" });
    const res = await e.runRangeLeg(LEG_BY_NAME.movements, { maxPages: 2 });
    expect(res.added).toBe(1);
    expect(await db.count("movements")).toBe(2);
  });

  test("a caught-up /stock_movements leg reports added: 0, not -1 or 1", async () => {
    const db = await freshMirrorDb();
    const w = fullWorld({ stock_movements: { a: { ts: "2026-09-01T00:00:00.000Z" } } });
    const e = engineOn(db, w);
    await e.runSetup();
    expect((await e.runRangeLeg(LEG_BY_NAME.movements, { maxPages: 2 })).added).toBe(0);
  });
});
