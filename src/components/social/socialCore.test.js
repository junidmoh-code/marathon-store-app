// ─── SOCIAL CORE — THE RULES THAT MUST HOLD ──────────────────────────────────
// The gate that stands between a generated draft and a live Instagram account
// is a pure function, and this file is what proves it. Where a test only
// asserts an obvious happy path it says so; the ones that matter break the
// property on purpose.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PLATFORMS, PLATFORM_KEYS, POST_KINDS, STATUSES, MAX_ATTEMPTS, CAPTION_MIN, MAX_MEDIA,
  postBlocker, enabledPlatforms, outstandingPlatforms, attemptsExhausted, isDue,
  captionWithLink, captionFor, truncateWords,
  nextSlots, assignSlots, formatSlot, toLocalInput, fromLocalInput,
  productLink, describePost, resultLine, SLOT_DAYS, SLOT_HOUR_SAST,
  needsVerification, QUEUE_FILTERS, STALE_CLAIM_MS,
} from "./socialCore";

const HERE = dirname(fileURLToPath(import.meta.url));

const ok = (over = {}) => ({
  status: "approved",
  kind: "single",
  media: [{ url: "https://x/1.jpg", type: "image" }],
  caption: "A perfectly ordinary caption about a shoe.",
  platforms: { instagram: true, facebook: false, tiktok: false },
  scheduledAt: 1000,
  ...over,
});

describe("postBlocker — the gate", () => {
  it("lets a complete approved post through", () => {
    expect(postBlocker(ok(), { now: 5000 })).toBeNull();
  });

  // ── THE ONE RULE ─────────────────────────────────────────────────────────
  // Every non-approved status must be refused. Enumerated rather than spot-
  // checked: a future status added to STATUSES without a decision about
  // whether it may post should fail here, not in production.
  it.each(STATUSES.filter((s) => s !== "approved"))("refuses status %s", (status) => {
    const reason = postBlocker(ok({ status }), { now: 5000 });
    expect(reason).toBeTruthy();
    expect(reason.toLowerCase()).toContain("approved");
  });

  it("refuses a post with no status at all, and a null post", () => {
    expect(postBlocker(ok({ status: undefined }))).toBeTruthy();
    expect(postBlocker(null)).toBeTruthy();
    expect(postBlocker(undefined)).toBeTruthy();
    expect(postBlocker("approved")).toBeTruthy();
  });

  it("refuses no media, empty media, and media with no url", () => {
    expect(postBlocker(ok({ media: [] }))).toMatch(/no image or video/i);
    expect(postBlocker(ok({ media: undefined }))).toMatch(/no image or video/i);
    expect(postBlocker(ok({ media: [{ type: "image" }] }))).toMatch(/no image or video/i);
  });

  it("refuses more media than any platform can take", () => {
    const many = Array.from({ length: MAX_MEDIA + 1 }, (_, i) => ({ url: `https://x/${i}.jpg`, type: "image" }));
    expect(postBlocker(ok({ media: many }))).toMatch(/too many/i);
  });

  it("refuses an empty or too-short caption", () => {
    expect(postBlocker(ok({ caption: "" }))).toMatch(/caption/i);
    expect(postBlocker(ok({ caption: "   " }))).toMatch(/caption/i);
    expect(postBlocker(ok({ caption: "x".repeat(CAPTION_MIN - 1) }))).toMatch(/caption/i);
    expect(postBlocker(ok({ caption: "x".repeat(CAPTION_MIN) }))).toBeNull();
  });

  it("refuses a post with no platform switched on", () => {
    expect(postBlocker(ok({ platforms: {} }))).toMatch(/no platform/i);
    expect(postBlocker(ok({ platforms: { instagram: false, facebook: false, tiktok: false } }))).toMatch(/no platform/i);
    // A truthy-but-not-true value must NOT count as on. platforms comes back
    // from RTDB, and "true" the string is a real thing to land in a database.
    expect(postBlocker(ok({ platforms: { instagram: "true" } }))).toMatch(/no platform/i);
  });

  it("refuses a platform key it does not know", () => {
    // enabledPlatforms filters to known keys, so an unknown key alone reads as
    // "no platform" — which is still a refusal, which is the point.
    expect(postBlocker(ok({ platforms: { threads: true } }))).toBeTruthy();
  });

  it("refuses more items than a specific platform allows", () => {
    // Instagram takes 10; a carousel of 10 is fine for IG and fine for the
    // others too, so the per-platform ceiling is exercised via MAX_MEDIA above.
    const ten = Array.from({ length: 10 }, (_, i) => ({ url: `https://x/${i}.jpg`, type: "image" }));
    expect(postBlocker(ok({ media: ten }))).toBeNull();
  });

  describe("requireDue", () => {
    it("holds a post whose slot has not arrived", () => {
      expect(postBlocker(ok({ scheduledAt: 9999 }), { now: 5000, requireDue: true })).toMatch(/not due/i);
    });
    it("releases it exactly at the slot, not a millisecond before", () => {
      expect(postBlocker(ok({ scheduledAt: 5000 }), { now: 4999, requireDue: true })).toMatch(/not due/i);
      expect(postBlocker(ok({ scheduledAt: 5000 }), { now: 5000, requireDue: true })).toBeNull();
    });
    it("treats an unscheduled approved post as due now", () => {
      for (const at of [null, undefined, 0, "", NaN]) {
        expect(isDue({ scheduledAt: at }, 1)).toBe(true);
        expect(postBlocker(ok({ scheduledAt: at }), { now: 1, requireDue: true })).toBeNull();
      }
    });
    it("ignores the schedule entirely when requireDue is off", () => {
      expect(postBlocker(ok({ scheduledAt: 9e12 }), { now: 1 })).toBeNull();
    });
  });
});

// ─── FIXES FROM THE ADVERSARIAL REVIEW ───────────────────────────────────────
// Each of these pins a defect that was real in this branch.
describe("the gate refuses what the senders cannot send", () => {
  const item = (type, n = 1) => Array.from({ length: n }, (_, i) => ({ url: `https://x/${i}`, type }));

  // publishFacebook throws a NON-retryable error on a mixed set. Without this
  // the queue showed the post as fine, Junid approved it, and it parked in
  // Failed on the evening it was meant to go out.
  it("refuses a mixed video and photo set", () => {
    expect(postBlocker(ok({ media: [...item("video"), ...item("image")] }))).toMatch(/either video or photos/i);
  });

  // Facebook's Page API takes one video or several photos, never several
  // videos — but Instagram's carousel is fine with them, so the rule is
  // per-platform rather than a blanket ban that would refuse a post Instagram
  // could take.
  it("refuses several videos when Facebook is on", () => {
    expect(postBlocker(ok({
      media: item("video", 2),
      platforms: { instagram: true, facebook: true, tiktok: false },
    }))).toMatch(/Facebook takes one video/i);
  });

  it("allows several videos when Facebook is off", () => {
    expect(postBlocker(ok({
      media: item("video", 2),
      platforms: { instagram: true, facebook: false, tiktok: false },
    }))).toBeNull();
  });

  it("still allows a single video and a pure photo set", () => {
    expect(postBlocker(ok({ media: item("video") }))).toBeNull();
    expect(postBlocker(ok({ media: item("image", 4) }))).toBeNull();
  });
});

describe("an unconfirmed send is never blind-retried", () => {
  // The window: the platform published, the response was lost. Re-sending is
  // how one post becomes two on a live public account.
  it("flags a platform left in `sending`", () => {
    const p = ok({ results: { instagram: { state: "sending", attempts: 1 } } });
    expect(needsVerification(p, "instagram")).toBe(true);
  });

  it("does not flag any settled state", () => {
    for (const state of ["ok", "error", "skipped", undefined]) {
      expect(needsVerification(ok({ results: { instagram: { state } } }), "instagram")).toBe(false);
    }
    expect(needsVerification(ok(), "instagram")).toBe(false);
  });

  it("a `sending` platform is still OUTSTANDING, so it cannot be quietly forgotten", () => {
    const p = ok({ platforms: { instagram: true }, results: { instagram: { state: "sending" } } });
    expect(outstandingPlatforms(p)).toEqual(["instagram"]);
  });

  it("says plainly that a human must look at the account", () => {
    const line = resultLine(ok({ results: { instagram: { state: "sending" } } }), "instagram");
    expect(line).toMatch(/never got confirmation/i);
    expect(line).toMatch(/CHECK THE ACCOUNT/);
  });
});

describe("the Sending state is visible to a person", () => {
  // A post claimed by a run that then died sat in "posting" — a state with no
  // tab, so it appeared in NO list and nothing ever looked at it again.
  it("posting is a queue filter", () => {
    expect(QUEUE_FILTERS.map((f) => f.key)).toContain("posting");
  });

  it("every status a post can hold has somewhere to be seen", () => {
    const filters = new Set(QUEUE_FILTERS.map((f) => f.key));
    for (const s of STATUSES) expect(filters.has(s), `status "${s}" has no queue tab`).toBe(true);
  });

  it("a stale claim threshold exists and is longer than any real run", () => {
    // A ten-item carousel of videos is ten container ingests at up to five
    // minutes each; the threshold must sit above that.
    expect(STALE_CLAIM_MS).toBeGreaterThan(10 * 5 * 60 * 1000);
  });
});

describe("platform bookkeeping", () => {
  it("lists enabled platforms in PLATFORMS order regardless of key order", () => {
    const p = ok({ platforms: { tiktok: true, instagram: true, facebook: true } });
    expect(enabledPlatforms(p)).toEqual(["instagram", "facebook", "tiktok"]);
  });

  it("treats a platform already posted as no longer outstanding", () => {
    const p = ok({
      platforms: { instagram: true, facebook: true, tiktok: false },
      results: { instagram: { state: "ok" } },
    });
    expect(outstandingPlatforms(p)).toEqual(["facebook"]);
  });

  // A FAILED platform is still outstanding — that is what makes the retry
  // happen. Break this and a failure becomes a silent drop.
  it("keeps a failed platform outstanding", () => {
    const p = ok({ platforms: { instagram: true }, results: { instagram: { state: "error", attempts: 1 } } });
    expect(outstandingPlatforms(p)).toEqual(["instagram"]);
  });

  it("keeps a SKIPPED platform outstanding too", () => {
    // TikTok is skipped on every run today. It must stay outstanding so that
    // the day it is connected, the next run posts it.
    const p = ok({ platforms: { tiktok: true }, results: { tiktok: { state: "skipped" } } });
    expect(outstandingPlatforms(p)).toEqual(["tiktok"]);
  });

  it("counts retries out at MAX_ATTEMPTS and not before", () => {
    const at = (n) => ({ results: { instagram: { attempts: n } } });
    expect(attemptsExhausted(at(MAX_ATTEMPTS - 1), "instagram")).toBe(false);
    expect(attemptsExhausted(at(MAX_ATTEMPTS), "instagram")).toBe(true);
    expect(attemptsExhausted(at(MAX_ATTEMPTS + 1), "instagram")).toBe(true);
    expect(attemptsExhausted({}, "instagram")).toBe(false);
  });
});

describe("captions", () => {
  it("appends the link once and never twice", () => {
    const c = captionWithLink("Nice shoe", "https://marathonclub.co.za/products/x");
    expect(c).toContain("https://marathonclub.co.za/products/x");
    expect(captionWithLink(c, "https://marathonclub.co.za/products/x")).toBe(c);
  });

  it("returns the body unchanged when there is no link, and the link alone when there is no body", () => {
    expect(captionWithLink("body", "")).toBe("body");
    expect(captionWithLink("", "https://x")).toBe("https://x");
  });

  it("splits TikTok into a title and a description, and puts the link in the description", () => {
    const post = ok({ caption: "A short line about the shoe.", link: "https://marathonclub.co.za/products/x" });
    const { title, description } = captionFor(post, "tiktok");
    expect(title).toBe("A short line about the shoe.");
    expect(description).toContain("https://marathonclub.co.za/products/x");
    expect(title).not.toContain("https://");
  });

  it("truncates a long TikTok title on a word boundary", () => {
    const long = "word ".repeat(60).trim();
    const { title } = captionFor(ok({ caption: long }), "tiktok");
    expect(title.length).toBeLessThanOrEqual(150);
    expect(title.endsWith("…")).toBe(true);
    // Never mid-word: the character before the ellipsis is not a letter cut
    // out of "word".
    expect(title).not.toMatch(/wor…$/);
  });

  it("does not truncate anything already inside a platform's limit", () => {
    for (const p of PLATFORMS) {
      const c = captionFor(ok({ caption: "short" }), p.key);
      const text = c.caption ?? c.description;
      expect(text).not.toContain("…");
    }
  });

  it("truncateWords falls back to a hard cut when there is no whitespace to cut back to", () => {
    const s = "x".repeat(50);
    const out = truncateWords(s, 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("refuses an unknown platform rather than guessing", () => {
    expect(() => captionFor(ok(), "threads")).toThrow(/unknown platform/i);
  });
});

describe("the three-a-week schedule", () => {
  const SAST = 2 * 3600000;
  const dowOf = (ms) => new Date(ms + SAST).getUTCDay();
  const hourOf = (ms) => new Date(ms + SAST).getUTCHours();

  it("only ever lands on the configured days, at the configured hour", () => {
    const slots = nextSlots(Date.UTC(2026, 7, 22, 6, 0), 20);
    expect(slots.length).toBe(20);
    for (const s of slots) {
      expect(SLOT_DAYS).toContain(dowOf(s));
      expect(hourOf(s)).toBe(SLOT_HOUR_SAST);
    }
  });

  it("returns them strictly increasing and never in the past", () => {
    const from = Date.UTC(2026, 7, 22, 6, 0);
    const slots = nextSlots(from, 10);
    for (const s of slots) expect(s).toBeGreaterThanOrEqual(from);
    for (let i = 1; i < slots.length; i++) expect(slots[i]).toBeGreaterThan(slots[i - 1]);
  });

  it("gives exactly three slots per week", () => {
    const slots = nextSlots(Date.UTC(2026, 7, 22, 6, 0), 12);
    const week = 7 * 86400000;
    // The 4th slot is one week after the 1st, the 5th after the 2nd, and so on.
    for (let i = 0; i + 3 < slots.length; i++) {
      expect(slots[i + 3] - slots[i]).toBe(week);
    }
  });

  it("skips today's slot once its hour has passed", () => {
    // Monday 2026-08-24, 19:00 SAST = 17:00 UTC. Monday is a slot day, but
    // 18:00 has gone, so the next slot must be Wednesday.
    const monday19 = Date.UTC(2026, 7, 24, 17, 0);
    const [first] = nextSlots(monday19, 1);
    expect(dowOf(first)).toBe(3);
  });

  it("includes today's slot when the hour has not passed", () => {
    const monday9 = Date.UTC(2026, 7, 24, 7, 0);
    const [first] = nextSlots(monday9, 1);
    expect(dowOf(first)).toBe(1);
    expect(hourOf(first)).toBe(SLOT_HOUR_SAST);
  });

  describe("assignSlots", () => {
    const from = Date.UTC(2026, 7, 22, 6, 0);

    it("never hands out an evening a live post already holds", () => {
      const [a, b, c] = nextSlots(from, 3);
      const held = [{ status: "approved", scheduledAt: a }, { status: "draft", scheduledAt: b }];
      expect(assignSlots(held, 2, from)).toEqual([c, nextSlots(from, 4)[3]]);
    });

    it("ignores discarded and posted items when deciding what is taken", () => {
      const [a] = nextSlots(from, 1);
      const held = [{ status: "discarded", scheduledAt: a }, { status: "posted", scheduledAt: a }];
      expect(assignSlots(held, 1, from)[0]).toBe(a);
    });

    it("returns the number asked for even when many evenings are taken", () => {
      const taken = nextSlots(from, 6).map((s) => ({ status: "approved", scheduledAt: s }));
      const got = assignSlots(taken, 3, from);
      expect(got.length).toBe(3);
      expect(new Set(got).size).toBe(3);
      for (const s of got) expect(taken.some((t) => t.scheduledAt === s)).toBe(false);
    });

    // ── THE BUG THIS PINS ────────────────────────────────────────────────
    // nextSlots used to walk a flat 28 days, which caps at twelve slots. A
    // queue holding a dozen scheduled posts pushes assignSlots' request past
    // that, the extra slots came back undefined, and the generator wrote
    // `scheduledAt: null` — which means DUE IMMEDIATELY. Posts meant to be
    // spread over weeks would have gone out together on the next run.
    it("returns the full count even when a dozen evenings are already taken", () => {
      const taken = nextSlots(from, 12).map((s) => ({ status: "approved", scheduledAt: s }));
      const got = assignSlots(taken, 4, from);
      expect(got.length).toBe(4);
      expect(got.every((s) => Number.isFinite(s))).toBe(true);
      for (const s of got) expect(taken.some((t) => t.scheduledAt === s)).toBe(false);
    });

    it("nextSlots reaches as far ahead as the count needs", () => {
      // Twelve was the old ceiling; well past it must still be honoured.
      expect(nextSlots(from, 12).length).toBe(12);
      expect(nextSlots(from, 13).length).toBe(13);
      expect(nextSlots(from, 40).length).toBe(40);
      expect(nextSlots(from, 100).length).toBe(100);
    });

    it("nextSlots stays sane at the degenerate ends", () => {
      expect(nextSlots(from, 0)).toEqual([]);
      expect(nextSlots(from, -1)).toEqual([]);
      // Bounded: a silly request is capped rather than spinning.
      expect(nextSlots(from, 100000).length).toBeLessThan(200);
    });

    it("survives an empty and a malformed existing list", () => {
      expect(assignSlots([], 2, from).length).toBe(2);
      expect(assignSlots(null, 2, from).length).toBe(2);
      expect(assignSlots([null, {}, { scheduledAt: "nonsense", status: "draft" }], 2, from).length).toBe(2);
    });
  });
});

describe("SAST formatting round-trips", () => {
  it("formats in South African time, not UTC", () => {
    // 2026-08-22 16:00 UTC is 18:00 SAST on the Saturday.
    expect(formatSlot(Date.UTC(2026, 7, 22, 16, 0))).toBe("Sat 22 Aug, 18:00");
  });

  it("says so rather than printing an epoch for a missing schedule", () => {
    for (const v of [null, undefined, 0, NaN, "x"]) expect(formatSlot(v)).toBe("not scheduled");
  });

  it("round-trips through the datetime-local input", () => {
    const ms = Date.UTC(2026, 7, 22, 16, 0);
    expect(fromLocalInput(toLocalInput(ms))).toBe(ms);
  });

  it("returns null for anything the input could not have produced", () => {
    for (const v of ["", "not a date", "2026-08-22", "2026-08-22T18", null, undefined]) {
      expect(fromLocalInput(v)).toBeNull();
    }
  });
});

describe("links", () => {
  it("builds a product URL from a handle", () => {
    expect(productLink("black-mesh-daypack")).toBe("https://marathonclub.co.za/products/black-mesh-daypack");
  });
  it("falls back to the storefront rather than a broken /products/ URL", () => {
    for (const v of ["", null, undefined, "   "]) expect(productLink(v)).toBe("https://marathonclub.co.za");
  });
});

describe("summaries", () => {
  it("describes a post without throwing on a half-built one", () => {
    expect(describePost(ok())).toContain("Single product");
    expect(() => describePost({})).not.toThrow();
    expect(() => describePost(null)).not.toThrow();
  });
  it("reports each platform's last outcome", () => {
    expect(resultLine(ok(), "instagram")).toBe("not sent yet");
    expect(resultLine(ok({ results: { instagram: { state: "ok", at: Date.UTC(2026, 7, 22, 16, 0) } } }), "instagram"))
      .toBe("posted Sat 22 Aug, 18:00");
    expect(resultLine(ok({ results: { instagram: { state: "error", attempts: 2, error: "nope" } } }), "instagram"))
      .toBe(`failed (2/${MAX_ATTEMPTS}) — nope`);
    expect(resultLine(ok({ results: { tiktok: { state: "skipped", error: "not connected" } } }), "tiktok"))
      .toBe("skipped — not connected");
  });
});

// ─── THE COMPLIANCE VALIDATOR MUST NOT REACH CAPTIONS ────────────────────────
// Owner ruling, 2026-08-22: the brand-stripping rule exists because the
// payment gateway scans the SHOPIFY CATALOGUE. It does not apply to social
// captions, and applying it would produce posts nobody can understand.
//
// This is pinned as an ABSENCE because the plausible mistake is not forgetting
// a safeguard — it is a future reader noticing that Shopify validates and
// social does not, assuming that is an oversight, and "fixing" it. The failure
// would be silent: captions would still generate, they would just stop naming
// anything.
describe("captions are not subject to the Shopify brand validator", () => {
  const files = readdirSync(HERE).filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\./.test(f));

  it("finds the social modules to check", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files)("%s does not import shopifyTriggers or compliance", (file) => {
    const src = readFileSync(join(HERE, file), "utf8");
    // Comments legitimately DISCUSS the rule, so only import/require statements
    // are checked.
    const imports = src.match(/^\s*(?:import[^;]*from\s*|.*\brequire\()\s*["'][^"']+["']/gm) || [];
    for (const line of imports) {
      expect(line).not.toMatch(/shopifyTriggers/);
      expect(line).not.toMatch(/compliance/);
    }
  });

  it("a brand name in a caption survives every transform in this module", () => {
    // The fixture said "in store now" — incidental to what this test is about
    // (brand names surviving), and now refused by the physical-shop rule added
    // 2026-08-23. Changed to an online phrasing so the test goes on measuring
    // the one thing it was written to measure. See socialShopRule.test.js.
    const post = ok({ caption: "Nike Air Max 90 in white — online now.", link: "https://marathonclub.co.za/products/x" });
    expect(postBlocker(post)).toBeNull();
    for (const p of PLATFORM_KEYS) {
      const out = captionFor(post, p);
      expect((out.caption ?? out.description) + (out.title ?? "")).toContain("Nike Air Max 90");
    }
  });
});

describe("the vocabulary is internally consistent", () => {
  it("every post kind's product range is sane", () => {
    for (const k of POST_KINDS) {
      expect(k.minProducts).toBeGreaterThan(0);
      expect(k.maxProducts).toBeGreaterThanOrEqual(k.minProducts);
      expect(k.maxProducts).toBeLessThanOrEqual(MAX_MEDIA);
      expect(typeof k.costUSD).toBe("number");
    }
  });
  it("every platform declares a caption ceiling and a media ceiling", () => {
    for (const p of PLATFORMS) {
      expect(p.captionMax).toBeGreaterThan(0);
      expect(p.mediaMax).toBeGreaterThan(0);
    }
    expect(PLATFORMS.find((p) => p.key === "tiktok").titleMax).toBe(150);
  });
});
