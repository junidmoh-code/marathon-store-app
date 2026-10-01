import { describe, test, expect } from "vitest";
import { freshMirrorDb, rec } from "./helpers";
import {
  healthKey, healthyMeta, recordLegFailed, isLegUsable, getLegHealth,
  shrinkVerdict, shrankInfo, vouchingRecord, heldRows, claimIsBackedByRows,
  SHRINK_TOLERANCE, SHRINK_ABS_FLOOR, SNAPSHOT_META_PREFIXES, legVerdict,
} from "../health";

const good = (rows) => healthyMeta("products", { path: "products", rows, at: 1 })[healthKey("products")];

describe("empty is not success", () => {
  test("a leg with no health record at all is unusable", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", {}), rec("p2", {})]);
    // Rows on disk are NOT the question. #276 stamped success over an empty
    // store; count() > 0 is the test that cannot tell the two apart.
    expect(await isLegUsable(db, "products")).toBe(false);
  });

  test("a health record over an EMPTIED store does not make the leg usable", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", {})], { [healthKey("products")]: good(1) });
    expect(await isLegUsable(db, "products")).toBe(true);
    await db.replaceAll("products", []);           // emptied underneath the record
    expect(await isLegUsable(db, "products")).toBe(false);
  });
});

describe("a failed attempt is not a lost snapshot", () => {
  test("a failure keeps the rows readable via `vouched`", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", {}), rec("p2", {})], {
      [healthKey("products")]: good(2),
    });
    await recordLegFailed(db, "products", {
      path: "products", reason: "timed-out", at: 9, state: "failed", retryable: true,
    });
    const health = await getLegHealth(db, "products");
    expect(health.ok).toBe(false);
    expect(health.reason).toBe("timed-out");
    // The complete on-disk catalogue stays in service — this is the Till 3
    // incident, where one slow page took a whole good copy out of use.
    expect(health.vouched.rows).toBe(2);
    expect(await isLegUsable(db, "products")).toBe(true);
  });

  test("a second failure does not lose the snapshot the first one carried", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", {})], { [healthKey("products")]: good(1) });
    for (const reason of ["timed-out", "transport", "timed-out"]) {
      await recordLegFailed(db, "products", { path: "products", reason, at: 1, state: "failed" });
    }
    expect((await getLegHealth(db, "products")).vouched.rows).toBe(1);
    expect(await isLegUsable(db, "products")).toBe(true);
  });

  test("keepVouched:false makes a leg unusable — for the one failure that must", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", {})], { [healthKey("products")]: good(1) });
    await recordLegFailed(db, "products", {
      path: "products", reason: "did-not-land", at: 1, state: "failed", keepVouched: false,
    });
    expect(await isLegUsable(db, "products")).toBe(false);
  });
});

describe("a snapshot may never shrink quietly", () => {
  test("a small drop is ordinary deletion and is accepted", () => {
    expect(shrinkVerdict({ held: 4945, incoming: 4900 }).accept).toBe(true);
  });

  test("the measured POS truncation — 4,654 to 799 — is refused", () => {
    expect(shrinkVerdict({ held: 4654, incoming: 799 }).accept).toBe(false);
  });

  test("a small leg gets an absolute floor, not just a percentage", () => {
    // 2% of 30 is 0 rows of slack, which would refuse every real deletion.
    expect(shrinkVerdict({ held: 30, incoming: 10 }).accept).toBe(true);
    expect(SHRINK_ABS_FLOOR).toBe(25);
    expect(SHRINK_TOLERANCE).toBe(0.02);
  });

  test("the first sync, with nothing held, is never a shrink", () => {
    expect(shrinkVerdict({ held: 0, incoming: 1 }).accept).toBe(true);
    expect(shrinkVerdict({ held: undefined, incoming: 1 }).accept).toBe(true);
  });

  test("a refusal keeps the held rows READABLE — the fix must not cause the harm", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", Array.from({ length: 400 }, (_, i) => rec(`p${i}`, {})), {
      [healthKey("products")]: good(400),
    });
    await recordLegFailed(db, "products",
      shrankInfo({ path: "products", held: 400, incoming: 10, at: 2 }));
    const health = await getLegHealth(db, "products");
    expect(health.ok).toBe(false);
    expect(health.reason).toBe("shrank");
    expect(await isLegUsable(db, "products")).toBe(true);
    expect(vouchingRecord(health).rows).toBe(400);
  });
});

describe("counting a docs leg", () => {
  test("held rows are counted by node, not by the whole shared store", async () => {
    const db = await freshMirrorDb();
    await db.replacePrefixed("docs", "users", [rec("users/u1", {}), rec("users/u2", {})]);
    await db.replacePrefixed("docs", "locations", [rec("locations", {})]);
    expect(await heldRows(db, "users")).toBe(2);
    expect(await heldRows(db, "locations")).toBe(1);
  });

  test("a docs leg's claim is checked against its OWN rows", async () => {
    const db = await freshMirrorDb();
    await db.replacePrefixed("docs", "users", [rec("users/u1", {})], {
      [healthKey("users")]: healthyMeta("users", { path: "users", rows: 1, at: 1 })[healthKey("users")],
    });
    // Another leg's rows must not make this one's claim look backed.
    expect(await claimIsBackedByRows(db, "users", await getLegHealth(db, "users"))).toBe(true);
    await db.replacePrefixed("docs", "users", []);
    await db.replacePrefixed("docs", "locations", [rec("locations", {}), rec("locations/x", {})]);
    expect(await claimIsBackedByRows(db, "users", await getLegHealth(db, "users"))).toBe(false);
  });
});

describe("what a schema purge must take with it", () => {
  test("the feed cursor and the setup marker are purged with the rows", () => {
    // Both have the dangerous polarity: left standing over an empty store they
    // say "up to date" and "already set up".
    expect(SNAPSHOT_META_PREFIXES).toContain("feedCursor.");
    expect(SNAPSHOT_META_PREFIXES).toContain("setup.");
    expect(SNAPSHOT_META_PREFIXES).toContain("mirror.health.");
    expect(SNAPSHOT_META_PREFIXES).toContain("staging.");
  });
});

describe("legVerdict keeps \"no\" and \"could not ask\" apart", () => {
  const closing = () => Promise.reject(Object.assign(new Error("The database connection is closing."), { name: "InvalidStateError" }));

  test("yes, no — the same facts isLegUsable answers", async () => {
    const db = await freshMirrorDb();
    expect(await legVerdict(db, "products")).toBe("no");                 // nothing vouches
    await db.replaceAll("products", [rec("p1", {})], { [healthKey("products")]: good(1) });
    expect(await legVerdict(db, "products")).toBe("yes");
    await db.replaceAll("products", []);                                  // emptied underneath
    expect(await legVerdict(db, "products")).toBe("no");
  });

  test("a health record that cannot be read is UNKNOWN, not no", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", {})], { [healthKey("products")]: good(1) });
    expect(await legVerdict({ ...db, getMeta: closing }, "products")).toBe("unknown");
  });

  test("rows that cannot be COUNTED are unknown, not no — the record is read fine", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [rec("p1", {})], { [healthKey("products")]: good(1) });
    expect(await legVerdict({ ...db, count: closing, countPrefixed: closing }, "products")).toBe("unknown");
  });
});
