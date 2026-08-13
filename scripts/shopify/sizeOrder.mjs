// ── Storefront size ordering for the Shopify push ────────────────────────────
// Shopify renders the Size dropdown in productOptions order, and the catalogue
// stores sizes in the order they were tapped in — 144 live products carry runs
// like ["6","7","8","9","10","11","3","4","5","5.5"]. This module owns the one
// sort applied before a payload is built. Pure functions, no I/O.
//
// Order groups, from a 2026-08-13 read-only census of all 4,131 sized records
// (distinct values: 3–13 incl. "5.5", 26–35, 55–63, S M L XL XXL XXXL 4XL, "_"):
//   1. numeric sizes ascending — parseFloat handles half sizes ("5.5")
//   2. letter sizes in garment order (XXS…6XL; census has S…XXXL and 4XL, the
//      neighbours are included so a future XS or 5XL lands in place, and 2XL/3XL
//      spellings fold onto XXL/XXXL)
//   3. anything unrecognised, in its original order (never dropped, never guessed)
//   4. the "_" one-size sentinel last ("One Size" reads naturally at the end of
//      a dropdown on the 1 live record that mixes "_" with a real size)
// A pure one-size product (sizes === ["_"]) is returned as-is: single option
// value, nothing to sort.
import { encodeSizeKey } from "../../src/utils/sizeKey.js";

const NUMERIC = /^\d+(\.\d+)?$/;

// Canonical garment run. 2XL/3XL/4XL/5XL/6XL are digit spellings of the same
// rungs — both spellings map to one rank so a mixed record still orders right.
const GARMENT_RANK = new Map(
  [
    ["XXS"], ["XS"], ["S"], ["M"], ["L"], ["XL"],
    ["XXL", "2XL"], ["XXXL", "3XL"], ["4XL", "XXXXL"], ["5XL"], ["6XL"],
  ].flatMap((names, rank) => names.map((n) => [n, rank]))
);

// group ids — compared before the in-group key
const G_NUMERIC = 0, G_GARMENT = 1, G_UNKNOWN = 2, G_ONESIZE = 3;

function rankOf(size, index) {
  const s = String(size).trim();
  if (s === "_") return [G_ONESIZE, 0];
  if (NUMERIC.test(s)) return [G_NUMERIC, parseFloat(s)];
  const g = GARMENT_RANK.get(s.toUpperCase());
  if (g !== undefined) return [G_GARMENT, g];
  return [G_UNKNOWN, index]; // stable: unknowns keep their catalogue order
}

// The Shopify option value a catalogue size renders as. "_" is the app's
// one-size sentinel; everything else displays verbatim.
export function displaySizeName(size) {
  return size === "_" ? "One Size" : String(size);
}

// Pre-flight validation BEFORE any Shopify mutation: a size array whose tokens
// collide — as display values ("_" next to a literal "One Size") or as RTDB
// keys ("5.5" next to "5_5") — would create variants that cannot be told apart
// in the ID map. Catching it here beats a thrown error AFTER the product was
// already created. Returns human-readable problem strings; empty = clean.
export function findSizeCollisions(sizes) {
  const problems = [];
  const byDisplay = new Map();
  const byKey = new Map();
  for (const s of sizes) {
    if ((typeof s !== "string" && typeof s !== "number") || String(s).trim() === "") {
      problems.push(`invalid size token: ${JSON.stringify(s)}`);
      continue;
    }
    const display = displaySizeName(s);
    const key = encodeSizeKey(s);
    if (byDisplay.has(display) && byDisplay.get(display) !== s) {
      problems.push(`sizes ${JSON.stringify(byDisplay.get(display))} and ${JSON.stringify(s)} collide as option "${display}"`);
    }
    if (byKey.has(key) && byKey.get(key) !== s) {
      problems.push(`sizes ${JSON.stringify(byKey.get(key))} and ${JSON.stringify(s)} collide as RTDB key "${key}"`);
    }
    if (byDisplay.get(display) === s || byKey.get(key) === s) {
      problems.push(`duplicate size token ${JSON.stringify(s)}`);
    }
    if (!byDisplay.has(display)) byDisplay.set(display, s);
    if (!byKey.has(key)) byKey.set(key, s);
  }
  return problems;
}

// Sort a record's sizes for the storefront. Returns a NEW array of the
// original tokens (never rewrites "5.5", never re-cases "s"); input untouched.
export function sortSizes(sizes) {
  if (!Array.isArray(sizes)) return sizes;
  if (sizes.length === 1 && sizes[0] === "_") return [...sizes];
  return sizes
    .map((size, index) => ({ size, rank: rankOf(size, index), index }))
    .sort((a, b) =>
      a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.index - b.index
    )
    .map((e) => e.size);
}
