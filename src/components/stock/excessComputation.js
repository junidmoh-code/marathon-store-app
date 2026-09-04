// ─── HUB EXCESS COMPUTATION — Sneakers group, hub1 + hub2 ────────────────────
// (Commit 3 of the excess-sneakers-hub-to-central build; see
// docs/EXCESS-SNEAKERS.md for the Phase 1/2 investigation this extends.)
//
// PURE computation layer only — no RTDB writes, no UI. The existing "Excess
// Inventory" tab (MoveExcess.jsx) computes STORE-source clothing excess (and a
// net-based Hub 2 clothing leg) inline; this file is a SEPARATE, ADDITIVE
// capability and does not touch that logic. Nothing in MoveExcess.jsx changed
// for this commit — see the header of that file for its own excess model.
//
// ── THE FORMULA (owner spec) ─────────────────────────────────────────────────
//
//   excess = onHand - target(Keep) - unitsReservedByOpenOutboundRefillRequestsFromThatHub
//   movable = max(0, excess)      — a move must leave the cell at EXACTLY
//                                    target, never below
//   a card never renders below 1 unit movable
//
// Only sizes the engine considers ARMED produce a target at all — a size with
// no Keep number (resolveTarget returns null) must never produce a card. "0"
// is a valid, distinct, ARMED target (the engine's own dead-size rule) and
// DOES produce excess when onHand/reserved leave something above it.
//
// An EXPLICIT per-product /stock_targets/{loc}/{pid}/{sizeKey} row — Hub 1's
// 124 kill-switch rows found in Phase 1 — EXCLUDES the cell entirely,
// regardless of the value it holds and regardless of what the category policy
// would otherwise say. resolveTarget (mirrored below from seatingCore.js,
// itself a documented, differential-fuzzed mirror of
// functions/lib/refill-engine.cjs) already tries the explicit row FIRST and
// stamps `source: "explicit"` when one exists — so this file simply treats
// that source as "no card ever", rather than "target used for the excess
// subtraction". This is the one place this file's contract diverges from
// resolveTarget's own return value: the engine WANTS to top a cell to an
// explicit 0; excess computation must not treat that as "excess = onHand -
// 0", it must not show a card at all.
//
// ── DISPLAYS ─────────────────────────────────────────────────────────────────
// A registered display unit is booked at its hub's /stock cell exactly like
// any other unit (displaySlots.js: "the slot is informational, never a stock
// cell — it moves no quantity, and the unit it describes stays booked at
// `bookedHub` exactly as before"). onHand here is simply cell.qty, so a
// display unit is already counted as available stock with no special-casing
// needed — and this module never reads /settings/displaySlots, so it can
// never subtract one. Any future caller that lets a move touch a specific
// unit (Commit 4's UI) must consult displaySlots itself before letting a
// transfer take the unit currently on a shop floor.
//
// ── RESERVATION NETTING ──────────────────────────────────────────────────────
// "Open outbound refill request FROM this hub" = a /refill_requests record
// with status "open" whose FULFILLING location is this hub — that is
// `r.source` (compat), `r.createdFrom.source` (current engine write shape,
// functions/refill-scan.cjs:738-742), or failing both the route configured for
// the requesting location, `config.routes[r.requestingLocation]`. NEVER
// `r.requestingLocation` itself, which is the DESTINATION the request is FOR.
//
// That third leg matters: it is the engine's OWN precedence
// (refill-engine.cjs:1244, `rr.source || rr.createdFrom?.source ||
// routes[rr.requestingLocation]`). Matching only the first two would silently
// drop any request carrying neither field — a legacy row, or a hand-made
// request — from the netting, inflating that hub's excess and letting the same
// physical units be sent to Central while still promised to a shop. Mirroring
// the engine exactly is the whole point of this lookup.
//
// ── GROUPS ───────────────────────────────────────────────────────────────────
// Sneakers group (owner's "footwear-all" policy group, functions/lib/
// policy-groups.cjs): boots, designer-shoes, kids-shoes, loafers,
// running-shoes, slides, sneakers — computed unconditionally at hub1/hub2.
//
// Clothing is the SAME formula, reusable via the same computeHubExcess core,
// but gated behind config/refillEngine/excessClothingEnabled — absent/false =
// OFF (the same fail-safe grammar as ruleBasedTargets/footwearTargets: a
// garbled or unreadable config arms nothing). Off by default; flip the key
// live with no deploy to turn it on, per-location or network-wide.

// ── HALF SIZES: ONE KEY SHAPE, ONE HELPER ────────────────────────────────────
// The stock map this file is given comes from useStockCells(), which DECODES
// /stock's RTDB-safe keys ("5_5" → "5.5"). Targets, the policy size run and the
// engine all speak the ENCODED shape. Both spellings are reconciled in exactly
// one place — seatingCore's cellAt/cellQtyAt — which resolveTarget's own
// sizeUnitsAnywhere and this loop's onHand both go through. Nothing here may
// index a cell map by a size directly.
//
// Before that helper existed, resolveTarget read "no units of 5.5 anywhere",
// its dead-size rule returned target 0 instead of the row's 2, and every unit
// of every half-size hub cell was carded as excess: 207 rows / 442 units across
// the two hubs, and four moves that took a cell below its Keep.
// See docs/EXCESS-55-INVESTIGATION.md.

import { resolveTarget, engineSizeKey, isClothing, cellQtyAt } from "./seatingCore";
import { isDeactivated } from "../../utils/deactivation";

// The only hubs this feature touches — same closed list as HubCleanup
// (CLEANUP_HUBS, hubCleanupCore.js): hub3/Pine is out of scope everywhere in
// this build, deliberately not derived from the location registry.
export const EXCESS_HUB_LOCATIONS = Object.freeze(["hub1", "hub2"]);

// footwear-all policy group member categories (policy-groups.cjs), i.e. the
// "Sneakers" group this build arms at hub1 (Phase 1) and hub2 (Phase 2).
export const SNEAKER_CATEGORY_KEYS = Object.freeze([
  "boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers",
]);
const SNEAKER_CATEGORY_SET = new Set(SNEAKER_CATEGORY_KEYS);

export function isSneakerGroupProduct(product) {
  return SNEAKER_CATEGORY_SET.has(product?.categoryKey);
}

// ── clothing gate — config/refillEngine/excessClothingEnabled ────────────────
// Same grammar as ruleTargetsEnabled/footwearTargetsEnabled (seatingCore.js /
// refill-engine.cjs): `true` = on everywhere, `{loc: true, ...}` = per-
// location (absent location = off), anything else (absent, false, garbled) =
// off. Off by default — flip this ONE key live, no code change, no deploy.
export function clothingExcessEnabled(config, dest) {
  const v = config?.excessClothingEnabled;
  if (v === true) return true;
  if (v && typeof v === "object" && !Array.isArray(v)) return v[dest] === true;
  return false;
}

// ── THE KILL SWITCH — config/refillEngine/excessEnabled ──────────────────────
// ONE RTDB write hides every excess card, network-wide, with no code change and
// no deploy. The grammar is deliberately the INVERSE of the arming switches
// above: this is an off switch for a feature that is already live, so ABSENT
// means ON. Anything else would turn the screen off the moment the key were
// tidied away.
//
//   absent / true / garbled  → ON everywhere (today's behaviour)
//   false                    → OFF everywhere — no card, at any hub
//   { hub2: false }          → OFF at hub2 only; every other hub stays ON
//
// Read HERE, inside the computation, not in the screen: every caller of
// computeHubExcess (sneakers, clothing, any future group) is covered by the one
// gate, and a card cannot survive because a component forgot to ask.
export function excessEnabledAt(config, loc) {
  const v = config?.excessEnabled;
  if (v === false) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) return v[loc] !== false;
  return true;
}

// ── reservation netting ───────────────────────────────────────────────────────
// Builds a `${hub}|${pid}|${sizeKey}` -> qty map from already-open refill
// requests (pass the result of useRefillRequests("open"), the SAME hook
// MoveExcess.jsx already subscribes with — no new whole-node read pattern).
export function reservedByHubFromOpenRequests(openRequests, routes = {}) {
  const out = new Map();
  for (const r of openRequests || []) {
    if (!r || r.status !== "open" || r.shadow) continue;
    const src = r.source || r.createdFrom?.source || routes?.[r.requestingLocation];
    if (!src || !r.productId || r.size == null) continue;
    const k = `${src}|${r.productId}|${engineSizeKey(r.size)}`;
    out.set(k, (out.get(k) || 0) + (Number(r.qty) || 0));
  }
  return out;
}

// ── the core computation ──────────────────────────────────────────────────────
//
// ctx: { products, stock, targets, config } — same shapes resolveTarget/
//      seatingCore already expect: stock/targets keyed { loc: { pid: {...} } }.
// reserved: the Map from reservedByHubFromOpenRequests.
// opts: { locations = EXCESS_HUB_LOCATIONS, groupFilter, minMovable = 1 }
//
// Returns one row per (loc, pid, size) with movable excess >= minMovable —
// never a bare "excess", always the already-clamped movable quantity, so a
// caller can never accidentally move a cell below target.
export function computeHubExcess(ctx, reserved, opts = {}) {
  const { products, stock, targets, config } = ctx;
  const locations = opts.locations || EXCESS_HUB_LOCATIONS;
  const groupFilter = opts.groupFilter;
  const minMovable = opts.minMovable == null ? 1 : opts.minMovable;
  const out = [];

  for (const loc of locations) {
    if (!excessEnabledAt(config, loc)) continue;   // the kill switch, per location
    const byProduct = stock?.[loc] || {};
    for (const [pid, bySize] of Object.entries(byProduct)) {
      const p = products?.[pid];
      if (!p || isDeactivated(p)) continue;
      if (groupFilter && !groupFilter(p)) continue;
      for (const size of Object.keys(bySize || {})) {
        const t = resolveTarget({ targets, config, products, stock }, loc, pid, size);

        // ── THE FOUR GUARDS, IN THE ORDER THEY MUST HOLD ────────────────────
        // Each one is load-bearing on its own; none is implied by the formula
        // below, and each has a test that fails when it is deleted.
        //
        // 1. UNARMED IS NOT ZERO. No row resolved → no Keep number exists →
        //    this cell is not judged here at all. A blank is a blank.
        if (!t) continue;
        // 2. A TARGET THAT IS NOT A FINITE NUMBER IS A BLANK, NOT A 0. Belt to
        //    guard 1's braces: whatever a future resolver returns, only a real
        //    number may be subtracted from a shelf count.
        if (typeof t.target !== "number" || !Number.isFinite(t.target)) continue;
        // 3. An EXPLICIT per-product row excludes the cell entirely, whatever
        //    value it holds (see the header).
        if (t.source === "explicit") continue;
        // 4. onHand <= Keep → NEVER a card, under any code path. The formula
        //    below already yields <= 0 here, but this states the invariant
        //    where it can be read and killed by a test, instead of leaving it
        //    as an emergent property of arithmetic.
        const onHand = cellQtyAt(stock, loc, pid, size);
        if (onHand <= t.target) continue;

        const sizeKey = engineSizeKey(size);
        const reservedQty = reserved?.get(`${loc}|${pid}|${sizeKey}`) || 0;
        const excess = onHand - t.target - reservedQty;
        const movable = Math.max(0, excess);
        if (movable < minMovable) continue;
        out.push({
          loc, pid, size, sizeKey,
          onHand, target: t.target, reserved: reservedQty,
          excess: movable, targetSource: t.source,
        });
      }
    }
  }
  return out;
}

// Sneakers-group excess at hub1 + hub2 — unconditional, no flag. This is the
// function Commit 4's UI calls for the new hub-source sneaker cards.
export function computeHubSneakerExcess(ctx, reserved, opts = {}) {
  return computeHubExcess(ctx, reserved, { ...opts, groupFilter: isSneakerGroupProduct });
}

// Clothing excess at hub1 + hub2 via the SAME formula, gated behind the
// off-by-default flag above. Returns [] whenever the flag resolves false at
// EVERY requested location — i.e. zero cards by default, with no code change
// needed to turn it on later.
export function computeHubClothingExcess(ctx, reserved, opts = {}) {
  const locations = (opts.locations || EXCESS_HUB_LOCATIONS)
    .filter((loc) => clothingExcessEnabled(ctx.config, loc));
  if (!locations.length) return [];
  return computeHubExcess(ctx, reserved, {
    ...opts,
    locations,
    groupFilter: (p) => isClothing(p) && !isSneakerGroupProduct(p),
  });
}
