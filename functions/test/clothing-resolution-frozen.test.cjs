// ─── CLOTHING RESOLUTION IS FROZEN ────────────────────────────────────────────
//
// The third pass of the Engine Policy screen builds a per-size editor and folds
// the footwear group into one Sneakers entry. CLOTHING IS NOT TOUCHED by any of
// it: it is armed today by 7,797 hand-made /stock_targets rows plus the engine's
// own rules, and that arrangement has to keep working EXACTLY as it does now.
//
// "Exactly" is not a promise a comment can keep, so this replays it.
//
// fixtures/clothing-resolution.json was cut from the live database on
// 2026-08-22 by scripts/census-engine-policy-sizes.mjs. It holds the inputs —
// the engine config, and the products, stock cells and explicit rows for three
// clothing products per category — TOGETHER WITH the answer resolveTarget gave
// for every one of their cells at every destination. This test feeds the inputs
// back in and asserts the same answers, field for field, including the fields
// where absent and 0 are different policies.
//
// A per-size capability that alters ONE existing intent is a failure, and this
// is where that shows up: 520 cells across 71 products, 4 destinations, and
// every resolution source the live estate uses (explicit rows, the default
// clothing run, the category map, the subcategory rule).
//
// ── WHY THE WHOLE SNAPSHOT IS NOT IN HERE ────────────────────────────────────
// The live figure is 18,622 cells, hashed
// c7711b12a7f07f86a71801e1c876101e6c4aea0f0ea331cdd7b3269940f86c72. That hash
// is re-derived against the live database by re-running the census, which is
// the branch-level proof; this file is the one that runs on every commit.

const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { resolveTarget, encodeSizeKey } = require("../lib/refill-engine.cjs");

const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "clothing-resolution.json"), "utf8"));

test("every clothing cell in the live snapshot resolves to exactly what it did", () => {
  const ctx = { targets: fx.targets, config: fx.config, products: fx.products, stock: fx.stock };
  const got = {};
  for (const dest of Object.keys(fx.config.mode || {})) {
    for (const pid of Object.keys(fx.products)) {
      const sizes = Array.isArray(fx.products[pid]?.sizes) ? fx.products[pid].sizes : [];
      const cellKeys = Object.keys(fx.stock?.[dest]?.[pid] || {});
      const seen = new Set();
      for (const raw of [...sizes, ...cellKeys]) {
        const k = encodeSizeKey(raw);
        if (seen.has(k)) continue;
        seen.add(k);
        const t = resolveTarget(ctx, dest, pid, String(raw));
        if (!t) continue;
        got[`${dest}|${pid}|${k}`] = { target: t.target, minQty: t.minQty, reorderPoint: t.reorderPoint, source: t.source };
      }
    }
  }
  // Same set of cells: a cell that stopped resolving is as much a change as one
  // that resolves differently, and a NEW cell resolving is the one this pass is
  // most at risk of — a per-size map speaking where nothing spoke before.
  assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(fx.expected).sort(),
    "the set of clothing cells that resolve has changed");
  for (const key of Object.keys(fx.expected)) {
    assert.deepStrictEqual(got[key], fx.expected[key], `${key} resolves differently than it did live`);
  }
  assert.ok(Object.keys(fx.expected).length > 400, "the fixture lost its coverage");
});

test("the snapshot covers every resolution source the estate actually uses", () => {
  const sources = new Set(Object.values(fx.expected).map((v) => v.source));
  for (const s of ["explicit", "default", "category_policy"]) {
    assert.ok(sources.has(s), `the fixture no longer covers source "${s}" — it is not proving what it says`);
  }
});

// ── THE TWO SHAPES THAT COULD REACH CLOTHING WITHOUT ANYBODY MEANING THEM TO ──
// Clothing categories carry no entry in categoryPolicy and no group, and this
// pass does not give them one. These assert that from the fixture's own config
// rather than from a comment — if a clothing category is ever armed by hand,
// this fails and the freeze has to be re-taken deliberately.
test("no clothing category carries a map entry or a group membership in the frozen config", () => {
  const CLOTHING_KEYS = ["t-shirts", "hoodies", "jackets", "pants", "shorts", "tracksuits",
    "ladies-tracksuits", "soccer-jerseys", "golf-t-shirts", "shirts", "suits", "dresses",
    "underwear", "baseball-shirts", "basketball-vests"];
  const policy = fx.config.categoryPolicy || {};
  const grouped = Object.values(fx.config.policyGroups || {})
    .flatMap((g) => (Array.isArray(g?.memberCategoryKeys) ? g.memberCategoryKeys : []));
  for (const key of CLOTHING_KEYS) {
    assert.ok(!(key in policy), `${key} has a category policy entry — clothing is not touched by this pass`);
    assert.ok(!grouped.includes(key), `${key} is in a policy group — clothing is not touched by this pass`);
  }
});
