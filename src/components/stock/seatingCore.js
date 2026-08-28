// ─── SEATING — THE ONE CARRIAGE ANSWER ───────────────────────────────────────
//
// "Does this location carry this product, and WHY." One function. The Seating
// tab asks it and renders the answer; it re-derives nothing of its own.
//
// ── WHAT CARRIAGE ACTUALLY IS, TODAY, IN PRODUCTION ──────────────────────────
//
// NOT movement provenance. The /stock_provenance cutover (PRs #376/#377/#381/
// #382/#390) was REVERSED by owner order on 2026-08-20 (PR #395), and the
// reversal is what is deployed: the source zip of functions:refillHealthScan
// downloaded 2026-08-24 contains ZERO references to stock_provenance or
// carriesByIndex, and its lib/refill-engine.cjs is byte-identical to this
// repo's (md5 57a9729182033ebe07bee8c776ea3758). Carriage is decided by
// resolveTarget, and resolveTarget's only carriage predicate is storeCarries —
// CELL EXISTENCE. Anything written against the provenance model would answer a
// question production does not ask.
//
// ── THE PRECEDENCE, PROVEN FROM refill-engine.cjs, NOT ASSUMED ───────────────
//
//   1. explicit /stock_targets/{loc}/{pid}/{sizeKey} row   :468  — ALWAYS WINS
//   2. /config/refillEngine/categoryPolicy (+ policyGroups) :505
//   3. the footwear rule            (needs storeCarries)   :520
//   4. the clothing kill switch                            :543
//   5. the clothing rule            (needs storeCarries)   :546  — subcategory
//                                                                 run, then the
//                                                                 size run
//
// An explicit row with `target: 0` therefore OUTRANKS every rule below it. That
// is what makes it the off switch, and it is the one this file writes through
// (see seatingStore.js). It is also already the off switch the Decision Queue
// uses — NoTargetQueue.jsx:325 `excludeHere` — so nothing new is invented here.
//
// ── WHY THIS FILE IS A MIRROR, AND WHAT KEEPS IT HONEST ──────────────────────
//
// The browser bundle cannot import functions/. So resolveTarget is mirrored
// here, and a mirror nothing checks is a mirror that drifts. seatingCore.test.js
// DIFFERENTIAL-FUZZES this file against the real refill-engine.cjs export over
// randomised catalogues, configs, stock and target rows: every case must agree
// on the resolved target, not merely on the cases somebody thought to write
// down. If the engine changes, that test goes red before this screen can lie.
//
// ── encodeSizeKey IS THE ENGINE'S, NOT src/utils/sizeKey.js ──────────────────
// They differ: the engine trims and maps "" → "_", the client encoder returns
// "" unchanged. Target resolution is the engine's question, so the engine's
// encoder is the one that answers it. Pinned by the same differential test.

// ── engine primitives, mirrored ──────────────────────────────────────────────

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const avail = (q) => Math.max(q, 0);
const positiveTarget = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

// refill-engine.cjs:31 — NOT src/utils/sizeKey.js (see the header note).
export function engineSizeKey(size) {
  const s = String(size == null ? "" : size).trim();
  if (!s) return "_";
  return s.replace(/[.#$/[\]\s]/g, "_");
}

// refill-engine.cjs:174
export function isClothing(product) {
  if (!product) return false;
  if (product.productType) return product.productType === "clothing";
  return (product.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
}

// refill-engine.cjs:198 — CATEGORY, not productType.
export function isFootwear(product) {
  return product?.category === "Footwear";
}

// refill-engine.cjs:237 / :262 — both fail-safe: absent or garbled means OFF.
export const ruleTargetsEnabled = (config, dest) => switchOn(config?.ruleBasedTargets, dest);
export const footwearTargetsEnabled = (config, dest) => switchOn(config?.footwearTargets, dest);
function switchOn(v, dest) {
  if (v === true) return true;
  if (isObj(v)) return v[dest] === true;
  return false;
}

// refill-engine.cjs:300 — positive finite only; a 0 at policy level is a typo,
// not an exclusion (that meaning belongs to a row a human wrote).
export function subcategoryRun(config, products, pid, dest) {
  const sub = products?.[pid]?.subcategory;
  if (typeof sub !== "string" || !sub) return null;
  const run = config?.subcategoryRunByLocation?.[dest];
  if (!isObj(run)) return null;
  const t = run[sub];
  return positiveTarget(t) ? t : null;
}

// ── policy-resolve.cjs, mirrored (a leaf module there, a leaf block here) ────

function locationEntryMode(locEntry) {
  if (!isObj(locEntry)) return "invalid";
  const hasSizes = isObj(locEntry.sizes);
  const hasTarget = locEntry.target !== undefined;
  if (hasSizes && hasTarget) return "invalid";
  if (hasSizes) return "per-size";
  if (hasTarget) return "uniform";
  return "invalid";
}

// A category with its OWN entry never consults a group — and "own entry" means
// THE KEY IS PRESENT, not "the key holds something readable". A garbled own
// entry arms nothing and falls through to nothing.
export function armedGroupForCategory(config, categoryKey) {
  if (typeof categoryKey !== "string" || !categoryKey) return null;
  const own = config?.categoryPolicy?.[categoryKey];
  if (own !== undefined && own !== null) return null;
  const groups = config?.policyGroups;
  if (!isObj(groups)) return null;
  const claiming = Object.keys(groups).sort().filter((gk) => {
    const g = groups[gk];
    if (!isObj(g)) return false;
    if (g.armed !== true) return false;
    if (!isObj(g.policy)) return false;
    return Array.isArray(g.memberCategoryKeys) && g.memberCategoryKeys.includes(categoryKey);
  });
  if (!claiming.length) return null;
  return { groupKey: claiming[0], group: groups[claiming[0]], overlaps: claiming.slice(1) };
}

export function effectivePolicyFor(config, categoryKey) {
  const own = config?.categoryPolicy?.[categoryKey];
  if (isObj(own)) return { entry: own, source: "category", groupKey: null };
  const g = armedGroupForCategory(config, categoryKey);
  if (!g) return null;
  return { entry: g.group.policy, source: "group", groupKey: g.groupKey };
}

function locationPolicyFor(config, categoryKey, dest) {
  const eff = effectivePolicyFor(config, categoryKey);
  if (!eff) return null;
  const cat = eff.entry;
  if (!isObj(cat)) return null;
  const loc = cat[dest];
  const mode = locationEntryMode(loc);
  if (mode === "invalid") return null;
  const perSize = cat.perSize === true;
  if (mode === "per-size") {
    if (!perSize) return null;
    const usable = Object.keys(loc.sizes).some((k) => positiveTarget(loc.sizes[k]?.target));
    if (!usable) return null;
    return { perSize: true, mode, target: null, minQty: null, reorderPoint: null,
      sizes: loc.sizes, carriedOnly: carriedOnlyOf(loc), source: eff.source, groupKey: eff.groupKey };
  }
  if (!positiveTarget(loc.target)) return null;
  return { perSize, mode, target: loc.target, minQty: loc.minQty, reorderPoint: loc.reorderPoint,
    sizes: null, carriedOnly: carriedOnlyOf(loc), source: eff.source, groupKey: eff.groupKey };
}

// policy-resolve.cjs carriedOnlyOf — present-and-not-false gates; absent or
// explicit false is unscoped (garbled leans toward the fewer-products side).
function carriedOnlyOf(locEntry) {
  return isObj(locEntry)
    && locEntry.carriedOnly !== undefined && locEntry.carriedOnly !== false;
}

// refill-engine.cjs:405 — including the carriedOnly carriage-scope gate: an
// entry flagged carriedOnly speaks only for products this location already
// holds a stock cell for (storeCarries). Gated HERE, the one choke point, so
// seatingSizes / resolveTarget / every seating consumer agree with the engine.
export function categoryPolicyEntry(config, products, stock, pid, dest) {
  const key = products?.[pid]?.categoryKey;
  if (typeof key !== "string" || !key) return null;
  const r = locationPolicyFor(config, key, dest);
  if (!r) return null;
  if (r.carriedOnly && !storeCarries(stock, dest, pid)) return null;
  return { target: r.target, reorderPoint: r.reorderPoint, minQty: r.minQty,
    perSize: r.perSize, sizes: r.sizes, carriedOnly: r.carriedOnly === true,
    policySource: r.source, groupKey: r.groupKey };
}

// refill-engine.cjs:409 — negative counted cells clamp to 0: a count error must
// not arm a size.
function sizeUnitsAnywhere(stock, pid, size) {
  const k = engineSizeKey(size);
  let n = 0;
  for (const loc of Object.keys(stock || {})) n += avail(num(stock[loc]?.[pid]?.[k]?.qty));
  return n;
}

const productSizes = (products, pid) => (products?.[pid]?.sizes || []).map(String);

// refill-engine.cjs:416
function categoryPolicyTarget(config, products, stock, dest, pid, size) {
  const entry = categoryPolicyEntry(config, products, stock, pid, dest);
  if (!entry) return null;
  const rp = entry.reorderPoint;
  const shape = (target, minQty, reorderPoint) => ({
    target,
    minQty: typeof minQty === "number" && Number.isFinite(minQty) && minQty >= 0
      ? minQty
      : (target > 0 ? Math.ceil(target / 2) : 0),
    reorderPoint: typeof reorderPoint === "number" && Number.isFinite(reorderPoint) && reorderPoint >= 0
      ? reorderPoint : null,
    source: "category_policy",
  });
  const shaped = (target) => shape(target, entry.minQty, rp);
  if (entry.sizes) {
    if (engineSizeKey(size) === "_") return null;
    const row = entry.sizes[engineSizeKey(size)];
    if (!isObj(row)) return null;
    if (typeof row.target !== "number" || !Number.isFinite(row.target) || row.target <= 0) return null;
    if (!productSizes(products, pid).includes(String(size))) return null;
    return shape(sizeUnitsAnywhere(stock, pid, size) > 0 ? row.target : 0, row.minQty, row.reorderPoint);
  }
  if (!entry.perSize) {
    return engineSizeKey(size) === "_" ? shaped(entry.target) : null;
  }
  if (engineSizeKey(size) === "_") return null;
  if (!productSizes(products, pid).includes(String(size))) return null;
  return shaped(sizeUnitsAnywhere(stock, pid, size) > 0 ? entry.target : 0);
}

// refill-engine.cjs:202 — CELL EXISTENCE, regardless of quantity. Zero-qty
// cells persist indefinitely (applyMovement never deletes one), which is why
// switching off must write a fact rather than remove a cell.
export function storeCarries(stock, loc, pid) {
  return !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
}

// refill-engine.cjs:467 — the whole precedence, in its load-bearing order.
export function resolveTarget({ targets, config, products, stock }, dest, pid, size) {
  const explicit = targets?.[dest]?.[pid]?.[engineSizeKey(size)];
  if (explicit && typeof explicit.target === "number") {
    const rp = explicit.reorderPoint;
    return {
      target: num(explicit.target),
      minQty: num(explicit.minQty),
      reorderPoint: typeof rp === "number" && Number.isFinite(rp) && rp >= 0 ? rp : null,
      source: "explicit",
    };
  }
  const catT = categoryPolicyTarget(config, products, stock, dest, pid, size);
  if (catT) return catT;
  const fp = products?.[pid];
  // Evaluated BEFORE the clothing kill switch — a shared early return would
  // couple the two switches, which is exactly what having two is for.
  if (footwearTargetsEnabled(config, dest) && isFootwear(fp) && storeCarries(stock, dest, pid)) {
    if (productSizes(products, pid).includes(size)) {
      const run = config?.footwearRunByLocation?.[dest] || {};
      const t = run[engineSizeKey(size)];
      if (typeof t === "number" && t > 0) {
        const rp = config?.footwearReorderPoint?.[dest];
        return {
          target: t,
          minQty: Math.max(1, t - 1),
          reorderPoint: typeof rp === "number" && Number.isFinite(rp) && rp >= 0 ? rp : null,
          source: "footwear_default",
        };
      }
    }
  }
  if (!ruleTargetsEnabled(config, dest)) return null;
  const p = products?.[pid];
  if (isClothing(p) && storeCarries(stock, dest, pid)) {
    const sizes = productSizes(products, pid);
    if (sizes.includes(size)) {
      const subT = typeof size === "string" && size.trim() !== ""
        ? subcategoryRun(config, products, pid, dest)
        : null;
      if (subT !== null) {
        return { target: subT, minQty: Math.max(1, subT - 1), reorderPoint: null, source: "subcategory_default" };
      }
      const run = config?.defaultRunByStore?.[dest] || {};
      const t = run[size];
      if (typeof t === "number" && t > 0) {
        return { target: t, minQty: Math.max(1, t - 1), reorderPoint: null, source: "default" };
      }
    }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ANSWER
// ═════════════════════════════════════════════════════════════════════════════

// Why a location is (or is not) seated. Ordered by the engine's own precedence,
// most authoritative first, so a caller can compare two reasons by index.
export const SEAT_REASON = {
  EXPLICIT_ROW: "explicit_row",
  CATEGORY_POLICY: "category_policy",
  FOOTWEAR_RULE: "footwear_rule",
  SUBCATEGORY_RULE: "subcategory_rule",
  CLOTHING_RULE: "clothing_rule",
  SWITCHED_OFF: "switched_off",
  CELL_ONLY: "cell_only",
  NOT_SEATED: "not_seated",
};

// One short line each. No paragraph reaches this screen (Engine Policy's
// standing rule); the explanation lives in these comments instead.
export const SEAT_LABEL = {
  [SEAT_REASON.EXPLICIT_ROW]: "Product target",
  [SEAT_REASON.CATEGORY_POLICY]: "Category policy",
  [SEAT_REASON.FOOTWEAR_RULE]: "Footwear rule",
  [SEAT_REASON.SUBCATEGORY_RULE]: "Subcategory rule",
  [SEAT_REASON.CLOTHING_RULE]: "Size run",
  [SEAT_REASON.SWITCHED_OFF]: "Switched off",
  [SEAT_REASON.CELL_ONLY]: "Cell only — no target",
  [SEAT_REASON.NOT_SEATED]: "Not carried",
};

const SOURCE_TO_REASON = {
  explicit: SEAT_REASON.EXPLICIT_ROW,
  category_policy: SEAT_REASON.CATEGORY_POLICY,
  footwear_default: SEAT_REASON.FOOTWEAR_RULE,
  subcategory_default: SEAT_REASON.SUBCATEGORY_RULE,
  default: SEAT_REASON.CLOTHING_RULE,
};

// THE SIZES A SEATING DECISION MUST SPEAK FOR.
// The engine's sizesFor() walks the union of the explicit-row keys and — when a
// rule or policy manages the product here — EVERY DECLARED CATALOGUE SIZE, not
// merely the sizes a cell exists for. A switch-off that covered only stocked
// sizes would leave every unstocked declared size still armed: that is the gap
// in NoTargetQueue's excludeHere (it iterates card.sizes, which are cell sizes),
// and it is why this returns the full union.
export function seatingSizes({ products, stock, targets, config }, loc, pid) {
  const out = new Set(Object.keys(targets?.[loc]?.[pid] || {}));
  for (const k of Object.keys(stock?.[loc]?.[pid] || {})) out.add(k);
  for (const s of productSizes(products, pid)) out.add(engineSizeKey(s));
  // ── THE "_" CELL A ONE-SIZE CATEGORY POLICY ARMS ──────────────────────────
  // sizesFor ends its category branch with a bare `else out.add("_")`
  // (refill-engine.cjs:1079): a policy in ONE-SIZE mode speaks for the no-size
  // cell and nothing else. managedPids admits such a product with NO CARRIAGE
  // GATE AT ALL (:1052), so it is armed at every mapped location even with no
  // cell and no row anywhere.
  //
  // Leaving it out was the exact bug this feature exists to close, inverted: a
  // perfume with a uniform trophy policy read "Not carried", and a switch-off
  // wrote rows for its declared letter sizes while the engine went on raising
  // requests against "_" for ever. A product declaring no sizes could not be
  // switched off at all — the plan came back empty.
  //
  // Found by adversarial review (PR #429) with a COVERAGE fuzz: 54 armed-but-
  // uncovered cases, every one of them "_" via category_policy. The existing
  // differential fuzz compares resolveTarget PER SIZE and so could never see
  // it — it is only ever asked about sizes this function already returned.
  const cat = categoryPolicyEntry(config, products, stock, pid, loc);
  if (cat && !cat.sizes && !cat.perSize) out.add("_");
  return [...out];
}

// Raw size for an encoded key: the catalogue's own spelling when it has one,
// otherwise the decoded key. "_" is the no-size cell and decodes to "".
export function rawSizeOf(products, pid, sizeKey) {
  for (const s of productSizes(products, pid)) if (engineSizeKey(s) === sizeKey) return String(s);
  return sizeKey === "_" ? "" : String(sizeKey).replace(/(\d)_(\d)/g, "$1.$2");
}

// ── seatingAt — THE FUNCTION ─────────────────────────────────────────────────
//
//   { seated, reason, label, units, hasCell, sizes: [ {sizeKey, size, qty,
//     target, source, lastType, updatedAt} ], rowCount, offRows, offRecord }
//
// `seated` answers the engine's question — will this location be asked to hold
// this product — and `reason` says which of the five sources answered it.
//
// THE TWO NEGATIVE REASONS ARE NOT THE SAME THING and must never be collapsed:
//   SWITCHED_OFF  a human wrote target 0. A decision, and reversible.
//   CELL_ONLY     stock sits here with nothing arming it (the kill switch is
//                 off, or the product is neither clothing nor footwear). Not a
//                 decision — nobody has ruled on it.
// A shop that stocks a line and is simply sold out still reads as SEATED with
// zero units, which is why nothing here offers a bulk sweep.
export function seatingAt(ctx, loc, pid) {
  const { products, stock, targets } = ctx;
  const cells = stock?.[loc]?.[pid] || {};
  const rows = targets?.[loc]?.[pid] || {};
  const keys = seatingSizes(ctx, loc, pid);

  const sizes = [];
  let best = null;
  let units = 0;
  let anyZeroRow = false;

  for (const sizeKey of keys.slice().sort()) {
    const size = rawSizeOf(products, pid, sizeKey);
    const cell = cells[sizeKey];
    const t = resolveTarget(ctx, loc, pid, size);
    const qty = num(cell?.qty);
    units += qty;
    if (t && t.target <= 0 && t.source === "explicit") anyZeroRow = true;
    if (t && t.target > 0 && !best) best = t.source;
    sizes.push({
      sizeKey, size, qty,
      // The cell's optimistic-concurrency version, and its last movement id as
      // a fallback. Carried so the move can key its idempotency on the STATE it
      // acted upon — see moveBatchId. Admin-SDK scripts write /stock cells
      // wholesale and can leave `v` off entirely, so a v-only key would hash
      // every such cell to one constant for ever.
      v: typeof cell?.v === "number" ? cell.v : null,
      mv: cell?.mv ?? null,
      hasCell: cell !== undefined,
      target: t ? t.target : null,
      source: t ? t.source : null,
      lastType: cell?.lastType ?? null,
      updatedAt: cell?.updatedAt ?? null,
    });
  }

  const hasCell = storeCarries(stock, loc, pid);
  const reason = best
    ? SOURCE_TO_REASON[best]
    : anyZeroRow ? SEAT_REASON.SWITCHED_OFF
    : hasCell ? SEAT_REASON.CELL_ONLY
    : SEAT_REASON.NOT_SEATED;

  return {
    loc, pid,
    seated: !!best,
    reason,
    label: SEAT_LABEL[reason],
    units,
    hasCell,
    sizes,
    rowCount: Object.keys(rows).length,
    // The rows this screen itself switched off — the only ones Re-seat may
    // touch. A hand-made row is somebody's decision and is never removed.
    offRows: Object.keys(rows).filter((k) => rows[k]?.source === SEATING_OFF_SOURCE),
  };
}

// The `source` stamp that marks a target row as this screen's doing. Re-seat
// keys off it, so it must never be reused by another writer.
export const SEATING_OFF_SOURCE = "seating_off";

// The newest cell touch at a location, and whether it was a sale.
//
// HONEST NAMING. The owner asked for "last sold there". There is no way to
// answer that exactly without a whole-node read: /stock_movements is a flat
// push-id node indexed only on `ts` (live rules, checked 2026-08-24), and
// insights_log is 85,261 flat entries joined by product NAME. Both are barred
// here. What the /stock cell itself carries — `lastType` and `updatedAt`, both
// written by applyMovement — is exact, per-location, per-size and free. So the
// screen shows the last MOVEMENT and says when it was a sale, rather than
// showing a number it cannot stand behind.
export function lastTouch(seat) {
  let newest = null;
  for (const s of seat.sizes) {
    if (!s.updatedAt) continue;
    if (!newest || String(s.updatedAt) > String(newest.updatedAt)) newest = s;
  }
  if (!newest) return null;
  return { at: newest.updatedAt, type: newest.lastType, sold: newest.lastType === "sold", size: newest.size };
}

// Every location this product is seated at or holds stock at, in the order the
// caller gave. A location with neither is still returned — the row says "not
// carried", which is half the point of the screen.
export function seatingRows(ctx, locations, pid) {
  return (locations || []).map((loc) => seatingAt(ctx, loc, pid));
}
