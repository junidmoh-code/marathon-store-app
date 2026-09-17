// ─── FIRST BATCH DIRECT TO SHOP — the Solve's new first leg (pure, testable) ──
// Owner spec 2026-09-17. For a product that exists only at Central and is
// kept at Hub 2 for its shops (Marathon PE / Trophy — every category except
// sneakers and slides, since the same evening), the Missing Products Solve
// used to seed qty-0 cells at Hub 2 AND the shop and leave the rest to the
// engine: Hub 2 then asked Central for its whole buffer, and the shop asked
// Hub 2 for its policy quantity — so Hub 2 staff unpacked one bag to fulfil
// shop requests one by one.
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
// seeded at Solve time for a size Central can send: for a product the clothing
// RULE governs, no Hub 2 node means the engine cannot raise hub2←central at
// all (managedPids needs storeCarries); for a product a category MAP or an
// explicit row governs, the engine manages Hub 2 with no cell — and there the
// guard is the engine's own lock, read by the trigger before it raises Hub 2's
// leg (deferredTo: engine when the scan got there first) and counted as
// inbound by the engine when the trigger did. Either way: one Hub 2 request.
// Hub 2's node is seeded by the deferred leg, at the moment its own request
// is raised.
//
// PER SIZE, NOT PER PRODUCT. A size Central has none of cannot be sent first,
// so it follows today's path unchanged (seed Hub 2 + shop; the engine takes
// over when Central restocks). A size Central does have gets the first-batch
// leg. Both sets land in ONE atomic multi-path update, as the old Solve did.
//
// EVERYTHING KEYS BY productId — never by name (177 duplicate-name groups).
// Size keys go through encodeSizeKey / stockCellPath. Timestamps come from the
// caller (serverNowMs / serverNowIso), never Date.now().

import { stockSizeKey, stockCellPath, encodeSizeKey } from "../../utils/sizeKey";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";
import { isDeactivated } from "../../utils/deactivation.js";

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
// Central's "Out of Stock" on a SHOP's first batch. Stamped by the Source
// queue in the same write as the cancel (and by the trigger as a backstop for
// any other cancel writer): to the engine a cancel WITHOUT a reason is a human
// rejection at the requesting location's cell — a 24h retry and a reject
// streak that would throttle the shop's ordinary hub2→shop refill for a "no"
// that was about Central's shelf. With a reason it is a withdrawal.
export const CENTRAL_DECLINED_REASON = "first_batch_central_declined";
// A first-batch SHOP leg (never Hub 2's own leg, whose human "no" IS the
// Central-level answer the engine should learn from).
export const isFirstBatchShopLeg = (r) => !!r && r.createdFrom?.firstBatch === true && r.requestingLocation !== FIRST_BATCH_HUB;

// ── SNEAKERS AND SLIDES — the ONLY two categories off this path ──────────────
// Owner rule 2026-09-17: everything except sneakers and slides goes through
// Hub 2 into the shop and takes the first-batch path — bags, belts, caps,
// beanies, gloves, perfumes, soccer jerseys, sunglasses, underwear, and every
// other category. The identity is the catalogue's own: the effective category
// key (an assigned categoryKey wins; a keyless record whose legacy pair is
// Footwear + Sneakers IS a sneaker — productTaxonomy.effectiveCategoryKey, the
// engine's policyCategoryKey twin, pinned equal by test), plus the keyless
// legacy pair for slides (Footwear + "Sandals & Slides", the taxonomy's own
// derivation for that key). Nothing else is excluded here. Boots, soccer
// boots, loafers and the rest never reach this Solve at all — the Missing
// Products tab owns the complement of the footwear group
// (missingProductsCore.inFootwearGroup) — but the rule is stated exactly so a
// future entry point inherits it unchanged.
export const EXCLUDED_KEYS = Object.freeze(["sneakers", "slides"]);
export function isSneakerOrSlide(p) {
  if (!p) return false;
  const key = effectiveCategoryKey(p);
  if (key) return EXCLUDED_KEYS.includes(key);
  return p.category === "Footwear" && p.subcategory === "Sandals & Slides";
}

// ── SCOPE — which Solve routes the first batch straight to the shop ──────────
// True when ALL of these hold; a "no" leaves the old seed-only path untouched:
//   • the card is Central-stranded (source "central") — a hub-stranded card is
//     the hub-to-hub Solve, frozen;
//   • the nominated store's route is Hub 2 (config.routes) — that is what "kept
//     at Hub 2" means to the engine;
//   • the product exists and is not a sneaker or a slide.
//
// WHAT PR #607 ALSO REQUIRED, AND WHY IT NO LONGER DOES (2026-09-17): the
// product had to be clothing in the engine's sense, with NO unscoped Hub 2
// category-policy leg and NO explicit /stock_targets row at Hub 2. Those three
// tests all said the same thing — "the engine manages Hub 2 for this product
// with no cell, so not seeding Hub 2 does not stop it asking Central" — and
// that was #607's whole anti-duplication argument for Hub 2. It was never the
// load-bearing guard: the engine's OWN lock is. Whoever locks
// /refill_engine/open/hub2/{pid}/{sizeKey} first wins — the scan
// (create-if-absent) or the trigger (same transaction shape); the trigger
// records `deferredTo: engine` when it loses, and the engine counts our lock
// as inbound when we win and proposes nothing. So a mapped category (bags,
// perfumes…) or an explicit-row product takes the same path as a plain tee:
// the shop's request first, Hub 2's leg on fulfil, one Hub 2 request ever.
// Their policies are read exactly as they are, by resolvedRun — the map or
// the row simply IS the shop's / Hub 2's target.
// ── THE PATH IS OFF (incident 2026-09-17 evening, _first-batch-incident-2026-09-17.md) ──
// Owner order: revert the #607 behaviour until the first batch is rebuilt with
// the Hub 2-presence guard as a hard precondition. While this is false NO
// Solve takes the first-batch branch — every card seeds Hub 2 AND the shop
// exactly as before #607 — and the server twin (functions/lib/first-batch.cjs
// FIRST_BATCH_PATH_ENABLED, pinned equal by test) turns any first-batch shop
// request a stale bundle still creates back into the old Solve (Hub 2 seeded,
// request withdrawn). The flag is a PARAMETER of firstBatchEligible so the
// path's own tests keep exercising it with `enabled: true`; every real caller
// (NetworkTransfer) takes the default.
export const FIRST_BATCH_ENABLED = false;

export function firstBatchEligible({ source, store, product, routes, enabled = FIRST_BATCH_ENABLED } = {}) {
  if (enabled !== true) return false;
  if (source !== "central") return false;
  if (!store || routes?.[store] !== FIRST_BATCH_HUB) return false;
  if (!product) return false;
  if (isSneakerOrSlide(product)) return false;
  return true;
}

// ── LOCATION HISTORY — which shop gets the first batch ───────────────────────
// Owner rule 2026-09-17: use each product's location history — where the
// product, and its style or siblings, currently sit and have been sent
// before (NOT sales history) — to inform the arrangement. What the system
// holds, and what can be read SCOPED (investigation §3):
//   • /stock cells — where a product sits now; a qty-0 cell is a product that
//     was sent there and sold out (cells are never deleted). HealthView
//     already holds /stock whole for this screen: ZERO new reads.
//   • /stock_targets rows — a human seated the product there (7,797 hand-made
//     rows). Already held by HealthView.
//   • style-code siblings — colourway siblings share styleCodeNormalised (the
//     stamp is on the record the client holds). Nearly empty for clothing
//     (4 of 329 stranded cards on 2026-09-17), present for the record.
//   • /stock_movements and /refill_requests are indexed by time only, so a
//     per-product query would be a whole-node read (banned) — not used.
// The strongest signal is the CATEGORY'S OWN PLACEMENT: where the products
// of the same effective category key are kept today (bags: Trophy 356 vs
// PE 97; caps & beanies: PE 295 vs 0; suits 0 vs 49 …). A Central-stranded
// product has no shop cell of its own by definition, so its history is its
// siblings' and its category's.
//
// WHAT HISTORY DECIDES: the shop nominated BY DEFAULT for the first batch
// (the operator can still tap the other shop — nothing is typed). Three
// tiers, most specific first; a tier that answers with a tie falls through:
//   1. the product's OWN positive explicit row at a shop;
//   2. a style-code sibling carried at a shop (more sibling cells wins, units
//      break ties);
//   3. the category's placement (the shop carrying more of the category).
// No signal, or a tie at every tier → today's default (the first store with
// qualifying sizes), unchanged. A shop with no qualifying sizes is never
// nominated, whatever its history — the policy decides WHERE a product may
// be kept at all; history only orders the shops the policy allows.
//
// WHAT HISTORY DOES NOT DECIDE — the shop / Hub 2 split. It is fixed by the
// two policies and Central's count: the shop's request is min(shop target,
// Central free, cap) now and Hub 2's leg min(hub2 target − on hand, Central
// remainder, cap) after. A history-shrunk first batch would not survive: the
// engine's own reconcile grows every locked open request back to exactly
// that number on the next scan (refill-engine.cjs `desired`/`availForMe`),
// and the request must be right AS CREATED. Policies are the owner's and are
// used as they are.
//
// KEYED BY productId THROUGHOUT. Siblings are found by the style-code STAMP,
// never by name: duplicate-name twins (177 groups) share no history here.
export const HISTORY_STORES = ["marathon-pe", "trophy"];
// The engine's storeCarries: a node exists (any qty, qty 0 included).
const carriesAt = (allStock, loc, pid) => !!allStock?.[loc]?.[pid] && Object.keys(allStock[loc][pid]).length > 0;
// `c != null`: an array-coerced row answers null in a hole.
const positiveUnits = (row) => Object.values(row || {}).reduce((t, c) => t + (c != null ? Math.max(Number(c.qty) || 0, 0) : 0), 0);
const humanKey = (key) => String(key || "product");

// Built ONCE per (products, allStock) — one walk of the catalogue the screen
// already holds — so every card's history is a lookup, not a scan.
export function buildPlacementIndex({ products, allStock, stores = HISTORY_STORES } = {}) {
  const byKey = {};    // effective category key → { store: products carried there }
  const byCode = {};   // styleCodeNormalised → [productId]
  for (const p of Array.isArray(products) ? products : []) {
    if (!p || !p.id) continue;
    // A retired line or a merge loser is not history a new line should
    // follow (39 live shop nodes belong to deactivated products).
    if (isDeactivated(p) || p.mergedInto) continue;
    const code = typeof p.styleCodeNormalised === "string" ? p.styleCodeNormalised.trim() : "";
    if (code) (byCode[code] = byCode[code] || []).push(p.id);
    const key = effectiveCategoryKey(p);
    if (!key) continue;
    for (const s of stores) {
      if (!carriesAt(allStock, s, p.id)) continue;
      const e = (byKey[key] = byKey[key] || {});
      e[s] = (e[s] || 0) + 1;
    }
  }
  return { byKey, byCode, stores: [...stores] };
}

// One product's location history at each shop, from the index and the two
// nodes the screen holds. Pure; `targets` may be null (a failed read → no
// own-row tier, the other tiers still answer).
export function firstBatchHistory({ pid, product, index, allStock, targets, stores } = {}) {
  const locs = stores || index?.stores || HISTORY_STORES;
  const key = effectiveCategoryKey(product);
  const code = typeof product?.styleCodeNormalised === "string" ? product.styleCodeNormalised.trim() : "";
  const siblings = code ? (index?.byCode?.[code] || []).filter((x) => x !== pid) : [];
  const byStore = {};
  for (const s of locs) {
    const rows = targets?.[s]?.[pid];
    // a positive row only: an explicit 0 is "deliberately excluded", not a seat
    const ownRow = !!rows && typeof rows === "object" && Object.values(rows).some((r) => r && typeof r.target === "number" && r.target > 0);
    let siblingCells = 0, siblingUnits = 0;
    for (const sib of siblings) {
      if (!carriesAt(allStock, s, sib)) continue;
      siblingCells += 1;
      siblingUnits += positiveUnits(allStock[s][sib]);
    }
    const categoryCarried = (key && index?.byKey?.[key]?.[s]) || 0;
    byStore[s] = { ownRow, siblingCells, siblingUnits, categoryCarried };
  }
  const categoryTotal = locs.reduce((t, s) => t + byStore[s].categoryCarried, 0);
  return { key, siblings, byStore, categoryTotal };
}

// The nomination. `candidates` = the shops with qualifying sizes, in today's
// default order; the answer is always one of them (or null when there are
// none). `sentence` is the one line the panel shows; null when history had
// nothing to say and the default stood.
export function firstBatchStoreChoice({ history, candidates, labels = {} } = {}) {
  const cands = (candidates || []).filter((s) => history?.byStore?.[s]);
  if (!cands.length) return { store: null, tier: null, sentence: null };
  const label = (s) => labels[s] || s;
  const pick = (score, tier, sentence) => {
    let best = null, bestScore = 0, tie = false;
    for (const s of cands) {
      const v = score(history.byStore[s]);
      if (v > bestScore) { best = s; bestScore = v; tie = false; }
      else if (v === bestScore && v > 0) tie = true;
    }
    return best && !tie ? { store: best, tier, sentence: sentence(best, history.byStore[best]) } : null;
  };
  return pick((h) => (h.ownRow ? 1 : 0), "own_row",
      (s) => `${label(s)} first — this product has its own target row there.`)
    || pick((h) => h.siblingCells * 1000 + h.siblingUnits, "siblings",
      (s, h) => `${label(s)} first — ${h.siblingCells === 1 ? "a colourway sibling is" : `${h.siblingCells} colourway siblings are`} kept there${h.siblingUnits > 0 ? ` (${h.siblingUnits} unit${h.siblingUnits === 1 ? "" : "s"})` : ""}.`)
    || pick((h) => h.categoryCarried, "category",
      (s, h) => `${label(s)} first — where ${h.categoryCarried} of ${history.categoryTotal} ${humanKey(history.key)} lines are kept.`)
    || { store: cands[0], tier: "default", sentence: null };
}

// ── CENTRAL'S OPEN RESERVATIONS — what the engine has already promised ───────
// (2026-09-17, the de-duplication guard the widening needs.) The engine
// manages Hub 2 for a MAPPED category or an explicit-row product with no
// cell, so by the time a card is Solved the scan may already hold an open
// hub2←central lock for the very units the shop is about to ask for (live on
// the day: a caps-beanies card, 1 unit at Central, 1 engine lock). A sibling
// shop's first-batch lock reserves Central the same way. The engine's own
// idea of "free" is on-hand MINUS those reservations (refill-engine.cjs
// sourceReserved: every open lock whose source — explicit, else the route of
// its destination — is Central), and the shop's request must be right AS
// CREATED: sized from that same free, so no unit is booked twice and the
// scan has nothing to shrink. The trigger does the identical sum for Hub 2's
// leg (first-batch.cjs centralReservations); this is the client twin, over
// the per-location lock nodes the Solve reads (one scoped read per routed
// location). Lock keys are the engine's encodeSizeKey of the raw size.
//
// DEAD LOCKS ARE NOT RESERVATIONS. A lock outlives its request in two known
// ways: the Solve's own Undo cancels the shop's request but cannot touch
// /refill_engine (client-unwritable), and a fulfilled request's lock stays
// until the next scan's close — while Central's cell is ALREADY decremented
// (a double subtraction). The server twin excludes by runId / refillId; the
// client reads each lock's request row (one scoped read per lock) and drops
// a lock whose request is gone or no longer open. (Sonnet + adversarial
// review, PR #608: an undo-then-re-solve asked Central for 1 where the policy
// said 2 and Central held 3.)
export function pruneClosedLocks({ openByLoc, requestsById } = {}) {
  const out = {};
  for (const [loc, bySize] of Object.entries(openByLoc || {})) {
    if (!bySize || typeof bySize !== "object") { out[loc] = bySize ?? null; continue; }
    const kept = {};
    for (const [sizeKey, entry] of Object.entries(bySize)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.refillId && Object.prototype.hasOwnProperty.call(requestsById || {}, entry.refillId)) {
        const r = requestsById[entry.refillId];
        if (!r || r.status !== "open") continue;   // gone, fulfilled or cancelled → not a reservation
      }
      kept[sizeKey] = entry;
    }
    out[loc] = Object.keys(kept).length ? kept : null;
  }
  return out;
}
// The refillIds a lock table names — what pruneClosedLocks needs read.
export const lockRefillIds = (openByLoc) => {
  const ids = new Set();
  for (const bySize of Object.values(openByLoc || {})) {
    if (!bySize || typeof bySize !== "object") continue;
    for (const entry of Object.values(bySize)) if (entry && typeof entry === "object" && entry.refillId) ids.add(String(entry.refillId));
  }
  return [...ids];
};

export function centralReservedBySize({ openByLoc, routes, source = "central" } = {}) {
  const out = {};
  for (const [loc, bySize] of Object.entries(openByLoc || {})) {
    if (!bySize || typeof bySize !== "object") continue;
    for (const [sizeKey, entry] of Object.entries(bySize)) {
      if (!entry || typeof entry !== "object") continue;
      const src = entry.source || routes?.[loc];
      if (src !== source) continue;
      const q = typeof entry.qty === "number" && Number.isFinite(entry.qty) ? entry.qty : 0;
      out[sizeKey] = (out[sizeKey] || 0) + Math.max(q || 1, 1);
    }
  }
  return out;
}
// On-hand at Central for a raw size, net of the reservations above (never
// below 0). `qtyAt(size)` is the caller's decoded-cell lookup.
// The lock key is the ENGINE's encoder, which trims first and maps an empty
// size to "_" (refill-engine.cjs encodeSizeKey); the app's does neither, so a
// padded " 8" would look up "_8" against a lock at "8" and read "nothing
// reserved". Trim and map here so the two agree on every size shape.
// (Adversarial review, PR #608.)
export const lockKeyFor = (size) => { const k = String(size ?? "").trim(); return k ? encodeSizeKey(k) : "_"; };
export const centralFreeFor = ({ qtyAt, reserved, size }) =>
  Math.max((Number(typeof qtyAt === "function" ? qtyAt(size) : 0) || 0) - (reserved?.[lockKeyFor(size)] || 0), 0);

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
  // stockSizeKey, the SAME encoder stockCellPath uses for the path — never
  // encodeSizeKey, which disagrees on "" ("" vs "_") and "Free Size"
  // ("Free_Size" vs "_"): a probe that misses the stored cell would seed qty 0
  // over it. `!= null` because an array-coerced row answers null in a hole.
  // (CodeRabbit, PR #607.)
  const has = (loc, sz) => existing?.[loc]?.[stockSizeKey(sz)] != null;
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
    // This solve's OWN cancel already landed (a retry after the seed deletes
    // failed mid-way): done, not a blocker. (CodeRabbit, PR #607.)
    if (r.status === "cancelled" && r.cancelReason === SOLVE_UNDONE_REASON) continue;
    if (r.status !== "open") {
      // Three different pasts, three different sentences: Central sent it,
      // Central answered "no", or the ENGINE withdrew it (a cancelReason —
      // Central ran dry, or the need was met another way). Calling an engine
      // withdrawal "Central answered" would send the operator to ask Central
      // about a decision Central never made. (Adversarial review, PR #607.)
      const past = r.status === "fulfilled" ? "Central has already sent"
        : r.cancelReason ? `the engine already withdrew (${String(r.cancelReason).replace(/_/g, " ")})`
        : "Central has already answered";
      blockers.push(`${past} the ${String(r.size)} request for ${storeLabel} — this solve can no longer be undone.`);
      continue;
    }
    if ((Number(r.sentQty) || 0) > 0) blockers.push(`Central has started sending size ${String(r.size)} to ${storeLabel} — this solve can no longer be undone.`);
  }
  return blockers;
}

// The undo's cancel, as a TRANSACTION per request — never a blind patch. The
// blocker check above reads the rows once; Central's fulfil (live read →
// applyMovement → status write) can land in the gap, and a plain update
// landing last would mark a row whose stock has already MOVED as
// "solve_undone" — the trigger would then raise no Hub 2 leg, ever. Inside the
// CAS the row is re-verified as open-and-untouched; anything else aborts and
// the row stands. (Spec review, PR #607.)
//
// `null` on a null callback: the client SDK runs the first callback on its
// local cache, which may be empty — returning undefined THERE aborts for good
// (the one-shot abort), so a missing row answers "nothing to cancel" instead,
// and a real row is re-delivered by the server for a second callback.
export function firstBatchUndoCancelTxn({ nowIso, uid } = {}) {
  return (cur) => {
    if (cur === null || cur === undefined) return null;
    if (cur.status !== "open" || (Number(cur.sentQty) || 0) > 0) return undefined;
    return { ...cur, status: "cancelled", cancelReason: SOLVE_UNDONE_REASON, resolvedAt: nowIso, ...(uid ? { resolvedBy: uid } : {}) };
  };
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
