// Saved copies for a cold start, against the REAL mirror database (openMirrorDb
// on fake-indexeddb): same uid only, size-capped, throttled, and wiped when
// the signed-in person changes.
import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openMirrorDb } from "../db";
import { createResumeCopies, RESUME_PREFIX, RESUME_WRITE_EVERY_MS } from "../resumeCopy";

function rig() {
  const dbP = openMirrorDb({ indexedDBFactory: new IDBFactory(), dbName: "resume-test" });
  let t = 1_000_000;
  const timers = [];
  const copies = (now = () => t) => createResumeCopies({
    getDb: () => dbP, now,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    warn: () => {},
  });
  const advance = (ms) => { t += ms; for (const x of [...timers]) if (x.at <= t) { timers.splice(timers.indexOf(x), 1); x.fn(); } };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { dbP, copies, advance, settle, now: () => t };
}

describe("resume copies live in the mirror's own database", () => {
  it("a page thrown away and restored gets the last live answer back — for the same person", async () => {
    const r = rig();
    const before = r.copies();
    expect(before.save("u1", "users/u1", { destShop: "marathon-pe", permissions: ["source"] })).toBe(true);
    await r.settle();
    const after = r.copies();                       // a fresh page: nothing in memory
    expect(after.peek("u1", "users/u1")).toBe(null);
    const got = await after.load("u1", "users/u1");
    expect(got.value).toEqual({ destShop: "marathon-pe", permissions: ["source"] });
    expect(got.at).toBe(r.now());
    expect(await after.load("u2", "users/u1")).toBe(null);   // another person: nothing
    const keys = await (await r.dbP).getAllKeys("meta");
    expect(keys.filter((k) => k.startsWith(RESUME_PREFIX))).toEqual(["resume|u1|users/u1"]);
  });

  it("a value too big to be worth saving is not saved", async () => {
    const r = rig();
    const c = createResumeCopies({ getDb: () => r.dbP, maxBytes: 50, warn: () => {} });
    expect(c.save("u1", "k", { big: "x".repeat(100) })).toBe(false);
    expect(c.peek("u1", "k")).toBe(null);
  });

  it("a hot value is written at most once per interval, and the newest lands", async () => {
    const r = rig();
    const c = r.copies();
    c.save("u1", "k", 1); await r.settle();
    c.save("u1", "k", 2); c.save("u1", "k", 3); await r.settle();
    const db = await r.dbP;
    expect((await db.getMeta("resume|u1|k")).value).toBe(1);
    r.advance(RESUME_WRITE_EVERY_MS); await r.settle();
    expect((await db.getMeta("resume|u1|k")).value).toBe(3);
  });

  it("sign-out wipes every saved copy and nothing queued before it lands after it", async () => {
    const r = rig();
    const c = r.copies();
    c.save("u1", "a", 1); c.save("u1", "b", 2); await r.settle();
    c.save("u1", "a", 9);                           // trailing write queued
    await c.clearAll();
    r.advance(RESUME_WRITE_EVERY_MS); await r.settle();
    const db = await r.dbP;
    const keys = await db.getAllKeys("meta");
    expect(keys.filter((k) => k.startsWith(RESUME_PREFIX))).toEqual([]);
    expect(c.peek("u1", "a")).toBe(null);
    expect(await r.copies().load("u1", "a")).toBe(null);
  });

  it("no database at all: load answers null, save still keeps it for this page", async () => {
    const c = createResumeCopies({ getDb: () => Promise.reject(new Error("no idb")), warn: () => {} });
    expect(await c.load("u1", "k")).toBe(null);
    expect(c.save("u1", "k", { a: 1 })).toBe(true);
    expect(c.peek("u1", "k").value).toEqual({ a: 1 });
  });
});
