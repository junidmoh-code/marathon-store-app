// Tests for the shared AI Studio regenerator core. The interesting cases are
// the ones where getting it wrong costs money or puts a brand word on the
// storefront, so those are the ones pinned hardest.
import { describe, it, expect } from "vitest";
import {
  PHOTO_PRESETS, PHOTO_ENGINES, FIX_PRESETS, NOTE_MAX, STYLE_HOUSE, STYLE_WHITE,
  toggleFix, sanitiseNote, buildGenerateRequest, readGenerateResult,
  costByEngineStr, photoFailureSuffix,
} from "./aiStudioCore";
import { triggersInText } from "../../utils/shopifyTriggers";

describe("the presets", () => {
  it("offers exactly the two the function understands, in Junid's words", () => {
    expect(PHOTO_PRESETS.map((p) => p.key)).toEqual([STYLE_WHITE, STYLE_HOUSE]);
    expect(PHOTO_PRESETS.map((p) => p.label)).toEqual(["Normal", "House"]);
  });

  it("carries the function's own per-image cost, not a guess", () => {
    // GEMINI_FLAT_IMAGE_USD and NBPRO_FLAT_IMAGE_USD in functions/index.js.
    expect(PHOTO_PRESETS.find((p) => p.key === STYLE_WHITE).costUSD).toBe(0.067);
    expect(PHOTO_PRESETS.find((p) => p.key === STYLE_HOUSE).costUSD).toBe(0.134);
  });

  it("keeps 'auto' first among the engines — it is the default", () => {
    expect(PHOTO_ENGINES[0][0]).toBe("auto");
  });
});

describe("the fix chips", () => {
  it("adds, combines and removes without disturbing free text", () => {
    const [, a] = FIX_PRESETS[0];
    const [, b] = FIX_PRESETS[2];
    let note = "keep the sole cream";
    note = toggleFix(note, a);
    expect(note).toBe(`keep the sole cream; ${a}`);
    note = toggleFix(note, b);
    expect(note).toContain(a);
    expect(note).toContain(b);
    note = toggleFix(note, a);
    expect(note).not.toContain(a);
    expect(note).toContain(b);
    expect(note).toContain("keep the sole cream");
  });

  it("never leaves a dangling or doubled separator", () => {
    const [, a] = FIX_PRESETS[1];
    expect(toggleFix(toggleFix("", a), a)).toBe("");
    const two = toggleFix(toggleFix("", FIX_PRESETS[3][1]), FIX_PRESETS[4][1]);
    const back = toggleFix(two, FIX_PRESETS[3][1]);
    expect(back.startsWith(";")).toBe(false);
    expect(back.endsWith(";")).toBe(false);
    expect(back).not.toMatch(/;\s*;/);
  });
});

describe("sanitiseNote — what the box shows is what the model gets", () => {
  it("matches the server's own cleaning: control chars out, whitespace collapsed", () => {
    expect(sanitiseNote("laces\t\ttucked\n\nin")).toBe("laces tucked in");
    expect(sanitiseNote("  padded  ")).toBe("padded");
  });

  it("keeps accented and non-Latin text the server keeps", () => {
    expect(sanitiseNote("café crème")).toBe("café crème");
  });

  it("caps at the server's limit rather than silently losing the tail later", () => {
    expect(sanitiseNote("x".repeat(500))).toHaveLength(NOTE_MAX);
  });

  it("survives null and undefined", () => {
    expect(sanitiseNote(null)).toBe("");
    expect(sanitiseNote(undefined)).toBe("");
  });
});

describe("buildGenerateRequest", () => {
  it("refuses to build a request with no product", () => {
    expect(() => buildGenerateRequest({ productId: "" })).toThrow(/productId/);
  });

  it("always names ONE product and always reprocesses", () => {
    const r = buildGenerateRequest({ productId: "p1" });
    expect(r.productIds).toEqual(["p1"]);
    expect(r.reprocess).toBe(true);
  });

  it("omits `style` for normal and sets it for house", () => {
    expect(buildGenerateRequest({ productId: "p1" }).style).toBeUndefined();
    expect(buildGenerateRequest({ productId: "p1", style: STYLE_HOUSE }).style).toBe("house");
  });

  it("sends an engine only when one was really chosen", () => {
    expect(buildGenerateRequest({ productId: "p1", engine: "auto" }).engine).toBeUndefined();
    expect(buildGenerateRequest({ productId: "p1", engine: "nonsense" }).engine).toBeUndefined();
    expect(buildGenerateRequest({ productId: "p1", engine: "gemini" }).engine).toBe("gemini");
  });

  it("never sends an engine with house — the function forces Nano Banana Pro anyway", () => {
    const r = buildGenerateRequest({ productId: "p1", style: STYLE_HOUSE, engine: "openai" });
    expect(r.engine).toBeUndefined();
    expect(r.style).toBe("house");
  });

  it("omits an empty note instead of sending an empty string", () => {
    expect(buildGenerateRequest({ productId: "p1", note: "   " }).note).toBeUndefined();
  });

  it("sends sourceUrl only when given — AI Studio's calls stay byte-identical", () => {
    expect(buildGenerateRequest({ productId: "p1" }).sourceUrl).toBeUndefined();
    expect(buildGenerateRequest({ productId: "p1", sourceUrl: "https://x/y.jpg" }).sourceUrl).toBe("https://x/y.jpg");
  });
});

describe("the free text cannot reach Shopify", () => {
  // The fields that DO travel to Shopify are the alt text (the cleaned listing
  // name) and the file name (a generated id). The note is neither. This test
  // exists so that a future change which starts routing the note into a
  // pushed field fails here rather than on the storefront.
  it("puts a brand word from the note nowhere except `note`", () => {
    const brandy = "make it look like the Nike Air Force 1 hero shot";
    expect(triggersInText(brandy).length).toBeGreaterThan(0); // the note really is dirty
    const req = buildGenerateRequest({ productId: "p1", note: brandy, sourceUrl: "https://x/y.jpg" });
    const dirtyKeys = Object.entries(req)
      .filter(([, v]) => typeof v === "string" && triggersInText(v).length > 0)
      .map(([k]) => k);
    expect(dirtyKeys).toEqual(["note"]);
  });

  it("keeps the note out of every field a media plan is built from", () => {
    const req = buildGenerateRequest({ productId: "p1", note: "adidas please" });
    // buildMediaPlan (scripts/shopify/media.mjs) reads only URLs and the clean
    // title. Nothing in this request is either.
    expect(req.productIds).toEqual(["p1"]);
    expect(Object.keys(req)).not.toContain("alt");
    expect(Object.keys(req)).not.toContain("title");
    expect(Object.keys(req)).not.toContain("filename");
  });
});

describe("readGenerateResult", () => {
  it("returns the image when the run made one for THIS product", () => {
    const out = readGenerateResult({
      processed: 1, estCostUSD: 0.067, costByEngine: { gemini: 0.067 },
      sample: [{ id: "p1", proposedUrl: "https://s/gen.jpg", engine: "gemini" }],
    }, "p1");
    expect(out).toMatchObject({ ok: true, proposedUrl: "https://s/gen.jpg", engine: "gemini", costUSD: 0.067 });
  });

  it("does not hand back another product's image", () => {
    const out = readGenerateResult({
      processed: 1, sample: [{ id: "pOTHER", proposedUrl: "https://s/other.jpg" }],
    }, "p1");
    expect(out.ok).toBe(false);
  });

  it("surfaces the function's OWN reason when nothing was generated", () => {
    const out = readGenerateResult({
      processed: 0, failed: 1, sample: [],
      failures: [{ id: "p1", reason: "AI credits depleted or rate-limited (429) — check Gemini billing" }],
    }, "p1");
    expect(out.ok).toBe(false);
    expect(out.problem).toMatch(/credits depleted/);
  });

  it("still says something useful when an older build returned no failures array", () => {
    const out = readGenerateResult({ processed: 0, failed: 1 }, "p1");
    expect(out.ok).toBe(false);
    expect(out.problem).toMatch(/no reason/);
  });

  it("treats a processed count with no sample entry as a failure, not a blank image", () => {
    const out = readGenerateResult({ processed: 1, sample: [{ id: "p1" }] }, "p1");
    expect(out.ok).toBe(false);
  });

  it("survives a completely absent payload", () => {
    expect(readGenerateResult(undefined, "p1").ok).toBe(false);
  });
});

describe("the cost and failure lines", () => {
  it("names only the engines that actually spent", () => {
    expect(costByEngineStr({ gemini: 0.039, openai: 0, nbpro: 0 })).toBe(" · gemini $0.0390");
    expect(costByEngineStr({ gemini: 0, openai: 0 })).toBe("");
    expect(costByEngineStr(null)).toBe("");
  });

  it("groups identical failure reasons with a count, commonest first", () => {
    const s = photoFailureSuffix([
      { reason: "AI returned no image" },
      { reason: "No sneaker Style Kit references" },
      { reason: "AI returned no image" },
    ]);
    expect(s).toBe(" — why: AI returned no image ×2; No sneaker Style Kit references ×1");
  });

  it("is empty when there is nothing to explain", () => {
    expect(photoFailureSuffix([])).toBe("");
    expect(photoFailureSuffix(undefined)).toBe("");
  });
});
