// ─── ASSISTANT LABEL FINDER — suggestion wiring, pinned at the source ────────
// (Owner spec 2026-08-13.) AssistantLabelFinder lives inside App.jsx (not
// exported), whose import graph pulls the live firebase bootstrap — so these
// claims are pinned the way this repo pins App-internal wiring
// (displayRegisterRemoved.test.js): against the source text. The pins:
//
//   1. Both dead-ends run buildLinkSuggestions — code kind AND tokens kind.
//   2. The tokens call feeds the match call's own candidates in.
//   3. The rendered suggestion row shows the REASON and taps to finish() —
//      select-only; the finder must never write an alias (assistants have no
//      write role, and the surface is documented read-only).
//   4. The reader's meta (modelName) is accepted by both handlers.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "App.jsx"), "utf8");
// Everything from the finder's definition to the next top-level component.
const finder = app.slice(app.indexOf("function AssistantLabelFinder"), app.indexOf("function AssistantView"));

describe("the assistant finder's suggestion wiring", () => {
  it("exists and is the slice we think it is", () => {
    expect(finder.length).toBeGreaterThan(1000);
    expect(finder).toContain("onFound");
  });

  it("the code dead-end ranks the catalogue before giving up", () => {
    expect(finder).toMatch(/kind: "code", normalised: scanNorm/);
    expect(finder).toContain("suggestions: close");
  });

  it("the till tries the label's OTHER tokens before the dead-end, read-only (review, PR #354)", () => {
    // Any-token resolution — the same door the count flow uses. A resolved
    // owner finishes the sale; several owners ask; the call is read-only.
    expect(finder).toMatch(/resolveAnyCodes\(tillAlternates\)/);
    expect(finder).toMatch(/anyTok\.resolved/);
    expect(finder).toContain("match more than one product — tap the right one");
  });

  it("the code dead-end POOLS every token and the label's words (review, PR #354)", () => {
    expect(finder).toMatch(/allCodes: meta && Array\.isArray\(meta\.allCodes\) \? meta\.allCodes : null,\s*\n\s*tokens: meta && Array\.isArray\(meta\.tokens\)/);
  });

  it("the tokens dead-end ranks too, seeded with the match call's own candidates", () => {
    expect(finder).toMatch(/kind: "tokens", tokens/);
    expect(finder).toMatch(/aliasCandidates: match && Array\.isArray\(match\.candidates\)/);
  });

  it("both handlers accept the reader's meta and pass modelName through", () => {
    expect(finder).toMatch(/handleCode = async \(display, meta = null\)/);
    expect(finder).toMatch(/handleTokens = async \(tokens, meta = null\)/);
    expect((finder.match(/modelName: meta && typeof meta\.modelName === "string"/g) || []).length).toBe(2);
  });

  it("weak-only results never claim 'close' — both handlers switch to the honest 'closest we have' wording", () => {
    // 2026-08-13 loosening: buildLinkSuggestions now returns weak browsing
    // rows (brandSegment/substring). When they are ALL there is, the note
    // must not dress them up as near-matches (substitute review, PR #353).
    expect((finder.match(/close\.some\(\(s\) => !s\.weak\)/g) || []).length).toBe(2);
    expect((finder.match(/nothing matched closely, but these are the closest we have/g) || []).length).toBe(2);
  });

  it("suggestion rows show the reason and SELECT the product — they never file an alias", () => {
    expect(finder).toContain("{s.reasons.join(");
    expect(finder).toMatch(/note\.suggestions[\s\S]{0,400}onClick=\{\(\) => finish\(s\.product\)\}/);
    // Select-only: no alias write exists anywhere in the finder.
    expect(finder).not.toContain("addLabelAlias");
    expect(finder).not.toContain("recordLabelCodes");
  });
});
