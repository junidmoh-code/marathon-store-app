import { describe, test, expect, vi, beforeAll, afterAll } from "vitest";
import { freshMirrorDb } from "./helpers";
import {
  primePhotoCachePass, evictOldestUntil, clearPhotoCache, heldPhotoCount,
  readCachedPhotoUrl, fetchFullPhoto, photoCacheRequest, fullPhotoCacheRequest,
  isObjectNotFound, PHOTO_CACHE_BYTE_BUDGET, PHOTO_MISSING_RETRY_MS,
  PHOTO_CACHE_INDEX_META_KEY,
} from "../photoCache";

// Node has a real URL.createObjectURL that insists on a real Blob. The blobs
// here are {size,type} stand-ins on purpose — the module only ever reads those
// two fields — so the object-url factory is replaced for the whole file.
const realCreate = globalThis.URL.createObjectURL;
beforeAll(() => { globalThis.URL.createObjectURL = () => "blob:x"; });
afterAll(() => { globalThis.URL.createObjectURL = realCreate; });

// A Cache Storage stand-in. Keyed by the Request's url, as the real one is.
function fakeCache() {
  const held = new Map();
  return {
    held,
    async put(req, res) { held.set(req.url, res); },
    async match(req) { return held.get(req.url) ?? undefined; },
    async delete(req) { return held.delete(req.url); },
  };
}

// A Storage stand-in that hands back blobs of a stated size, or throws the
// error the real SDK throws for a missing object.
function fakeStorage(sizes, { fail = new Set(), transportFail = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async getBlob(path) {
      calls.push(path);
      const id = path.split("/")[1];
      if (transportFail.has(id)) throw new Error("network down");
      if (fail.has(id) || sizes[id] === undefined) {
        const err = new Error("Firebase Storage: Object 'x' does not exist.");
        err.code = "storage/object-not-found";
        throw err;
      }
      return { size: sizes[id], type: "image/webp" };
    },
  };
}

// The module reaches firebase/storage directly, so the two functions it calls
// are mocked at the module boundary rather than injected — the same shape the
// POS's own photoCache tests use.
vi.mock("firebase/storage", () => ({
  ref: (storage, path) => ({ storage, path }),
  getBlob: (r) => r.storage.getBlob(r.path),
}));

const products = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${from + i}`, photoUrl: `https://x/${from + i}.jpg` }));

const pass = (over) => primePhotoCachePass({
  isBusy: () => false, now: () => 1000, setTimeoutFn: (fn) => fn(),
  estimate: async () => null, ...over,
});

describe("the thumbnail trickle", () => {
  test("caches a thumbnail per product and records what it holds", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 20000, p1: 21000 });
    const summary = await pass({ db, storage, cache, products: products(2) });
    expect(summary.cached).toBe(2);
    expect(await heldPhotoCount(db)).toBe(2);
    expect(cache.held.size).toBe(2);
  });

  test("a second pass fetches nothing — this is the whole point", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 20000, p1: 21000 });
    const ps = products(2);
    await pass({ db, storage, cache, products: ps });
    const before = storage.calls.length;
    const again = await pass({ db, storage, cache, products: ps });
    expect(again.cached).toBe(0);
    expect(storage.calls.length).toBe(before);
  });

  test("a RE-SHOT product is re-fetched, because its marker moved", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 20000 });
    await pass({ db, storage, cache, products: [{ id: "p0", photoUrl: "https://x/old.jpg" }] });
    const before = storage.calls.length;
    await pass({ db, storage, cache, products: [{ id: "p0", photoUrl: "https://x/new.jpg" }] });
    expect(storage.calls.length).toBe(before + 1);
  });

  test("A FAILED FETCH IS NOT A MISSING PHOTO", async () => {
    // Marking a transport failure `missing` suppressed the retry for six
    // hours, so one pass run while the line was down poisoned that slice of
    // the catalogue for the rest of the day.
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 20000 }, { transportFail: new Set(["p0"]) });
    const summary = await pass({ db, storage, cache, products: products(1) });
    expect(summary.missing).toBe(0);
    expect(summary.failed).toBe(1);
    const index = await db.getMeta(PHOTO_CACHE_INDEX_META_KEY);
    expect(index?.p0).toBeUndefined();      // nothing suppressed
  });

  test("a genuinely absent object IS marked missing, and re-checked later", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({});
    const summary = await pass({ db, storage, cache, products: products(1) });
    expect(summary.missing).toBe(1);
    expect(isObjectNotFound({ code: "storage/object-not-found" })).toBe(true);
    // Inside the retry window: not re-asked.
    const before = storage.calls.length;
    await pass({ db, storage, cache, products: products(1), now: () => 1000 + PHOTO_MISSING_RETRY_MS - 1 });
    expect(storage.calls.length).toBe(before);
    // Past it: re-asked.
    await pass({ db, storage, cache, products: products(1), now: () => 1000 + PHOTO_MISSING_RETRY_MS + 1 });
    expect(storage.calls.length).toBe(before + 1);
  });

  test("a blob bigger than the whole budget is skipped, not cached", async () => {
    // byteBudget - bytes would be negative, and the eviction would wipe the
    // entire cache trying to reach an impossible ceiling — and then store the
    // oversized blob anyway.
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 500 });
    const summary = await pass({ db, storage, cache, products: products(1), byteBudget: 100 });
    expect(summary.skipped).toBe(1);
    expect(cache.held.size).toBe(0);
  });

  test("the budget evicts oldest-first and keeps room for the new blob", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 40, p1: 40, p2: 40 });
    let t = 1000;
    await pass({ db, storage, cache, products: products(3), byteBudget: 100, now: () => (t += 10) });
    // 120 bytes wanted, 100 allowed: the oldest goes.
    const index = await db.getMeta(PHOTO_CACHE_INDEX_META_KEY);
    const bytes = Object.values(index).reduce((s, v) => s + (v.bytes || 0), 0);
    expect(bytes).toBeLessThanOrEqual(100);
    expect(index.p0).toBeUndefined();
    expect(index.p2).toBeDefined();
  });

  test("a write in flight stops the batch rather than competing with it", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 20 });
    let t = 0;
    const summary = await pass({
      db, storage, cache, products: products(1),
      isBusy: () => true, passBudgetMs: 50, now: () => (t += 30), setTimeoutFn: (fn) => fn(),
    });
    expect(summary.stopped).toBe("busy");
    expect(summary.cached).toBe(0);
  });

  test("a pass that fetched NOTHING does not move the cursor past what it skipped", async () => {
    // The scan walks ahead of the work, so stamping the last SCANNED id would
    // skip a page of thumbnails for a whole lap of the catalogue.
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 20, p1: 20 });
    let t = 0;
    await pass({
      db, storage, cache, products: products(2),
      isBusy: () => true, passBudgetMs: 10, now: () => (t += 30), setTimeoutFn: (fn) => fn(),
    });
    expect(await db.getMeta("photoCache.scanCursor")).toBeUndefined();
  });

  test("a read hit returns a url, a miss returns null so the caller falls back", async () => {
    const cache = fakeCache();
    expect(await readCachedPhotoUrl(cache, "p0")).toBeNull();
    await cache.put(photoCacheRequest("p0"), { blob: async () => ({}) });
    expect(await readCachedPhotoUrl(cache, "p0")).toBe("blob:x");
  });

  test("clearing counts only when the thumbnails were ACTUALLY dropped", async () => {
    const db = await freshMirrorDb();
    await db.setMeta(PHOTO_CACHE_INDEX_META_KEY, { p0: { bytes: 1 } });
    globalThis.caches = { delete: async () => false };
    expect(await clearPhotoCache(db)).toBe(false);
    globalThis.caches = { delete: async () => true };
    await db.setMeta(PHOTO_CACHE_INDEX_META_KEY, { p0: { bytes: 1 } });
    expect(await clearPhotoCache(db)).toBe(true);
    expect(await heldPhotoCount(db)).toBe(0);
    delete globalThis.caches;
  });

  test("heldPhotoCount counts pictures, not `missing` markers", async () => {
    const db = await freshMirrorDb();
    await db.setMeta(PHOTO_CACHE_INDEX_META_KEY, {
      p0: { bytes: 10, missing: false }, p1: { bytes: 0, missing: true },
    });
    expect(await heldPhotoCount(db)).toBe(1);
  });
});

describe("full-size photos: on demand, once, never pre-downloaded", () => {
  test("a full photo is fetched once and served from cache afterwards", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 109000 });
    const product = { id: "p0", photoUrl: "https://x/0.jpg" };
    await fetchFullPhoto({ db, storage, cache, product, now: () => 1 });
    expect(storage.calls).toEqual(["products/p0/photo.jpg"]);
    await fetchFullPhoto({ db, storage, cache, product, now: () => 2 });
    expect(storage.calls).toHaveLength(1);       // still one
  });

  test("a RE-SHOT product does not serve last month's picture", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({ p0: 109000 });
    await fetchFullPhoto({ db, storage, cache, product: { id: "p0", photoUrl: "https://x/old.jpg" }, now: () => 1 });
    await fetchFullPhoto({ db, storage, cache, product: { id: "p0", photoUrl: "https://x/new.jpg" }, now: () => 2 });
    expect(storage.calls).toHaveLength(2);
  });

  test("a failure returns null so the caller uses the url it already has", async () => {
    const db = await freshMirrorDb();
    const cache = fakeCache();
    const storage = fakeStorage({}, { transportFail: new Set(["p0"]) });
    expect(await fetchFullPhoto({ db, storage, cache, product: { id: "p0" }, now: () => 1 })).toBeNull();
  });

  test("the originals share the thumbnails' budget and are keyed apart from them", () => {
    expect(fullPhotoCacheRequest("p0").url).not.toBe(photoCacheRequest("p0").url);
    // 200 MB clears the measured 111.3 MB thumbnail set with room for the
    // handful of originals a person opens by hand.
    expect(PHOTO_CACHE_BYTE_BUDGET).toBe(200 * 1024 * 1024);
  });
});

describe("eviction is structurally incapable of touching the data legs", () => {
  test("it is handed the cache and the photo index, and nothing else", async () => {
    const db = await freshMirrorDb();
    await db.replaceAll("products", [{ key: "p1", value: { id: "p1" } }]);
    await db.setMeta(PHOTO_CACHE_INDEX_META_KEY, {
      p0: { bytes: 100, at: 1 }, p1: { bytes: 100, at: 2 },
    });
    await evictOldestUntil(fakeCache(), db, 0);
    expect(await db.count("products")).toBe(1);
    expect(await heldPhotoCount(db)).toBe(0);
  });

  test("`missing` markers are not evictable — they are not bytes", async () => {
    const db = await freshMirrorDb();
    await db.setMeta(PHOTO_CACHE_INDEX_META_KEY, {
      p0: { bytes: 0, at: 1, missing: true }, p1: { bytes: 100, at: 2 },
    });
    await evictOldestUntil(fakeCache(), db, 0);
    const index = await db.getMeta(PHOTO_CACHE_INDEX_META_KEY);
    expect(index.p0).toBeDefined();
    expect(index.p1).toBeUndefined();
  });
});
