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
// ── THE MODEL IS AN UPPER BOUND, AND IT IS A TIGHT ONE ───────────────────────
// It walks the deficit loop's arithmetic faithfully — deficit = target − on
// hand − inbound, the reorderPoint gate on physical on-hand only, avail()
// clamping a negative counted cell to 0 — and then the three gates that decide
// most of the outcome in practice:
//
//   • already in flight       (engine: `if (inb > 0) continue`)
//   • nothing anywhere        (engine: `networkQty − have <= 0` → reorder list)
//   • THE SOURCE IS EMPTY     (engine's actionable-only rule, owner v9: a
//                              request exists only if the source can physically
//                              fill it right now; qty is capped to what the
//                              source has, and units are reserved within the
//                              scan so two stores are never sent one unit)
//
// That third gate is not a detail. Measured against the live snapshot on
// 2026-08-21, caps-beanies has 293 cells below target at its two armed
// locations and the real engine creates ZERO requests for them, because their
// upstream is empty too. A model without the source gate reports 293 and would
// have panicked the owner out of a change that actually costs 19 requests.
//
// What it still does NOT model — every one of which can only REMOVE a request,
// so the number stays a ceiling: confirmed-out, reject streaks, retry cooldown,
// the recount park, and the global round-robin throttle. Two INBOUND sources are
// also unmodelled and lean the same way: manual "Shop Refill" order lines and
// held central->hub lines both count as inbound to the engine, so a cell with
// one of those in flight can read here as a request the engine will not make.
// Callers must present `wouldRequest` as "at most".
//
// Destination MODE is reported per leg rather than folded in — see modeOf
// below. The totals mirror computeRefillPlan, which computes intents for
// shadow and off destinations too; only a "live" destination has them written.
//
// test/category-policy-differential.test.cjs holds all of this to the real
// computeRefillPlan over 400 generated worlds, and the census script runs the
// real engine alongside the model on the live snapshot — so the residual gap is
// measured rather than assumed.

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

// Mirrors of refill-engine.cjs's own fallbacks, so an absent config key models
// what the engine would actually do rather than what is convenient here.
const ENGINE_DEFAULT_MAX_UNITS_PER_INTENT = 20;
const ENGINE_DEFAULT_MAX_INTENTS_PER_RUN = 200;
const MAX_REORDER_POINT = 500;

// `visors` was re-keyed out of the live map deliberately and carries NO policy.
// It still EXISTS as a taxonomy category, so it renders in the card as an
// unarmed row — but writing it is refused here, at the server, because the only
// way it could be armed is by mistake.
const REFUSED_CATEGORY_KEYS = new Set(["visors"]);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// refill-engine.cjs's `num()`, mirrored: anything that is not a finite number
// is 0, NOT coerced. Callers then apply their own `|| 1` fallback exactly as
// the engine does, so a string qty resolves identically on both sides.
const engineNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
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
  // A SINGLE RTDB KEY SEGMENT, checked here rather than trusted. The key is
  // interpolated straight into `config/refillEngine/categoryPolicy/${key}`, and
  // the taxonomy allow-list below only bites when /settings/productTaxonomy
  // read back non-empty — so an unreadable or unseeded taxonomy would let a key
  // containing "/" write to a nested path somewhere else entirely. RTDB also
  // forbids . # $ [ ] in keys outright.
  if (!/^[A-Za-z0-9_-]+$/.test(categoryKey)) {
    return `categoryKey must be letters, digits, hyphens or underscores only (got ${JSON.stringify(categoryKey)})`;
  }
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
  // ── THE LEGS ARE NOT JUST THE ARMED ONES ──────────────────────────────────
  // The engine's managedPids starts from Object.keys(targets[dest]) — a product
  // with an explicit row is managed at that destination whether or not the map
  // names it. So a category can produce real refills at a location this policy
  // has never armed, off legacy rows alone.
  //
  // Walking only the armed locations made the model UNDER-report, which is the
  // one direction that matters: the panel says "the next scan asks for at most
  // N refills" and it was quietly excluding whole destinations. Found by the
  // differential fuzz in test/category-policy-differential.test.cjs — 27 of 400
  // generated worlds, every one of them this shape.
  //
  // Unarmed legs carry no map numbers (target/minQty/reorderPoint null) and are
  // marked armed:false, so the editor still refuses to treat them as policy —
  // but their rows are counted, because the engine counts them.
  const dests = Object.keys(config?.mode || {});
  const hasRowsHere = (loc) => pids.some((pid) => Object.keys(targets?.[loc]?.[pid] || {}).length > 0);
  const legLocs = [...new Set([...armedLocs, ...dests.filter(hasRowsHere)])];
  // A destination's MODE decides whether the scan writes anything at all:
  // refill-scan.cjs only persists requests for mode "live" — "shadow" produces
  // read-only artifacts and "off" produces nothing. computeRefillPlan still
  // COMPUTES intents for those destinations (which is why the totals below
  // include them, and why the differential test against computeRefillPlan
  // matches), so the mode is reported per leg instead of being silently folded
  // in. A caller presenting "the scan will ask for N" must say which of those
  // N land at a destination that is not live.
  const modeOf = (loc) => (config?.mode || {})[loc] || "off";
  const perSize = isPlainObject(cat) && cat.perSize === true;
  const ctx = { targets, config, products, stock };
  // THE ENGINE'S OWN DEFAULTS, not convenient ones. refill-engine.cjs falls
  // back to 20 units per intent and 200 intents per run when the config keys
  // are absent. Defaulting to Infinity/null here made the model overstate units
  // by up to 10x on an absent key, and quietly disabled the over-cap warning
  // altogether — both in the direction of a preview the owner cannot trust.
  const capUnits = typeof maxUnitsPerIntent === "number" && maxUnitsPerIntent > 0
    ? maxUnitsPerIntent : ENGINE_DEFAULT_MAX_UNITS_PER_INTENT;
  const routes = config?.routes && typeof config.routes === "object" ? config.routes : {};
  const qtyAt = (loc, pid, sizeKey) =>
    Math.max(typeof stock?.[loc]?.[pid]?.[sizeKey]?.qty === "number" ? stock[loc][pid][sizeKey].qty : 0, 0);
  // Units of one cell across the WHOLE network — the engine's networkQty. A
  // deficit with nothing anywhere upstream is a supplier reorder, never a
  // request.
  const networkQty = (pid, sizeKey) => {
    let n = 0;
    for (const loc of Object.keys(stock || {})) n += qtyAt(loc, pid, sizeKey);
    return n;
  };
  // ── SOURCE RESERVATIONS ───────────────────────────────────────────────────
  // Units at a source already promised to somebody. Two contributions, and
  // missing the first was a real over-reporting bug found by the differential
  // fuzz: the engine SEEDS this map from every open request before the deficit
  // loop starts (refill-engine.cjs:569-577), because a unit already committed
  // to an open lock cannot also be sent somewhere else. Starting empty let the
  // model promise the same physical unit twice.
  //
  // The second contribution is within-pass: a request earlier in this model
  // claims its units, exactly as the scan does. Locations are walked in the
  // map's key order rather than the scan's destination order, so WHICH of two
  // competing legs wins a scarce unit can differ — the total cannot.
  const reserved = new Map();
  for (const [dest, byPid] of Object.entries(openIndex || {})) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      for (const [sizeKey, entry] of Object.entries(bySize || {})) {
        if (!entry) continue;
        const src = entry.source || routes[dest];
        if (!src) continue;
        const k = `${src}|${pid}|${sizeKey}`;
        // num(), not Number(): the engine maps a non-finite qty to 0 and then
        // falls back to 1. `Number("6") || 1` is 6 where the engine reserves 1,
        // which over-reserves the source and can park a cell the engine would
        // have filled — the under-report direction.
        reserved.set(k, (reserved.get(k) || 0) + (engineNum(entry.qty) || 1));
      }
    }
  }

  const legs = [];
  const overriddenPids = new Set();
  const legacyPids = new Set();
  for (const loc of legLocs) {
    let cells = 0, wouldRequest = 0, unitsWanted = 0, silent = 0, atTarget = 0, onHand = 0, overrides = 0;
    let parkedNoSource = 0, parkedNothingAnywhere = 0, inFlight = 0, legacyRows = 0;
    const overrideRows = [], legacyRowList = [];
    const src = routes[loc] || null;
    for (const pid of pids) {
      // ── THE SIZES THE DEFICIT LOOP WOULD ACTUALLY WALK ────────────────────
      // sizesFor() (refill-engine.cjs) STARTS from the explicit rows that
      // already exist for this cell and then ADDS the map's sizes. Deriving the
      // list from the map alone was a real hole, and it hid the one number this
      // screen is built around: a one-size category whose legacy products still
      // carry letter rows would report "0 overridden" and "asks for nothing"
      // while the engine issued requests off those very rows — exactly the
      // "79 fitted caps still carry introduce-existing letter rows" case.
      //
      // Keyed by ENCODED size, like the engine's Set, so a product declaring
      // both "5.5" and "5 5" (both encode to 5_5) is walked once rather than
      // twice — walked twice it would double-count the cell and double-reserve
      // against the source.
      const bySizeKey = new Map();
      const add = (raw) => { const k = encodeSizeKey(raw); if (!bySizeKey.has(k)) bySizeKey.set(k, raw); };
      for (const k of Object.keys(targets?.[loc]?.[pid] || {})) {
        // Recover the declared size this row is about, so resolveTarget is
        // asked the same question the engine asks it. A row on a size the
        // product no longer declares still counts — the engine honours it.
        const declared = (products[pid]?.sizes || []).map(String).find((sz) => encodeSizeKey(sz) === k);
        add(declared === undefined ? k : declared);
      }
      if (perSize) for (const sz of (products[pid]?.sizes || []).map(String)) { if (sz !== "_") add(sz); }
      else add("_");

      // The sizes THIS map entry speaks for, encoded — the test that separates
      // an override from a legacy row below.
      // At a leg the map does not arm it speaks for NOTHING, so every explicit
      // row there is a legacy row rather than an override — there is nothing to
      // override.
      const mapSpeaksFor = new Set(!armedLocs.includes(loc) ? []
        : perSize
          ? (products[pid]?.sizes || []).map(String).filter((sz) => sz !== "_").map(encodeSizeKey)
          : ["_"]);

      let pidOverridden = false;
      for (const [sizeKey, size] of bySizeKey) {
        const t = resolveTarget(ctx, loc, pid, size);
        if (!t || t.target <= 0) continue;
        cells += 1;
        if (t.source === "explicit") {
          // ── OVERRIDE vs LEGACY ROW — a distinction worth the extra field ───
          // An explicit row only OVERRIDES THE MAP when it sits on a size the
          // map actually speaks for: the "_" cell in one-size mode, a declared
          // size in per-size mode. A row on any other size is a LEGACY ROW —
          // the engine walks it and it produces real requests, but the map was
          // never going to govern that cell, so it contradicts nothing.
          //
          // Conflating the two is not academic. Measured on the live estate
          // 2026-08-21, caps-beanies has 188 explicit rows on 94 products and
          // EVERY ONE is on a letter size (S or M) left behind by the headwear
          // one-size collapse — while the map is one-size and speaks only for
          // "_". Reported as overrides that reads "94 products ignore your
          // numbers", which is false and would have stopped a correct change.
          // Reported as legacy rows it reads "94 products still carry old
          // sized rows", which is true and is a cleanup task.
          const row = { pid, name: products[pid]?.name || "", size: sizeKey, target: t.target,
            minQty: t.minQty ?? null, reorderPoint: t.reorderPoint ?? null };
          if (mapSpeaksFor.has(sizeKey)) {
            overrides += 1;
            pidOverridden = true;
            if (overrideRows.length < 200) overrideRows.push(row);
          } else {
            legacyRows += 1;
            legacyPids.add(pid);
            if (legacyRowList.length < 200) legacyRowList.push(row);
          }
        }
        const have = qtyAt(loc, pid, sizeKey);
        onHand += have;
        const inboundEntry = openIndex?.[loc]?.[pid]?.[sizeKey];
        const inbound = inboundEntry ? (engineNum(inboundEntry.qty) || 1) : 0;
        const deficit = t.target - have - inbound;
        if (deficit <= 0) { atTarget += 1; continue; }
        // The gate reads PHYSICAL on-hand only — inbound is already inside
        // `deficit` above, so a cell with stock on the way never reaches here.
        if (t.reorderPoint != null && have > t.reorderPoint) { silent += 1; continue; }
        // Already on its way — the engine skips the cell outright rather than
        // topping up a partial delivery.
        if (inbound > 0) { inFlight += 1; continue; }
        // Nothing anywhere else in the network → reorder list, not a request.
        if (networkQty(pid, sizeKey) - have <= 0) { parkedNothingAnywhere += 1; continue; }
        // ACTIONABLE-ONLY: a request exists only if the source can fill it now.
        const srcKey = `${src}|${pid}|${sizeKey}`;
        const srcAvail = src ? qtyAt(src, pid, sizeKey) - (reserved.get(srcKey) || 0) : 0;
        if (srcAvail <= 0) { parkedNoSource += 1; continue; }
        const qty = Math.min(deficit, srcAvail, capUnits);
        reserved.set(srcKey, (reserved.get(srcKey) || 0) + qty);
        wouldRequest += 1;
        unitsWanted += qty;
      }
      if (pidOverridden) overriddenPids.add(pid);
    }
    const c = carriage[loc] || { carries: false, products: 0, units: 0 };
    const mapped = isPlainObject(cat) && isPlainObject(cat[loc]) ? cat[loc] : null;
    legs.push({
      loc,
      carries: c.carries,
      // false = this leg's refills come from explicit rows alone; the policy
      // being edited has no say over it.
      armed: armedLocs.includes(loc),
      // "live" | "shadow" | "off" — only a live destination has its requests
      // written by the scan.
      mode: modeOf(loc),
      target: mapped?.target ?? null,
      minQty: mapped?.minQty ?? null,
      reorderPoint: mapped?.reorderPoint ?? null,
      source: src,
      cells, wouldRequest, unitsWanted, silent, atTarget, onHand,
      inFlight, parkedNoSource, parkedNothingAnywhere,
      legacyRows, legacyRowList,
      // Everything below target that produces no request: in flight, nothing
      // anywhere, or the source is empty. The card shows this so "0 requests"
      // never reads as "0 shortfall".
      parked: parkedNoSource + parkedNothingAnywhere,
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
  // The subset the scan actually writes. Reported alongside the total rather
  // than replacing it, so the number stays comparable to computeRefillPlan
  // while the card can still say "of which N land at a live shop".
  const liveRequests = legs.filter((l) => l.mode === "live").reduce((n, l) => n + l.wouldRequest, 0);
  const liveUnits = legs.filter((l) => l.mode === "live").reduce((n, l) => n + l.unitsWanted, 0);
  const cap = typeof maxIntentsPerRun === "number" && maxIntentsPerRun > 0
    ? maxIntentsPerRun : ENGINE_DEFAULT_MAX_INTENTS_PER_RUN;
  return {
    categoryKey,
    perSize,
    products: pids.length,
    armedLocations: armedLocs,
    // Legs that produce refills off explicit rows alone, with no map entry.
    unarmedLegsWithRows: legLocs.filter((l) => !armedLocs.includes(l)),
    carriage,
    legs,
    centralOnHand,
    totalRequests,
    totalUnits,
    liveRequests,
    liveUnits,
    nonLiveLegs: legs.filter((l) => l.mode !== "live" && l.wouldRequest > 0).map((l) => ({ loc: l.loc, mode: l.mode, requests: l.wouldRequest })),
    overriddenProducts: overriddenPids.size,
    overriddenProductIds: [...overriddenPids],
    // Rows the engine honours on sizes the map does not speak for. Not an
    // override — a cleanup backlog.
    legacyRowCells: legs.reduce((n, l) => n + l.legacyRows, 0),
    legacyRowProducts: legacyPids.size,
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
  ENGINE_DEFAULT_MAX_UNITS_PER_INTENT, ENGINE_DEFAULT_MAX_INTENTS_PER_RUN,
  validatePolicyEntry, validateCategoryPolicy, diffCategoryPolicy,
  carriageForCategory, modelCategoryPolicy, defaultMinQty,
};
