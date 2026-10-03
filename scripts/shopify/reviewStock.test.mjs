// ── The review list hides what cannot be sold, and nothing else moves ───────
import { describe, it, expect } from "vitest";
import {
  sweepReviewStock, judgeProduct, hasSellableStock, verdictFor, reviewBucket,
  REVIEW_DIRTY_PATH, HIDDEN_PATH, MAX_PER_RUN,
} from "./reviewStock.mjs";
import { networkTotals } from "./inventory.mjs";

// ── A fake RTDB that behaves like one where it matters here ─────────────────
// RTDB stores no empty objects. Removing the last child of a node removes the
// node, and writing null deletes. A fake that kept `{ shopifyReviewHidden: {} }`
// would let a test believe a node exists that the server has already dropped.
// The transaction models the cold-cache null-first pass (see inventorySync.test).
function fakeDb(store) {
  const writes = [];
  const parts = (path) => path.split("/").filter(Boolean);
  const at = (path) => {
    let n = store;
    for (const p of parts(path)) { n = n?.[p]; if (n === undefined) return null; }
    return n === undefined ? null : n;
  };
  const prune = (path) => {
    const ps = parts(path);
    for (let i = ps.length - 1; i >= 1; i--) {
      const parent = at(ps.slice(0, i).join("/"));
      const k = ps[i - 1];
      if (parent && typeof parent === "object" && Object.keys(parent).length === 0) {
        const gp = i - 1 === 0 ? store : at(ps.slice(0, i - 1).join("/"));
        delete gp[k];
      }
    }
  };
  const setAt = (path, value) => {
    const ps = parts(path);
    if (value === null || value === undefined) {
      const parent = at(ps.slice(0, -1).join("/"));
      if (parent && typeof parent === "object") delete parent[ps.at(-1)];
      prune(ps.slice(0, -1).join("/") + "/x");
      return;
    }
    let n = store;
    for (const p of ps.slice(0, -1)) { if (typeof n[p] !== "object" || n[p] === null) n[p] = {}; n = n[p]; }
    n[ps.at(-1)] = value;
  };
  const db = {
    ref: (path) => ({
      get: async () => ({ val: () => at(path) }),
      set: async (v) => { writes.push(["set", path, v]); setAt(path, v); },
      remove: async () => { writes.push(["remove", path]); setAt(path, null); },
      transaction: async (updater) => {
        const optimistic = updater(null);
        if (optimistic === undefined) return { committed: false, snapshot: { val: () => null } };
        const next = updater(at(path));
        if (next !== undefined) { writes.push(["txn", path, next]); setAt(path, next); }
        return { committed: next !== undefined, snapshot: { val: () => at(path) } };
      },
    }),
  };
  return { db, writes, store };
}

const TS = { ".sv": "timestamp" };
const LOCS = { locations: { pe: {}, hub1: {}, "marathon-pine": {}, hub3: {}, in_transit: {} } };

function world({ stock = {}, node, sizes = ["8", "9"], marker = 1, hidden } = {}) {
  return {
    ...LOCS,
    products: { p1: { name: "Shoe", ...(sizes ? { sizes } : {}) } },
    ...(node ? { shopify_publish: { p1: node } } : {}),
    stock,
    [REVIEW_DIRTY_PATH]: { p1: marker },
    ...(hidden ? { config: { shopifyReviewHidden: { p1: hidden }, other: { keep: true } } } : { config: { other: { keep: true } } }),
  };
}

describe("hasSellableStock IS networkTotals", () => {
  it("agrees with networkTotals on Pine / transit / negatives / off-record sizes", () => {
    const tree = {
      "marathon-pine": { p1: { "8": { qty: 4 } } },     // untrusted: does not count
      in_transit: { p1: { "9": { qty: 2 } } },          // unsellable
      pe: { p1: { "8": { qty: -3 }, "12": { qty: 5 } } }, // negative; 12 not in the record
    };
    expect(Object.values(networkTotals(tree, "p1", ["8", "9"])).some((q) => q > 0)).toBe(false);
    expect(hasSellableStock(tree, "p1", ["8", "9"])).toBe(false);
    tree.hub1 = { p1: { "9": { qty: 1 } } };
    expect(hasSellableStock(tree, "p1", ["8", "9"])).toBe(true);
  });
  it("cannot judge a record with no sizes — null, never false", () => {
    expect(hasSellableStock({ pe: { p1: { "_": { qty: 0 } } } }, "p1", undefined)).toBe(null);
    expect(hasSellableStock({}, "p1", [])).toBe(null);
  });
});

describe("verdictFor", () => {
  it("never hides a product on or going on the storefront", () => {
    expect(verdictFor({ node: { state: "live", liveState: "on" }, sizes: ["8"], sellable: false }).verdict).toBe("show");
    expect(verdictFor({ node: { state: "awaiting", desiredState: "on" }, sizes: ["8"], sellable: false }).verdict).toBe("show");
  });
  it("hides a live-but-OFF product with no stock (it is in the review list)", () => {
    expect(verdictFor({ node: { state: "live", liveState: "off" }, sizes: ["8"], sellable: false }).verdict).toBe("hide");
  });
  it("never hides what it cannot judge", () => {
    expect(verdictFor({ node: null, sizes: null, sellable: null }).verdict).toBe("show");
  });
});

describe("reviewBucket", () => {
  it("splits blocked / in review / awaiting", () => {
    expect(reviewBucket(null)).toBe("awaiting");
    expect(reviewBucket({ state: "awaiting" })).toBe("awaiting");
    expect(reviewBucket({ state: "blocked" })).toBe("blocked");
    expect(reviewBucket({ state: "awaiting", nameApprovedAt: 1 })).toBe("in review");
    expect(reviewBucket({ state: "live", liveState: "off" })).toBe("in review");
  });
});

describe("sweepReviewStock", () => {
  it("HIDES a not-live product with no sellable unit, and touches nothing else", async () => {
    const f = fakeDb(world({
      node: { state: "awaiting", cleanName: "Nice Shoe", condition: "new", photos: ["a"] },
      stock: { pe: { p1: { "8": { qty: 0 } } }, "marathon-pine": { p1: { "8": { qty: 3 } } } },
    }));
    const before = JSON.stringify(f.store.shopify_publish);
    const r = await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(r).toMatchObject({ seen: 1, hidden: 1, shown: 0, cleared: 1, failed: 0 });
    expect(f.store.config.shopifyReviewHidden.p1).toEqual(TS);
    // The review state is preserved byte-for-byte; liveState/desiredState untouched.
    expect(JSON.stringify(f.store.shopify_publish)).toBe(before);
    expect(f.writes.every(([, p]) => p.startsWith(HIDDEN_PATH) || p.startsWith(REVIEW_DIRTY_PATH))).toBe(true);
    // The marker node was the last child — RTDB drops it entirely.
    expect(f.store[REVIEW_DIRTY_PATH]).toBeUndefined();
  });

  it("SHOWS it again when stock returns, and the empty hidden node disappears", async () => {
    const f = fakeDb(world({ hidden: 123, stock: { hub1: { p1: { "9": { qty: 1 } } } } }));
    const r = await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(r).toMatchObject({ shown: 1, hidden: 0, cleared: 1 });
    expect(f.store.config.shopifyReviewHidden).toBeUndefined();
    expect(f.store.config.other).toEqual({ keep: true }); // siblings untouched
  });

  it("keeps the ORIGINAL hidden time on a re-judgement", async () => {
    const f = fakeDb(world({ hidden: 123, stock: {} }));
    await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(f.store.config.shopifyReviewHidden.p1).toBe(123);
  });

  it("un-hides a product that went on the storefront, regardless of stock", async () => {
    const f = fakeDb(world({ hidden: 1, node: { state: "awaiting", desiredState: "on" }, stock: {} }));
    await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(f.store.config.shopifyReviewHidden).toBeUndefined();
  });

  it("never hides a record with no sizes", async () => {
    const f = fakeDb(world({ sizes: null, stock: {} }));
    const r = await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(r.hidden).toBe(0);
    expect(f.store.config.shopifyReviewHidden).toBeUndefined();
  });

  it("a dry run writes nothing at all", async () => {
    const f = fakeDb(world({ stock: {} }));
    const r = await sweepReviewStock(f.db, { commit: false, timestamp: TS });
    expect(r.results[0]).toMatchObject({ verdict: "hide", dryRun: true });
    expect(f.writes).toEqual([]);
  });

  it("a movement that re-marks mid-judgement keeps the marker for the next tick", async () => {
    const f = fakeDb(world({ stock: {}, marker: 1 }));
    const origRef = f.db.ref;
    f.db.ref = (path) => {
      const r = origRef(path);
      if (path === `products/p1/sizes`) {
        const g = r.get;
        r.get = async () => { f.store[REVIEW_DIRTY_PATH].p1 = 2; return g(); };
      }
      return r;
    };
    const r = await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(r).toMatchObject({ cleared: 0, kept: 1 });
    expect(f.store[REVIEW_DIRTY_PATH].p1).toBe(2);
  });

  it("never reads /stock or /locations whole beyond the ten-row config", async () => {
    const f = fakeDb(world({ stock: { pe: { p1: { "8": { qty: 1 } } } } }));
    const reads = [];
    const origRef = f.db.ref;
    f.db.ref = (path) => { reads.push(path); return origRef(path); };
    await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(reads).not.toContain("stock");
    expect(reads.filter((p) => p.startsWith("stock/")).every((p) => p.split("/").length === 3)).toBe(true);
    // Excluded locations are not even read.
    expect(reads).not.toContain("stock/marathon-pine/p1");
  });

  it("caps a run", async () => {
    const store = world({ stock: {} });
    for (let i = 0; i < MAX_PER_RUN + 5; i++) store[REVIEW_DIRTY_PATH][`q${String(i).padStart(4, "0")}`] = 1;
    const f = fakeDb(store);
    const r = await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(r.results.length).toBe(MAX_PER_RUN);
  });

  it("an empty marker node costs one read and no location read", async () => {
    const f = fakeDb({ ...LOCS });
    const reads = [];
    const origRef = f.db.ref;
    f.db.ref = (path) => { reads.push(path); return origRef(path); };
    const r = await sweepReviewStock(f.db, { commit: true, timestamp: TS });
    expect(r.seen).toBe(0);
    expect(reads).toEqual([REVIEW_DIRTY_PATH]);
  });
});

describe("judgeProduct", () => {
  it("does not read stock for a product on the storefront", async () => {
    const f = fakeDb(world({ node: { state: "live", liveState: "on" } }));
    const reads = [];
    const origRef = f.db.ref;
    f.db.ref = (path) => { reads.push(path); return origRef(path); };
    const j = await judgeProduct(f.db, "p1", ["pe"]);
    expect(j.verdict).toBe("show");
    expect(reads.some((p) => p.startsWith("stock/"))).toBe(false);
  });
});
