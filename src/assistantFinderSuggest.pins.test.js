// ─── ASSISTANT LABEL FINDER — wiring pins ────────────────────────────────────
// (Owner spec 2026-08-13, rewritten 2026-08-23 when the finder moved out of
// App.jsx into components/assistant/AssistantLabelFinder.jsx.) The finder now
// RENDERS in a test (assistantLabelFinder.render.test.jsx) — the behaviour is
// proved there. What stays pinned at the source here is the one thing a
// render test cannot cheaply prove: the finder never grows a write.
//
//   1. The finder is the module App.jsx mounts — not a second copy.
//   2. Every token pools through the count flow's own gather
//      (labelTokenSet + mergeTokenCandidates) and the ranked list is padded
//      so it is never empty (fillToMin).
//   3. Rows render through the SHARED CandidateCards and a tap SELECTS —
//      select-only; the finder must never write an alias (assistants have no
//      write role, and the surface is documented read-only).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "App.jsx"), "utf8");
const finder = readFileSync(join(here, "components", "assistant", "AssistantLabelFinder.jsx"), "utf8");

describe("the assistant finder's wiring", () => {
  it("App.jsx mounts the module and holds no second copy", () => {
    expect(app).toMatch(/import AssistantLabelFinder from "\.\/components\/assistant\/AssistantLabelFinder"/);
    expect(app).not.toMatch(/function AssistantLabelFinder/);
    expect(finder).toMatch(/export default function AssistantLabelFinder/);
    expect(finder).toContain("onFound");
  });

  it("every token pools through the count flow's gather, and the list is padded — never empty", () => {
    expect(finder).toMatch(/labelTokenSet\(display, meta && meta\.allCodes\)/);
    expect(finder).toMatch(/mergeTokenCandidates\(\{ tokens, products, claims, serverOwners, resolved \}\)/);
    // The pad is the ONE shared helper (hubCleanupCore.padCandidateRows), the
    // same one the merge picker uses — never a private copy.
    expect(finder).toMatch(/import \{ labelTokenSet, mergeTokenCandidates, exactCandidateRow, padCandidateRows \} from "\.\.\/stock\/hubCleanupCore"/);
    expect(finder).toMatch(/padCandidateRows\(\{\s*exactRows, products: \(products \|\| \[\]\)\.filter\(offerable\)/);
    expect(finder).not.toMatch(/buildLinkSuggestions/);
    expect(finder).toMatch(/kind: "tokens", tokens, aliasCandidates: cands/);
  });

  it("both handlers accept the reader's meta and pass modelName through", () => {
    expect(finder).toMatch(/handleCode = async \(display, meta = null\)/);
    expect(finder).toMatch(/handleTokens = async \(tokens, meta = null\)/);
    expect((finder.match(/modelName: meta && typeof meta\.modelName === "string"/g) || []).length).toBe(2);
  });

  it("weak-only results never claim 'close' — the honest 'closest we have' wording", () => {
    expect(finder).toMatch(/nothing matched closely, but these are the closest we have/);
  });

  it("rows are the SHARED CandidateCards and SELECT the product — the finder never files an alias", () => {
    expect(finder).toMatch(/import CandidateCards from "\.\.\/shared\/CandidateCards"/);
    expect(finder).toMatch(/<CandidateCards suggestions=\{note\.rows\}[\s\S]{0,200}onPick=\{\(p\) => finish\(p\)\}/);
    // Select-only: no alias write exists anywhere in the finder.
    expect(finder).not.toContain("addLabelAlias");
    expect(finder).not.toContain("recordLabelCodes");
    expect(finder).not.toContain("learnLabelLayout");
  });
});
