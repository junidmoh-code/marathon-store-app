// Tests for the shared AI Studio regenerator core. The interesting cases are
// the ones where getting it wrong costs money or puts a brand word on the
// storefront, so those are the ones pinned hardest.
import { describe, it, expect } from "vitest";
import {
  PHOTO_PRESETS, PHOTO_ENGINES, FIX_PRESETS, NOTE_MAX, STYLE_HOUSE, STYLE_WHITE,
  toggleFix, fixFits, sanitiseNote, buildGenerateRequest, readGenerateResult,
  costByEngineStr, photoFailureSuffix, resolveEngine, priceLabelFor, gradeAdmitsWear,
} from "./aiStudioCore";
import { triggersInText } from "../../utils/shopifyTriggers";
import { CONDITIONS } from "./publishShared";

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

// ─── THE THINGS THE ADVERSARIAL REVIEW FOUND ─────────────────────────────────

describe("a fix chip is never truncated mid-instruction", () => {
  // The chips are 100-103 characters and NOTE_MAX is 240, so a third one lands
  // exactly on the cap. Slicing there cut "the colours are off or washed out —
  // restore the product's true… colours exactly" in half, leaving a paid prompt
  // that TELLS the model the colours are wrong and never says to fix them.
  it("adds nothing rather than adding half a sentence", () => {
    let note = "";
    for (const [, instr] of FIX_PRESETS) note = toggleFix(note, instr);
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    for (const part of note.split("; ")) {
      expect(FIX_PRESETS.some(([, instr]) => instr === part)).toBe(true);
    }
  });

  it("a chip that does not fit leaves the note exactly as it was", () => {
    const two = toggleFix(toggleFix("", FIX_PRESETS[0][1]), FIX_PRESETS[1][1]);
    expect(toggleFix(two, FIX_PRESETS[2][1])).toBe(two);
  });

  it("fixFits tells a UI which chips it can honestly offer", () => {
    expect(fixFits("", FIX_PRESETS[0][1])).toBe(true);
    const two = toggleFix(toggleFix("", FIX_PRESETS[0][1]), FIX_PRESETS[1][1]);
    expect(fixFits(two, FIX_PRESETS[2][1])).toBe(false);
    expect(fixFits(two, FIX_PRESETS[0][1])).toBe(true);   // already on — untapping always fits
  });
});

describe("the price on the button belongs to the engine that will be billed", () => {
  it("mirrors defaultEngineFor: footwear and clothing go to Gemini, the rest to OpenAI", () => {
    expect(resolveEngine({ product: { category: "Footwear" } })).toBe("gemini");
    expect(resolveEngine({ product: { category: "Clothing" } })).toBe("gemini");
    expect(resolveEngine({ product: { category: "Perfume" } })).toBe("openai");
    expect(resolveEngine({ product: null })).toBe("openai");
  });

  it("house always resolves to Nano Banana Pro, whatever engine is asked for", () => {
    expect(resolveEngine({ style: STYLE_HOUSE, engine: "openai" })).toBe("nbpro");
  });

  it("an explicit engine wins over the routing", () => {
    expect(resolveEngine({ engine: "openai", product: { category: "Footwear" } })).toBe("openai");
  });

  it("refuses to invent a flat price for OpenAI, which is billed on tokens", () => {
    expect(priceLabelFor("gemini")).toBe("~$0.067");
    expect(priceLabelFor("nbpro")).toBe("~$0.134");
    expect(priceLabelFor("openai")).toBe("billed per token");
  });

  it("the engine hints describe a route that actually exists", () => {
    // "OpenAI · best for clothing" described a route defaultEngineFor never takes.
    const openai = PHOTO_ENGINES.find(([k]) => k === "openai");
    expect(openai[2]).not.toMatch(/clothing/i);
  });
});

describe("usedSourceUrl — the side-by-side must be able to prove itself", () => {
  const sample = (extra) => ({ processed: 1, sample: [{ id: "p1", proposedUrl: "https://s/g.jpg", ...extra }] });

  it("carries back the photo the server actually read", () => {
    expect(readGenerateResult(sample({ sourceUrl: "https://s/a.jpg" }), "p1").usedSourceUrl).toBe("https://s/a.jpg");
  });

  it("reports null — not the requested url — when an older build echoed nothing", () => {
    // Defaulting to the requested url would turn "unknown" into a false "yes".
    expect(readGenerateResult(sample({}), "p1").usedSourceUrl).toBeNull();
  });
});

// ─── NO FIX CHIP MAY ASK FOR WEAR REMOVAL ────────────────────────────────────
// Owner ruling 2026-08-20. The chips are injected as "PRIORITY FIX … Apply
// this above all else", so a loose phrase HERE outranks the base prompt by
// construction. The CONDITION_CLAUSE in functions/lib/photo-prompt.cjs is the
// backstop (and is tested there); this is the guard at the source.
describe("the fix chips do not ask for the item to be made newer", () => {
  const BANNED = [
    [/authentic product's true shape/i, "a worn shoe's true shape IS deformed by wear"],
    [/restore the product's true/i,     "a faded item's true colour IS faded"],
    [/richer and deeper/i,              "would deepen colour the item has genuinely lost"],
    [/fix the logos, patterns, stitching\b/i, "on frayed stitching, that is a repair"],
    [/\bpristine\b/i,                  "names wear removal outright"],
    [/\bbrand[- ]new\b/i,              "names wear removal outright"],
    [/\bscuff/i,                        "wear"],
    [/\bscratch/i,                      "wear"],
    [/\bunworn\b/i,                    "wear"],
    [/\blike[- ]new\b/i,               "wear"],
  ];

  for (const [label, instruction] of FIX_PRESETS) {
    it(`"${label}" asks only about the photograph`, () => {
      for (const [re, why] of BANNED) {
        expect(instruction, `${label}: ${why}`).not.toMatch(re);
      }
    });
  }

  it("combines exactly two chips — which is the ceiling, not a floor", () => {
    // Said "two still combine" as though there were headroom. There is not:
    // the chips are ~100 characters against a 240 cap, so two is the MAXIMUM
    // and always was, before this change as well. Asserting >= 2 could never
    // fail and hid that. Pinned to the real number so that raising NOTE_MAX,
    // or lengthening a chip, shows up here as a change rather than silently.
    let note = "", added = 0;
    for (const [, instr] of FIX_PRESETS) {
      const before = note;
      note = toggleFix(note, instr);
      if (note !== before) added += 1;
    }
    expect(added).toBe(2);
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
  });

  it("every chip still fits on its own", () => {
    for (const [label, instruction] of FIX_PRESETS) {
      expect(instruction.length, `${label} is too long to tap at all`).toBeLessThanOrEqual(NOTE_MAX);
    }
  });
});

// ─── THE GRADE WARNING FIRED ON ALL THREE GRADES ─────────────────────────────
// It was `/marks|wear/i` against the grade string, inline in the card. That
// matches "Excellent — no visible wear" on the word "wear" while the grade
// says the opposite — so the banner fired on every publishable product, and
// told the reviewer that "the description tells the customer those marks are
// there" on an item graded as having none.
describe("gradeAdmitsWear", () => {
  it("is quiet on the grade that promises no marks", () => {
    expect(gradeAdmitsWear("Excellent — no visible wear")).toBe(false);
  });

  it("warns on the two grades that declare marks", () => {
    expect(gradeAdmitsWear("Very good — light cosmetic marks")).toBe(true);
    expect(gradeAdmitsWear("Good — visible wear, priced accordingly")).toBe(true);
  });

  it("covers exactly two of the three real grades", () => {
    expect(CONDITIONS.filter(gradeAdmitsWear)).toHaveLength(2);
  });

  it("stays quiet when no grade is set", () => {
    for (const v of [undefined, null, "", "   ", 42, {}]) expect(gradeAdmitsWear(v)).toBe(false);
  });

  it("is not re-opened by a differently-worded negative grade", () => {
    expect(gradeAdmitsWear("Mint — no visible scuffs")).toBe(false);
    expect(gradeAdmitsWear("No marks at all")).toBe(false);
  });
});
