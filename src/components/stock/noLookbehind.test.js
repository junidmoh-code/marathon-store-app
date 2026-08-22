// ─── NO REGEX SYNTAX THE SHOP TABLETS CANNOT PARSE ────────────────────────────
// Run: npx vitest run src/components/stock/noLookbehind.test.js
//
// A lookbehind assertion — (?<=…) or (?<!…) — is a SyntaxError at PARSE time on
// any engine that does not support it, not an error when the line runs. In a
// single-bundle app that means the WHOLE APP fails to load: a blank screen on
// the shop floor, from one character in one string helper nobody was looking at.
//
// Safari gained lookbehind in 16.4 (March 2023). Nothing in this estate records
// a userAgent, so there is no device inventory to check an iPad against, and the
// safe assumption is that one is older.
//
// This is a REPO-WIDE guard rather than a fix to one line, because the fix to
// one line does not survive the next person who reaches for a lookbehind. It
// scans the source that is actually bundled — src/ — and it is deliberately
// blunt: named capture groups (?<name>…) are legal and much older, so they are
// excluded by the pattern rather than by an allow-list.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { firstSentence, previewVerdict } from "./enginePolicyCore";

const SRC = join(process.cwd(), "src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...walk(p)); continue; }
    if (/\.(js|jsx|mjs|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("nothing in the bundle uses a regex lookbehind", () => {
  it("finds no (?<= or (?<! anywhere under src/", () => {
    // (?<= and (?<! only — (?<name>…) is a named capture group and is fine.
    const LOOKBEHIND = /\(\?<[=!]/;
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith("noLookbehind.test.js"))
      .filter((f) => LOOKBEHIND.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(`${process.cwd()}/`, ""));
    expect(offenders).toEqual([]);
  });
});

describe("firstSentence replaces the lookbehind exactly", () => {
  // The old expression, kept HERE (in a test, which runs on node) purely to
  // prove the replacement produces the same string. It must never go back into
  // shipped source.
  const old = (t) => String(t || "").split(/(?<=\.)\s+/)[0];

  const CASES = [
    "The next scan asks for at most 19 refills (61 units). That fits inside the 75-per-scan limit, which is shared with every other category. Central holds 198, which covers it.",
    "The next scan asks for nothing — every shelf in this category is already at or above target.",
    "The next scan asks for nothing. 293 shelves are below target, but there is no stock upstream to fill them — those wait for a delivery, not for this setting.",
    "Run a preview to see what the next scan would do.",
    "No full stop at all",
    "",
    "Trailing dot.",
    "Decimal 5.5 units stay in one sentence. Second sentence.",
  ];

  for (const text of CASES) {
    it(`matches the old behaviour for ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(firstSentence(text)).toBe(old(text));
    });
  }

  it("matches on the real verdicts the panel renders", () => {
    const models = [
      { totalRequests: 0, totalUnits: 0, centralOnHand: 100, cap: 75, overriddenProducts: 0, legs: [] },
      { totalRequests: 0, totalUnits: 0, centralOnHand: 100, cap: 75, overriddenProducts: 0, legs: [{ parked: 293 }] },
      { totalRequests: 120, totalUnits: 300, centralOnHand: 100, cap: 75, overriddenProducts: 0, legs: [] },
      { totalRequests: 19, totalUnits: 300, centralOnHand: 198, cap: 75, overriddenProducts: 79, legs: [] },
      { totalRequests: 12, totalUnits: 40, centralOnHand: 100, cap: 75, overriddenProducts: 0, legs: [],
        nonLiveLegs: [{ loc: "hub1", mode: "shadow", requests: 5 }] },
    ];
    for (const m of models) {
      const v = previewVerdict(m, { cap: 75 });
      expect(firstSentence(v)).toBe(old(v));
      // …and it really is only the first sentence.
      expect(v.startsWith(firstSentence(v))).toBe(true);
    }
    expect(firstSentence(previewVerdict(null))).toBe("Run a preview to see what the next scan would do.");
  });
});
