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
// HUB 2 IS ALWAYS SEEDED — AND HUB 2 PRESENCE IS THE HARD PRECONDITION
// (owner rule after the 2026-09-17 incident, _first-batch-incident-2026-09-17.md):
//   • If the product exists at Hub 2 by ANY means — a stock cell (qty 0
//     included: cells are never deleted, so a qty-0 cell IS prior presence),
//     an engine lock at Hub 2 (a pending inbound), an open Hub 2 request — the
//     shop requests from Hub 2, NEVER from Central. Such a product takes the
//     old Solve unchanged. The check runs here at Solve time (hub2Presence)
//     and AGAIN in the trigger when the request is created (the server twin
//     hub2PresenceSignals in functions/lib/first-batch.cjs, pinned equal by
//     test): a request created for a product Hub 2 holds is withdrawn there
//     with `first_batch_hub2_present` and the normal route takes over.
//   • Central-to-shop applies ONLY to a product Hub 2 has never held, and
//     only for that first batch. After it, everything is the normal route.
//   • Hub 2 is seeded for EVERY qualifying size in the same atomic write as
//     the shop's requests — first-batch sizes included. #607 deliberately
//     left Hub 2 un-seeded for those sizes so the engine could not raise a
//     second hub2←central; that was never the load-bearing guard (the engine's
//     own lock is), and an un-seeded Hub 2 is a Hub 2 that is not a valid
//     source. Hub 2 must remain a valid source for every product at all
//     times: the engine raises hub2←central from Central's remainder on its
//     next scan (the shop's lock reserves the shop's units first), and the
//     trigger's deferred leg defers to that lock when it exists.
//   • The request records the Hub 2 cells THIS Solve wrote
//     (createdFrom.hub2Seeded) so the trigger's re-check can tell the Solve's
//     own qty-0 seeds from prior presence.
// The shop cell is seeded at qty 0 as before: the engine only manages a shop
// for a product the shop CARRIES, and the Missing Products card leaves the
// list once a shop node exists.
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
// Which open request rows Source's queues LIST — and therefore which its
// badges COUNT (App.jsx hubBadges; RefillQueue's own filter is the same
// predicate). A hub's queue lists every open request at that hub. A SHOP's
// queue lists only the shop's first-batch legs from Central: the engine's
// ordinary hub2→shop rows are Hub 2's work, and counting them put 112/113 on
// the Trophy/Marathon tabs for a picking list Central never had (incident
// 2026-09-17). One predicate, one number, one list.
export const sourceQueueLists = (r, shopLocs) =>
  !!r && r.status === "open" && !!r.productId
  && (shopLocs && (typeof shopLocs.has === "function" ? shopLocs.has(r.requestingLocation) : shopLocs.includes?.(r.requestingLocation)) ? isFirstBatchShopLeg(r) : true);
// The badge counts what the list shows, minus shadow rows (listed as previews,
// never counted as work).
export const countsTowardSourceQueue = (r, shopLocs) => sourceQueueLists(r, shopLocs) && !r.shadow;

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
export const FIRST_BATCH_ENABLED = true;   // ON again since the Hub 2-presence guard below (Phase 3 of the incident plan)

// ── HUB 2 PRESENCE — the hard precondition ───────────────────────────────────
// The signals, from scoped inputs the caller already holds or has read:
//   hub2Node           /stock/hub2/{pid} (object, array-coerced row, or null)
//   hub2Locks          /refill_engine/open/hub2/{pid} (a live lock = a pending
//                      inbound or an open Hub 2 request the engine bookkeeps)
//   hub2OpenRequestIds open /refill_requests rows at Hub 2 for pid, when the
//                      caller has them (the server reads none: every engine
//                      request holds a lock, and the trigger's own leg too)
//   sinceIso           the request's own createdAt — a qty-0 seed or a lock
//                      stamped at/after it is not PRIOR presence
//   heldLines, pid     /settings/stockHold/held/hub2 — a held line for pid is
//                      units on the way to Hub 2
// A cell of any other kind — units, a movement, a human's or an earlier
// Solve's seed — IS presence: cells are never deleted, so it says Hub 2 held
// the product before. An explicit /stock_targets/hub2 row is a PLAN, not
// presence (the #608 owner spec put explicit-row products on the path); it is
// reported in `signals` for the panel but does not gate.
// CJS twin: functions/lib/first-batch.cjs hub2PresenceSignals (pinned equal).
export function hub2PresenceSignals({ hub2Node, hub2Locks, hub2OpenRequestIds, sinceIso, heldLines, pid } = {}) {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  // PRIOR presence is what counts: a qty-0 seed cell stamped AT OR AFTER the
  // request's own createdAt (`sinceIso`) was written by this Solve (its seeds
  // and its request carry the same `now`), by the trigger, or by another
  // Solve of the same product in the same window — none of them "Hub 2 held
  // it before". A seed stamped BEFORE the request, a seed with no stamp, and
  // any cell that is not a qty-0 seed (units, a movement) is presence. Judged
  // by SHAPE + STAMP, never by a list the client supplies: #610's first cut
  // listed only the first-batch sizes' seeds, so a normal-path size's seed —
  // written by the same update — withdrew the request, and two shops' Solves
  // withdrew each other. (Adversarial review, PR #610.)
  const laterSeed = (c) => !!c && c.mv === "seed" && !((Number(c.qty) || 0) > 0)
    && Number.isFinite(sinceMs) && !!c.updatedAt && Date.parse(c.updatedAt) >= sinceMs;
  const cells = Array.isArray(hub2Node)
    ? hub2Node.map((c, i) => [String(i), c]).filter(([, c]) => c != null)
    : Object.entries(hub2Node || {}).filter(([, c]) => c != null);
  const signals = [];
  if (cells.some(([, c]) => !laterSeed(c))) signals.push("stock_cell");
  // The same rule for the engine's lock at Hub 2: one claimed at/after the
  // request is the scan running in the trigger's gap (Hub 2 just became
  // managed), not prior presence; one that predates the request is. (Lock
  // createdAt is the scan's START time, so a scan spanning the write reads as
  // "before" — that error only withdraws to the normal route. Sonnet, PR #610.)
  const priorLock = (e) => !!e && typeof e === "object" && !(Number.isFinite(sinceMs) && e.createdAt && Date.parse(e.createdAt) >= sinceMs);
  if (hub2Locks && typeof hub2Locks === "object" && Object.values(hub2Locks).some(priorLock)) signals.push("engine_lock");
  if (Array.isArray(hub2OpenRequestIds) && hub2OpenRequestIds.length) signals.push("open_hub2_request");
  // A PENDING INBOUND in the hold lane: Central's fulfil of a Hub 2 request
  // parks the units at stock/in_transit and records a held line at
  // /settings/stockHold/held/hub2/{lineId} {productId, …} until the release
  // credits Hub 2 — no Hub 2 cell, and the engine closes the fulfilled
  // request's lock on its next scan. Units on the way to Hub 2 ARE Hub 2
  // presence. (Spec review, PR #610.)
  if (pid && heldLines && typeof heldLines === "object") {
    const lines = Array.isArray(heldLines) ? heldLines : Object.values(heldLines);
    if (lines.some((l) => l && typeof l === "object" && l.productId === pid)) signals.push("held_inbound");
  }
  return signals;
}
export const hub2Present = (args) => hub2PresenceSignals(args).length > 0;

// `hub2Present` is REQUIRED and fails closed: anything but an explicit
// `false` (unknown, unread, true) keeps the Solve on the old path.
export function firstBatchEligible({ source, store, product, routes, enabled = FIRST_BATCH_ENABLED, hub2Present: present } = {}) {
  if (enabled !== true) return false;
  if (present !== false) return false;
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
  const bySize = {};   // effective category key → { store: { sizeKey: products carrying that size there } }
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
      const bs = ((bySize[key] = bySize[key] || {})[s] = bySize[key][s] || {});
      for (const sk of cellKeys(allStock[s][p.id])) bs[sk] = (bs[sk] || 0) + 1;
    }
  }
  return { byKey, bySize, byCode, stores: [...stores] };
}
// The size keys a row holds a cell for (`c != null`: an array-coerced row
// answers null in a hole; its present indices are the keys).
const cellKeys = (row) => Array.isArray(row)
  ? row.map((c, i) => (c != null ? String(i) : null)).filter((k) => k !== null)
  : Object.entries(row || {}).filter(([, c]) => c != null).map(([k]) => k);

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
    const siblingSizes = {};   // sizeKey → siblings carrying that size at s
    for (const sib of siblings) {
      if (!carriesAt(allStock, s, sib)) continue;
      siblingCells += 1;
      siblingUnits += positiveUnits(allStock[s][sib]);
      for (const sk of cellKeys(allStock[s][sib])) siblingSizes[sk] = (siblingSizes[sk] || 0) + 1;
    }
    const categoryCarried = (key && index?.byKey?.[key]?.[s]) || 0;
    const sizeCarried = (key && index?.bySize?.[key]?.[s]) || {};
    byStore[s] = { ownRow, siblingCells, siblingUnits, siblingSizes, categoryCarried, sizeCarried };
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

// ── LOCATION HISTORY AND THE SHOP / HUB 2 SPLIT (owner rule, Phase 3) ────────
// What history CAN decide about the split without the engine undoing it: WHICH
// SIZES go to the shop first. A request's quantity is not history's to set
// (the engine's reconcile regrows every locked open request to min(target,
// Central free, cap) on the next scan — investigation §5 of #608), but a size
// that is NOT requested for the shop is simply the normal route: Hub 2 first,
// then hub2→shop when the shop's cell needs it. So, per size, the shop's own
// history says whether that size belongs at the shop at all:
//   1. colourway siblings carried at the shop (the most specific signal):
//      a size no sibling carries there stays at Hub 2 first;
//   2. else the category's placement at the shop, when it is large enough to
//      mean something (≥ MIN_LINES_FOR_SIZE_HINT lines kept): a size no line
//      of that category carries there stays at Hub 2 first (live 2026-09-17:
//      tracksuits XXXL — Trophy 34 lines, PE 13; t-shirts XXXL — PE 15 of
//      457; suits S — 4 of 49 at Trophy);
//   3. no history at that shop → every size Central can send goes first, as
//      before. A hint never ADDS a size: a size Central has none of, or the
//      policy does not cover, is never a first-batch size.
// The shop NOMINATION (own row > siblings > category) is unchanged.
export const MIN_LINES_FOR_SIZE_HINT = 10;
export function firstBatchSizeHints({ history, store, sizes, labels = {}, minLines = MIN_LINES_FOR_SIZE_HINT } = {}) {
  const h = history?.byStore?.[store];
  const out = {};
  if (!h) return out;
  const label = labels[store] || store;
  const cat = humanKey(history.key);
  for (const sz of sizes || []) {
    const size = String(sz);
    const sk = stockSizeKey(size);
    if (h.siblingCells > 0) {
      const n = h.siblingSizes?.[sk] || 0;
      out[size] = n > 0
        ? { to: "shop", why: null }
        : { to: "hub", why: `${size === "_" ? "One size" : size} stays at Hub 2 first — ${h.siblingCells === 1 ? "the colourway sibling" : `none of the ${h.siblingCells} colourway siblings`} at ${label} carr${h.siblingCells === 1 ? "ies no" : "y"} ${size === "_" ? "one-size" : size}; the engine sends it to ${label} from Hub 2 when needed.` };
      continue;
    }
    if ((h.categoryCarried || 0) >= minLines) {
      const n = h.sizeCarried?.[sk] || 0;
      out[size] = n > 0
        ? { to: "shop", why: null }
        : { to: "hub", why: `${size === "_" ? "One size" : size} stays at Hub 2 first — none of the ${h.categoryCarried} ${cat} lines at ${label} carries ${size === "_" ? "one-size" : size}; the engine sends it to ${label} from Hub 2 when needed.` };
      continue;
    }
    out[size] = { to: "shop", why: null };
  }
  return out;
}

// ── THE PER-SIZE SPLIT ───────────────────────────────────────────────────────
// `sizes` are the QUALIFYING sizes (positive target at Hub 2 AND the store —
// solvePlan.qualifyingSizes; unchanged). `run` is resolvedRun's map. A size
// Central can send at least one unit of is a first-batch size: the shop's own
// policy quantity, capped by what Central has and the engine's per-intent cap
// (maxUnitsPerIntent, live 20 — the same cap the engine applies to its own
// requests, so a first batch is never bigger than an engine batch). The rest
// follow today's path.
// `sizeHints` (optional): firstBatchSizeHints' map. A size hinted "hub" takes
// the normal path (Hub 2 first) and is reported in `held` with its sentence.
export function firstBatchSplit({ sizes, run, store, centralAvail, maxUnitsPerIntent, sizeHints } = {}) {
  const storeRun = (run && run[store]) || {};
  const at = typeof centralAvail === "function" ? centralAvail : () => 0;
  const cap = Number.isFinite(Number(maxUnitsPerIntent)) && Number(maxUnitsPerIntent) > 0 ? Number(maxUnitsPerIntent) : 20;
  const firstBatch = [];
  const normal = [];
  const held = [];
  for (const sz of sizes || []) {
    const size = String(sz);
    const target = Number(storeRun[size.toUpperCase()]) || 0;
    const avail = Math.max(Number(at(sz)) || 0, 0);
    const qty = Math.min(target, avail, cap);
    const hint = sizeHints && sizeHints[size];
    if (qty > 0 && hint && hint.to === "hub") { normal.push(size); held.push({ size, why: hint.why || null }); continue; }
    if (qty > 0) firstBatch.push({ size, qty, target, avail });
    else normal.push(size);
  }
  return { firstBatch, normal, held };
}

// ── THE ATOMIC WRITE ─────────────────────────────────────────────────────────
// One multi-path update, seed-if-absent for every cell (a cell that already
// exists is never overwritten — the SEED rule branch refuses that anyway):
//   • the STORE gets a qty-0 seed for every qualifying size (both sets);
//   • Hub 2 gets a qty-0 seed for every qualifying size too (both sets) —
//     Hub 2 is always a valid source (see the header); the first-batch
//     sizes' Hub 2 seeds are recorded on the request as hub2Seeded;
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
    if (has(loc, sz)) return false;
    const p = stockCellPath(loc, pid, sz);
    updates[p] = seedCell();
    paths.push(p);
    return true;
  };
  // Hub 2 AND the shop for EVERY qualifying size — first-batch sizes
  // included (Hub 2 is always a valid source; see the header).
  const hub2Seeded = [];
  for (const l of split.firstBatch) { if (seed(FIRST_BATCH_HUB, l.size)) hub2Seeded.push(stockSizeKey(l.size)); seed(store, l.size); }
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
        // the Hub 2 seeds THIS solve writes — information for the audit trail
        // (the guard judges its own seeds by their stamp, not by this list).
        // RTDB cannot store an empty array, so none → omitted.
        ...(hub2Seeded.length ? { hub2Seeded } : {}),
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
  const heldSizes = new Set((split?.held || []).map((h) => h.size));
  return {
    shopNow, hubAfter,
    sizesNow: (split?.firstBatch || []).map((l) => l.size),
    // the normal-path sizes Central has none of — held sizes are listed apart
    sizesNormal: (split?.normal || []).filter((sz) => !heldSizes.has(sz)),
    held: split?.held || [],
  };
}
