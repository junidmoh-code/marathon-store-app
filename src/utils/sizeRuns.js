// ─── SIZE RUNS — the size lists become data ───────────────────────────────────
// A "size run" is the ordered list of sizes a category's grid renders (the
// apparel letters, the footwear numbers, …). Until now each run lived as a
// hardcoded constant in productTaxonomy.js, so adding a size (the owner asking
// for 4XL) was a code change and a deploy. This module makes runs REGISTRY DATA:
//
//   • The live runs live at RTDB /settings/productTaxonomy/sizeRuns/{runKey},
//     seeded once from the constants by scripts/seed-size-runs.mjs.
//   • A category points at its run via `sizeRunKey`. Resolution (sizesForCat)
//     prefers the live run, falls back to the seeded run, and finally to the
//     category's own literal `sizes` — a partial or missing registry can never
//     blank a size grid.
//   • Runs are ADD-ONLY. Sizes are /stock cell keys and barcode-catalog keys, so
//     renaming, reordering or deleting one would orphan live stock. There is
//     deliberately NO code path in this module (or the admin tab that calls it)
//     that removes, renames or reorders an existing size — appendSizeToRun
//     refuses to return anything that isn't the old list with exactly one
//     insertion, and the tests mutation-prove that refusal.
//   • Duplicate spellings are the real hazard: "4XL" and "XXXXL" would become
//     TWO stock cells for one physical size and split stock silently. Every new
//     size is normalised and checked against every run in canonical form
//     (X-count / numeric folding) before it can be created.

import {
  SIZES_APPAREL, SIZES_FOOTWEAR, SIZES_KIDS, SIZES_FITTED_CAP, SIZES_GLOVES,
  ONE_SIZE_SENTINEL, isOneSize, sizesOf,
} from "./productTaxonomy.js";

// ── The comparator ───────────────────────────────────────────────────────────
// New sizes append in CORRECT SORT POSITION, not alphabetically:
//   apparel letters: XS-family < S < M < L < XL-family ascending
//                    (… XXS < XS < S < M < L < XL < XXL < XXXL < 4XL < 5XL …)
//   numeric runs:    plain numeric order, halves included (5 < 5.5 < 6)
// Mixed comparisons are made total (numbers sort before letters) so insertion
// is deterministic even against a hand-edited run.

const BASE_LETTER_RANK = { S: 1, M: 2, L: 3 };

// "XL" → 1, "XXL" → 2, "XXXL" → 3, "4XL" → 4, "XXXXL" → 4 … null if not XL-family.
export function xlCount(s) {
  const m1 = /^(X+)L$/.exec(s);
  if (m1) return m1[1].length;
  const m2 = /^([2-9]\d*)XL$/.exec(s);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

// "XS" → 1, "XXS" → 2, "2XS" → 2 … null if not XS-family.
export function xsCount(s) {
  const m1 = /^(X+)S$/.exec(s);
  if (m1) return m1[1].length;
  const m2 = /^([2-9]\d*)XS$/.exec(s);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

// Letter rank on one ascending scale, or null when the token isn't a letter size.
function letterRank(s) {
  const u = String(s).toUpperCase();
  const xs = xsCount(u);
  if (xs != null) return 1 - xs;              // XS=0, XXS=-1, 3XS=-2 …
  if (u in BASE_LETTER_RANK) return BASE_LETTER_RANK[u];
  const xl = xlCount(u);
  if (xl != null) return 3 + xl;              // XL=4, XXL=5, XXXL=6, 4XL=7 …
  return null;
}

function numericValue(s) {
  const t = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return parseFloat(t);
}

export function compareSizes(a, b) {
  const na = numericValue(a), nb = numericValue(b);
  if (na != null && nb != null) return na - nb;
  const la = letterRank(a), lb = letterRank(b);
  if (la != null && lb != null) return la - lb;
  // Totality for odd inputs: numbers before letters, then plain string order —
  // deterministic, and only reachable in a hand-edited mixed run.
  if (na != null) return -1;
  if (nb != null) return 1;
  return String(a).localeCompare(String(b));
}

// ── Normalisation + canonical duplicate form ─────────────────────────────────
// normalizeSizeInput: what the operator TYPED → the size string we would store.
// Uppercases letter sizes, strips all whitespace, canonicalises numbers
// ("05" → "5", "5.50" → "5.5"). Returns null for input that can never be a
// size (empty, RTDB-illegal chars beyond ".", absurd length).
const LEGAL_SIZE = /^[A-Z0-9.]+$/;

export function normalizeSizeInput(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/\s+/g, "").toUpperCase();
  if (!s || s.length > 8) return null;
  if (!LEGAL_SIZE.test(s)) return null;
  const n = numericValue(s);
  if (n != null) s = String(n);               // "05" → "5", "5.50" → "5.5"
  return s;
}

// canonicalSizeKey: the form under which two spellings of the SAME physical
// size collide. XL-families fold to "<n>XL" ("XXXXL" → "4XL"), XS-families to
// "<n>XS", numbers to their numeric string. Everything else is itself.
export function canonicalSizeKey(size) {
  const s = String(size).toUpperCase();
  const n = numericValue(s);
  if (n != null) return String(n);
  const xl = xlCount(s);
  if (xl != null) return `${xl}XL`;
  const xs = xsCount(s);
  if (xs != null) return `${xs}XS`;
  return s;
}

// ── Validation of a new size against every run ───────────────────────────────
// Returns { ok:true, size } or { ok:false, reason, message } where message is
// operator-facing. `runs` is the resolved run map ({ runKey: { sizes:[…] } }),
// `runKey` the run being added to.
//
// Rules (in order):
//   • must normalise to a legal token; "_" (the one-size sentinel) is reserved
//   • exact match in the TARGET run → reject
//   • near-identical (same canonical form, any spelling) in the TARGET run →
//     block, naming the existing size ("XXXXL" vs an existing "4XL")
//   • near-identical in ANOTHER run under a DIFFERENT spelling → block and name
//     it: one physical size must have ONE spelling everywhere, or the stock
//     vocabulary forks. The IDENTICAL spelling existing in another run is fine
//     ("M" lives in both gloves and apparel today).
export function validateNewSize(runs, runKey, rawInput) {
  const size = normalizeSizeInput(rawInput);
  if (String(rawInput ?? "").trim() === ONE_SIZE_SENTINEL) {
    return { ok: false, reason: "reserved", message: `"${ONE_SIZE_SENTINEL}" is the reserved one-size marker — it cannot be created as a size.` };
  }
  if (!size) {
    return { ok: false, reason: "invalid", message: "That is not a valid size — letters, digits and a dot only (e.g. 4XL, 13, 5.5)." };
  }
  const canon = canonicalSizeKey(size);
  const target = runs && runs[runKey];
  const targetSizes = runSizes(target);
  for (const existing of targetSizes) {
    if (existing === size) {
      return { ok: false, reason: "exact-duplicate", message: `"${size}" is already in this run.`, existing, existingRunKey: runKey };
    }
    if (canonicalSizeKey(existing) === canon) {
      return { ok: false, reason: "near-duplicate", message: `"${size}" is the same size as the existing "${existing}" — sizes are stock keys, so a second spelling would split stock into two cells. Use "${existing}".`, existing, existingRunKey: runKey };
    }
  }
  for (const [k, run] of Object.entries(runs || {})) {
    if (k === runKey) continue;
    for (const existing of runSizes(run)) {
      if (existing !== size && canonicalSizeKey(existing) === canon) {
        return { ok: false, reason: "near-duplicate-other-run", message: `"${size}" is already known as "${existing}" (in the ${run.label || k} run). One physical size keeps ONE spelling everywhere — use "${existing}".`, existing, existingRunKey: k };
      }
    }
  }
  return { ok: true, size };
}

// ── ADD-ONLY append ──────────────────────────────────────────────────────────
// The ONLY way a run's size list changes. Inserts `size` at its correct sort
// position (before the first existing size that compares greater — STABLE, so
// an oddly-ordered hand-edited run is never reordered as a side effect) and
// PROVES the result is the old list plus exactly one insertion before
// returning. There is no removal, rename or reorder counterpart, on purpose.
export function appendSizeToRun(sizes, size) {
  const cur = (sizes || []).map(String);
  let at = cur.length;
  for (let i = 0; i < cur.length; i++) {
    if (compareSizes(cur[i], size) > 0) { at = i; break; }
  }
  const next = [...cur.slice(0, at), size, ...cur.slice(at)];
  // Add-only proof: removing the inserted element must give back the original,
  // byte for byte, in the original order.
  const check = [...next.slice(0, at), ...next.slice(at + 1)];
  if (check.length !== cur.length || check.some((s, i) => s !== cur[i])) {
    throw new Error("appendSizeToRun: add-only invariant violated");
  }
  return next;
}

/** validate + append in one step — what the admin tab's write path calls. */
export function addSizeToRun(runs, runKey, rawInput) {
  const v = validateNewSize(runs, runKey, rawInput);
  if (!v.ok) return v;
  const next = appendSizeToRun(runSizes(runs && runs[runKey]), v.size);
  return { ok: true, size: v.size, sizes: next };
}

// ── The seeded runs (constants → data, byte-identical day one) ───────────────
// The apparel run additionally carries XXXL and 4XL (the owner's immediate
// ask), inserted in correct sort position via the same add-only append the
// admin tab uses — SIZES_APPAREL itself is untouched, so every legacy reader
// of the constant behaves exactly as before.
function withEnsured(base, extras) {
  let out = base.map(String);
  for (const e of extras) {
    if (!out.some((s) => canonicalSizeKey(s) === canonicalSizeKey(e))) out = appendSizeToRun(out, e);
  }
  return out;
}

export const SIZE_RUN_SEED = {
  apparel:      { key: "apparel",      label: "Apparel (letters)", sizes: withEnsured(SIZES_APPAREL, ["XXXL", "4XL"]) },
  footwear:     { key: "footwear",     label: "Footwear (UK)",     sizes: [...SIZES_FOOTWEAR] },
  kids:         { key: "kids",         label: "Kids Shoes (EU)",   sizes: [...SIZES_KIDS] },
  "fitted-cap": { key: "fitted-cap",   label: "Fitted Caps (cm)",  sizes: [...SIZES_FITTED_CAP] },
  gloves:       { key: "gloves",       label: "Gloves",            sizes: [...SIZES_GLOVES] },
};

// RTDB stores arrays as index-keyed objects and can hand back either shape.
export function runSizes(run) {
  const raw = run && run.sizes;
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/** The resolved run map: live registry runs overlaid on the seed (live wins). */
export function sizeRunsOf(registry) {
  const live = (registry && registry.sizeRuns && typeof registry.sizeRuns === "object") ? registry.sizeRuns : {};
  const out = {};
  for (const [k, run] of Object.entries(SIZE_RUN_SEED)) out[k] = { ...run, sizes: [...run.sizes] };
  for (const [k, run] of Object.entries(live)) {
    if (!run || typeof run !== "object") continue;
    const sizes = runSizes(run);
    if (!sizes.length) continue;                    // a blanked live run can never blank a grid
    out[k] = { key: k, label: run.label || (out[k] && out[k].label) || k, sizes };
  }
  return out;
}

/**
 * THE size list for a category — run-aware sizesOf. Resolution order:
 *   1. one-size categories → the "_" sentinel (unchanged, forced)
 *   2. cat.sizeRunKey → the live run, else the seeded run of that key
 *   3. the category's own literal `sizes` (exactly today's behaviour)
 * A missing runKey, an unknown runKey, or an empty live run all fall through —
 * a partial registry can never blank a size grid.
 */
export function sizesForCat(registry, cat) {
  if (!cat) return [];
  if (isOneSize(cat)) return [ONE_SIZE_SENTINEL];
  const rk = cat.sizeRunKey;
  if (rk && typeof rk === "string") {
    const runs = sizeRunsOf(registry);
    const run = runs[rk];
    const sizes = runSizes(run);
    if (sizes.length) return sizes;
  }
  return sizesOf(cat);
}
