// ─── FIRST BATCH DIRECT TO SHOP — the Solve's new first leg (pure, testable) ──
// Owner spec 2026-09-17. For a product that exists only at Central and is
// kept at Hub 2 for its shops (Marathon PE / Trophy clothing), the Missing
// Products Solve used to seed qty-0 cells at Hub 2 AND the shop and leave the
// rest to the engine: Hub 2 then asked Central for its whole buffer, and the
// shop asked Hub 2 for its policy quantity — so Hub 2 staff unpacked one bag to
// fulfil shop requests one by one.
//
// Now, for exactly that Solve, the FIRST batch goes straight to the shop:
//   1. the Solve creates ONLY the shop's request — its own policy quantity,
//      source Central, destination the shop (one /refill_requests row per size,
//      the engine's own row shape, tagged createdFrom.firstBatch);
//   2. it appears in Source under a Trophy / Marathon tab and is fulfilled with
//      the existing Fulfil path (applyMovement central→shop, instantly);
//   3. when that shop request is fulfilled (fully, partially, or cancelled), the
//      SERVER (functions/lib/first-batch.cjs, trigger `firstBatchLeg`) raises
//      Hub 2's own request from Central, sized from what Central still has;
//   4. from then on nothing changes: shop refills from Hub 2 and Hub 2 refills
//      from Central through the engine exactly as before.
//
// WHY THE SHOP CELL IS STILL SEEDED HERE: the engine only ever manages a shop
// for a product the shop CARRIES (storeCarries — a stock node exists), and the
// Missing Products card only leaves the list once a shop node exists. Seeding
// the shop at qty 0 is therefore unchanged. What is NEW is that Hub 2 is NOT
// seeded at Solve time for a size Central can send: with no Hub 2 node the
// engine cannot raise hub2←central (managedPids needs storeCarries) — which is
// the whole reason the shop's request cannot be duplicated by the engine while
// it is open. Hub 2's node is seeded by the deferred leg, at the moment its own
// request is raised.
//
// PER SIZE, NOT PER PRODUCT. A size Central has none of cannot be sent first,
// so it follows today's path unchanged (seed Hub 2 + shop; the engine takes
// over when Central restocks). A size Central does have gets the first-batch
// leg. Both sets land in ONE atomic multi-path update, as the old Solve did.
//
// EVERYTHING KEYS BY productId — never by name (177 duplicate-name groups).
// Size keys go through encodeSizeKey / stockCellPath. Timestamps come from the
// caller (serverNowMs / serverNowIso), never Date.now().

import { encodeSizeKey, stockCellPath } from "../../utils/sizeKey";
import { isClothing } from "./missingProductsCore";
import { categoryPolicyLocs } from "./solvePlan";

export const FIRST_BATCH_HUB = "hub2";
// The lock runId the server stamps on both legs' engine locks. Kept as ONE
// string in one place per side (functions/lib/first-batch.cjs has the CJS
// twin, pinned equal by test) so the undo exemption and the trigger agree.
export const FIRST_BATCH_RUN_PREFIX = "first_batch:";
export const firstBatchRunId = (solveId) => `${FIRST_BATCH_RUN_PREFIX}${solveId}`;
// The Solve's identity. productId + server time: two Solves of one product
// cannot share it, and two products never do. Never a name.
export const solveIdFor = (pid, nowMs) => `fb_${pid}_${Number(nowMs).toString(36)}`;
// The undo's cancel reason: the engine reads "cancelled WITH a cancelReason"
// as its own kind of withdrawal (no cooldown, no confirmed-out learning), and
// the server trigger reads this exact string as "raise NO Hub 2 leg".
export const SOLVE_UNDONE_REASON = "solve_undone";

// ── SCOPE — is this Solve the one that routes shop quantities via Hub 2? ─────
// True only when ALL of these hold; every "no" leaves the old path untouched:
//   • the card is Central-stranded (source "central") — a hub-stranded card is
//     the hub-to-hub Solve, frozen;
//   • the nominated store's route is Hub 2 (config.routes) — that is what "kept
//     at Hub 2" means to the engine;
//   • the product is clothing in the engine's sense — the rule-based class whose
//     Hub 2 target exists only once Hub 2 carries a cell;
//   • its category has NO unscoped Hub 2 category-policy leg — a mapped category
//     (bags, belts, gloves, perfumes…) is managed at Hub 2 with no cell and no
//     Solve at all, so its Solve never routed anything; a carriedOnly leg still
//     needs the cell and stays eligible;
//   • no explicit /stock_targets row at Hub 2 — an explicit row makes the engine
//     manage Hub 2 for this product regardless of a cell.
export function firstBatchEligible({ source, store, product, routes, categoryPolicy, targets } = {}) {
  if (source !== "central") return false;
  if (!store || routes?.[store] !== FIRST_BATCH_HUB) return false;
  if (!isClothing(product)) return false;
  const key = typeof product?.categoryKey === "string" ? product.categoryKey.trim() : "";
  if (key) {
    const legs = categoryPolicyLocs(categoryPolicy, key);
    const hubLeg = categoryPolicy?.[key]?.[FIRST_BATCH_HUB];
    if (legs.includes(FIRST_BATCH_HUB) && !(hubLeg && hubLeg.carriedOnly === true)) return false;
  }
  if (targets?.[FIRST_BATCH_HUB]?.[product?.id] && Object.keys(targets[FIRST_BATCH_HUB][product.id]).length > 0) return false;
  return true;
}

// ── THE PER-SIZE SPLIT ───────────────────────────────────────────────────────
// `sizes` are the QUALIFYING sizes (positive target at Hub 2 AND the store —
// solvePlan.qualifyingSizes; unchanged). `run` is resolvedRun's map. A size
// Central can send at least one unit of is a first-batch size: the shop's own
// policy quantity, capped by what Central has and the engine's per-intent cap
// (maxUnitsPerIntent, live 20 — the same cap the engine applies to its own
// requests, so a first batch is never bigger than an engine batch). The rest
// follow today's path.
export function firstBatchSplit({ sizes, run, store, centralAvail, maxUnitsPerIntent } = {}) {
  const storeRun = (run && run[store]) || {};
  const at = typeof centralAvail === "function" ? centralAvail : () => 0;
  const cap = Number.isFinite(Number(maxUnitsPerIntent)) && Number(maxUnitsPerIntent) > 0 ? Number(maxUnitsPerIntent) : 20;
  const firstBatch = [];
  const normal = [];
  for (const sz of sizes || []) {
    const target = Number(storeRun[String(sz).toUpperCase()]) || 0;
    const avail = Math.max(Number(at(sz)) || 0, 0);
    const qty = Math.min(target, avail, cap);
    if (qty > 0) firstBatch.push({ size: String(sz), qty, target, avail });
    else normal.push(String(sz));
  }
  return { firstBatch, normal };
}

// ── THE ATOMIC WRITE ─────────────────────────────────────────────────────────
// One multi-path update, seed-if-absent for every cell (a cell that already
// exists is never overwritten — the SEED rule branch refuses that anyway):
//   • the STORE gets a qty-0 seed for every qualifying size (both sets);
//   • Hub 2 gets a qty-0 seed ONLY for the normal sizes — never for a
//     first-batch size (see the header: that is the anti-duplication);
//   • one /refill_requests row per first-batch size, in the engine's own shape
//     plus the firstBatch tag the server trigger keys on.
// Returns the update, the request ids (for the undo record) and the seeded
// cell paths (the same contract the old Solve's undo record already uses).
export function buildFirstBatchSolveUpdate({ pid, store, split, existing = {}, seedCell, nowIso, uid, solveId, newKey } = {}) {
  const updates = {};
  const paths = [];
  const has = (loc, sz) => existing?.[loc]?.[encodeSizeKey(sz)] !== undefined;
  const seed = (loc, sz) => {
    if (has(loc, sz)) return;
    const p = stockCellPath(loc, pid, sz);
    updates[p] = seedCell();
    paths.push(p);
  };
  for (const l of split.firstBatch) seed(store, l.size);
  for (const sz of split.normal) { seed(FIRST_BATCH_HUB, sz); seed(store, sz); }
  const requestIds = [];
  for (const l of split.firstBatch) {
    const id = newKey();
    requestIds.push(id);
    updates[`refill_requests/${id}`] = {
      productId: pid,
      size: l.size,
      qty: l.qty,
      requestingLocation: store,
      status: "open",
      createdAt: nowIso,
      createdFrom: {
        firstBatch: true, solveId, source: "central", store, hub: FIRST_BATCH_HUB,
        via: "missing_products_solve",
        // omit-don't-copy: a null here would be dropped by RTDB anyway, but an
        // undefined would fail the whole atomic write (#327).
        ...(uid ? { by: uid } : {}),
      },
    };
  }
  return { updates, requestIds, paths };
}

// ── UNDO — what may still be undone, from the LIVE rows ──────────────────────
// A first-batch Solve is reversible only while Central has not started on it:
// every one of its requests must still be open with nothing sent. Returns the
// blocker sentences (empty = safe to undo).
export function firstBatchUndoBlockers({ liveRequests = {}, storeLabel = "the shop" } = {}) {
  const blockers = [];
  for (const [id, r] of Object.entries(liveRequests)) {
    if (!r) continue;   // already gone — nothing to cancel
    if (r.status !== "open") { blockers.push(`Central has already ${r.status === "fulfilled" ? "sent" : "answered"} the ${String(r.size)} request for ${storeLabel} — this solve can no longer be undone.`); continue; }
    if ((Number(r.sentQty) || 0) > 0) blockers.push(`Central has started sending size ${String(r.size)} to ${storeLabel} — this solve can no longer be undone.`);
  }
  return blockers;
}

// The cancel patch for the undo: cancelled WITH the solve_undone reason (so
// the engine treats it as a withdrawal, and the trigger raises no Hub 2 leg).
export function firstBatchUndoCancelUpdate({ requestIds = [], nowIso, uid } = {}) {
  const upd = {};
  for (const id of requestIds) {
    upd[`refill_requests/${id}/status`] = "cancelled";
    upd[`refill_requests/${id}/cancelReason`] = SOLVE_UNDONE_REASON;
    upd[`refill_requests/${id}/resolvedAt`] = nowIso;
    if (uid) upd[`refill_requests/${id}/resolvedBy`] = uid;
  }
  return upd;
}

// Units the panel shows: what goes to the shop NOW, and Hub 2's own policy
// quantity that FOLLOWS after the shop's fulfil (an estimate — the server sizes
// the real Hub 2 leg from Central's remainder at that moment).
export function firstBatchEstimate({ split, run } = {}) {
  const hubRun = (run && run[FIRST_BATCH_HUB]) || {};
  const shopNow = (split?.firstBatch || []).reduce((t, l) => t + l.qty, 0);
  const hubAfter = (split?.firstBatch || []).reduce((t, l) => t + (Number(hubRun[String(l.size).toUpperCase()]) || 0), 0);
  return { shopNow, hubAfter, sizesNow: (split?.firstBatch || []).map((l) => l.size), sizesNormal: split?.normal || [] };
}
