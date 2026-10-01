// ─── PROPERTY FUZZ — the footwear coverage buckets re-derived independently ──
//
// The hand-written cases in policy-category-key.test.cjs prove the situations
// somebody thought of. This re-derives BOTH buckets from first principles —
// resolveTarget asked size by size, the explicit rows read directly, cell
// presence read directly — over randomised catalogues, configs, stock and rows,
// and demands that the engine's lists equal the re-derivation exactly. Two
// directions, both mandatory: nothing listed that should not be (soundness),
// nothing missing that should be (completeness).
//
// The generator deliberately produces the shapes production produces:
//   • ARRAY-COERCED stock rows (dense integer size keys 3..11 come back from
//     RTDB as arrays with null holes — 560 of 5,793 live rows on 2026-09-15)
//   • keyless records with the legacy pair, keyless records without it,
//     padded keys, clothing-typed footwear, deactivated lines
//   • explicit rows including target 0, per-size maps naming none of a
//     product's sizes, products declaring no sizes, zero-unit cells
//   • config with and without a footwear leg at each destination
//
// It stands in for the second-brain reviewer slot (Kimi was over quota on
// 2026-09-15; Codex is excluded by owner order): a fuzz found three defects
// on PR #567 that four reviewers had missed, so it is not a formality.
//
// Run: cd functions && node --test test/policy-coverage-fuzz.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
// ONLY the function under test is imported. The re-derivation below resolves
// from raw config, rows and cells with its own code — it must not call
// resolveTarget, categoryPolicyEntry, policyCategoryKey or locationPolicyFor,
// or a bug inside those would reproduce on both sides and the fuzz would
// report equality regardless (second architect pass, PR #606; the standing
// rule: a census must not read the policy it measures). encodeSizeKey is a
// pure key encoder, not policy.
const { computeRefillPlan, encodeSizeKey } = require("../lib/refill-engine.cjs");

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const NOW = Date.parse("2026-09-15T09:00:00Z");
const DESTS = ["hub1", "hub2", "marathon-pe", "trophy"];
const LOCS = ["central", ...DESTS];
const SIZES = ["3", "5.5", "6", "7", "8", "11", "M", ""];
const STOCK_SIZES = ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11"];
const KEYS = ["sneakers", "slides", "designer-shoes", "soccer-boots", "t-shirts", " sneakers ", "", null, undefined];
const GROUP = new Set(["sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes", "designer-shoes"]);

// RTDB array coercion: a row whose keys are all small non-negative integers and
// more than half-dense comes back as an ARRAY with null holes. Reproduce it.
function coerce(row) {
  const keys = Object.keys(row);
  if (!keys.length || !keys.every((k) => /^\d+$/.test(k))) return row;
  const max = Math.max(...keys.map(Number));
  if (keys.length <= (max + 1) / 2) return row;
  const arr = new Array(max + 1).fill(null);
  for (const k of keys) arr[Number(k)] = row[k];
  return arr;
}

function makeCase(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const maybe = (v, p = 0.5) => (r() < p ? v : undefined);
  const products = {};
  const n = 1 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const pid = `p${i}`;
    products[pid] = {
      id: pid, name: pid,
      sizes: r() < 0.1 ? undefined : SIZES.filter(() => r() < 0.5),
      category: pick(["Footwear", "Footwear", "Clothing", undefined]),
      subcategory: pick(["Sneakers", "Sneakers", "Soccer Boots", undefined]),
      categoryKey: maybe(pick(KEYS), 0.7),
      productType: maybe(pick(["sneaker", "clothing", undefined])),
      deactivated: maybe({ at: 1 }, 0.15),
    };
  }
  const stock = {};
  for (const loc of LOCS) {
    if (r() < 0.2) continue;
    stock[loc] = {};
    for (const pid of Object.keys(products)) {
      if (r() < 0.4) continue;
      const row = {};
      // Stock keys are drawn from the full shoe run so rows get dense enough
      // for RTDB's array coercion (>half of 0..max present) — the live shape.
      // Sizes the record does NOT declare land in cells too (stray keys).
      const pool = r() < 0.5 ? STOCK_SIZES : SIZES;
      for (const s of pool) if (r() < 0.6) row[encodeSizeKey(s) || "_"] = { qty: pick([0, 0, 1, 2, 5, -1]) };
      if (Object.keys(row).length) stock[loc][pid] = coerce(row);
    }
  }
  const targets = {};
  for (const loc of DESTS) {
    for (const pid of Object.keys(products)) {
      if (r() > 0.15) continue;
      const rows = {};
      for (const s of SIZES) if (r() < 0.4) rows[encodeSizeKey(s) || "_"] = { target: pick([0, 0, 2, 3]), minQty: 1 };
      if (Object.keys(rows).length) (targets[loc] ||= {})[pid] = rows;
    }
  }
  const run = {};
  for (const s of ["3", "5.5", "6", "7", "8"]) if (r() < 0.6) run[encodeSizeKey(s)] = { target: pick([0, 2, 3]), minQty: 1, reorderPoint: 1 };
  const leg = () => (r() < 0.7 ? { sizes: run, carriedOnly: r() < 0.8 } : undefined);
  const categoryPolicy = {};
  for (const k of ["sneakers", "slides", "designer-shoes"]) {
    if (r() < 0.3) continue;
    const e = { perSize: true };
    for (const d of DESTS) { const l = leg(); if (l) e[d] = l; }
    categoryPolicy[k] = e;
  }
  // Sometimes the category is armed through a policy GROUP rather than its own
  // entry — the destination scope must see that leg too.
  const policyGroups = r() < 0.4 ? { "footwear-all": { armed: r() < 0.7, memberCategoryKeys: ["designer-shoes", "boots", "soccer-boots"], policy: { perSize: true, hub2: { sizes: run, carriedOnly: true } } } } : undefined;
  if (policyGroups && r() < 0.5) delete categoryPolicy["designer-shoes"];
  const config = {
    policyGroups,
    mode: Object.fromEntries(DESTS.map((d) => [d, "live"])),
    routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    ruleBasedTargets: pick([true, false]),
    footwearTargets: pick([undefined, undefined, true, { hub1: true }]),
    footwearRunByLocation: r() < 0.5 ? { hub1: { 6: 2, 7: 2 } } : {},
    defaultRunByStore: { hub2: { M: 3 } },
    maxIntentsPerRun: 50, maxFootwearIntentsPerRun: 50, maxUnitsPerIntent: 20,
    categoryPolicy,
  };
  return { nowMs: NOW, config, products, stock, targets, openIndex: {}, refillRequests: {}, orders: {}, movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {}, heldLines: {} };
}

// ── the independent re-derivation ────────────────────────────────────────────
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const cells = (row) => Object.entries(row || {}).filter(([, c]) => c && typeof c === "object");
const units = (row) => cells(row).reduce((n, [, c]) => n + Math.max(num(c.qty), 0), 0);
const carries = (stock, loc, pid) => !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
const isFootwear = (p) => p?.category === "Footwear";
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// The catalogue's rule, written again from the spec, not imported.
const keyOf = (p) => {
  const k = typeof p?.categoryKey === "string" ? p.categoryKey.trim() : "";
  if (k) return k;
  return p && p.category === "Footwear" && p.subcategory === "Sneakers" ? "sneakers" : null;
};
// isClothing, written again: explicit type, else the letter-size heuristic.
const clothingLike = (p) => p?.productType ? p.productType === "clothing"
  : (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
const inGroup = (p) => !clothingLike(p) && (isFootwear(p) || GROUP.has(keyOf(p)));
// Which policy object speaks for a key: own entry if PRESENT (even garbage),
// else the lexicographically first ARMED group naming it.
const policyFor = (config, key) => {
  const own = config.categoryPolicy?.[key];
  if (own !== undefined && own !== null) return isObj(own) ? own : null;
  const groups = config.policyGroups;
  if (!isObj(groups)) return null;
  const gk = Object.keys(groups).sort().find((g) => isObj(groups[g]) && groups[g].armed === true && isObj(groups[g].policy)
    && Array.isArray(groups[g].memberCategoryKeys) && groups[g].memberCategoryKeys.includes(key));
  return gk ? groups[gk].policy : null;
};
const unitsAnywhere = (stock, pid, sk) => Object.keys(stock).reduce((n, loc) => n + Math.max(num(stock[loc]?.[pid]?.[sk]?.qty), 0), 0);
// Does a size at (loc, pid) count as DECIDED or GOVERNED — resolved from raw
// data in the engine's documented precedence: explicit row > category policy
// (own entry / armed group; per-size map ∩ declared; carriedOnly; dead-size 0
// is governance) > footwear rule > clothing rule (kill switch + size run).
function decidedOrGoverned(snap, loc, pid, sk) {
  const { config, products, stock, targets } = snap;
  const p = products[pid];
  if (p.deactivated) return false;
  const row = targets[loc]?.[pid]?.[sk];
  if (row && typeof row.target === "number") return true;
  const declared = new Set((p.sizes || []).map((s) => encodeSizeKey(String(s))));
  const key = keyOf(p);
  const pol = key ? policyFor(config, key) : null;
  const leg = pol ? pol[loc] : null;
  if (isObj(leg)) {
    const hasSizes = isObj(leg.sizes), hasTarget = leg.target !== undefined;
    const scoped = leg.carriedOnly !== undefined && leg.carriedOnly !== false;
    if (!(scoped && !carries(stock, loc, pid)) && !(hasSizes && hasTarget)) {
      if (hasSizes) {
        const usable = Object.values(leg.sizes).some((r) => typeof r?.target === "number" && r.target > 0);
        if (pol.perSize === true && usable && sk !== "_" && declared.has(sk)) {
          const r = leg.sizes[sk];
          if (isObj(r) && typeof r.target === "number" && r.target > 0) return true;   // target, or dead-size 0 — both governance
        }
      } else if (typeof leg.target === "number" && leg.target > 0) {
        if (pol.perSize === true ? (sk !== "_" && declared.has(sk)) : sk === "_") return true;
      }
    }
  }
  const ft = config.footwearTargets;
  const footOn = ft === true || (isObj(ft) && ft[loc] === true);
  if (footOn && isFootwear(p) && carries(stock, loc, pid) && declared.has(sk)) {
    const t = config.footwearRunByLocation?.[loc]?.[sk];
    if (typeof t === "number" && t > 0) return true;
  }
  const rb = config.ruleBasedTargets;
  const ruleOn = rb === true || (isObj(rb) && rb[loc] === true);
  if (ruleOn && clothingLike(p) && carries(stock, loc, pid) && declared.has(sk)) {
    const t = config.defaultRunByStore?.[loc]?.[sk];
    if (typeof t === "number" && t > 0) return true;
  }
  return false;
}
function expectedUnarmed(snap) {
  const { config, products, stock } = snap;
  const dests = Object.keys(config.routes);
  const footwearDests = dests.filter((d) => !!config.footwearRunByLocation?.[d]
    || [...GROUP].some((k) => { const pol = policyFor(config, k); const leg = pol?.[d]; if (!isObj(leg)) return false;
      const hasSizes = isObj(leg.sizes), hasTarget = leg.target !== undefined; if (hasSizes && hasTarget) return false;
      if (hasSizes) return pol.perSize === true && Object.values(leg.sizes).some((r) => typeof r?.target === "number" && r.target > 0);
      return typeof leg.target === "number" && leg.target > 0; }));
  const rawSize = (p, sk) => { for (const s of p.sizes || []) if (encodeSizeKey(String(s)) === sk) return String(s); return sk === "_" ? "" : sk.replace(/(\d)_(\d)/g, "$1.$2"); };
  const out = [];
  for (const loc of footwearDests) {
    for (const pid of Object.keys(stock[loc] || {})) {
      const p = products[pid];
      if (!inGroup(p) || p.deactivated) continue;
      const declared = new Set((p.sizes || []).map((s) => encodeSizeKey(String(s))));
      const key = keyOf(p);
      const pol = key ? policyFor(config, key) : null;
      const leg = pol?.[loc];
      const entryOk = isObj(leg) && !(isObj(leg.sizes) && leg.target !== undefined)
        && (isObj(leg.sizes) ? (pol.perSize === true && Object.values(leg.sizes).some((r) => typeof r?.target === "number" && r.target > 0)) : (typeof leg.target === "number" && leg.target > 0))
        && !((leg.carriedOnly !== undefined && leg.carriedOnly !== false) && !carries(stock, loc, pid));
      const holes = [];
      for (const [sk, c] of cells(stock[loc][pid])) {
        const q = Math.max(num(c.qty), 0);
        if (q <= 0) continue;
        if (decidedOrGoverned(snap, loc, pid, sk)) continue;
        holes.push({ size: rawSize(p, sk), units: q, reason: !key ? "no_category_key" : !entryOk ? "no_policy" : !declared.has(sk) ? "size_not_declared" : "size_outside_run" });
      }
      if (!holes.length) continue;
      holes.sort((x, y) => y.units - x.units);
      out.push({ loc, pid, units: holes.reduce((n, h) => n + h.units, 0), key, reason: holes[0].reason, sizes: holes });
    }
  }
  return out;
}
function expectedUnorderable(snap) {
  const { products, stock } = snap;
  const out = [];
  const pids = new Set(Object.values(stock).flatMap((byPid) => Object.keys(byPid || {})));
  for (const pid of pids) {
    const p = products[pid];
    if (!isFootwear(p) || (p.productType || "sneaker") === "clothing" || p.deactivated) continue;
    if (["hub1", "hub2"].some((h) => carries(stock, h, pid))) continue;
    const byLoc = {};
    let total = 0;
    for (const loc of Object.keys(stock)) {
      if (loc === "hub1" || loc === "hub2") continue;
      const u = units(stock[loc]?.[pid]);
      if (u > 0) { byLoc[loc] = u; total += u; }
    }
    if (total > 0) out.push({ pid, units: total, byLoc });
  }
  return out;
}
const sortU = (a) => [...a].sort((x, y) => x.loc.localeCompare(y.loc) || x.pid.localeCompare(y.pid));
const sortO = (a) => [...a].sort((x, y) => x.pid.localeCompare(y.pid));

test("fuzz: both buckets equal an independent re-derivation, soundness and completeness, over 3,000 random snapshots", () => {
  const r = rng(20260915);
  let listedUnarmed = 0, listedUnorderable = 0, arrays = 0, legacy = 0;
  for (let i = 0; i < 3000; i++) {
    const snap = makeCase(r);
    for (const byPid of Object.values(snap.stock)) for (const row of Object.values(byPid)) if (Array.isArray(row)) arrays++;
    for (const p of Object.values(snap.products)) if (keyOf(p) === "sneakers" && !(typeof p.categoryKey === "string" && p.categoryKey.trim())) legacy++;
    const ex = computeRefillPlan(snap).exceptions;
    const gotU = sortU(ex.unarmedFootwear.items), expU = sortU(expectedUnarmed(snap));
    assert.deepEqual(gotU, expU, `case ${i}: unarmedFootwear\n${JSON.stringify(snap)}`);
    assert.equal(ex.unarmedFootwear.count, expU.length);
    const gotO = sortO(ex.unorderableFootwear.items), expO = sortO(expectedUnorderable(snap));
    assert.deepEqual(gotO, expO, `case ${i}: unorderableFootwear\n${JSON.stringify(snap)}`);
    assert.equal(ex.unorderableFootwear.count, expO.length);
    // Ordering contract: largest hole first.
    for (const list of [ex.unarmedFootwear.items, ex.unorderableFootwear.items]) {
      for (let k = 1; k < list.length; k++) assert.ok(list[k - 1].units >= list[k].units, `case ${i}: not sorted by units desc`);
    }
    // INVARIANTS the spec cares about, checked on every listed row:
    for (const row of ex.unarmedFootwear.items) {
      assert.ok(row.units > 0);
      for (const h of row.sizes) {
        const r = snap.targets[row.loc]?.[row.pid]?.[encodeSizeKey(h.size) || "_"];
        assert.ok(!(r && typeof r.target === "number"), "an explicit row on that size means a human ruled");
        assert.ok(h.units > 0);
      }
      assert.equal(row.units, row.sizes.reduce((n, h) => n + h.units, 0));
      assert.ok(!snap.products[row.pid].deactivated);
      assert.ok(carries(snap.stock, row.loc, row.pid), "listed only where a cell exists — WHERE is never invented");
    }
    for (const row of ex.unorderableFootwear.items) {
      assert.ok(!carries(snap.stock, "hub1", row.pid) && !carries(snap.stock, "hub2", row.pid));
      assert.ok(!("hub1" in row.byLoc) && !("hub2" in row.byLoc));
    }
    listedUnarmed += gotU.length; listedUnorderable += gotO.length;
  }
  // The fuzz must have exercised what it claims to: non-trivial lists, array
  // rows, and the legacy pair.
  assert.ok(listedUnarmed > 500, `unarmed listed only ${listedUnarmed} times`);
  assert.ok(listedUnorderable > 300, `unorderable listed only ${listedUnorderable} times`);
  assert.ok(arrays > 300, `array-coerced rows generated only ${arrays} times`);
  assert.ok(legacy > 300, `legacy pair generated only ${legacy} times`);
});

test("fuzz: the key rule changes NOTHING for a record that has an assigned key — the plan is identical with the legacy pair stripped", () => {
  const r = rng(7);
  let compared = 0;
  for (let i = 0; i < 1500; i++) {
    const snap = makeCase(r);
    const keyed = Object.entries(snap.products).filter(([, p]) => typeof p.categoryKey === "string" && p.categoryKey.trim());
    if (!keyed.length) continue;
    const stripped = { ...snap.products };
    for (const [pid, p] of keyed) stripped[pid] = { ...p, subcategory: "Other" };   // only the legacy pair's second half is read anywhere
    const a = computeRefillPlan(snap), b = computeRefillPlan({ ...snap, products: stripped });
    assert.deepEqual(a.intents, b.intents, `case ${i}: intents differ`);
    assert.deepEqual(a.exceptions.unarmedFootwear, b.exceptions.unarmedFootwear, `case ${i}: unarmedFootwear differs`);
    compared++;
  }
  assert.ok(compared > 800, `compared only ${compared}`);
});
