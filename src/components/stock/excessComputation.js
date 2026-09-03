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
// `r.source` (compat) or `r.createdFrom.source` (current engine write shape,
// functions/refill-scan.cjs:738-742), never `r.requestingLocation` (the
// DESTINATION the request is FOR). Same field precedence already used by
// refillQueueCore.js:1244 for the rejection-ledger "by" lookup — kept
// consistent here rather than invented.
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

import { resolveTarget, engineSizeKey, isClothing } from "./seatingCore";
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

// ── reservation netting ───────────────────────────────────────────────────────
// Builds a `${hub}|${pid}|${sizeKey}` -> qty map from already-open refill
// requests (pass the result of useRefillRequests("open"), the SAME hook
// MoveExcess.jsx already subscribes with — no new whole-node read pattern).
export function reservedByHubFromOpenRequests(openRequests) {
  const out = new Map();
  for (const r of openRequests || []) {
    if (!r || r.status !== "open" || r.shadow) continue;
    const src = r.source || r.createdFrom?.source;
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
    const byProduct = stock?.[loc] || {};
    for (const [pid, bySize] of Object.entries(byProduct)) {
      const p = products?.[pid];
      if (!p || isDeactivated(p)) continue;
      if (groupFilter && !groupFilter(p)) continue;
      for (const [size, cell] of Object.entries(bySize || {})) {
        const t = resolveTarget({ targets, config, products, stock }, loc, pid, size);
        if (!t) continue;                    // unarmed — no Keep number, never a card
        if (t.source === "explicit") continue; // explicit row — excluded entirely, any value
        const sizeKey = engineSizeKey(size);
        const onHand = Math.max(Number(cell?.qty) || 0, 0);
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
