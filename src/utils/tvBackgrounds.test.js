import { describe, it, expect } from "vitest";
import { normalizeTvBackgrounds, pickTvBackground, MIN_ROTATE_SECONDS, DEFAULT_ROTATE_SECONDS } from "./tvBackgrounds";

const node = (extra) => ({
  photos: {
    c: { url: "u-c", addedAt: 30 },
    a: { url: "u-a", addedAt: 10 },
    b: { url: "u-b", addedAt: 20 },
    junk: { addedAt: 5 },
  },
  ...extra,
});

describe("TV backgrounds", () => {
  it("no node, no photos: the board keeps its built-in wall", () => {
    const cfg = normalizeTvBackgrounds(null);
    expect(cfg.photos).toEqual([]);
    expect(cfg.rotateSeconds).toBe(DEFAULT_ROTATE_SECONDS);
    expect(pickTvBackground(cfg, 0)).toBeNull();
  });

  it("orders photos by upload and drops entries with no url", () => {
    expect(normalizeTvBackgrounds(node()).photos.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("default mode holds the chosen photo; a removed default falls back to the first", () => {
    expect(pickTvBackground(normalizeTvBackgrounds(node({ defaultId: "b" })), 123).id).toBe("b");
    expect(pickTvBackground(normalizeTvBackgrounds(node({ defaultId: "gone" })), 123).id).toBe("a");
  });

  it("rotate mode walks every photo in upload order on the timer, the same slot on every TV", () => {
    const cfg = normalizeTvBackgrounds(node({ mode: "rotate", rotateSeconds: 60, defaultId: "c" }));
    const at = (min) => pickTvBackground(cfg, min * 60000 + 1).id;
    expect([at(0), at(1), at(2), at(3)]).toEqual(["a", "b", "c", "a"]);
  });

  it("rotate with one photo just shows it; the timer has a floor", () => {
    const one = normalizeTvBackgrounds({ mode: "rotate", rotateSeconds: 1, photos: { a: { url: "u", addedAt: 1 } } });
    expect(one.rotateSeconds).toBe(MIN_ROTATE_SECONDS);
    expect(pickTvBackground(one, 999999).id).toBe("a");
  });
});

// ── Days of the week ─────────────────────────────────────────────────────────
import {
  johannesburgDay, photosForDay, toggleDay, normalizeDays, photoShowsOn,
} from "./tvBackgrounds";
import * as contract from "./tvBackgrounds";

// 2026-10-19 is a Monday. SAST = UTC+2.
const MON_SAST_0000 = Date.UTC(2026, 9, 18, 22, 0, 0); // Sun 22:00 UTC = Mon 00:00 SAST
const ids = (list) => list.map((p) => p.id);

describe("TV backgrounds — days", () => {
  const cfgOf = (photos, extra) => normalizeTvBackgrounds({ photos, ...extra });
  const photos = {
    every1: { url: "u1", addedAt: 1 },
    every2: { url: "u2", addedAt: 2, days: [] },
    sat:    { url: "u3", addedAt: 3, days: [6] },
    monWed: { url: "u4", addedAt: 4, days: [1, 3] },
    off:    { url: "u5", addedAt: 5, days: [1], enabled: false },
  };

  it("the day boundary is Johannesburg midnight, not UTC and not the TV's own zone", () => {
    expect(johannesburgDay(MON_SAST_0000 - 1)).toBe(0);      // Sun 23:59:59.999 SAST
    expect(johannesburgDay(MON_SAST_0000)).toBe(1);          // Mon 00:00 SAST (still Sunday in UTC)
    expect(new Date(MON_SAST_0000).getUTCDay()).toBe(0);
  });

  it("a day with tagged photos shows only those; every-day photos rest", () => {
    const cfg = cfgOf(photos);
    expect(ids(photosForDay(cfg, 1))).toEqual(["monWed"]);   // the switched-off Monday photo never shows
    expect(ids(photosForDay(cfg, 6))).toEqual(["sat"]);
  });

  it("a day with nothing tagged falls back to the every-day pool (absent or empty days)", () => {
    expect(ids(photosForDay(cfgOf(photos), 2))).toEqual(["every1", "every2"]);
  });

  it("pickTvBackground follows today's pool on the Johannesburg day", () => {
    const cfg = cfgOf(photos, { defaultId: "every1" });
    expect(pickTvBackground(cfg, MON_SAST_0000 - 1).id).toBe("every1"); // Sunday: default is in the pool
    expect(pickTvBackground(cfg, MON_SAST_0000).id).toBe("monWed");     // Monday: default not in the pool → its first
    const rot = cfgOf(photos, { mode: "rotate", rotateSeconds: 60 });
    const tue = MON_SAST_0000 + 86400000;
    const seen = new Set([0, 1, 2, 3].map((m) => pickTvBackground(rot, tue + m * 60000).id));
    expect([...seen].sort()).toEqual(["every1", "every2"]);
  });

  it("only day-tagged photos and none for today → the built-in wall", () => {
    const cfg = cfgOf({ sat: { url: "u", addedAt: 1, days: [6] } });
    expect(pickTvBackground(cfg, MON_SAST_0000)).toBeNull();
  });

  it("Workshop order wins over upload time", () => {
    const cfg = cfgOf({ a: { url: "a", addedAt: 1, order: 30 }, b: { url: "b", addedAt: 2, order: 10 }, c: { url: "c", addedAt: 3 } });
    expect(ids(cfg.photos)).toEqual(["c", "b", "a"]); // c has no order → its upload time (3)
  });

  it("days normalise from RTDB's array or object form, 0–6 only", () => {
    expect(normalizeDays([3, 1, 1, 9, -1, "2"])).toEqual([1, 2, 3]);
    expect(normalizeDays({ 0: 5, 1: 0 })).toEqual([0, 5]);
    expect(normalizeDays(undefined)).toEqual([]);
    expect(photoShowsOn({ days: [] }, 4)).toBe(true);
  });

  it("toggling: all on is written as null (every day), the last day can't be switched off", () => {
    expect(toggleDay([], 1)).toEqual([0, 2, 3, 4, 5, 6]);
    expect(toggleDay([0, 2, 3, 4, 5, 6], 1)).toBeNull();
    expect(toggleDay([3], 3)).toBeUndefined();
    expect(toggleDay([3], 5)).toEqual([3, 5]);
  });

  it("there is no photo cap any more", () => {
    expect("MAX_TV_BACKGROUNDS" in contract).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, { url: `u${i}`, addedAt: i }]));
    expect(normalizeTvBackgrounds({ photos: many }).photos).toHaveLength(60);
  });
});

describe("TV backgrounds — guards", () => {
  it("a data: URL (image bytes in the database) is never drawn", () => {
    const cfg = normalizeTvBackgrounds({ photos: { bad: { url: "data:image/jpeg;base64,AAAA", addedAt: 1 }, ok: { url: "https://x", addedAt: 2 } } });
    expect(cfg.photos.map((p) => p.id)).toEqual(["ok"]);
  });
});
