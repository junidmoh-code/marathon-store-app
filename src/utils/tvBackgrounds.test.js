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
