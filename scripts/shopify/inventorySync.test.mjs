// ── The marker contract: a failed push must never look like a done one ───────
//
// These are the two defects CodeRabbit found on PR #559 and that were logged as
// adoption blockers rather than patched inside a byte-identical rescue commit.
// They are tested here first because the marker-driven design has exactly ONE
// safety property, and both defects broke it:
//
//   1. syncProduct can answer ok:false WITHOUT calling Shopify (every mapped
//      inventory item stale). The marker was cleared anyway, so that product —
//      an oversellable one, by definition — stopped retrying for good.
//   2. A marker written after desiredFor() read /stock but before the clear was
//      deleted with it. The movement it stood for was then never pushed.
//
// A fake db is used rather than the emulator: what is under test is the ORDER
// and the CONDITIONS of the clear, which a fake can drive into races an
// emulator cannot be made to produce on demand.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { sweepDirty, sweepBacklog, syncProduct, clearMarker, DIRTY_PATH } from "./inventorySync.mjs";

// ── A fake RTDB just rich enough for this module ─────────────────────────────
// get() reads a path out of a plain object; transaction() runs the updater
// against the CURRENT value and applies the result, which is what makes the
// mid-flight race expressible: a test can mutate the store between the read and
// the clear and see what the transaction decides.
function fakeDb(store, { onTransaction } = {}) {
  const at = (path) => {
    const parts = path.split("/");
    let node = store;
    for (const p of parts) { node = node?.[p]; if (node === undefined) return undefined; }
    return node;
  };
  const setAt = (path, value) => {
    const parts = path.split("/");
    let node = store;
    for (const p of parts.slice(0, -1)) { node[p] ??= {}; node = node[p]; }
    if (value === null || value === undefined) delete node[parts.at(-1)];
    else node[parts.at(-1)] = value;
  };
  return {
    ref: (path) => ({
      get: async () => ({ val: () => (at(path) === undefined ? null : at(path)) }),
      transaction: async (updater) => {
        onTransaction?.(path);
        const current = at(path) === undefined ? null : at(path);
        const next = updater(current);
        if (next !== undefined) setAt(path, next);
        return { snapshot: { val: () => (at(path) === undefined ? null : at(path)) } };
      },
    }),
  };
}

const LOCATIONS = { pe: true, pine: true };

// A product mapped to Shopify with one variant, and app stock to match.
function withProduct(pid, { appQty, marker }) {
  return {
    locations: LOCATIONS,
    stock: { pe: { [pid]: { M: { qty: appQty } } } },
    shopify_sync: { [pid]: { variants: { M: { shopifyInventoryItemId: "gid://shopify/InventoryItem/1" } } } },
    [DIRTY_PATH]: { [pid]: marker },
  };
}

// Shopify says 7 available for item 1; the location query is answered too.
const graphqlSaying = (available) => vi.fn(async (query) => {
  if (query.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
  if (query.includes("inventorySetQuantities")) return { inventorySetQuantities: { userErrors: [] } };
  return { nodes: [{ id: "gid://shopify/InventoryItem/1", inventoryLevel: { quantities: [{ name: "available", quantity: available }] } }] };
});

describe("clearMarker", () => {
  it("clears when the revision is unchanged", async () => {
    const store = { [DIRTY_PATH]: { p1: 4 } };
    expect(await clearMarker(fakeDb(store), "p1", 4)).toBe(true);
    expect(store[DIRTY_PATH].p1).toBeUndefined();
  });

  it("KEEPS a marker whose revision moved on — the movement it stands for is unpushed", async () => {
    const store = { [DIRTY_PATH]: { p1: 5 } };
    expect(await clearMarker(fakeDb(store), "p1", 4)).toBe(false);
    expect(store[DIRTY_PATH].p1).toBe(5);
  });

  it("treats an already-absent marker as cleared, and writes nothing", async () => {
    const store = { [DIRTY_PATH]: {} };
    const seen = [];
    expect(await clearMarker(fakeDb(store, { onTransaction: (p) => seen.push(p) }), "p1", 4)).toBe(true);
    expect(seen).toEqual([`${DIRTY_PATH}/p1`]);
  });
});

describe("sweepDirty — blocker 1: ok:false must not clear", () => {
  it("keeps the marker when every mapped inventory item is stale, so it retries", async () => {
    const pid = "p1";
    const store = withProduct(pid, { appQty: 0, marker: 1 });
    // Shopify resolves NONE of the ids — the all-stale case, which returns
    // ok:false without ever attempting a mutation.
    const graphql = vi.fn(async (query) => {
      if (query.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
      return { nodes: [] };
    });
    const r = await sweepDirty(fakeDb(store), graphql, { commit: true, isLive: () => true });
    expect(store[DIRTY_PATH][pid]).toBe(1);       // still marked
    expect(r.cleared).toBe(0);
    expect(r.kept).toBe(1);
    expect(r.remaining).toBe(1);
  });

  it("keeps the marker when the push THROWS", async () => {
    const pid = "p1";
    const store = withProduct(pid, { appQty: 0, marker: 1 });
    // The location lookup succeeds — the failure is the PRODUCT's push, which is
    // the case that has to be survivable per-product. (A location lookup that
    // fails throws out of sweepDirty entirely and touches no marker at all;
    // reconcile.mjs catches that and the next tick retries the whole queue.)
    const graphql = vi.fn(async (query) => {
      if (query.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
      throw new Error("ETIMEDOUT");
    });
    const r = await sweepDirty(fakeDb(store), graphql, { commit: true, isLive: () => true });
    expect(store[DIRTY_PATH][pid]).toBe(1);
    expect(r.cleared).toBe(0);
    expect(r.remaining).toBe(1);
  });

  it("clears the marker when the push succeeded", async () => {
    const pid = "p1";
    const store = withProduct(pid, { appQty: 3, marker: 1 });
    const r = await sweepDirty(fakeDb(store), graphqlSaying(7), { commit: true, isLive: () => true });
    expect(store[DIRTY_PATH][pid]).toBeUndefined();
    expect(r.pushed).toBe(1);
    expect(r.cleared).toBe(1);
    expect(r.remaining).toBe(0);
  });
});

describe("sweepDirty — blocker 2: a marker written mid-flight survives", () => {
  it("does not delete a revision written after the stock read", async () => {
    const pid = "p1";
    const store = withProduct(pid, { appQty: 3, marker: 1 });
    // The stock read inside desiredFor is the moment a concurrent movement can
    // land. Bump the marker there, exactly as the trigger's increment would.
    const db = fakeDb(store);
    const realRef = db.ref;
    db.ref = (path) => {
      const r = realRef(path);
      if (path === `stock/pe/${pid}`) {
        const get = r.get;
        r.get = async () => { const v = await get(); store[DIRTY_PATH][pid] = 2; return v; };
      }
      return r;
    };
    const r = await sweepDirty(db, graphqlSaying(7), { commit: true, isLive: () => true });
    expect(store[DIRTY_PATH][pid]).toBe(2);   // the newer movement still queued
    expect(r.pushed).toBe(1);                 // this run's numbers DID go up
    expect(r.cleared).toBe(0);
    expect(r.remaining).toBe(1);
  });
});

describe("sweepDirty — the honest remaining count", () => {
  it("a dry run reports the whole queue, not zero", async () => {
    const store = withProduct("p1", { appQty: 3, marker: 1 });
    const r = await sweepDirty(fakeDb(store), graphqlSaying(7), { commit: false, isLive: () => true });
    expect(r.cleared).toBe(0);
    expect(r.remaining).toBe(1);
    expect(store[DIRTY_PATH].p1).toBe(1);
  });

  it("counts what is past the per-run cap as remaining", async () => {
    const store = { ...withProduct("p1", { appQty: 3, marker: 1 }) };
    store[DIRTY_PATH].p2 = 1;
    store[DIRTY_PATH].p3 = 1;
    // p2/p3 are not live, so they are cleared without a Shopify call; a cap of
    // 1 means only p1 is looked at this run.
    const r = await sweepDirty(fakeDb(store), graphqlSaying(7), { commit: true, max: 1, isLive: (p) => p === "p1" });
    expect(r.seen).toBe(3);
    expect(r.cleared).toBe(1);
    expect(r.remaining).toBe(2);
  });

  it("an empty node costs nothing and answers zero everywhere", async () => {
    const graphql = vi.fn();
    const r = await sweepDirty(fakeDb({}), graphql, { commit: true, isLive: () => true });
    expect(r).toMatchObject({ seen: 0, pushed: 0, cleared: 0, remaining: 0 });
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe("sweepDirty — a product we do not sell online", () => {
  it("clears its marker without calling Shopify, so the node cannot grow forever", async () => {
    const store = { [DIRTY_PATH]: { p9: 1 }, locations: LOCATIONS };
    const graphql = vi.fn(async (query) => {
      if (query.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
      throw new Error("must not be asked about a product that is not live");
    });
    const r = await sweepDirty(fakeDb(store), graphql, { commit: true, isLive: () => false });
    expect(store[DIRTY_PATH].p9).toBeUndefined();
    expect(r.cleared).toBe(1);
    expect(r.remaining).toBe(0);
  });

  it("accepts an ASYNC isLive — the reconciler answers it with a per-pid read", async () => {
    const store = { [DIRTY_PATH]: { p9: 1 }, locations: LOCATIONS };
    const graphql = vi.fn(async (query) =>
      query.includes("locations(first: 2)") ? { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } } : {});
    const r = await sweepDirty(fakeDb(store), graphql, { commit: true, isLive: async () => false });
    expect(r.cleared).toBe(1);
  });
});

describe("sweepDirty — remaining is READ BACK, not computed", () => {
  it("counts a marker the trigger wrote DURING the run", async () => {
    // The run clears every marker it started with. Arithmetic on its own
    // numbers would answer "queue empty" with a new product sitting in it.
    const pid = "p1";
    const store = withProduct(pid, { appQty: 3, marker: 1 });
    const db = fakeDb(store);
    const realRef = db.ref;
    db.ref = (path) => {
      const r = realRef(path);
      if (path === `stock/pe/${pid}`) {
        const get = r.get;
        r.get = async () => { const v = await get(); store[DIRTY_PATH].p2 = 1; return v; };
      }
      return r;
    };
    const res = await sweepDirty(db, graphqlSaying(7), { commit: true, isLive: (p) => p === pid });
    expect(res.cleared).toBe(1);          // p1 was pushed and cleared
    expect(res.remaining).toBe(1);        // p2 arrived and is still queued
    expect(store[DIRTY_PATH].p2).toBe(1);
  });
});

// ── The backstop ─────────────────────────────────────────────────────────────
// Every way the marker can fail to be written ends in the same silent state: a
// product whose storefront quantity is wrong and which says nothing about it.
// The backstop is the path that does not depend on a marker existing, so the
// cases below are about it covering everything and losing nothing across runs.
describe("sweepBacklog", () => {
  const liveStore = (pids) => {
    const store = { locations: LOCATIONS, stock: { pe: {} }, shopify_sync: {} };
    for (const pid of pids) {
      store.stock.pe[pid] = { M: { qty: 3 } };
      store.shopify_sync[pid] = { variants: { M: { shopifyInventoryItemId: "gid://shopify/InventoryItem/1" } } };
    }
    return store;
  };

  it("takes a slice and hands back the pid to carry on from", async () => {
    const r = await sweepBacklog(fakeDb(liveStore(["a", "b", "c", "d"])), graphqlSaying(7),
      { livePids: ["d", "b", "a", "c"], max: 2, commit: true });
    expect(r.checked).toBe(2);
    expect(r.nextCursor).toBe("b");   // sorted: a,b,c,d — took a,b
    expect(r.wrapped).toBe(false);
  });

  it("resumes AFTER the cursor and covers the whole list across runs", async () => {
    const pids = ["a", "b", "c", "d", "e"];
    const store = liveStore(pids);
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 3; i++) {
      const g = vi.fn(async (query) => {
        if (query.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
        if (query.includes("inventorySetQuantities")) return { inventorySetQuantities: { userErrors: [] } };
        return { nodes: [{ id: "gid://shopify/InventoryItem/1", inventoryLevel: { quantities: [{ name: "available", quantity: 7 }] } }] };
      });
      const r = await sweepBacklog(fakeDb(store), g, { livePids: pids, cursor, max: 2, commit: true });
      seen.push(...r.results.map((x) => x.pid));
      cursor = r.nextCursor;
    }
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(cursor).toBeNull();   // the pass wrapped; the next run starts at the top
  });

  it("a cursor naming a product that has since gone OFF still resumes correctly", async () => {
    // "b" is no longer live. Ordering by value means the pass carries on at "c"
    // rather than restarting — which an index-based cursor could not do.
    const r = await sweepBacklog(fakeDb(liveStore(["a", "c", "d"])), graphqlSaying(7),
      { livePids: ["a", "c", "d"], cursor: "b", max: 1, commit: true });
    expect(r.results.map((x) => x.pid)).toEqual(["c"]);
  });

  it("one product's failure costs only that product its turn", async () => {
    const pids = ["a", "b"];
    let n = 0;
    const g = vi.fn(async (query) => {
      if (query.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
      if (++n === 1) throw new Error("ETIMEDOUT");
      if (query.includes("inventorySetQuantities")) return { inventorySetQuantities: { userErrors: [] } };
      return { nodes: [{ id: "gid://shopify/InventoryItem/1", inventoryLevel: { quantities: [{ name: "available", quantity: 7 }] } }] };
    });
    const r = await sweepBacklog(fakeDb(liveStore(pids)), g, { livePids: pids, max: 2, commit: true });
    expect(r.checked).toBe(2);
    expect(r.results[0]).toMatchObject({ pid: "a", ok: false });
    expect(r.results[1]).toMatchObject({ pid: "b", ok: true });
  });

  it("NEVER touches a marker — the two paths share syncProduct and nothing else", async () => {
    const store = liveStore(["a"]);
    store[DIRTY_PATH] = { a: 1, zzz: 1 };
    await sweepBacklog(fakeDb(store), graphqlSaying(7), { livePids: ["a"], commit: true });
    expect(store[DIRTY_PATH]).toEqual({ a: 1, zzz: 1 });
  });

  it("an empty live set is not an error and costs no Shopify call", async () => {
    const g = vi.fn();
    const r = await sweepBacklog(fakeDb({}), g, { livePids: [], commit: true });
    expect(r).toMatchObject({ checked: 0, pushed: 0, nextCursor: null, wrapped: true });
    expect(g).not.toHaveBeenCalled();
  });
});

// ── THE OPPOSITE FAILURE: A PRODUCT THE APP THINKS IS LIVE AND ISN'T ─────────
// All 7 refusals in the 2026-09-05 correction run were products DELETED from
// Shopify while the app still recorded state:"live", liveState:"on". The
// message said "the id map is stale", which is true and useless — it describes
// a symptom shared by two very different situations.
describe("syncProduct — an entirely unknown id map is diagnosed, not guessed at", () => {
  const goneStore = () => ({
    locations: LOCATIONS,
    stock: { pe: { p1: { M: { qty: 3 } } } },
    shopify_sync: { p1: { shopifyProductId: "gid://shopify/Product/1", variants: { M: { shopifyInventoryItemId: "gid://shopify/InventoryItem/1" } } } },
  });

  it("says DELETED when Shopify does not have the product either", async () => {
    const g = vi.fn(async (q) => {
      if (q.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
      if (q.includes("product(id:")) return { product: null };
      return { nodes: [] };
    });
    const r = await syncProduct(fakeDb(goneStore()), g, "p1", { commit: true });
    expect(r).toMatchObject({ ok: false, productGone: true });
    expect(r.why).toMatch(/DELETED FROM SHOPIFY/);
    expect(r.why).toContain("gid://shopify/Product/1");
  });

  it("keeps the STALE MAP diagnosis when the product is still there", async () => {
    const g = vi.fn(async (q) => {
      if (q.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
      if (q.includes("product(id:")) return { product: { id: "gid://shopify/Product/1" } };
      return { nodes: [] };
    });
    const r = await syncProduct(fakeDb(goneStore()), g, "p1", { commit: true });
    expect(r).toMatchObject({ ok: false, productGone: false });
    expect(r.why).toMatch(/the id map is stale/);
  });

  it("a probe that THROWS answers null, not 'present' — and never masks the refusal", async () => {
    const g = vi.fn(async (q) => {
      if (q.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
      if (q.includes("product(id:")) throw new Error("ETIMEDOUT");
      return { nodes: [] };
    });
    const r = await syncProduct(fakeDb(goneStore()), g, "p1", { commit: true });
    expect(r.ok).toBe(false);
    expect(r.productGone).toBeNull();
    expect(r.why).toMatch(/the id map is stale/);
  });

  it("costs NOTHING on the healthy path — the probe is only asked after a failure", async () => {
    const store = withProduct("p1", { appQty: 3, marker: 1 });
    const g = graphqlSaying(7);
    await syncProduct(fakeDb(store), g, "p1", { commit: true });
    expect(g.mock.calls.some(([q]) => q.includes("product(id:"))).toBe(false);
  });
});

// ── THE TWO HOLES AN ADVERSARIAL PASS FOUND, AND THEY INTERACT ───────────────
describe("sweepDirty — a `skipped` result is NOT a success", () => {
  it("keeps the marker when the product has no shopify_sync id map", async () => {
    // syncProduct answers { pid, skipped } with NO `ok` field. The clear used
    // to ask `r.ok !== false`, and undefined !== false, so this cleared the
    // marker after doing nothing at all — and logged nothing either.
    const store = { locations: LOCATIONS, stock: { pe: { p1: { M: { qty: 3 } } } }, [DIRTY_PATH]: { p1: 1 } };
    const lines = [];
    const r = await sweepDirty(fakeDb(store), graphqlSaying(7), { commit: true, isLive: () => true, log: (l) => lines.push(l) });
    expect(store[DIRTY_PATH].p1).toBe(1);
    expect(r.cleared).toBe(0);
    expect(r.kept).toBe(1);
    expect(lines.join(" ")).toMatch(/no shopify_sync id map/);
  });

  it("keeps the marker when the map carries no inventory item ids", async () => {
    const store = {
      locations: LOCATIONS,
      stock: { pe: { p1: { M: { qty: 3 } } } },
      shopify_sync: { p1: { variants: { M: {} } } },
      [DIRTY_PATH]: { p1: 1 },
    };
    const r = await sweepDirty(fakeDb(store), graphqlSaying(7), { commit: true, isLive: () => true });
    expect(store[DIRTY_PATH].p1).toBe(1);
    expect(r.cleared).toBe(0);
  });
});

describe("sweepDirty — stuck markers cannot monopolise the window", () => {
  // A marker whose push can never succeed is never cleared, by design. RTDB
  // returns children in KEY order, so without rotation the same low-sorting
  // zombies would sit at the front of every tick's slice for ever, and once
  // there were `max` of them nothing else would ever be pushed again.
  const zombieStore = (n, live) => {
    const store = { locations: LOCATIONS, stock: { pe: {} }, shopify_sync: {}, [DIRTY_PATH]: {} };
    for (let i = 0; i < n; i++) {
      const pid = `a${String(i).padStart(3, "0")}`;   // sort BEFORE the live one
      store[DIRTY_PATH][pid] = 1;
      store.stock.pe[pid] = { M: { qty: 1 } };
      store.shopify_sync[pid] = { shopifyProductId: "gid://shopify/Product/9", variants: { M: { shopifyInventoryItemId: "gid://shopify/InventoryItem/999" } } };
    }
    store[DIRTY_PATH][live] = 1;
    store.stock.pe[live] = { M: { qty: 3 } };
    store.shopify_sync[live] = { variants: { M: { shopifyInventoryItemId: "gid://shopify/InventoryItem/1" } } };
    return store;
  };
  // Item 999 is unknown to Shopify, item 1 is known — so the a### products are
  // permanently stuck and the live one is pushable.
  const g = () => vi.fn(async (query) => {
    if (query.includes("locations(first: 2)")) return { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main" }] } };
    if (query.includes("inventorySetQuantities")) return { inventorySetQuantities: { userErrors: [] } };
    if (query.includes("product(id:")) return { product: null };
    return { nodes: [{ id: "gid://shopify/InventoryItem/1", inventoryLevel: { quantities: [{ name: "available", quantity: 7 }] } }] };
  });

  it("without rotation the live product would never be reached — with it, it is", async () => {
    const store = zombieStore(3, "zzz");
    // A window of 2 against 4 markers: the first run sees only zombies.
    const r1 = await sweepDirty(fakeDb(store), g(), { commit: true, max: 2, isLive: () => true });
    expect(r1.results.map((x) => x.pid)).toEqual(["a000", "a001"]);
    expect(r1.nextCursor).toBe("a001");
    // The next run carries on past them rather than starting at the front again.
    const r2 = await sweepDirty(fakeDb(store), g(), { commit: true, max: 2, cursor: r1.nextCursor, isLive: () => true });
    expect(r2.results.map((x) => x.pid)).toEqual(["a002", "zzz"]);
    expect(r2.pushed).toBe(1);
    expect(store[DIRTY_PATH].zzz).toBeUndefined();   // pushed AND cleared
    expect(store[DIRTY_PATH].a000).toBe(1);          // the zombies stay marked
  });

  it("wraps back to the front once it runs off the end", async () => {
    const store = zombieStore(3, "zzz");
    const r = await sweepDirty(fakeDb(store), g(), { commit: true, max: 2, cursor: "zzz", isLive: () => true });
    expect(r.results.map((x) => x.pid)).toEqual(["a000", "a001"]);
  });

  it("does not rotate at all when the whole queue fits in one run", async () => {
    const store = withProduct("p1", { appQty: 3, marker: 1 });
    const r = await sweepDirty(fakeDb(store), graphqlSaying(7), { commit: true, isLive: () => true });
    expect(r.nextCursor).toBeNull();
  });
});

// ── The one constant that lives in two languages ─────────────────────────────
// The Cloud Function trigger (functions/lib/shopify-inventory-dirty.cjs, CJS)
// decides whether a movement is worth marking; this module's push
// (inventory.mjs, ESM) decides what is sellable. They must agree on which
// locations are not sellable, or a movement at a location one of them thinks is
// sellable is either never marked (a silent drift) or marked forever (a marker
// that never finds anything to do). Nothing but this test connects them.
describe("the unsellable-location list is shared with the trigger", () => {
  it("matches functions/lib/shopify-inventory-dirty.cjs exactly", async () => {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const { UNSELLABLE_LOCATIONS } = require("../../functions/lib/shopify-inventory-dirty.cjs");
    const src = readFileSync(new URL("./inventory.mjs", import.meta.url), "utf8");
    const m = src.match(/const UNSELLABLE_LOCATIONS = new Set\(\[([^\]]*)\]\)/);
    expect(m, "inventory.mjs no longer declares UNSELLABLE_LOCATIONS the way this test reads it").toBeTruthy();
    const fromEsm = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    expect(fromEsm.sort()).toEqual([...UNSELLABLE_LOCATIONS].sort());
  });
});
