// ── TIKTOK QUEUE — tests for the pure parts (tiktokQueue.mjs) ───────────────
import { describe, it, expect } from "vitest";
import {
  buildQueue, pickNext, classifyPost, eligible, counts, captionParts, cutWords, tiktokText, familyKey, slotGap,
  MAX_ATTEMPTS, GAP_MIN_MS, GAP_MAX_MS, PHOTO_TITLE_MAX, VIDEO_CAPTION_MAX,
} from "./tiktokQueue.mjs";

const ok = { instagram: { state: "ok" } };
const img = (u) => ({ type: "image", url: `https://x/${u}.jpg` });
const vid = (u) => ({ type: "video", url: `https://x/${u}.mp4` });

describe("buildQueue", () => {
  it("takes only posts that really went out on Instagram or Facebook", () => {
    const q = buildQueue([
      { id: "a", status: "posted", results: ok, media: [img("a")], postedAt: 1 },
      { id: "b", status: "failed", results: ok, media: [img("b")], postedAt: 2 },
      { id: "c", status: "posted", results: { instagram: { state: "failed" } }, media: [img("c")], postedAt: 3 },
      { id: "d", status: "posted", results: { facebook: { state: "ok" } }, media: [img("d")], postedAt: 4 },
      { id: "e", status: "sample", results: ok, media: [img("e")], postedAt: 5 },
    ]);
    expect(q.map((c) => c.key)).toEqual(["a", "d"]);
  });

  it("posts a story and its feed twin once, as the 9:16 story render", () => {
    const q = buildQueue([
      { id: "s1", format: "story", status: "posted", results: ok, media: [img("s1")], artwork: { story: { url: "https://x/s1-916.jpg" } }, postedAt: 10 },
      { id: "f1", format: "feed", twinOf: "s1", status: "posted", results: ok, media: [img("f1")], caption: "Feed caption #Nike", postedAt: 11 },
    ]);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ key: "s1", media: "PHOTO", urls: ["https://x/s1-916.jpg"], caption: "Feed caption #Nike" });
  });

  it("a reel and its story twin are one VIDEO post", () => {
    const q = buildQueue([
      { id: "r1", format: "reel", status: "posted", results: ok, media: [vid("r1")], caption: "Reel", postedAt: 5 },
      { id: "t1", format: "story", videoFrom: "r1", status: "posted", results: ok, media: [vid("r1")], postedAt: 6 },
    ]);
    expect(q).toEqual([expect.objectContaining({ key: "r1", media: "VIDEO", urls: ["https://x/r1.mp4"] })]);
  });

  it("oldest first; AI flag off only for new arrivals", () => {
    const q = buildQueue([
      { id: "n", status: "posted", results: ok, media: [img("n")], postedAt: 9, kind: "new_arrivals" },
      { id: "o", status: "posted", results: ok, media: [img("o")], postedAt: 2, kind: "outfit" },
    ]);
    expect(q.map((c) => [c.key, c.isAigc])).toEqual([["o", true], ["n", false]]);
  });

  it("family key: videoFrom, then twinOf, then own id", () => {
    expect(familyKey({ id: "x", twinOf: "y", videoFrom: "z" })).toBe("z");
    expect(familyKey({ id: "x", twinOf: "y" })).toBe("y");
    expect(familyKey({ id: "x" })).toBe("x");
  });
});

describe("pickNext / eligible / counts", () => {
  const q = [
    { key: "p1", media: "PHOTO" }, { key: "p2", media: "PHOTO" }, { key: "v1", media: "VIDEO" },
  ];
  it("never repeats anything that reached TikTok or may have", () => {
    for (const state of ["sending", "sent", "live", "failed"]) expect(eligible({ state })).toBe(false);
    expect(eligible({ state: "refused", attempts: 1 })).toBe(true);
    expect(eligible({ state: "refused", attempts: MAX_ATTEMPTS })).toBe(false);
    expect(pickNext(q, { families: { p1: { state: "live" } } }, null).key).toBe("p2");
  });
  it("alternates photo and video while both remain", () => {
    expect(pickNext(q, { families: {} }, "PHOTO").key).toBe("v1");
    expect(pickNext(q, { families: {} }, "VIDEO").key).toBe("p1");
    expect(pickNext(q, { families: { v1: { state: "live" } } }, "PHOTO").key).toBe("p1");
    expect(pickNext(q, { families: { p1: { state: "live" }, p2: { state: "live" }, v1: { state: "live" } } }, null)).toBe(null);
  });
  it("counts", () => {
    expect(counts(q, { families: { p1: { state: "live" }, v1: { state: "sent" } } })).toMatchObject({ total: 3, photos: 2, videos: 1, posted: 1, pending: 1, waiting: 1 });
  });
});

describe("captions", () => {
  const ig = "The Adidas Predator Elite FG is built for players who demand precision.\n\nOrder yours online.\n\n#AdidasPredator #PredatorElite #SoccerBoots #Adidas #MarathonClub #SneakerSA";
  it("strips the IG hashtags and adds 3 to 5 relevant ones", () => {
    const { body, tags } = captionParts(ig, "single");
    expect(body).toBe("The Adidas Predator Elite FG is built for players who demand precision.\n\nOrder yours online.");
    expect(tags).toEqual(["#AdidasPredator", "#PredatorElite", "#MarathonClub", "#SneakerTok", "#SouthAfrica"]);
    expect(captionParts("No tags here", "outfit").tags).toEqual(["#MarathonClub", "#OOTD", "#SouthAfrica"]);
  });
  it("photo: title within 90, description with tags; video: one caption within 2200", () => {
    const p = tiktokText({ media: "PHOTO", caption: ig, kind: "single" });
    expect(p.title).toBe("The Adidas Predator Elite FG is built for players who demand precision.");
    expect(p.title.length).toBeLessThanOrEqual(PHOTO_TITLE_MAX);
    expect(p.description.endsWith("#SouthAfrica")).toBe(true);
    const long = "word ".repeat(1000);
    const v = tiktokText({ media: "VIDEO", caption: long, kind: "pairing" });
    expect(v.description.length).toBeLessThanOrEqual(VIDEO_CAPTION_MAX);
    expect(v.description).toMatch(/…\n\n#MarathonClub #SneakerTok #SouthAfrica$/);
  });
  it("cutWords never cuts mid-word", () => {
    expect(cutWords("alpha beta gamma delta", 12)).toBe("alpha beta…");
    expect(cutWords("short", 12)).toBe("short");
  });
});

it("slot gap stays inside 15 to 20 minutes", () => {
  expect(slotGap(() => 0)).toBe(GAP_MIN_MS);
  expect(slotGap(() => 0.9999)).toBeLessThan(GAP_MAX_MS);
});

describe("review fixes", () => {
  it("a feed twin of a reel's story twin is the reel's family", () => {
    const q = buildQueue([
      { id: "r", format: "reel", status: "posted", results: ok, media: [vid("r")], postedAt: 1 },
      { id: "s", format: "story", videoFrom: "r", twinOf: "r", status: "posted", results: ok, media: [vid("r")], postedAt: 2 },
      { id: "f", format: "feed", twinOf: "s", status: "posted", results: ok, media: [img("f")], postedAt: 3 },
    ]);
    expect(q.map((c) => c.key)).toEqual(["r"]);
  });
  it("hashtags dedupe case-insensitively and house tags match whole words only", () => {
    expect(captionParts("x #fypage #Nike #nike", "single").tags).toEqual(["#fypage", "#Nike", "#MarathonClub", "#SneakerTok", "#SouthAfrica"]);
  });
  it("never cuts an emoji in half", () => {
    const out = cutWords("a".repeat(8) + "\u{1F45F}\u{1F45F}", 10);
    expect(/[\uD800-\uDBFF]…$/.test(out)).toBe(false);
  });
  it("skip set keeps a refused family out of the rest of the run", () => {
    const q = [{ key: "a", media: "PHOTO" }, { key: "b", media: "PHOTO" }];
    expect(pickNext(q, { families: { a: { state: "refused", attempts: 1 } } }, null, new Set(["a"])).key).toBe("b");
  });
  it("classifies Signal Studio replies", () => {
    expect(classifyPost(200, { publishId: "p" })).toMatchObject({ state: "sent" });
    expect(classifyPost(502, { kind: "unknown" })).toMatchObject({ state: "failed", abort: false });
    expect(classifyPost(502, { kind: "wait" })).toMatchObject({ state: null, abort: true, attempt: false });
    expect(classifyPost(502, { kind: "limit" })).toMatchObject({ state: null, abort: true });
    expect(classifyPost(502, { kind: "permanent" })).toMatchObject({ state: "refused", attempt: true, abort: false });
    expect(classifyPost(409, { error: "TikTok is not connected yet" })).toMatchObject({ state: null, abort: true });
    expect(classifyPost(409, { error: "file x was already sent to TikTok" })).toMatchObject({ state: "failed" });
    expect(classifyPost(400, { error: "bad" })).toMatchObject({ state: "refused", attempt: true });
    expect(classifyPost(500, {})).toMatchObject({ state: "failed", abort: true });
    expect(classifyPost(0, {})).toMatchObject({ state: "failed", abort: true });
  });
});
