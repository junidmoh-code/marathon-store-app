// ─── PROPERTY FUZZ — the no-substring guarantee, over generated codes ─────────
// The hand-written tests pin the cases we thought of. This asks whether the
// PROPERTY holds over codes we did not: thousands of generated article codes in
// the shapes this catalogue actually carries, each checked against its own
// nearest neighbours.
//
// The properties, and what each one is protecting:
//
//   P1  A code never matches a STRICTLY LONGER unsegmented code that contains
//       it. This is the whole rule. 44712 vs 144712 / 447120 / 447125 — every
//       one of these is a different article on a different rail, and a match
//       here routes a delivery into the wrong stock cells.
//   P2  A code always matches ITSELF, in every spelling a supplier prints it —
//       bare, hyphenated, slashed, lower-cased, padded. A guarantee that
//       refuses real matches is not safety, it is a broken feature.
//   P3  A match is SYMMETRIC in tier: if typing A finds B exactly, typing B
//       finds A exactly. Asymmetry means two operators typing the same delivery
//       from opposite ends get different answers — the consistency failure this
//       feature exists to prevent.
//   P4  Ranking is TOTAL and STABLE: shuffling the catalogue never changes the
//       ranked output.
//   P5  Nothing throws, whatever is fed in.
//
// Seeded and deterministic — a failure here is reproducible from the seed in the
// source, not a flake to be re-run away.

import { describe, it, expect } from "vitest";
import { scoreCandidate, rankCandidates, extractTokens, TIER_EXACT_CODE, TIER_PARTIAL_CODE, TIER_FUZZY_NAME } from "./productDupMatch.js";
import { normaliseStyleCode as normaliseStyleCodeLike } from "./styleCode.js";

// Mulberry32 — a small deterministic PRNG, so a failure is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const D = "0123456789";
const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const pick = (r, s) => s[Math.floor(r() * s.length)];
const runOf = (r, s, n) => Array.from({ length: n }, () => pick(r, s)).join("");

// The shapes the live catalogue carries: a bare supplier article number, and the
// brand formats styleCode.js recognises.
//
// UNSEPARATED BY CONSTRUCTION. The properties below pair these with their own
// neighbours, so a separator here would change what "neighbour" means. Separated
// spellings are built explicitly, by makeSegmented.
function makeCode(r) {
  switch (Math.floor(r() * 5)) {
    case 0: return runOf(r, D, 4 + Math.floor(r() * 4));           // 44712
    case 1: return runOf(r, L, 2) + runOf(r, D, 7);                // CT8527016
    case 2: return runOf(r, D, 9);                                 // 315122111
    case 3: return runOf(r, L, 1 + Math.floor(r() * 2)) + runOf(r, D, 4 + Math.floor(r() * 3)); // IE3437
    default: return runOf(r, L, 2) + runOf(r, D, 3) + runOf(r, L, 3); // ML574EVG
  }
}

// A code as a supplier PRINTS it: two blocks, or three for the Lacoste-style
// label form. This is the shape the stem rule exists for, and until it was
// generated here no property exercised that rule at all — the fuzz was added in
// the same commit that changed it and could not have caught the regression it
// was meant to guard. (Adversarial delta review, PR #594.)
const MONTHS = new Set(["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]);
function makeSegmented(r) {
  const sep = pick(r, "-/_.");
  if (r() < 0.5) return { text: `${makeCode(r)}${sep}${runOf(r, D, 2)}`, blocks: 2 };
  // The Lacoste tongue-label form: a category prefix, the article block, a colour.
  // The three letters must not spell a MONTH — styleCode.js's lacoste-ref shape
  // deliberately refuses "…7-99SEP0678…" so a printed date cannot be read as a
  // style code. A generator that emits one is generating a string the system is
  // meant to reject, and counting the rejection as a miss.
  let letters = runOf(r, L, 3);
  while (MONTHS.has(letters)) letters = runOf(r, L, 3);
  return { text: `7${sep}${runOf(r, D, 2)}${letters}${runOf(r, D, 4)}${sep}${runOf(r, D, 3)}`, blocks: 3 };
}

const prod = (name, extra = {}) => ({ id: `p:${name}`, name, ...extra });

// EVERY PROPERTY BELOW ASSERTS ITS OWN COVERAGE. A fuzz whose generator drifts
// until nothing it produces can match anything still passes — silently, forever,
// proving nothing. So each property counts the comparisons that actually
// EXERCISED the rule under test and fails if that count collapses. (Property P3
// was found to be exactly this: 0 of 3000 pairs produced any hit at all, so its
// assertion compared null to null every iteration and could not fail.)
const atLeast = (n, got, what) => {
  if (got < n) throw new Error(`fuzz coverage collapsed: only ${got} ${what} (expected >= ${n}) — this property is no longer testing anything`);
};

describe("PROPERTY FUZZ — the no-substring guarantee", () => {
  it("P1: a code NEVER matches a longer unsegmented code that contains it", () => {
    const r = rng(20260909);
    const failures = [];
    let live = 0;
    for (let i = 0; i < 4000; i++) {
      const code = makeCode(r);
      // Every one-character extension, front and back — the neighbours a
      // substring matcher would happily confuse with each other.
      const neighbours = [
        pick(r, D) + code,
        code + pick(r, D),
        pick(r, L) + code,
        code + pick(r, L),
      ];
      for (const n of neighbours) {
        if (n === code) continue;
        // A neighbour only EXERCISES the rule when it is itself code-shaped —
        // a letter appended to an all-digit code is not, and such a pair could
        // never match under any implementation.
        if (extractTokens(n).codes.length) live++;
        const hit = scoreCandidate(code, prod(n));
        if (hit && (hit.tier === TIER_EXACT_CODE || hit.tier === TIER_PARTIAL_CODE)) {
          failures.push({ code, neighbour: n, tier: hit.tier });
        }
        const back = scoreCandidate(n, prod(code));
        if (back && (back.tier === TIER_EXACT_CODE || back.tier === TIER_PARTIAL_CODE)) {
          failures.push({ code: n, neighbour: code, tier: back.tier });
        }
      }
    }
    atLeast(4000, live, "code-shaped neighbour pairs");
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("P1b: nor a longer code that merely SHARES a prefix", () => {
    const r = rng(777);
    const failures = [];
    for (let i = 0; i < 3000; i++) {
      const code = makeCode(r);
      const longer = code + runOf(r, D, 1 + Math.floor(r() * 3));   // no separator
      const hit = scoreCandidate(code, prod(longer));
      if (hit && hit.tier !== TIER_FUZZY_NAME) failures.push({ code, longer, tier: hit.tier });
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("P2: a code always matches ITSELF, in every spelling a supplier prints", () => {
    const r = rng(31337);
    const misses = [];
    for (let i = 0; i < 2000; i++) {
      const code = makeCode(r);
      for (const typed of [code, code.toLowerCase(), `  ${code}  `]) {
        const hit = scoreCandidate(typed, prod(code));
        if (!hit || hit.tier !== TIER_EXACT_CODE) misses.push({ typed, code, hit });
      }
      // …and the same code stored under styleCodeNormalised or as a barcode.
      for (const stored of [prod("Some Garment", { styleCodeNormalised: code }), prod("Some Garment", { barcode: code })]) {
        const hit = scoreCandidate(code, stored);
        if (!hit || hit.tier !== TIER_EXACT_CODE) misses.push({ code, stored: stored.name, hit });
      }
    }
    expect(misses.slice(0, 5)).toEqual([]);
  });

  it("P2b: a separated spelling of one code is the SAME code, not a partial one", () => {
    const r = rng(4242);
    const wrong = [];
    for (let i = 0; i < 500; i++) {
      const a = runOf(r, D, 5), b = runOf(r, D, 2);
      // 44712-01, 44712/01, 44712.01, 44712_01 are one code printed four ways.
      const spellings = [`${a}-${b}`, `${a}/${b}`, `${a}.${b}`, `${a}_${b}`];
      for (const s1 of spellings) for (const s2 of spellings) {
        const hit = scoreCandidate(s1, prod(s2));
        if (!hit || hit.tier !== TIER_EXACT_CODE) wrong.push({ s1, s2, hit });
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it("P3: a code match is SYMMETRIC — both operators get the same answer", () => {
    // THE PAIRS MUST BE ABLE TO MATCH, or this asserts null === null forever.
    // Each pair here is two spellings of ONE article — a bare code and a
    // separated one, or two colourway siblings — and half of them store the code
    // somewhere other than the name, which is the only place a genuine asymmetry
    // could hide (typed tokens come from extractTokens; product tokens come from
    // the name PLUS styleCodeNormalised PLUS barcodes).
    const r = rng(90210);
    const asym = [];
    let hits = 0;
    for (let i = 0; i < 3000; i++) {
      const seg = makeSegmented(r);
      const bare = normaliseStyleCodeLike(seg.text);
      const pairs = [
        [seg.text, prod(seg.text)],
        [seg.text, prod("Some Garment", { styleCodeNormalised: bare })],
        [bare, prod(seg.text)],
        [seg.text, prod(makeSegmented(r).text)],
      ];
      for (const [typed, other] of pairs) {
        const ab = scoreCandidate(typed, other);
        const ba = scoreCandidate(other.name === "Some Garment" ? bare : other.name, prod(typed));
        const t = (h) => (h ? h.tier : null);
        if (t(ab) !== null || t(ba) !== null) hits++;
        if (t(ab) !== t(ba)) asym.push({ typed, other: other.name, ab: t(ab), ba: t(ba) });
      }
    }
    atLeast(3000, hits, "pairs that actually produced a match");
    expect(asym.slice(0, 5)).toEqual([]);
  });

  it("P3b: the stem rule is exercised — separated codes find their own siblings", () => {
    const r = rng(24680);
    const misses = [];
    let checked = 0;
    for (let i = 0; i < 1500; i++) {
      const seg = makeSegmented(r);
      const blocks = seg.text.split(/[-/_.]/);
      // Same article, different trailing block: a sibling colourway.
      const sibling = [...blocks.slice(0, -1), runOf(r, D, blocks[blocks.length - 1].length)].join("-");
      if (sibling === seg.text) continue;
      checked++;
      const hit = scoreCandidate(seg.text, prod(sibling));
      if (!hit) misses.push({ typed: seg.text, sibling, blocks: seg.blocks });
    }
    atLeast(1000, checked, "sibling pairs");
    expect(misses.slice(0, 5)).toEqual([]);
  });

  it("P4: ranking is stable — shuffling the catalogue never changes the answer", () => {
    const r = rng(5150);
    let reordered = 0;
    for (let i = 0; i < 300; i++) {
      const code = makeCode(r);
      const catalogue = [
        prod(code),
        prod(`${code}-0${Math.floor(r() * 9)}`),
        prod(`${code} Mens Fleece Tracksuit`),
        prod(makeCode(r)),
        prod("Mens Fleece Tracksuit"),
        prod(`${pick(r, D)}${code}`),
      ];
      const base = rankCandidates(code, catalogue).map((x) => x.product.id);
      // FISHER-YATES, not sort() with a random comparator. An inconsistent
      // comparator is not a shuffle: measured, it left the array UNCHANGED in 22
      // of these 300 iterations, where the assertion is trivially true.
      const shuffled = [...catalogue];
      for (let k = shuffled.length - 1; k > 0; k--) {
        const j = Math.floor(r() * (k + 1));
        [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
      }
      if (base.length > 1) reordered += shuffled.some((p, idx) => p !== catalogue[idx]) ? 1 : 0;
      expect(rankCandidates(code, shuffled).map((x) => x.product.id)).toEqual(base);
    }
    atLeast(250, reordered, "catalogues that were actually reordered");
  });

  it("P5: nothing throws, whatever is fed in", () => {
    const r = rng(1);
    const junk = [
      "", "   ", "---", "\u{1F642}\u{1F642}", "44712\n44713", "A".repeat(5000),
      "7-45SMA0004-075", "44712--01", "-44712-", "44712-", "-44712",
      "US10UK9", "44712 " + "9".repeat(400), "\t", "44712 -01",
    ];
    const products = [
      null, undefined, {}, { id: "p" }, { id: "p", name: null }, { id: "p", name: 42 },
      { id: "p", name: "44712", barcodes: null }, { id: "p", name: "44712", barcodes: { M: null } },
      { id: "p", name: "44712", styleCodeNormalised: 5 }, { id: "p", name: "\u{1F642}" },
      { id: "p", name: "A".repeat(5000) }, { id: "p", name: "44712", barcode: { nested: true } },
    ];
    for (const typed of junk) {
      for (const p of products) expect(() => scoreCandidate(typed, p)).not.toThrow();
      expect(() => rankCandidates(typed, products)).not.toThrow();
    }
    for (let i = 0; i < 500; i++) {
      const s = runOf(r, D + L + "-/_. ", 1 + Math.floor(r() * 30));
      expect(() => rankCandidates(s, [prod(makeCode(r))])).not.toThrow();
    }
  });
});
