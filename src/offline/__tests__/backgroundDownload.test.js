// ─── THE BACKGROUND DOWNLOAD: ABANDONABLE, RESUMABLE, AND NEVER SHORT ────────
//
// The download now runs behind a working app instead of in front of a held
// one, which changes three things about it and each is tested here:
//
//   1. IT CAN BE ABANDONED. The fleet kill switch can arrive in the middle of
//      104 MB. A device told to stop mirroring must stop DOWNLOADING, or the
//      one control that ends an incident goes on spending money on it.
//   2. IT RESUMES. A tab closed at leg nine starts again at leg nine, not at
//      leg one — on a shop line that is the difference between finishing
//      today and never finishing.
//   3. A SHORT READ IS NEVER SERVED. On a FIRST download the shrink guard is
//      blind: `held` is 0, so a catalogue truncated to a fifth of itself is
//      "more than I had" and is accepted. That is the POS incident (4,654
//      products read as 799 overnight) in the one state the guard cannot see,
//      and /mirror_counts is what closes it.
import { describe, test, expect } from "vitest";
import { freshMirrorDb } from "./helpers";
import { createFakeRtdb } from "./fakeAdapter";
import { createSyncEngine, SETUP_META_PREFIX } from "../sync";
import { isLegUsable, getLegHealth } from "../health";
import { COUNTS_ROOT } from "../changeFeed";

const T0 = 1_780_000_000_000;

function world(extra = {}) {
  return createFakeRtdb({
    locations: { hub1: { id: "hub1" }, "marathon-pe": { id: "marathon-pe" } },
    users: { u1: { name: "Zee" } },
    products: { p1: { id: "p1", name: "Nike Air", price: 1200 } },
    stock: { hub1: { p1: { 9: { qty: 3 } } } },
    orders: { "001": { id: "001" } },
    customers: { c1: { name: "Ndu" } },
    refill_requests: { r1: { status: "open" } },
    ...extra,
  });
}

const engineOn = (db, w, opts = {}) =>
  createSyncEngine({ db, adapter: w.adapter, now: () => T0, buildVersion: "b1", ...opts });

const manyProducts = (n) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`p${i}`, { id: `p${i}`, name: `shoe ${i}` }]));

describe("a download can be abandoned mid-way", () => {
  test("the kill switch stops it between legs, and nothing is half-swapped", async () => {
    const db = await freshMirrorDb();
    const w = world();
    const e = engineOn(db, w);

    let legsSeen = 0;
    const res = await e.runSetup({
      // "The switch went false after the second leg."
      keepGoing: () => { legsSeen += 1; return legsSeen <= 2; },
    });

    expect(res.abandoned).toBe(true);
    expect((await e.setupState()).done).toBe(false);
    // Whatever landed, landed whole: every leg with a setup marker has a
    // health record and the rows to back it.
    for (const { leg, ready } of (await e.setupState()).legs) {
      if (!ready) continue;
      expect(await isLegUsable(db, leg)).toBe(true);
    }
  });

  test("and the next attempt picks up from where it stopped", async () => {
    const db = await freshMirrorDb();
    const w = world();
    const e = engineOn(db, w);

    let n = 0;
    await e.runSetup({ keepGoing: () => { n += 1; return n <= 2; } });
    const afterFirst = (await e.setupState()).legs.filter((l) => l.ready).map((l) => l.leg);
    expect(afterFirst.length).toBeGreaterThan(0);

    // The legs already done are not asked for again: readPath/readKeyPage
    // counts for them do not move.
    const before = w.calls.readKeyPage.filter((c) => c.path === "products").length;
    await e.runSetup();
    const after = w.calls.readKeyPage.filter((c) => c.path === "products").length;
    if (afterFirst.includes("products")) expect(after).toBe(before);

    expect((await e.setupState()).done).toBe(true);
  });

  test("a leg already set up is never re-downloaded by a resume", async () => {
    const db = await freshMirrorDb();
    const w = world({ products: manyProducts(40) });
    const e = engineOn(db, w);
    await e.runSetup();
    const before = w.calls.readKeyPage.length + w.calls.readPath.length;
    const res = await e.runSetup();
    expect(res.alreadyDone).toBe(true);
    expect(w.calls.readKeyPage.length + w.calls.readPath.length).toBe(before);
    expect(await db.count("products")).toBe(40);
  });
});

describe("a FIRST download that comes back short is never served", () => {
  test("the census refuses it — the state the shrink guard cannot see", async () => {
    // 4,654 products on the server. This device reads 799 of them, which is
    // what a short page taken for the end of the node looks like from here.
    // `held` is 0, so shrinkVerdict accepts: nothing about the copy itself can
    // tell that it is a fifth of a catalogue.
    const db = await freshMirrorDb();
    const w = world({
      products: manyProducts(799),
      [COUNTS_ROOT]: { products: { rows: 4654, at: T0 } },
    });
    const e = engineOn(db, w);
    await e.runSetup();

    // Accepted by the swap…
    expect(await db.count("products")).toBe(799);
    expect(await isLegUsable(db, "products")).toBe(true);

    // …and refused by the outside opinion, BEFORE anything is served.
    const census = await e.checkCensus({ force: true });
    expect(census.drifted.map((d) => d.leg)).toContain("products");
    expect(await isLegUsable(db, "products")).toBe(false);
    expect((await getLegHealth(db, "products")).reason).toBe("count-drift");

    // NOTHING IS DELETED. A short read is a reason to distrust the copy, never
    // a reason to throw one away: the rows stay until a full read replaces
    // them, and the dropped setup marker is what makes that read happen.
    expect(await db.count("products")).toBe(799);
    expect(await db.getMeta(`${SETUP_META_PREFIX}products`)).toBeUndefined();
  });

  test("a complete download passes the same check and serves", async () => {
    const db = await freshMirrorDb();
    const w = world({
      products: manyProducts(4654),
      [COUNTS_ROOT]: { products: { rows: 4654, at: T0 } },
    });
    const e = engineOn(db, w);
    await e.runSetup();
    const census = await e.checkCensus({ force: true });
    expect(census.drifted).toEqual([]);
    expect(await isLegUsable(db, "products")).toBe(true);
  });

  test("an EMPTY read is refused outright, census or no census", async () => {
    // The other half of the same rule. /products cannot legitimately be empty,
    // so zero rows is a failed read, never an empty mirror — and the copy that
    // is already on the device is kept.
    const db = await freshMirrorDb();
    const w = world({ products: manyProducts(40) });
    const e = engineOn(db, w);
    await e.runSetup();
    w.write("products", null);
    await expect(e.runSetup({ force: true })).rejects.toThrow(/ZERO rows/);
    expect(await db.count("products")).toBe(40);
  });
});
