// ─── THE ABSOLUTE RULE, PINNED ───────────────────────────────────────────────
//
// (Owner directive, 2026-09-08.) "Nothing ever picks, guesses, suggests or
// pre-selects a display size — no default, no last-used, no most-available, no
// auto-fill."
//
// A rule about what code MUST NOT do cannot be proved by exercising the code:
// there is no input that demonstrates the absence of a default. So this reads
// the source of every surface that can put a size on the display record and
// pins the shapes that would reintroduce one.
//
// It is a source test on purpose, and it is the same technique
// displayMarkerInformational.test.js uses to pin that a deleted divert stays
// deleted. The failure it prevents has already happened twice on this feature:
//   • before 2026-08-26 the sheet did not appear at all, so the SENT size was
//     silently recorded as the display size;
//   • the fix left the sent size PRESELECTED, which is the same mistake wearing
//     a smaller hat — a preselected answer is the answer that gets confirmed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

// COMMENTS ARE STRIPPED BEFORE MATCHING. These files explain at length what
// they must not do — displayRowUi.jsx's own header says "no `defaultSize`
// prop" — so matching the raw source would fail on the documentation of the
// rule rather than on a breach of it. Strings survive: a preselect would be
// code, and code is what is being pinned.
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

const APP = code(read("../../App.jsx"));
const PICKER = code(read("./displayRowUi.jsx"));
const DUPES = code(read("./DuplicateDisplaysTab.jsx"));
const WALL = code(read("./UnregisteredDisplaysTab.jsx"));
const REQUEST = code(read("./displayRequestStore.js"));

describe("the warehouse size sheet opens with NOTHING chosen", () => {
  it("the sheet is opened with picked: null, always", () => {
    expect(APP).toContain("setSizeSheet({ order, options: sz.options, picked: null })");
  });

  it("no branch computes a picked size from the order", () => {
    // The exact shape that was there, and any near relative of it.
    expect(APP).not.toMatch(/picked:\s*sz\.known/);
    expect(APP).not.toMatch(/picked:\s*(order|o)\.(sentSize|size|displayRefillSize)/);
    expect(APP).not.toMatch(/picked:\s*[^n,}]*\?\s*String\(/);
  });

  it("a footwear refill ALWAYS asks — it never falls through to a direct write", () => {
    // `needed` is unconditionally true for footwear; the only early return is
    // the non-footwear one, which has no size to choose between.
    expect(APP).toMatch(/if \(!productIsFootwear\(prod\)\) return \{ needed: false/);
    expect(APP).toContain("return { needed: true, options, known: null };");
    // The old escape hatch: "no sizes on record → write the order's size".
    expect(APP).not.toMatch(/if \(!options\.length && known\) return \{ needed: false/);
  });
});

describe("the shared size picker has no default", () => {
  it("takes no defaultSize / initial / preselect prop of any kind", () => {
    expect(PICKER).not.toMatch(/default(Size|Picked)|preselect|initialSize|suggested/i);
  });

  it("starts at null and the confirm is dead until a human picks", () => {
    expect(PICKER).toContain("useState(null)");
    expect(PICKER).toContain("disabled={!picked || busy}");
  });

  it("offers no way through when the product declares no sizes", () => {
    // The empty-options branch renders a refusal, not a fallback.
    expect(PICKER).toMatch(/no sizes on record/);
    expect(PICKER).not.toMatch(/onPick\((order|row|product)\./);
  });
});

describe("nothing else invents a size", () => {
  it("both tabs get their size from the picker's callback only", () => {
    for (const [name, src] of [["DuplicateDisplaysTab", DUPES], ["UnregisteredDisplaysTab", WALL]]) {
      expect(src, name).toContain("onPick={(sz) =>");
      // No "most available", no "the biggest cell", no "the one we sent".
      expect(src, name).not.toMatch(/sort\([^)]*qty/);
      expect(src, name).not.toMatch(/mostAvailable|lastUsed|bestSize|suggestSize/i);
    }
  });

  it("the 15-minute timer raises a request and never a size", () => {
    // The request an auto/manual raise mints carries size: null, explicitly.
    expect(REQUEST).toMatch(/size:\s*null/);
    expect(REQUEST).not.toMatch(/size:\s*(product|p)\.sizes/);
  });

  it("the wall walk's request carries no size either", () => {
    expect(WALL).toMatch(/raiseDisplayRequest\(\{ orders, store, hub, product \}\)/);
  });
});
