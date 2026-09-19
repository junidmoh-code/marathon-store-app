import { describe, test, expect } from "vitest";
import { freshMirrorDb } from "./helpers";
import { createFakeRtdb, pushKeyForMs } from "./fakeAdapter";
import {
  runChangeFeedPage, rowsFromChangePage, cursorIsResumable, msFromPushKey,
  changeCursorAtSetupStart, CursorExpiredError, FEED_CURSOR_META,
  CHANGE_RETENTION_MS, CHANGES_ROOT,
} from "../changeFeed";

const T0 = 1_780_000_000_000;

// A change record at a chosen moment, so a page has a known key order.
const change = (i, n, k, t = T0 + i * 1000) => [pushKeyForMs(t, String(i).padStart(12, "A")), { n, k, t }];

function world(records, tree = {}) {
  return createFakeRtdb({ ...tree, [CHANGES_ROOT]: Object.fromEntries(records) });
}

describe("reading a page of the change feed", () => {
  test("a product edit reaches the local copy", async () => {
    const db = await freshMirrorDb();
    const w = world([change(0, "products", "p1")], {
      products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
    });
    const res = await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    expect(res.applied).toBe(1);
    expect(await db.get("products", "p1")).toEqual({ id: "p1", name: "Nike Air", price: 1200 });
  });

  test("A PRICE CHANGE REACHES THE MIRROR — the POS failure, end to end", async () => {
    // A price changed in the office and a mirrored till went on showing the old
    // one. This is that path: edit the node, run the feed, read the local copy.
    const db = await freshMirrorDb();
    const w = world([change(0, "products", "p1")], {
      products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
    });
    await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    expect((await db.get("products", "p1")).price).toBe(1200);

    w.write("products/p1/price", 999);
    w.write(`${CHANGES_ROOT}/${change(1, "products", "p1")[0]}`, change(1, "products", "p1")[1]);
    await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 120_000 });
    expect((await db.get("products", "p1")).price).toBe(999);
  });

  test("a DELETE upstream removes the local row", async () => {
    const db = await freshMirrorDb();
    const w = world([change(0, "products", "p1")], { products: { p1: { id: "p1" } } });
    await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    expect(await db.count("products")).toBe(1);

    w.write("products/p1", null);
    const [k, rec] = change(1, "products", "p1");
    w.write(`${CHANGES_ROOT}/${k}`, rec);
    const res = await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 120_000 });
    expect(res.deleted).toBe(1);
    expect(await db.count("products")).toBe(0);
  });

  test("the cursor advances to the largest key in the page", async () => {
    const db = await freshMirrorDb();
    const recs = [change(0, "products", "p1"), change(1, "products", "p2"), change(2, "products", "p3")];
    const w = world(recs, { products: { p1: {}, p2: {}, p3: {} } });
    const res = await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    expect(res.cursor).toBe(recs[2][0]);
    expect(await db.getMeta(FEED_CURSOR_META)).toBe(recs[2][0]);
  });

  test("a second pass reads only what is new", async () => {
    const db = await freshMirrorDb();
    const w = world([change(0, "products", "p1")], { products: { p1: {} } });
    await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    const before = w.calls.readPath.length;
    const res = await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 61_000 });
    expect(res.applied).toBe(0);
    expect(res.done).toBe(true);
    expect(w.calls.readPath.length).toBe(before);   // no row re-read
  });

  test("one row written many times in a burst costs ONE read", async () => {
    const db = await freshMirrorDb();
    const recs = Array.from({ length: 40 }, (_, i) => change(i, "products", "p1"));
    const w = world(recs, { products: { p1: { price: 5 } } });
    await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    expect(w.calls.readPath.filter((p) => p === "products/p1")).toHaveLength(1);
  });

  test("a full page is not `done` — a short one is", async () => {
    const db = await freshMirrorDb();
    const recs = Array.from({ length: 4 }, (_, i) => change(i, "products", `p${i}`));
    const w = world(recs, { products: { p0: {}, p1: {}, p2: {}, p3: {} } });
    const res = await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000, pageSize: 4 });
    expect(res.done).toBe(false);
    const next = await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000, pageSize: 4 });
    expect(next.done).toBe(true);
  });

  test("a row that cannot be read abandons the page WITHOUT moving the cursor", async () => {
    const db = await freshMirrorDb();
    const w = world([change(0, "products", "p1"), change(1, "products", "p2")], {
      products: { p1: {}, p2: {} },
    });
    const real = w.adapter.readPath;
    w.adapter.readPath = async (path) => {
      if (path === "products/p2") throw new Error("line dropped");
      return real(path);
    };
    await expect(runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 })).rejects.toThrow();
    // Nothing committed, nothing skipped: the next pass sees the same page.
    expect(await db.getMeta(FEED_CURSOR_META)).toBeUndefined();
    expect(await db.count("products")).toBe(0);
  });

  test("rows land in the store their leg names, at the key their depth gives", async () => {
    const db = await freshMirrorDb();
    const w = world([
      change(0, "stock", "hub1|p1"),
      change(1, "settings/displayRows", "marathon-pe|p1|r9"),
      change(2, "locations", ""),
    ], {
      stock: { hub1: { p1: { 9: { qty: 3 } } } },
      settings: { displayRows: { "marathon-pe": { p1: { r9: { open: true } } } } },
      locations: { hub1: { label: "Hub 1" } },
    });
    await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    expect(await db.get("stock", "hub1|p1")).toEqual({ 9: { qty: 3 } });
    expect(await db.get("displayRows", "marathon-pe|p1|r9")).toEqual({ open: true });
    expect(await db.get("docs", "locations")).toEqual({ hub1: { label: "Hub 1" } });
  });

  test("a page whose records are ALL skipped still advances — or it repeats for ever", async () => {
    const db = await freshMirrorDb();
    const w = world([change(0, "some_node_this_build_does_not_know", "x")]);
    const res = await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    expect(res.applied).toBe(0);
    expect(res.skipped[0].why).toBe("unknown-node");
    expect(await db.getMeta(FEED_CURSOR_META)).toBe(res.cursor);
  });
});

describe("what a page refuses to apply", () => {
  test("a /stock row naming an unknown location is skipped, never guessed", () => {
    const page = Object.fromEntries([change(0, "stock", "pe|p1")]);
    const { rows, skipped } = rowsFromChangePage(page);
    // "pe" is the POS's id. Storing this row would put pe's cells where nothing
    // looks and leave marathon-pe's wrong — the /stock/pe failure, inverted.
    expect(rows).toHaveLength(0);
    expect(skipped[0].why).toBe("unknown-location");
  });

  test("a canonical location passes", () => {
    const { rows } = rowsFromChangePage(Object.fromEntries([change(0, "stock", "marathon-pe|p1")]));
    expect(rows).toHaveLength(1);
  });

  test("a malformed record is skipped rather than crashing the pass", () => {
    const { rows, skipped } = rowsFromChangePage({ k1: null, k2: "nonsense", k3: { n: "products" } });
    expect(rows).toHaveLength(0);
    expect(skipped.map((s) => s.why)).toEqual(["malformed", "malformed", "no-row-key"]);
  });

  test("a depth>0 leg with an empty row key is refused", () => {
    const { rows, skipped } = rowsFromChangePage(Object.fromEntries([change(0, "products", "")]));
    expect(rows).toHaveLength(0);
    expect(skipped[0].why).toBe("no-row-key");
  });

  test("a depth-0 leg's empty row key is CORRECT, not missing", () => {
    const { rows } = rowsFromChangePage(Object.fromEntries([change(0, "locations", "")]));
    expect(rows).toHaveLength(1);
  });
});

describe("a cursor past retention is not resumable", () => {
  test("a fresh cursor resumes", () => {
    expect(cursorIsResumable(pushKeyForMs(T0), T0 + 60_000)).toBe(true);
  });

  test("no cursor at all resumes — nothing has been consumed yet", () => {
    expect(cursorIsResumable(null, T0)).toBe(true);
    expect(cursorIsResumable(undefined, T0)).toBe(true);
  });

  test("a cursor older than the retained window does NOT", () => {
    const old = pushKeyForMs(T0 - CHANGE_RETENTION_MS - 1);
    expect(cursorIsResumable(old, T0)).toBe(false);
  });

  test("the safety margin trips a day early, not on the day", () => {
    // A device should not discover it needs a 104 MB download mid-trade.
    const justInside = pushKeyForMs(T0 - CHANGE_RETENTION_MS + 25 * 3600_000);
    const justOutside = pushKeyForMs(T0 - CHANGE_RETENTION_MS + 23 * 3600_000);
    expect(cursorIsResumable(justInside, T0)).toBe(true);
    expect(cursorIsResumable(justOutside, T0)).toBe(false);
  });

  test("a cursor whose time cannot be read is treated as expired", () => {
    // Corrupt, or a key format this build does not understand. Resuming would
    // skip an unknown amount; downloading again skips nothing.
    expect(cursorIsResumable("!!!", T0)).toBe(false);
    expect(cursorIsResumable("short", T0)).toBe(false);
  });

  test("the feed RAISES rather than resuming from an expired cursor", async () => {
    const db = await freshMirrorDb();
    await db.setMeta(FEED_CURSOR_META, pushKeyForMs(T0 - CHANGE_RETENTION_MS - 1));
    const w = world([change(0, "products", "p1")], { products: { p1: {} } });
    await expect(runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 }))
      .rejects.toThrow(CursorExpiredError);
  });

  test("push key time survives a round trip", () => {
    for (const ms of [0, 1, T0, T0 + 86400000]) {
      expect(msFromPushKey(pushKeyForMs(ms))).toBe(ms);
    }
  });
});

describe("where a device's cursor starts", () => {
  test("it is the NEWEST record at the moment the download began", async () => {
    const recs = [change(0, "products", "p1"), change(1, "products", "p2")];
    const w = world(recs);
    expect(await changeCursorAtSetupStart({ adapter: w.adapter })).toBe(recs[1][0]);
  });

  test("an empty log is a real state and yields null, not a failure", async () => {
    const w = createFakeRtdb({});
    expect(await changeCursorAtSetupStart({ adapter: w.adapter })).toBeNull();
  });

  test("a write DURING the download is replayed, never skipped", async () => {
    // The cursor is taken at the start, so anything written while the 104 MB
    // was in flight comes down the feed afterwards — an upsert of a value that
    // may already be correct, which costs one read. Skipping it would be
    // silent and permanent.
    const db = await freshMirrorDb();
    const recs = [change(0, "products", "p1")];
    const w = world(recs, { products: { p1: { price: 10 } } });
    const startCursor = await changeCursorAtSetupStart({ adapter: w.adapter });

    // …the download reads /products here, catching price 10…
    await db.replaceAll("products", [{ key: "p1", value: { price: 10 } }]);
    // …and a price edit lands mid-download.
    w.write("products/p1/price", 88);
    const [k, rec] = change(1, "products", "p1");
    w.write(`${CHANGES_ROOT}/${k}`, rec);

    await db.setMeta(FEED_CURSOR_META, startCursor);
    await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 60_000 });
    expect((await db.get("products", "p1")).price).toBe(88);
  });
});

describe("a page commits WITH its cursor, or not at all", () => {
  // The claim at the top of changeFeed.js, and until now untested: a mutation
  // audit moved the cursor write to its own transaction BEFORE every putPage
  // and all 57 tests here stayed green. The one test that looked like it
  // covered this only fails the FETCH, which happens before any store is
  // touched. (Opus test audit, PR #618.)
  //
  // What these fail instead is a STORE WRITE, mid-page, which is the shape of
  // "the tab was closed" and "the quota ran out".

  const wrapDb = (db, onPut) => ({
    ...db,
    putPage: (...args) => onPut(args) ?? db.putPage(...args),
  });

  test("a store write that fails leaves the cursor exactly where it was", async () => {
    const db = await freshMirrorDb();
    const w = world([change(0, "products", "p1")], { products: { p1: { price: 1 } } });
    const failing = wrapDb(db, () => { throw new Error("quota exceeded mid-page"); });
    await expect(runChangeFeedPage({ db: failing, adapter: w.adapter, now: () => T0 + 1000 }))
      .rejects.toThrow("quota exceeded");
    expect(await db.getMeta(FEED_CURSOR_META)).toBeUndefined();
  });

  test("a page touching TWO stores does not advance the cursor if the second fails", async () => {
    // This is the ordering the code comments claim: the cursor rides the LAST
    // store's transaction, so a later failure cannot leave it ahead of rows
    // that never landed.
    const db = await freshMirrorDb();
    const w = world([change(0, "products", "p1"), change(1, "customers", "c1")], {
      products: { p1: { price: 1 } }, customers: { c1: { name: "Ndu" } },
    });
    let n = 0;
    const failing = wrapDb(db, () => {
      n += 1;
      if (n === 2) throw new Error("second store failed");
      return undefined;
    });
    await expect(runChangeFeedPage({ db: failing, adapter: w.adapter, now: () => T0 + 1000 }))
      .rejects.toThrow("second store failed");
    expect(await db.getMeta(FEED_CURSOR_META)).toBeUndefined();
    // The first store's rows DID land — that is fine and deliberate: they are
    // upserts of current values, so the retry re-applies them harmlessly.
    expect(await db.count("products")).toBe(1);
  });

  test("and the retry then completes the page and moves the cursor once", async () => {
    const db = await freshMirrorDb();
    const recs = [change(0, "products", "p1"), change(1, "customers", "c1")];
    const w = world(recs, { products: { p1: { price: 1 } }, customers: { c1: { name: "Ndu" } } });
    let n = 0;
    const failing = wrapDb(db, () => {
      n += 1;
      if (n === 2) throw new Error("second store failed");
      return undefined;
    });
    await expect(runChangeFeedPage({ db: failing, adapter: w.adapter, now: () => T0 + 1000 }))
      .rejects.toThrow();
    const res = await runChangeFeedPage({ db, adapter: w.adapter, now: () => T0 + 2000 });
    expect(res.applied).toBe(2);
    expect(await db.getMeta(FEED_CURSOR_META)).toBe(recs[1][0]);
    expect(await db.count("customers")).toBe(1);
  });

  test("the cursor is written by the page commit, not beside it", async () => {
    // The atomicity itself: the cursor must arrive in the SAME putPage call as
    // the last store's rows. A version that called setMeta separately would
    // pass every test above and still lose a change on a reload between the
    // two writes.
    const db = await freshMirrorDb();
    const w = world([change(0, "products", "p1")], { products: { p1: { price: 1 } } });
    const seen = [];
    const watched = { ...db, putPage: (store, records, opts) => {
      seen.push({ store, rows: records.length, cursorKey: opts?.cursorKey });
      return db.putPage(store, records, opts);
    } };
    await runChangeFeedPage({ db: watched, adapter: w.adapter, now: () => T0 + 1000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ store: "products", rows: 1, cursorKey: FEED_CURSOR_META });
  });
});
