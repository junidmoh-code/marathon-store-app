// A BEHAVIOURAL test, replacing two source-text pins that a mutation audit
// walked straight past while leaving every asserted substring byte-identical.
// The mutation made the spared name null, so the filter kept nothing and every
// cache — including 111 MB of thumbnails — was deleted on every boot, with
// both pins green. (Opus test audit, PR #618.)
import { describe, test, expect, vi } from "vitest";
import { clearCachesExceptPhotos } from "../cacheClear";
import { PHOTO_CACHE_NAME } from "../photoCache";

const fakeCaches = (names) => {
  const held = new Set(names);
  return { held, keys: async () => [...held], delete: vi.fn(async (k) => held.delete(k)) };
};

describe("the boot-time cache clear", () => {
  test("keeps the photo mirror and deletes everything else", async () => {
    const c = fakeCaches(["workbox-precache-v2", PHOTO_CACHE_NAME, "old-runtime"]);
    const deleted = await clearCachesExceptPhotos({ cacheStorage: c });
    expect(deleted.sort()).toEqual(["old-runtime", "workbox-precache-v2"]);
    expect([...c.held]).toEqual([PHOTO_CACHE_NAME]);
  });

  test("a device with only the photo mirror loses nothing", async () => {
    const c = fakeCaches([PHOTO_CACHE_NAME]);
    expect(await clearCachesExceptPhotos({ cacheStorage: c })).toEqual([]);
    expect(c.delete).not.toHaveBeenCalled();
  });

  test("it spares the name photoCache.js actually uses, not a copy of it", async () => {
    const c = fakeCaches([PHOTO_CACHE_NAME]);
    await clearCachesExceptPhotos({ cacheStorage: c });
    expect(PHOTO_CACHE_NAME).toBe("marathon-store-photo-mirror-v1");
    expect([...c.held]).toContain(PHOTO_CACHE_NAME);
  });

  test("no Cache Storage at all is not an error", async () => {
    expect(await clearCachesExceptPhotos({ cacheStorage: null })).toEqual([]);
  });

  test("a keys() that throws is not an error either", async () => {
    const c = { keys: async () => { throw new Error("blocked"); }, delete: vi.fn() };
    expect(await clearCachesExceptPhotos({ cacheStorage: c })).toEqual([]);
  });

  test("one delete failing does not stop the others", async () => {
    const held = new Set(["a", "b", PHOTO_CACHE_NAME]);
    const c = {
      keys: async () => [...held],
      delete: async (k) => { if (k === "a") throw new Error("busy"); return held.delete(k); },
    };
    await clearCachesExceptPhotos({ cacheStorage: c });
    expect(held.has("b")).toBe(false);
    expect(held.has(PHOTO_CACHE_NAME)).toBe(true);
  });
});
