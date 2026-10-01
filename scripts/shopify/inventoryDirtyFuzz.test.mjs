// ── THE DIFFERENTIAL FUZZ: the trigger's SKIP must never hide a real change ───
//
// Two functions in two languages decide the same thing from opposite ends, and
// nothing but their agreement keeps the storefront correct:
//
//   functions/lib/shopify-inventory-dirty.cjs  sellableChanged(before, after)
//       CJS, in a Cloud Function. Decides whether a stock write is worth a
//       marker AT ALL. A `false` here is a decision that NOTHING needs pushing.
//
//   scripts/shopify/inventory.mjs              networkTotals(tree, pid, sizes)
//       ESM, in the pusher. Computes the number Shopify is actually given.
//
// THE PROPERTY. If the trigger says "no sellable change", the pusher must agree
// — the totals it would compute before and after must be IDENTICAL for every
// size. Any input where the trigger skips and the totals differ is a stock
// movement that reaches Shopify never, silently, which is precisely the bug
// this whole change exists to end.
//
// It is fuzzed rather than enumerated because the interesting cases are the
// ones nobody thinks to write: a swap between two sizes (same sum, two wrong
// variants), a negative clamped to zero on one side only, a cell that changes
// from a bare number to a movement-stamped object, a size that appears or
// vanishes, and a key the id map does not carry.
//
// The reverse direction is deliberately NOT asserted. The trigger is allowed to
// mark when nothing changed — an over-mark costs one counter write and a sweep
// that finds no drift. Only the SKIP is dangerous, so only the skip is pinned.
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { networkTotals } from "./inventory.mjs";
import { stockSizeKey } from "../../src/utils/sizeKey.js";

const require = createRequire(import.meta.url);
const { sellableChanged } = require("../../functions/lib/shopify-inventory-dirty.cjs");

// A small, deterministic PRNG so a failure is reproducible from its seed alone.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const SIZES = ["S", "M", "L", "XL", "5_5", "6", "_"];

// Every shape a /stock cell has ever had in this database: the movement-stamped
// object applyMovement writes, a bare number from old data, a negative
// bookkeeping artefact, an explicitly absent key, and the junk that a bad write
// could leave behind.
function randomCell(r) {
  const k = Math.floor(r() * 8);
  const qty = Math.floor(r() * 9) - 3;          // -3..5, so negatives are common
  switch (k) {
    case 0: return { qty, lastType: "sale", mv: `m${Math.floor(r() * 3)}` };
    case 1: return qty;                          // bare number, old data
    case 2: return { qty: String(qty) };          // numeric string
    case 3: return null;
    case 4: return { qty: 0 };
    case 5: return {};                            // no qty at all
    case 6: return { qty, extra: r() };           // an unrelated field moving
    default: return { qty };
  }
}

function randomCells(r) {
  const cells = {};
  for (const s of SIZES) if (r() < 0.6) cells[s] = randomCell(r);
  return Object.keys(cells).length ? cells : null;   // "the product has no cells here"
}

// ── THE `after` IS A MUTATION OF THE `before`, NOT AN INDEPENDENT DRAW ───────
// Two independent random cell maps almost always differ, so the trigger marks
// nearly every pair and the SKIP branch — the only dangerous one — goes
// untested. It also is not what a stock write looks like: a movement perturbs
// one cell of an existing record. Mutating gives a realistic mix, and half the
// mutations are deliberately NO-OPS for the sellable quantity (a different
// movement id, a re-encoding of the same number, one negative swapped for
// another) because those are exactly the writes the trigger is supposed to skip
// — and therefore exactly where a wrong skip would hide.
function mutate(r, cells) {
  if (!cells) return r() < 0.5 ? null : randomCells(r);
  const next = JSON.parse(JSON.stringify(cells));
  const keys = Object.keys(next);
  const k = keys[Math.floor(r() * keys.length)];
  switch (Math.floor(r() * 9)) {
    case 0: delete next[k]; break;                                   // a size vanishes
    case 1: next[SIZES[Math.floor(r() * SIZES.length)]] = randomCell(r); break;  // one appears/changes
    case 2: next[k] = randomCell(r); break;                          // one cell rewritten
    case 3: { const c = next[k]; if (c && typeof c === "object") c.mv = `m${Math.floor(r() * 9)}`; break; }   // no-op: movement id
    case 4: { const c = next[k]; if (c && typeof c === "object") c.extra = r(); break; }                       // no-op: unrelated field
    case 5: { const c = next[k];                                      // no-op: same number, other shape
      const q = c !== null && typeof c === "object" ? c.qty : c;
      next[k] = r() < 0.5 ? { qty: q } : q; break; }
    case 6: { const c = next[k];                                      // no-op: one negative for another
      const q = Number(c !== null && typeof c === "object" ? c.qty : c);
      if (q < 0) next[k] = { qty: q - Math.floor(r() * 5) - 1 }; break; }
    // ── THE SWAP, GENERATED ON PURPOSE ────────────────────────────────────
    // One unit off one size and onto another: the commonest movement on a shop
    // floor, and the one shape whose SUM does not move while two variants do.
    // Left to chance the mutation strategy above almost never produces it —
    // verified by breaking sellableChanged into a sum comparison, at which
    // point the 20,000-pair loop still passed and only the hand-written case
    // below caught it. A fuzz that cannot fail is decoration, so the swap is
    // generated rather than hoped for.
    case 7: {
      const j = keys[Math.floor(r() * keys.length)];
      if (j === k) break;
      const qty = (c) => Math.max(0, Number(c !== null && typeof c === "object" ? c.qty : c) || 0);
      const from = qty(next[k]);
      if (from < 1) break;
      next[k] = { qty: from - 1 };
      next[j] = { qty: qty(next[j]) + 1 };
      break;
    }
    default: break;                                                   // no-op: nothing at all
  }
  return Object.keys(next).length ? next : null;
}

// What the pusher would send, for the sizes the id map carries.
function totalsFor(cells, sizes) {
  return networkTotals({ pe: { p1: cells || {} } }, "p1", sizes);
}

describe("differential fuzz — a skipped mark never hides a change the pusher would make", () => {
  it("holds over 20,000 random before/after pairs", () => {
    const r = rng(20260905);
    const counterexamples = [];
    let skips = 0, changes = 0;
    for (let i = 0; i < 20000; i++) {
      const before = randomCells(r);
      const after = mutate(r, before);
      // The id map's sizes — sometimes every size, sometimes a subset, because
      // a product's map carries only the sizes it was published with and the
      // pusher only ever totals those.
      const sizes = SIZES.filter(() => r() < 0.7);
      const marked = sellableChanged(before, after);
      if (marked) { changes++; continue; }
      skips++;
      const a = totalsFor(before, sizes);
      const b = totalsFor(after, sizes);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        counterexamples.push({ i, before, after, sizes, a, b });
      }
    }
    // Both branches must be well exercised, or the property passed by never
    // being tested. A fuzz that only ever produced "marked" would be green and
    // meaningless.
    expect(skips).toBeGreaterThan(2000);
    expect(changes).toBeGreaterThan(2000);
    expect(counterexamples.slice(0, 3)).toEqual([]);
  });

  it("catches the swap by hand too — the case a sum-based comparison would miss", () => {
    const before = { S: { qty: 3 }, M: { qty: 2 } };
    const after  = { S: { qty: 2 }, M: { qty: 3 } };
    expect(sellableChanged(before, after)).toBe(true);
    // And the pusher agrees it matters: two variants change.
    expect(totalsFor(before, ["S", "M"])).not.toEqual(totalsFor(after, ["S", "M"]));
  });

  it("the encoded half-size key survives both sides identically", () => {
    // "5.5" is stored as "5_5". The trigger compares RAW cell keys and the
    // pusher totals by the encoded key, so a half size must not be a blind spot.
    expect(stockSizeKey("5.5")).toBe("5_5");
    const before = { "5_5": { qty: 1 } };
    const after  = { "5_5": { qty: 4 } };
    expect(sellableChanged(before, after)).toBe(true);
    expect(totalsFor(before, ["5.5"])).toEqual({ "5_5": 1 });
    expect(totalsFor(after, ["5.5"])).toEqual({ "5_5": 4 });
  });
});
