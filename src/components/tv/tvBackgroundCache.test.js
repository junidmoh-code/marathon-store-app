// The board's photo cache: each photo is downloaded once, rotation reads from
// the cache, removed photos are pruned, and any failure falls back to the URL.
import { describe, it, expect, vi } from "vitest";
import { createTvBackgroundCache, TV_BG_CACHE_NAME } from "./tvBackgroundCache";

function fakeCaches() {
  const stores = new Map();
  return {
    stores,
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        match: async (u) => m.get(u),
        put: async (u, r) => { m.set(u, r); },
        keys: async () => [...m.keys()].map((url) => ({ url })),
        delete: async (req) => m.delete(req.url),
      };
    },
  };
}
const response = (body) => ({ ok: true, status: 200, blob: async () => ({ body }) });

function setup() {
  const cacheStorage = fakeCaches();
  const fetchFn = vi.fn(async (u) => response(u));
  let n = 0;
  const urlApi = { createObjectURL: vi.fn(() => `blob:${++n}`), revokeObjectURL: vi.fn() };
  const cache = createTvBackgroundCache({ cacheStorage, fetchFn, urlApi, log: { warn: () => {} } });
  return { cache, cacheStorage, fetchFn, urlApi };
}

describe("tvBackgroundCache", () => {
  it("preloads today's set once; rotating through it never fetches again", async () => {
    const { cache, fetchFn, cacheStorage } = setup();
    await cache.prefetch(["a", "b", "c"]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const u of ["a", "b", "c", "a", "b", "c", "a"]) {
      expect(String(await cache.resolve(u))).toMatch(/^blob:/);
    }
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect([...cacheStorage.stores.keys()]).toEqual([TV_BG_CACHE_NAME]);
  });

  it("a new upload downloads only the new photo", async () => {
    const { cache, fetchFn } = setup();
    await cache.prefetch(["a", "b"]);
    await cache.prefetch(["a", "b", "new"]);
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual(["a", "b", "new"]);
  });

  it("holds only a few decoded photos in memory, revoking the oldest", async () => {
    const { cache, urlApi } = setup();
    for (const u of ["a", "b", "c", "d", "e"]) await cache.resolve(u);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("prunes photos removed in the Workshop", async () => {
    const { cache, cacheStorage } = setup();
    await cache.prefetch(["a", "b", "c"]);
    expect(await cache.prune(["a", "c"])).toEqual(["b"]);
    expect([...cacheStorage.stores.get(TV_BG_CACHE_NAME).keys()]).toEqual(["a", "c"]);
  });

  it("fails open: no Cache Storage, or a refused download, draws the plain URL", async () => {
    const none = createTvBackgroundCache({ cacheStorage: null, fetchFn: vi.fn(), urlApi: null });
    expect(await none.resolve("https://x/a.jpg")).toBe("https://x/a.jpg");
    const { cache, fetchFn } = setup();
    fetchFn.mockRejectedValueOnce(new TypeError("CORS"));
    expect(await cache.resolve("https://x/b.jpg")).toBe("https://x/b.jpg");
  });
});
