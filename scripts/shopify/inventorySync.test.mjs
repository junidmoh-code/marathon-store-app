// ─── THE INVENTORY SWEEP — failure semantics, not happy paths ────────────────
// The happy path is one line: read both sides, write ours. Everything that can
// actually hurt is in what happens when a push FAILS, because the failure mode
// is silent: a marker cleared on a failed push means the storefront keeps
// offering stock that no longer exists and nothing ever revisits it.
import { describe, it, expect, vi } from "vitest";
import { sweepDirty, syncProduct, DIRTY_PATH, MAX_PER_RUN } from "./inventorySync.mjs";

// A minimal RTDB stand-in: ref(path).get()/.remove() over a plain tree.
function fakeDb(tree) {
  const removed = [];
  const at = (path) => path.split("/").reduce((o, k) => (o == null ? undefined : o[k]), tree);
  return {
    removed,
    ref: (path) => ({
      get: async () => ({ val: () => at(path) ?? null }),
      remove: async () => { removed.push(path); },
    }),
  };
}

const world = (over = {}) => ({
  // /locations is where the location NAMES come from. Reading them off /stock
  // pulled the whole 5.36 MB node once per product.
  locations: over.locations ?? { trophy: { id: "trophy" }, in_transit: { id: "in_transit" } },
  [DIRTY_PATH]: over.markers ?? { p1: { at: 1, location: "trophy" } },
  shopify_sync: over.sync ?? { p1: { variants: { 8: { shopifyInventoryItemId: "gid://ii/1" } } } },
  stock: over.stock ?? { trophy: { p1: { 8: { qty: 2 } } } },
});

// graphql stub: the location query, the read-back, then the mutation.
function fakeGraphql({ shopifyHas = 5, failMutation = false } = {}) {
  const calls = [];
  return Object.assign(async (q, vars) => {
    calls.push({ q, vars });
    if (/locations\(first: 2\)/.test(q)) return { locations: { nodes: [{ id: "gid://loc/1", name: "Main" }] } };
    if (/InventoryItem/.test(q) && /query/.test(q)) {
      return { nodes: (vars.ids || []).map((id) => ({ id, inventoryLevel: { quantities: [{ name: "available", quantity: shopifyHas }] } })) };
    }
    if (failMutation) throw new Error("Shopify said no");
    return { inventorySetQuantities: { userErrors: [] } };
  }, { calls });
}

describe("a marker is cleared only when the push actually landed", () => {
  it("clears after a successful push", async () => {
    const db = fakeDb(world());
    const r = await sweepDirty(db, fakeGraphql(), { commit: true, isLive: () => true });
    expect(r.pushed).toBe(1);
    expect(db.removed).toContain(`${DIRTY_PATH}/p1`);
  });

  it("KEEPS the marker when the push throws — the next tick retries", async () => {
    // The whole reason the marker is a node and not a timestamp cursor. If this
    // ever clears, a failed push looks exactly like a completed one and the
    // storefront stays wrong until someone notices by hand.
    const db = fakeDb(world());
    const r = await sweepDirty(db, fakeGraphql({ failMutation: true }), { commit: true, isLive: () => true });
    expect(db.removed).not.toContain(`${DIRTY_PATH}/p1`);
    expect(r.results[0].ok).toBe(false);
    expect(r.pushed).toBe(0);
  });

  it("a dry run clears nothing and writes nothing", async () => {
    const db = fakeDb(world());
    const g = fakeGraphql();
    await sweepDirty(db, g, { commit: false, isLive: () => true });
    expect(db.removed).toEqual([]);
    expect(g.calls.some((c) => /mutation/.test(c.q))).toBe(false);
  });
});

describe("markers for things not on the storefront", () => {
  it("are cleared without a Shopify call — otherwise the node grows forever", async () => {
    // Every stock movement on everything marks. Most of the catalogue is not
    // online; leaving those markers would mean the node accumulates a key per
    // product ever touched, and the sweep re-reads them on every tick.
    const db = fakeDb(world());
    const g = fakeGraphql();
    const r = await sweepDirty(db, g, { commit: true, isLive: () => false });
    expect(db.removed).toContain(`${DIRTY_PATH}/p1`);
    expect(r.pushed).toBe(0);
    expect(g.calls.some((c) => /InventoryItem/.test(c.q))).toBe(false);
  });
});

describe("the per-run cap", () => {
  it("takes a bite and leaves the rest marked", async () => {
    const markers = {}; for (let i = 0; i < 10; i++) markers[`p${i}`] = { at: 1 };
    const db = fakeDb({ ...world({ markers }), shopify_sync: {}, stock: {} });
    const r = await sweepDirty(db, fakeGraphql(), { commit: true, isLive: () => true, max: 4 });
    expect(r.seen).toBe(10);
    expect(r.remaining).toBe(6);
    expect(db.removed.length).toBe(4);
  });

  it("has a sane default — a bulk count must not hold the Shopify session all tick", () => {
    expect(MAX_PER_RUN).toBeGreaterThan(5);
    expect(MAX_PER_RUN).toBeLessThanOrEqual(100);
  });
});

describe("what gets written", () => {
  it("sends EVERY mapped variant, not only the drifted ones", async () => {
    // inventorySetQuantities is absolute. Sending a patch would make the result
    // depend on the read-back still being current; sending the full set makes
    // one call the whole truth for that product.
    const db = fakeDb(world({
      sync: { p1: { variants: { 8: { shopifyInventoryItemId: "gid://ii/8" }, 9: { shopifyInventoryItemId: "gid://ii/9" } } } },
      stock: { trophy: { p1: { 8: { qty: 2 }, 9: { qty: 4 } } } },
    }));
    const g = fakeGraphql({ shopifyHas: 2 });   // size 8 agrees, size 9 drifts
    const r = await syncProduct(db, g, "p1", { commit: true });
    expect(r.drift.map((d) => d.sizeKey)).toEqual(["9"]);
    const mutation = g.calls.find((c) => /inventorySetQuantities/.test(c.q));
    expect(mutation.vars.input.quantities.length).toBe(2);
  });

  it("no drift means no mutation at all", async () => {
    const db = fakeDb(world());
    const g = fakeGraphql({ shopifyHas: 2 });   // app also has 2
    const r = await syncProduct(db, g, "p1", { commit: true });
    expect(r.changed).toBe(0);
    expect(g.calls.some((c) => /inventorySetQuantities/.test(c.q))).toBe(false);
  });

  it("a product with no id map is skipped, not failed", async () => {
    const db = fakeDb(world({ sync: {} }));
    const r = await syncProduct(db, fakeGraphql(), "p1", { commit: true });
    expect(r.skipped).toMatch(/id map/);
  });

  it("in_transit never counts toward what the storefront may sell", async () => {
    // Boxes that left their source and have not landed are not sellable.
    const db = fakeDb(world({
      stock: { trophy: { p1: { 8: { qty: 1 } } }, in_transit: { p1: { 8: { qty: 9 } } } },
    }));
    const g = fakeGraphql({ shopifyHas: 0 });
    const r = await syncProduct(db, g, "p1", { commit: true });
    expect(r.drift[0].quantity).toBe(1);
  });
});

// ── ONE STALE ID MUST NOT VETO ITS NEIGHBOURS ────────────────────────────────
// A live product's id map points at inventory items that no longer exist on the
// shop. inventorySetQuantities rejects the WHOLE mutation on one unknown id, so
// sending them meant that product's oversellable variants stayed oversellable.
describe("an inventory item Shopify does not know", () => {
  // The read-back only answers for ids Shopify can resolve; an id missing from
  // the response is the signal.
  function partialGraphql(knownIds, shopifyHas = 5) {
    const calls = [];
    return Object.assign(async (q, vars) => {
      calls.push({ q, vars });
      if (/locations\(first: 2\)/.test(q)) return { locations: { nodes: [{ id: "gid://loc/1", name: "Main" }] } };
      if (/InventoryItem/.test(q) && /query/.test(q)) {
        return { nodes: (vars.ids || []).filter((id) => knownIds.includes(id))
          .map((id) => ({ id, inventoryLevel: { quantities: [{ name: "available", quantity: shopifyHas }] } })) };
      }
      return { inventorySetQuantities: { userErrors: [] } };
    }, { calls });
  }

  const twoVariants = () => world({
    sync: { p1: { variants: { 8: { shopifyInventoryItemId: "gid://ii/8" }, 9: { shopifyInventoryItemId: "gid://ii/GONE" } } } },
    stock: { trophy: { p1: { 8: { qty: 1 }, 9: { qty: 1 } } } },
  });

  it("is dropped from the write, and the good variant is still corrected", async () => {
    const db = fakeDb(twoVariants());
    const g = partialGraphql(["gid://ii/8"]);
    const r = await syncProduct(db, g, "p1", { commit: true });
    expect(r.ok).toBe(true);
    expect(r.staleVariants).toEqual(["9"]);
    const mutation = g.calls.find((c) => /inventorySetQuantities/.test(c.q));
    expect(mutation.vars.input.quantities.map((x) => x.inventoryItemId)).toEqual(["gid://ii/8"]);
  });

  it("is reported rather than swallowed — a stale id map is a real problem", async () => {
    const db = fakeDb(twoVariants());
    const r = await syncProduct(db, partialGraphql(["gid://ii/8"]), "p1", { commit: true });
    expect(r.staleVariants.length).toBe(1);
  });

  it("a product where EVERY id is unknown fails loudly instead of silently succeeding", async () => {
    const db = fakeDb(twoVariants());
    const r = await syncProduct(db, partialGraphql([]), "p1", { commit: true });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/id map is stale/);
  });
});

describe("the whole /stock node is never read", () => {
  it("location names come from /locations", async () => {
    // 5.36 MB per product over 866 products is ~4.6 GB a run. The first version
    // did exactly that to read ten strings.
    const reads = [];
    const tree = world();
    const db = {
      ref: (path) => { reads.push(path); return { get: async () => ({ val: () => path.split("/").reduce((o, k) => (o == null ? undefined : o[k]), tree) ?? null }), remove: async () => {} }; },
    };
    await syncProduct(db, fakeGraphql(), "p1", { commit: false });
    expect(reads).toContain("locations");
    expect(reads).not.toContain("stock");
  });
});
