import { describe, test, expect } from "vitest";
import { freshMirrorDb } from "./helpers";
import {
  readStaging, appendStagingChunk, loadStagingRecords, clearStaging,
  stagingKeys, stagingKey, StagingIncompleteError, STAGING_TTL_MS,
} from "../staging";

const rows = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ key: `k${from + i}`, value: { i: from + i } }));

describe("a refresh is never a restart", () => {
  test("a resumed download keeps the pages that landed", async () => {
    const db = await freshMirrorDb();
    let m = await readStaging(db, "products", { buildVersion: "b1" });
    m = await appendStagingChunk(db, "products", { manifest: m, rows: rows(3, 0), afterKey: "k2" });
    m = await appendStagingChunk(db, "products", { manifest: m, rows: rows(3, 3), afterKey: "k5" });
    // A new pass reads what is staged rather than starting at page one.
    const resumed = await readStaging(db, "products", { buildVersion: "b1" });
    expect(resumed.chunks).toBe(2);
    expect(resumed.rows).toBe(6);
    expect(resumed.afterKey).toBe("k5");
    expect(await loadStagingRecords(db, "products", resumed)).toHaveLength(6);
  });

  test("staging for a different bundle is dropped, not resumed", async () => {
    const db = await freshMirrorDb();
    let m = await readStaging(db, "products", { buildVersion: "b1" });
    await appendStagingChunk(db, "products", { manifest: m, rows: rows(3), afterKey: "k2" });
    m = await readStaging(db, "products", { buildVersion: "b2" });
    expect(m.chunks).toBe(0);
    expect(await db.getMeta(stagingKey("products"))).toBeUndefined();
  });

  test("staging for a different scope is dropped", async () => {
    const db = await freshMirrorDb();
    let m = await readStaging(db, "stock", { scope: "hub1", buildVersion: "b1" });
    await appendStagingChunk(db, "stock", { manifest: m, rows: rows(2), afterKey: "k1" });
    m = await readStaging(db, "stock", { scope: "hub2", buildVersion: "b1" });
    expect(m.chunks).toBe(0);
  });

  test("staging older than the TTL is stale data, not progress", async () => {
    const db = await freshMirrorDb();
    const t0 = 1_000_000;
    let m = await readStaging(db, "products", { buildVersion: "b1", now: () => t0 });
    await appendStagingChunk(db, "products", { manifest: m, rows: rows(2), afterKey: "k1", now: () => t0 });
    m = await readStaging(db, "products", {
      buildVersion: "b1", now: () => t0 + STAGING_TTL_MS + 1,
    });
    expect(m.chunks).toBe(0);
  });

  test("`notBefore` re-reads staging that predates a change it cannot vouch for", async () => {
    const db = await freshMirrorDb();
    const t0 = 1_000_000;
    let m = await readStaging(db, "products", { buildVersion: "b1", now: () => t0 });
    await appendStagingChunk(db, "products", { manifest: m, rows: rows(2), afterKey: "k1", now: () => t0 });
    m = await readStaging(db, "products", {
      buildVersion: "b1", now: () => t0 + 1000, notBefore: t0 + 500,
    });
    expect(m.chunks).toBe(0);
  });
});

describe("a missing chunk is a FAILED download, not a short one", () => {
  test("a hole raises rather than assembling around it", async () => {
    const db = await freshMirrorDb();
    let m = await readStaging(db, "products", { buildVersion: "b1" });
    m = await appendStagingChunk(db, "products", { manifest: m, rows: rows(3, 0), afterKey: "k2" });
    m = await appendStagingChunk(db, "products", { manifest: m, rows: rows(3, 3), afterKey: "k5" });
    await db.deleteMetaMany(["staging.products.chunk.0"]);
    await expect(loadStagingRecords(db, "products", m)).rejects.toThrow(StagingIncompleteError);
  });

  test("a chunk written for a DIFFERENT page by another tab raises", async () => {
    const db = await freshMirrorDb();
    let m = await readStaging(db, "products", { buildVersion: "b1" });
    m = await appendStagingChunk(db, "products", { manifest: m, rows: rows(3, 0), afterKey: "k2" });
    // A second tab halved its page size and staged over chunk 0.
    await db.setMeta("staging.products.chunk.0", { end: "k1", rows: rows(2, 0) });
    await expect(loadStagingRecords(db, "products", m)).rejects.toThrow(/staged over it/);
  });
});

describe("clearing staging", () => {
  test("the high-water mark clears chunks a shorter later run did not rewrite", async () => {
    const db = await freshMirrorDb();
    let m = await readStaging(db, "products", { buildVersion: "b1" });
    for (let i = 0; i < 4; i += 1) {
      m = await appendStagingChunk(db, "products", { manifest: m, rows: rows(1, i), afterKey: `k${i}` });
    }
    // A resume with a halved page size writes fewer chunks than before.
    const shorter = { ...m, chunks: 2 };
    expect(stagingKeys("products", shorter)).toContain("staging.products.chunk.3");
    await clearStaging(db, "products", shorter);
    for (let i = 0; i < 4; i += 1) {
      expect(await db.getMeta(`staging.products.chunk.${i}`)).toBeUndefined();
    }
  });
});
