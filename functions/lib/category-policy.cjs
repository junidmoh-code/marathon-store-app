// ─── CATEGORY POLICY — VALIDATION, DIFF, AND THE DAY-ONE MODEL ────────────────
//
// ONE module, THREE readers, and that is the whole point of it existing:
//
//   • scripts/model-category-policy.mjs — the read-only census + model (writes
//     nothing, ever).
//   • functions/index.js setCategoryPolicy — validates the owner's edit, and
//     answers its dryRun preview.
//   • src/components/stock/EnginePolicyCard.jsx — renders the preview the
//     callable returned. It does NOT re-derive it; the card has no engine in it.
//
// The card's "what happens on the next scan" panel and the script's day-one
// table are therefore the SAME numbers from the SAME code. A second
// implementation in the browser would be a model of the model, and would drift
// the moment the engine changed underneath it.
//
// ── WHAT THIS FILE IS *NOT* ──────────────────────────────────────────────────
// It is not a reimplementation of target resolution. `resolveTarget` is
// imported from refill-engine.cjs and called directly, so the precedence order
//
//     explicit /stock_targets row  >  category map  >  footwear rule
//     >  kill switch  >  subcategory  >  size run
//
// is the engine's own, not a copy of it. That precedence is exactly why a map
// edit can look like it did nothing: 79 fitted caps still carry explicit
// introduce-existing letter rows, and every one of them outranks the map.
// Counting those overrides is a first-class output here for that reason.
//
// ── THE MODEL IS AN UPPER BOUND, AND SAYS SO ─────────────────────────────────
// It walks the deficit loop's arithmetic faithfully (deficit = target − on hand
// − inbound; the reorderPoint gate on physical on-hand only; avail() clamping a
// negative counted cell to 0) but it does NOT run the scan's suppression
// passes: confirmed-out, reject streaks, retry cooldown, in-flight detection,
// or the round-robin throttle. Every one of those can only REMOVE a request.
// So `wouldRequest` is the ceiling, never the floor — which is the safe
// direction for a number whose job is to warn the owner before they arm
// something. Callers must present it as a ceiling. The census script runs the
// REAL computeRefillPlan alongside this and prints both, so the size of the gap
// between them is measured rather than assumed.

const { resolveTarget, encodeSizeKey } = require("./refill-engine.cjs");

// The map's own vocabulary. Kept here rather than inline so the callable, the
// card and the script cannot disagree about what a field is called.
const POLICY_FIELDS = ["target", "minQty", "reorderPoint"];

// Hard ranges. Deliberately generous at the top (a hub keeping 200 of one line
// is unusual, not impossible) and absolutely closed at the bottom: a negative
// reorderPoint is the silent-starvation case the engine's own comment calls out
// — `have > -1` is true for every non-negative on-hand, so the cell would never
// be replenished again.
const MAX_TARGET = 500;
const MAX_REORDER_POINT = 500;

// `visors` was re-keyed out of the live map deliberately and carries NO policy.
// It still EXISTS as a taxonomy category, so it renders in the card as an
// unarmed row — but writing it is refused here, at the server, because the only
// way it could be armed is by mistake.
const REFUSED_CATEGORY_KEYS = new Set(["visors"]);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isCount = (v, max) => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= max;

// ── VALIDATION ───────────────────────────────────────────────────────────────
// Returns null when clean, or a human-readable string naming the offending
// field. The strings are surfaced verbatim to the owner in the card, so they
// say what is wrong rather than "invalid".
//
// minQty IS REQUIRED ALONGSIDE target, and that is not this file's opinion: the
// LIVE rule on /stock_targets requires hasChildren(['target','minQty']). The
// category map governs the same cells that node does; letting a map entry omit
// minQty would produce a policy the engine honours but no explicit row of the
// same shape could ever be written to mirror. So the two are kept in lockstep.
function validatePolicyEntry(entry, { where = "entry" } = {}) {
  if (!isPlainObject(entry)) return `${where}: must be an object`;
  for (const k of Object.keys(entry)) {
    if (!POLICY_FIELDS.includes(k)) return `${where}: unknown field "${k}" (allowed: ${POLICY_FIELDS.join(", ")})`;
  }
  if (!isCount(entry.target, MAX_TARGET) || entry.target <= 0) {
    return `${where}: target must be a whole number from 1 to ${MAX_TARGET}`;
  }
  if (!isCount(entry.minQty, MAX_TARGET)) {
    return `${where}: minQty is required alongside target and must be a whole number from 0 to ${MAX_TARGET}`;
  }
  if (entry.minQty > entry.target) return `${where}: minQty (${entry.minQty}) cannot exceed target (${entry.target})`;
  if (entry.reorderPoint !== undefined) {
    if (!isCount(entry.reorderPoint, MAX_REORDER_POINT)) {
      return `${where}: reorderPoint must be a whole number from 0 to ${MAX_REORDER_POINT}`;
    }
    // reorderPoint >= target is not a typo the engine can survive quietly: the
    // gate is `have > reorderPoint → stay silent`, and a deficit only exists
    // below target, so a point at or above target can only ever mean "ask at
    // every scan", which is what NO reorderPoint already means. Refusing it
    // keeps the field's meaning honest.
    if (entry.reorderPoint >= entry.target) {
      return `${where}: "Ask at" (${entry.reorderPoint}) must be below "Keep" (${entry.target}) — at or above it the setting does nothing`;
    }
  }
  return null;
}

// A whole category's proposed entry: { perSize?: bool, "<loc>": {…} }.
// `knownLocations` and `knownCategoryKeys` are passed in (never hardcoded) so
// this file has no private idea of what the estate looks like.
function validateCategoryPolicy(categoryKey, cat, { knownLocations, knownCategoryKeys }) {
  if (typeof categoryKey !== "string" || !categoryKey) return "categoryKey must be a non-empty string";
  if (REFUSED_CATEGORY_KEYS.has(categoryKey)) {
    return `"${categoryKey}" carries no policy by owner decision and cannot be armed here`;
  }
  if (Array.isArray(knownCategoryKeys) && knownCategoryKeys.length && !knownCategoryKeys.includes(categoryKey)) {
    return `unknown categoryKey "${categoryKey}" — it is not in /settings/productTaxonomy`;
  }
  // null = delete the entry = the documented OFF SWITCH. Legal, and the only
  // way to un-arm a category (deleting the products' rows does not do it).
  if (cat === null) return null;
  if (!isPlainObject(cat)) return "policy must be an object, or null to un-arm the category";
  const locs = Object.keys(cat).filter((k) => k !== "perSize");
  if (!locs.length) return "policy must name at least one location (or be null to un-arm)";
  if (cat.perSize !== undefined && typeof cat.perSize !== "boolean") return "perSize must be true or false";
  for (const loc of locs) {
    if (Array.isArray(knownLocations) && knownLocations.length && !knownLocations.includes(loc)) {
      return `unknown location "${loc}"`;
    }
    const err = validatePolicyEntry(cat[loc], { where: loc });
    if (err) return err;
  }
  return null;
}

// ── DIFF — "old -> new", per field ───────────────────────────────────────────
// Drives the card's changed-fields banner AND the audit entry, from one place,
// so what the owner was shown and what was recorded cannot differ.
// Absent is rendered as null, never as 0: "reorderPoint absent" (eager top-up)
// and "reorderPoint 0" (ask only when empty) are different policies.
function diffCategoryPolicy(before, after) {
  const out = [];
  const b = isPlainObject(before) ? before : {};
  const a = after === null ? {} : (isPlainObject(after) ? after : {});
  if ((b.perSize === true) !== (a.perSize === true)) {
    out.push({ loc: null, field: "perSize", from: b.perSize === true, to: a.perSize === true });
  }
  const locs = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k !== "perSize").sort();
  for (const loc of locs) {
    const bl = isPlainObject(b[loc]) ? b[loc] : null;
    const al = isPlainObject(a[loc]) ? a[loc] : null;
    if (bl && !al) { out.push({ loc, field: "location", from: "armed", to: "removed" }); continue; }
    if (!bl && al) { out.push({ loc, field: "location", from: "not armed", to: "armed" }); }
    for (const f of POLICY_FIELDS) {
      const from = bl && bl[f] !== undefined ? bl[f] : null;
      const to = al && al[f] !== undefined ? al[f] : null;
      if (from !== to) out.push({ loc, field: f, from, to });
    }
  }
  return out;
}

// ── CARRIAGE ─────────────────────────────────────────────────────────────────
// A location CARRIES a category when it holds at least one cell of at least one
// product in it. Cell PRESENCE, not units — that is what storeCarries() tests,
// and a design sitting at 0 on a shelf it normally stocks is still assortment.
//
// This is the gate the card uses to decide whether a location's row is
// editable, and it matters more here than anywhere else in the engine: a
// category-mapped product is managed at a mapped location UNCONDITIONALLY (see
// managedPids in refill-engine.cjs — no carriage gate, by design, so a
// script-imported perfume with no cell anywhere still resolves its buffer).
// Arming a location that does not carry the category therefore does not "do
// nothing" — it manufactures demand for EVERY product in that category at a
// store that has never stocked one. That is the PE/Trophy clothing
// contamination shape, and the reason "Not carried" is a refusal in the UI
// rather than a warning.
//
// `unitsHeld` is reported alongside because the two answers differ and the gap
// is itself evidence: marathon-pine's headwear cells were all zero husks left
// by a reconciliation run, not an assortment.
function carriageForCategory({ products, stock, categoryKey, locations }) {
  const pids = Object.keys(products || {}).filter((pid) => products[pid]?.categoryKey === categoryKey);
  const locs = Array.isArray(locations) && locations.length ? locations : Object.keys(stock || {});
  const out = {};
  for (const loc of locs) {
    let cells = 0, units = 0, withStock = 0;
    for (const pid of pids) {
      const bySize = stock?.[loc]?.[pid];
      if (!bySize || !Object.keys(bySize).length) continue;
      cells += 1;
      let u = 0;
      for (const c of Object.values(bySize)) u += Math.max(typeof c?.qty === "number" ? c.qty : 0, 0);
      units += u;
      if (u > 0) withStock += 1;
    }
    out[loc] = { carries: cells > 0, products: cells, productsHoldingStock: withStock, units };
  }
  return { pids, byLocation: out };
}

// ── THE DAY-ONE MODEL ────────────────────────────────────────────────────────
// Applies a proposed category map to a COPY of the live config and walks the
// deficit loop's arithmetic over the category's cells at each named location.
//
// `configAfter` is built by the caller (never mutated here) so the same
// function answers "what does the map do today" (configBefore) and "what would
// it do after this edit" (configAfter), and the card can show both.
function modelCategoryPolicy({
  config, products, stock, targets, openIndex,
  categoryKey, locations, maxIntentsPerRun, maxUnitsPerIntent,
}) {
  const { pids, byLocation: carriage } = carriageForCategory({ products, stock, categoryKey, locations });
  const cat = config?.categoryPolicy?.[categoryKey];
  const armedLocs = isPlainObject(cat)
    ? Object.keys(cat).filter((k) => k !== "perSize" && isPlainObject(cat[k]))
    : [];
  const perSize = isPlainObject(cat) && cat.perSize === true;
  const ctx = { targets, config, products, stock };
  const capUnits = typeof maxUnitsPerIntent === "number" && maxUnitsPerIntent > 0 ? maxUnitsPerIntent : Infinity;

  const legs = [];
  const overriddenPids = new Set();
  for (const loc of armedLocs) {
    let cells = 0, wouldRequest = 0, unitsWanted = 0, silent = 0, atTarget = 0, onHand = 0, overrides = 0;
    const overrideRows = [];
    for (const pid of pids) {
      // The sizes the deficit loop would walk for this cell — sizesFor()'s
      // category branch, exactly: one-size mode walks "_" alone, per-size mode
      // walks every declared catalogue size.
      const sizes = perSize ? (products[pid]?.sizes || []).map(String).filter((s) => s !== "_") : ["_"];
      let pidOverridden = false;
      for (const size of sizes) {
        const sizeKey = encodeSizeKey(size);
        const t = resolveTarget(ctx, loc, pid, size);
        if (!t || t.target <= 0) continue;
        cells += 1;
        if (t.source === "explicit") {
          overrides += 1;
          pidOverridden = true;
          if (overrideRows.length < 200) {
            overrideRows.push({ pid, name: products[pid]?.name || "", size: sizeKey, target: t.target,
              minQty: t.minQty ?? null, reorderPoint: t.reorderPoint ?? null });
          }
        }
        const have = Math.max(typeof stock?.[loc]?.[pid]?.[sizeKey]?.qty === "number" ? stock[loc][pid][sizeKey].qty : 0, 0);
        onHand += have;
        const inbound = Number(openIndex?.[loc]?.[pid]?.[sizeKey]?.qty) || (openIndex?.[loc]?.[pid]?.[sizeKey] ? 1 : 0);
        const deficit = t.target - have - inbound;
        if (deficit <= 0) { atTarget += 1; continue; }
        // The gate reads PHYSICAL on-hand only — inbound is already inside
        // `deficit` above, so a cell with stock on the way never reaches here.
        if (t.reorderPoint != null && have > t.reorderPoint) { silent += 1; continue; }
        wouldRequest += 1;
        unitsWanted += Math.min(deficit, capUnits);
      }
      if (pidOverridden) overriddenPids.add(pid);
    }
    const c = carriage[loc] || { carries: false, products: 0, units: 0 };
    legs.push({
      loc,
      carries: c.carries,
      target: cat[loc]?.target ?? null,
      minQty: cat[loc]?.minQty ?? null,
      reorderPoint: cat[loc]?.reorderPoint ?? null,
      cells, wouldRequest, unitsWanted, silent, atTarget, onHand,
      overrides, overrideRows,
    });
  }

  // Central is the only place a hub deficit can be filled from, so its on-hand
  // for this category is reported next to what the policy wants. It is NOT a
  // hard gate — a shortfall parks against a purchase order rather than
  // failing — but it is the number that decides whether "armed" means
  // "delivered this week" or "a queue of cards nobody can fill".
  let centralOnHand = 0;
  for (const pid of pids) {
    for (const c of Object.values(stock?.central?.[pid] || {})) {
      centralOnHand += Math.max(typeof c?.qty === "number" ? c.qty : 0, 0);
    }
  }

  const totalRequests = legs.reduce((n, l) => n + l.wouldRequest, 0);
  const totalUnits = legs.reduce((n, l) => n + l.unitsWanted, 0);
  const cap = typeof maxIntentsPerRun === "number" && maxIntentsPerRun > 0 ? maxIntentsPerRun : null;
  return {
    categoryKey,
    perSize,
    products: pids.length,
    armedLocations: armedLocs,
    carriage,
    legs,
    centralOnHand,
    totalRequests,
    totalUnits,
    overriddenProducts: overriddenPids.size,
    overriddenProductIds: [...overriddenPids],
    cap,
    // The cap is GLOBAL and dealt round-robin across destinations — every other
    // clothing category competes for the same 75. Over it means this category
    // alone would fill the scan; under it does NOT mean the whole scan fits.
    exceedsCap: cap != null && totalRequests > cap,
    exceedsCentral: totalUnits > centralOnHand,
    upperBound: true,
  };
}

// The default a first-time policy is seeded with, so "Minimum" is never typed
// from scratch. ceil(keep / 2) is the ratio every armed batch has used to date
// (8/4, 10/5, 5/3) and is what the engine itself falls back to when a map entry
// omits minQty — so seeding it changes nothing about behaviour and everything
// about how much the owner has to type.
const defaultMinQty = (target) => (typeof target === "number" && target > 0 ? Math.ceil(target / 2) : 0);

module.exports = {
  POLICY_FIELDS, MAX_TARGET, MAX_REORDER_POINT, REFUSED_CATEGORY_KEYS,
  validatePolicyEntry, validateCategoryPolicy, diffCategoryPolicy,
  carriageForCategory, modelCategoryPolicy, defaultMinQty,
};
