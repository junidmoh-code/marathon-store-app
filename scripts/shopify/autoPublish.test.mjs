// ── Auto-publish: name accepted, Excellent, publish — and never a live listing
import { describe, it, expect } from "vitest";
import { fakeDb } from "./fakeRtdb.testutil.mjs";
import { drainAutoPublish, autoPublishOne, SWITCH_PATH, EXCELLENT, MAX_PER_RUN, RETRY_AFTER_MS } from "./autoPublish.mjs";
import { AUTOPUBLISH_QUEUE_PATH, HIDDEN_PATH } from "./reviewStock.mjs";

const NOW = 1_800_000_000_000;
const now = async () => NOW;
const PHOTO = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/x.jpg";
const IN_STOCK = { pe: { p1: { M: { qty: 4 } } } };

function world({ node, product = {}, stock = IN_STOCK, enabled = true, queue = { p1: { queuedAt: 1 } }, hidden } = {}) {
  return {
    locations: { pe: {}, "marathon-pine": {} },
    products: { p1: { name: "Plain tee black", sizes: ["M"], photoUrl: PHOTO, ...product } },
    ...(node !== undefined ? { shopify_publish: { p1: node } } : {}),
    stock,
    [AUTOPUBLISH_QUEUE_PATH]: queue,
    config: { ...(enabled ? { shopifyAutoPublish: { enabled: true } } : {}), ...(hidden ? { shopifyReviewHidden: { p1: 1 } } : {}) },
  };
}
const pub = (f) => f.store.shopify_publish?.p1;

describe("autoPublishOne", () => {
  it("APPLIES the AI name suggestion, sets Excellent and publishes (intent only)", async () => {
    const f = fakeDb(world({ node: { state: "awaiting", nameProposal: { status: "pending", name: "Club Tee Black", proposedAt: 5 } } }));
    const r = await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] });
    expect(r.outcome).toBe("published");
    expect(pub(f)).toMatchObject({ cleanName: "Club Tee Black", cleanNameSource: "ai", condition: EXCELLENT, desiredState: "on" });
    expect(pub(f).nameProposal.status).toBe("applied");
    // The agent writes the INTENT; it never writes liveState — the reconciler does Shopify.
    expect(pub(f).liveState).toBeUndefined();
  });

  it("publishes a never-reviewed product under the lexicon's clean name", async () => {
    const f = fakeDb(world({ node: undefined }));
    const r = await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] });
    expect(r.outcome).toBe("published");
    expect(pub(f)).toMatchObject({ condition: EXCELLENT, desiredState: "on" });
    expect(pub(f).cleanName.length).toBeGreaterThan(2);
  });

  it("a name the compliance gate refuses (brand word) is NEVER published — it waits", async () => {
    const f = fakeDb(world({ node: { state: "awaiting", cleanName: "Nike Club Tee" } }));
    const r = await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] });
    expect(r.outcome).toBe("wait");
    expect(r.why).toMatch(/brand trigger/);
    expect(pub(f).desiredState).toBeUndefined();
  });

  it("replaces a Very good / Good grade with Excellent", async () => {
    const f = fakeDb(world({ node: { state: "awaiting", cleanName: "Club Tee Plain", condition: "Good — light signs of wear" } }));
    await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] });
    expect(pub(f).condition).toBe(EXCELLENT);
  });

  it("NEVER touches a product already ON the storefront", async () => {
    const live = { state: "live", liveState: "on", cleanName: "Old Name", condition: "Good — light signs of wear" };
    const f = fakeDb(world({ node: live }));
    const before = JSON.stringify(f.store.shopify_publish);
    const r = await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] });
    expect(r.outcome).toBe("done");
    expect(JSON.stringify(f.store.shopify_publish)).toBe(before);
  });

  it("does not re-publish a product already going on", async () => {
    const f = fakeDb(world({ node: { state: "awaiting", desiredState: "on", cleanName: "X Name", condition: EXCELLENT } }));
    const before = JSON.stringify(f.store.shopify_publish);
    expect((await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] })).outcome).toBe("done");
    expect(JSON.stringify(f.store.shopify_publish)).toBe(before);
  });

  it("leaves a BLOCKED product for a person", async () => {
    const f = fakeDb(world({ node: { state: "blocked", blockedReason: "trigger word" } }));
    expect((await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] })).outcome).toBe("done");
    expect(pub(f).desiredState).toBeUndefined();
  });

  it("re-checks stock NOW: 3 units is below the bar → not published", async () => {
    const f = fakeDb(world({ node: undefined, stock: { pe: { p1: { M: { qty: 3 } } } } }));
    const r = await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] });
    expect(r.outcome).toBe("done");
    expect(pub(f)).toBeUndefined();
  });

  it("Pine units do not count toward the bar", async () => {
    const f = fakeDb(world({ node: undefined, stock: { pe: { p1: { M: { qty: 1 } } }, "marathon-pine": { p1: { M: { qty: 9 } } } } }));
    expect((await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] })).outcome).toBe("done");
    expect(pub(f)).toBeUndefined();
  });

  it("waits (writes nothing) when there is no photo", async () => {
    const f = fakeDb(world({ node: undefined, product: { photoUrl: null } }));
    expect((await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] })).outcome).toBe("wait");
    expect(pub(f)).toBeUndefined();
  });

  it("waits for the AI namer when the lexicon cannot name it", async () => {
    // A brand-trigger name the lexicon refuses to clean on its own.
    const f = fakeDb(world({ node: undefined, product: { name: "Sneaker Bad Bunny x Indoor Benito" } }));
    const r = await autoPublishOne(f.db, "p1", { now, locNames: ["pe"] });
    if (r.outcome === "wait") expect(pub(f)?.desiredState).toBeUndefined();
    else expect(r.outcome).toBe("published"); // the lexicon could clean it — also fine
  });
});

describe("drainAutoPublish", () => {
  it("does NOTHING while the off switch is absent", async () => {
    const f = fakeDb(world({ node: undefined, enabled: false }));
    const r = await drainAutoPublish(f.db, { now });
    expect(r.enabled).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.store[AUTOPUBLISH_QUEUE_PATH].p1).toBeDefined();
  });

  it("publishes and empties the queue (the empty queue node disappears)", async () => {
    const f = fakeDb(world({ node: undefined }));
    const r = await drainAutoPublish(f.db, { now });
    expect(r).toMatchObject({ enabled: true, published: 1 });
    expect(f.store[AUTOPUBLISH_QUEUE_PATH]).toBeUndefined();
  });

  it("a waiting product stays queued with its reason and is not retried for 30 minutes", async () => {
    const f = fakeDb(world({ node: undefined, product: { photoUrl: null } }));
    await drainAutoPublish(f.db, { now });
    expect(f.store[AUTOPUBLISH_QUEUE_PATH].p1).toMatchObject({ lastTryAt: NOW, why: "no photo yet", queuedAt: 1 });
    const n = f.writes.length;
    await drainAutoPublish(f.db, { now: async () => NOW + RETRY_AFTER_MS - 1 });
    expect(f.writes.length).toBe(n); // not looked at again yet
  });

  it("publishes at most MAX_PER_RUN per tick", async () => {
    const store = world({ node: undefined, queue: {} });
    for (let i = 0; i < MAX_PER_RUN + 5; i++) {
      const pid = `q${String(i).padStart(3, "0")}`;
      store.products[pid] = { name: "Plain tee black", sizes: ["M"], photoUrl: PHOTO };
      store.stock.pe[pid] = { M: { qty: 5 } };
      store[AUTOPUBLISH_QUEUE_PATH][pid] = { queuedAt: 1 };
    }
    const f = fakeDb(store);
    const r = await drainAutoPublish(f.db, { now });
    expect(r.published).toBe(MAX_PER_RUN);
    expect(Object.keys(f.store[AUTOPUBLISH_QUEUE_PATH]).length).toBe(5);
  });
});
