// The Workshop's writes, against a fake Storage + a fake RTDB that behaves like
// the real one: an empty array or null removes the key.
import { describe, it, expect, vi } from "vitest";
import {
  uploadTvBackground, removeTvBackground, setTvBackgroundDays, swapTvBackgroundOrder,
  backfillThumbs, fullPathFor, thumbPathFor,
} from "./tvBackgroundOps";
import { TV_BG_MAX_EDGE, TV_BG_THUMB_EDGE } from "./tvBackgrounds";
import { readFileSync } from "node:fs";

function fakeWorld({ now = 1_800_000_000_000 } = {}) {
  const files = new Map();       // path → blob
  const db = {};                 // the tvBackgrounds node
  const writes = [];
  let n = 0;
  const setAt = (path, v) => {
    const parts = path.split("/").filter(Boolean);
    let o = db;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ||= {};
    const k = parts[parts.length - 1];
    // Real RTDB: null and [] both mean "no child here".
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) delete o[k];
    else o[k] = v;
  };
  const io = {
    newId: () => `id${++n}`,
    putFile: vi.fn(async (path, blob) => { files.set(path, blob); return `https://cdn/${path}?token=t`; }),
    deleteFile: vi.fn(async (path) => {
      if (!files.has(path)) { const e = new Error("gone"); e.code = "storage/object-not-found"; throw e; }
      files.delete(path);
    }),
    getFile: vi.fn(async (path) => files.get(path)),
    update: vi.fn(async (rel, patch) => {
      writes.push({ rel, patch });
      for (const [k, v] of Object.entries(patch)) {
        if (k.includes("/") || !rel) setAt(rel ? `${rel}/${k}` : k, v);
        else setAt(`${rel}/${k}`, v);
      }
    }),
    remove: vi.fn(async (rel) => setAt(rel, null)),
    nowMs: () => now,
    who: () => "junid",
    encode: vi.fn(async (file, edge, q) => ({ kind: "jpeg", edge, q, from: file.name || "blob" })),
  };
  return { io, files, db, writes };
}

describe("uploadTvBackground", () => {
  it("stores a 1920 full photo and a 320 thumb in Storage, metadata only in RTDB, server time", async () => {
    const { io, files, db } = fakeWorld();
    const id = await uploadTvBackground(io, { name: "wall.png" });
    expect([...files.keys()].sort()).toEqual([fullPathFor(id), thumbPathFor(id)].sort());
    expect(files.get(fullPathFor(id)).edge).toBe(TV_BG_MAX_EDGE);
    expect(files.get(thumbPathFor(id)).edge).toBe(TV_BG_THUMB_EDGE);
    const meta = db.photos[id];
    expect(meta).toMatchObject({ path: fullPathFor(id), thumbPath: thumbPathFor(id), uploadedAt: 1_800_000_000_000, enabled: true });
    expect(meta.days).toBeUndefined();                       // every day
    // Nothing that looks like image bytes ever reaches the database.
    expect(JSON.stringify(db)).not.toMatch(/data:image|base64/);
  });

  it("every upload is a new path — never an overwrite — and there is no cap", async () => {
    const { io, files } = fakeWorld();
    for (let i = 0; i < 40; i++) await uploadTvBackground(io, { name: `p${i}.jpg` });
    expect(files.size).toBe(80);
    const paths = io.putFile.mock.calls.map((c) => c[0]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("the Workshop and the app never re-impose a 12-photo cap", () => {
    const section = readFileSync(new URL("../components/TvBackgroundsSection.jsx", import.meta.url), "utf8");
    expect(section).not.toMatch(/MAX_TV_BACKGROUNDS|room <= 0|Only \$\{room\}/);
  });
});

describe("removeTvBackground", () => {
  it("deletes the full photo AND the thumb from Storage, then the metadata", async () => {
    const { io, files, db } = fakeWorld();
    const id = await uploadTvBackground(io, { name: "x.jpg" });
    await removeTvBackground(io, { id, path: fullPathFor(id), thumbPath: thumbPathFor(id) });
    expect(files.size).toBe(0);
    expect(db.photos?.[id]).toBeUndefined();
    const order = [...io.deleteFile.mock.calls.map((c) => c[0]), ...io.remove.mock.calls.map((c) => c[0])];
    expect(order).toEqual([fullPathFor(id), thumbPathFor(id), `photos/${id}`]);
  });

  it("a Storage failure keeps the photo listed so the remove can be retried", async () => {
    const { io, db } = fakeWorld();
    const id = await uploadTvBackground(io, { name: "x.jpg" });
    io.deleteFile.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "storage/retry-limit-exceeded" }));
    await expect(removeTvBackground(io, { id, path: fullPathFor(id), thumbPath: thumbPathFor(id) })).rejects.toThrow("offline");
    expect(db.photos[id]).toBeDefined();
  });

  it("an already-missing file (or a photo from before thumbs) still removes cleanly; the default is cleared", async () => {
    const { io, db } = fakeWorld();
    db.photos = { old: { url: "u" } };
    db.defaultId = "old";
    await removeTvBackground(io, { id: "old", path: fullPathFor("old"), thumbPath: "" }, { wasDefault: true });
    expect(db.photos.old).toBeUndefined();
    expect(db.defaultId).toBe("");
  });
});

describe("days + order", () => {
  it("every day is written as null; an explicit list as the list", async () => {
    const { io, db } = fakeWorld();
    db.photos = { a: { url: "u", days: [1] } };
    await setTvBackgroundDays(io, "a", [1, 3]);
    expect(db.photos.a.days).toEqual([1, 3]);
    await setTvBackgroundDays(io, "a", null);
    expect("days" in db.photos.a).toBe(false);
    await setTvBackgroundDays(io, "a", []);                 // even an empty list: never an empty array write
    expect(io.update.mock.calls.at(-1)[1]).toEqual({ days: null });
  });

  it("swapping order is one multi-path write", async () => {
    const { io, db } = fakeWorld();
    db.photos = { a: { order: 10 }, b: { order: 20 } };
    await swapTvBackgroundOrder(io, { id: "a", order: 10 }, { id: "b", order: 20 });
    expect(io.update).toHaveBeenCalledTimes(1);
    expect(db.photos.a.order).toBe(20);
    expect(db.photos.b.order).toBe(10);
  });
});

describe("backfillThumbs", () => {
  it("makes a thumb for photos that have none, once, and records it", async () => {
    const { io, files, db } = fakeWorld();
    files.set(fullPathFor("old"), { name: "full" });
    db.photos = { old: { url: "u", path: fullPathFor("old") } };
    const done = await backfillThumbs(io, [
      { id: "old", path: fullPathFor("old"), thumbUrl: "" },
      { id: "new", path: fullPathFor("new"), thumbUrl: "https://t" },
    ]);
    expect(done).toEqual(["old"]);
    expect(db.photos.old.thumbPath).toBe(thumbPathFor("old"));
    expect(io.encode).toHaveBeenCalledWith({ name: "full" }, TV_BG_THUMB_EDGE, expect.any(Number));
  });
});
