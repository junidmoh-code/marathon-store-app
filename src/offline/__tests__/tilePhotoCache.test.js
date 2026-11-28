// The order grid's photo cache (tilePhotoCache.js): the same photo twice costs
// one download; a new photo URL replaces the old one in the same slot; the
// budget evicts oldest first; a refused cross-origin read turns fetching off
// and leaves the plain <img> to do the work; the kill switch means OFF.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let mirrorOn = true;
vi.mock("../killSwitch", () => ({ offlineMirrorEnabled: () => mirrorOn }));
const meta = new Map();
vi.mock("../mirrorDbHandle", () => ({
  getMirrorDbHandle: async () => ({ getMeta: async (k) => meta.get(k), setMeta: async (k, v) => { meta.set(k, v); } }),
}));

const T = await import("../tilePhotoCache");

// A Cache Storage stand-in: one named cache, Request-keyed, Response values.
function fakeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) {
      const m = new Map();
      stores.set(name, {
        _m: m,
        match: async (req) => { const r = m.get(req.url); return r ? r.clone() : undefined; },
        put: async (req, res) => { m.set(req.url, res); },
        delete: async (req) => m.delete(req.url),
      });
    }
    return stores.get(name);
  };
  return { open, delete: async (name) => stores.delete(name), _stores: stores };
}

let fetches;
function photo(bytes = 1000, type = "image/jpeg") { return new Blob([new Uint8Array(bytes)], { type }); }

beforeEach(() => {
  mirrorOn = true;
  meta.clear();
  T._resetTileCacheForTests();
  globalThis.caches = fakeCaches();
  fetches = [];
  globalThis.fetch = vi.fn(async (url, opts) => { fetches.push({ url, opts }); return new Response(photo(), { status: 200 }); });
  let n = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:t/${++n}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => { delete globalThis.caches; });

// Forget the in-memory copies but keep Cache Storage: what a reload looks like.
async function reload() {
  await T._flushTileWritesForTests();
  await new Promise((r) => setTimeout(r, 4100));   // the debounced index write
  const keep = globalThis.caches;
  T._resetTileCacheForTests();
  globalThis.caches = keep;
}

describe("tile photo cache", () => {
  it("the second view of a photo is zero network, across a reload", async () => {
    const a = await T.getTile("p1", "https://s/p1.jpg?token=a", { priority: "high" });
    expect(a).toMatch(/^blob:/);
    expect(fetches).toHaveLength(1);
    expect(fetches[0].opts).toMatchObject({ mode: "cors", credentials: "omit", priority: "high" });
    await reload();
    globalThis.fetch.mockImplementation(async () => { throw new TypeError("offline"); });
    const b = await T.getTile("p1", "https://s/p1.jpg?token=a");
    expect(b).toMatch(/^blob:/);
    expect(fetches).toHaveLength(1);                 // came from the device
    await T.loadTileIndex();
    expect(T.isTileHeld("p1", "https://s/p1.jpg?token=a")).toBe(true);
  }, 15000);

  it("a re-shot photo (new URL / token) misses and replaces the old one in the same slot", async () => {
    await T.getTile("p1", "https://s/p1.jpg?token=a");
    await T._flushTileWritesForTests();
    const url = await T.getTile("p1", "https://s/p1.jpg?token=b");
    expect(url).toMatch(/^blob:/);
    expect(fetches.map((f) => f.url)).toEqual(["https://s/p1.jpg?token=a", "https://s/p1.jpg?token=b"]);
    await T._flushTileWritesForTests();
    const store = [...globalThis.caches._stores.values()][0];
    expect(store._m.size).toBe(1);
    expect(store._m.get(T.tileRequest("p1").url).headers.get("x-tile-src")).toBe("https://s/p1.jpg?token=b");
    expect(T.isTileHeld("p1", "https://s/p1.jpg?token=a")).toBe(false);
  });

  it("one download however many cards ask at once", async () => {
    await Promise.all([T.getTile("p1", "u1"), T.getTile("p1", "u1"), T.getTile("p1", "u1")]);
    expect(fetches).toHaveLength(1);
  });

  it("the budget evicts the oldest-written photos first", async () => {
    T._setTileBudgetForTests(2500);
    for (const id of ["a", "b", "c"]) { await T.getTile(id, `u-${id}`); await T._flushTileWritesForTests(); await new Promise((r) => setTimeout(r, 2)); }
    expect(T.isTileHeld("a", "u-a")).toBe(false);      // 3 × 1000 > 2500: a went
    expect(T.isTileHeld("b", "u-b")).toBe(true);
    expect(T.isTileHeld("c", "u-c")).toBe(true);
    expect(T.tileCacheStats().bytes).toBe(2000);
  });

  it("refused cross-origin reads (bucket CORS) turn fetching off; the card falls back to a plain <img>", async () => {
    globalThis.fetch.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    for (const id of ["a", "b", "c"]) expect(await T.getTile(id, `u-${id}`)).toBe(null);
    expect(T.tileFetchAllowed()).toBe(false);
    globalThis.fetch.mockClear();
    expect(await T.getTile("d", "u-d")).toBe(null);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("a dropped connection after reads have worked does not turn fetching off", async () => {
    await T.getTile("ok", "u-ok");
    globalThis.fetch.mockImplementation(async () => { throw new TypeError("network"); });
    for (const id of ["a", "b", "c", "d"]) await T.getTile(id, `u-${id}`);
    expect(T.tileFetchAllowed()).toBe(true);
  });

  it("prefetch (warm) puts the bytes on the device and makes no object URL", async () => {
    expect(await T.getTile("p1", "u1", { warm: true, priority: "low" })).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await T._flushTileWritesForTests();
    expect(T.isTileHeld("p1", "u1")).toBe(true);
    expect(await T.getTile("p1", "u1", { warm: true })).toBe(true);
    expect(fetches).toHaveLength(1);
  });

  it("a URL a card is showing is never revoked, however many photos pass through memory", async () => {
    const shown = await T.getTile("keep", "u-keep");        // handed over already held
    for (let i = 0; i < 130; i++) { const u = await T.getTile(`x${i}`, `u-x${i}`, { keep: false }); T.releaseTile(`x${i}`, u); }
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(shown);
    expect(URL.revokeObjectURL).toHaveBeenCalled();             // unheld ones do go
    T.releaseTile("keep", shown);
    await T.getTile("one-more", "u-one-more", { keep: false });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(shown);
  });

  it("a timed-out download is the line, not CORS: it never turns fetching off", async () => {
    globalThis.fetch.mockImplementation(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    for (const id of ["a", "b", "c", "d"]) expect(await T.getTile(id, `u-${id}`)).toBe(null);
    expect(T.tileFetchAllowed()).toBe(true);
  });

  it("a refused verdict is re-armed after ten minutes", async () => {
    globalThis.fetch.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const now = Date.now();
    for (const id of ["a", "b", "c"]) await T.getTile(id, `u-${id}`);
    expect(T.tileFetchAllowed()).toBe(false);
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    try { expect(T.tileFetchAllowed()).toBe(true); } finally { spy.mockRestore(); }
  });

  it("a card joining a prefetch gets the downloaded photo itself, at once", async () => {
    let release;
    globalThis.fetch.mockImplementation(async () => { await new Promise((r) => { release = r; }); return new Response(photo(), { status: 200 }); });
    const warm = T.getTile("p1", "u1", { warm: true, priority: "low" });
    const shown = T.getTile("p1", "u1");
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await warm).toBe(true);
    expect(await shown).toMatch(/^blob:/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("a clear drops writes still in flight and keeps shown URLs until let go", async () => {
    const shown = await T.getTile("p1", "u1");                // its write is pending
    await T.clearTileCache();
    await T._flushTileWritesForTests();
    expect(T.isTileHeld("p1", "u1")).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(shown);
    T.releaseTile("p1", shown);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(shown);
  });

  it("mirror off means off: no fetch, no cache", async () => {
    mirrorOn = false;
    expect(await T.getTile("p1", "u1")).toBe(null);
    expect(fetches).toHaveLength(0);
  });

  it("keeps a tiny placeholder sized as the photo, drawn as an SVG with its own blur", () => {
    const svg = decodeURIComponent(T.tinySvg({ tiny: "data:image/jpeg;base64,AAAA", w: 800, h: 1000 }).split(",")[1]);
    expect(svg).toContain('width="800" height="1000"');
    expect(svg).toContain("feGaussianBlur");
    expect(svg).toContain("data:image/jpeg;base64,AAAA");
  });

  it("clearTileCache drops the photos and the index", async () => {
    await T.getTile("p1", "u1");
    await T._flushTileWritesForTests();
    expect(await T.clearTileCache()).toBe(true);
    expect(T.isTileHeld("p1", "u1")).toBe(false);
    expect(meta.get(T.TILE_INDEX_META_KEY)).toEqual({});
  });
});
