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
import { sweepDirty, clearMarker, DIRTY_PATH } from "./inventorySync.mjs";

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
