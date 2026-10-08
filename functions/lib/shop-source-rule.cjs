// ─── A SHOP NEVER REFILLS FROM CENTRAL ONCE ITS HUB HAS HELD THE PRODUCT ─────
// Owner rule, 17 Sep 2026 (restated 3 Oct 2026): if a product exists at the
// shop's hub by ANY means — current stock, past stock, any movement ever
// recorded there — a shop refill for it is sourced from that hub and NEVER
// from Central. Central → shop exists for ONE thing: the first batch of a
// product the hub has never held, raised by the first-batch Solve (#607/#610).
// Everything else reaches a shop through its hub: Hub 2 ← Central, then
// shop ← Hub 2 (Section 2); Hub 3 ← Central, then Pine / Concrete ← Hub 3
// (Section 1, once those shops are engine destinations).
//
// This module is the rule, stated once. It is applied at the two points every
// request passes through (SHOP-CENTRAL-ROUTE-INVESTIGATION.md):
//   • refill-engine.cjs computeRefillPlan — a NEW engine intent may never be
//     shop ← Central (`forbiddenShopSource`), and an OPEN shop ← Central
//     request (only the first batch makes one) is withdrawn, untouched and not
//     mid-pick, the moment its shop's hub holds the product
//     (`shopCentralWithdrawal`). The engine reads /stock, the lock table, the
//     hold lane and /refill_requests whole every hour already, so the check
//     costs no new read.
//   • first-batch.cjs — the creation-time guard (#610) uses the same presence
//     signals (`hubPresenceSignals`; its hub2PresenceSignals is this function
//     with Hub 2's inputs).
//
// WHICH LOCATIONS ARE SHOPS. Never a hardcoded list — adding a shop or a hub
// must not silently drop the rule. A location is a shop when the /locations
// registry says `kind: "store"` OR the route shape says so: routed to a hub
// that is itself routed upstream (shop → hub → central). Either is enough.
// The registry catches what a misconfiguration breaks in the shape
// (`routes.trophy = "central"` makes Trophy look like a hub); the shape
// catches what a mis-typed registry breaks.
//
// THE SHOP'S HUB is `routes[shop]` when that is not Central — Hub 2 for
// Marathon PE and Trophy today. Never "any hub": a product Hub 1 has held
// says nothing about whether Trophy's hub has it.
//
// A SHOP config.routes DOES NOT NAME (Pine, Concrete) is routed by the network
// registry, per product: its hub is the hub holding its back stock for THAT
// product — Hub 3, or the Concrete Stockroom where the category or the product
// is mapped there. This module does not work that out a second time. The
// caller hands over the engine's own answer, `routing` (refill-engine.cjs
// networkRouting): `routing.stores` are the live shops the registry routes and
// `routing.sourceFor(shop, product, pid)` is the hub the engine refills that
// product from. So the rule covers exactly the shops the engine plans for and
// judges each against the hub the engine would use. A shop that is not live,
// or whose hub is not, is not in `routing.stores`: nothing automatic touches
// its requests. With no `routing`, or for a location config.routes names, the
// answer is the one above and nothing else.

"use strict";

const CENTRAL = "central";

// Registry OR route shape — either one is enough, never the registry alone: a
// mis-typed kind ("shop", "Store ") must not switch the rule off for a
// location the routes plainly treat as a shop (Fable review, PR #673). Both
// "store" and "shop" read as a shop, trimmed and case-folded.
const SHOP_KINDS = new Set(["store", "shop"]);
// The shops the registry routes, from the engine's routing — or false.
const registryShop = (loc, routing) => !!routing && !!routing.stores && typeof routing.stores.has === "function" && routing.stores.has(loc);
function isShopLoc(loc, { routes = {}, locations = null, routing = null } = {}) {
  if (!loc || loc === CENTRAL) return false;
  // A location something else is routed TO is a hub, whatever the registry
  // says (Hub 1 sells sneakers; a "store" tag on it must never refuse its own
  // Central refills — Sonnet review, PR #673).
  if (Object.values(routes || {}).includes(loc)) return false;
  const reg = locations && typeof locations === "object" ? locations[loc] : null;
  if (reg && typeof reg === "object" && typeof reg.kind === "string" && SHOP_KINDS.has(reg.kind.trim().toLowerCase())) return true;
  const hub = routes[loc];
  if (!!hub && hub !== CENTRAL && routes[hub] != null) return true;
  return registryShop(loc, routing);
}

// The hub a shop refills from, or null (not a shop, or routed straight to
// Central — itself a refused route, see forbiddenShopSource). For a shop the
// registry routes the hub is a per-product question: `ctx.product` / `ctx.pid`
// say which product, and a product with no live hub mapped answers null.
function shopHubFor(loc, ctx = {}) {
  if (!isShopLoc(loc, ctx)) return null;
  const hub = (ctx.routes || {})[loc];
  if (hub) return hub !== CENTRAL ? hub : null;
  if (!registryShop(loc, ctx.routing) || typeof ctx.routing.sourceFor !== "function") return null;
  const regHub = ctx.routing.sourceFor(loc, ctx.product, ctx.pid);
  return regHub && regHub !== CENTRAL ? regHub : null;
}

// True when a request INTO `dest` FROM `source` is one the engine may never
// create: a shop asking Central. (The first-batch Solve is not the engine and
// is guarded by its own Hub-presence precondition.)
//
// ONE EXCEPTION, product-aware: a shop the ENGINE itself routes to Central for
// this product (central-fed clothing — Concrete, lib/central-fed.cjs). Asked
// with `product`/`pid`, a Central source is allowed exactly when the engine's
// own routing answers Central for that product; asked without them, the
// predicate keeps its old meaning ("a shop ← Central row").
function forbiddenShopSource({ dest, source, routes, locations, routing, product, pid } = {}) {
  if (source !== CENTRAL) return false;
  if ((product !== undefined || pid !== undefined) && routing && typeof routing.sourceFor === "function"
      && routing.centralFed instanceof Set && routing.centralFed.has(dest)
      && routing.sourceFor(dest, product, pid) === CENTRAL) return false;
  return isShopLoc(dest, { routes, locations, routing });
}

// ── PRESENCE: has the hub held this product? ────────────────────────────────
// Signals, from inputs the caller already holds:
//   hubNode          /stock/{hub}/{pid} (object, array-coerced row, or null)
//   hubLocks         /refill_engine/open/{hub}/{pid}
//   hubOpenRequests  open /refill_requests rows at the hub for pid, as
//                    [{ createdAt }] or bare ids (a bare id counts — the
//                    caller could not date it)
//   heldLines        /settings/stockHold/held/{hub} — units on the way in
//   sinceIso         the request's own createdAt: a qty-0 SEED cell, a lock
//                    or a hub request stamped at/after it is the Solve's own
//                    carriage or the engine's follow-up leg, not PRIOR presence
// A cell of any other kind (units, a movement, a count, an older seed) IS
// presence: cells are never deleted, so a cell says the hub held the product.
// Judged by SHAPE + STAMP, never by a list a client supplies (PR #610).
function hubPresenceSignals({ hubNode, hubLocks, hubOpenRequests, heldLines, sinceIso, pid } = {}) {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const atOrAfter = (iso) => Number.isFinite(sinceMs) && !!iso && Date.parse(iso) >= sinceMs;
  const laterSeed = (c) => !!c && c.mv === "seed" && !((Number(c.qty) || 0) > 0) && atOrAfter(c.updatedAt);
  const cells = Array.isArray(hubNode)
    ? hubNode.filter((c) => c != null)
    : Object.values(hubNode || {}).filter((c) => c != null);
  const signals = [];
  if (cells.some((c) => !laterSeed(c))) signals.push("stock_cell");
  const priorLock = (e) => !!e && typeof e === "object" && !atOrAfter(e.createdAt);
  if (hubLocks && typeof hubLocks === "object" && Object.values(hubLocks).some(priorLock)) signals.push("engine_lock");
  if (Array.isArray(hubOpenRequests) && hubOpenRequests.some((r) => typeof r === "string" || !atOrAfter(r && r.createdAt))) {
    signals.push("open_hub2_request");
  }
  if (pid && heldLines && typeof heldLines === "object") {
    const lines = Array.isArray(heldLines) ? heldLines : Object.values(heldLines);
    if (lines.some((l) => l && typeof l === "object" && l.productId === pid)) signals.push("held_inbound");
  }
  return signals;
}

// ── A PICK IN PROGRESS (2026-10-03) ─────────────────────────────────────────
// Central's fulfil (src/components/stock/RefillQueue.jsx) moves stock with
// applyMovement — its own transactional writer — and records sentQty /
// fulfilled in a SECOND write. A scan landing between the two used to see an
// open, untouched request whose units had already left. The picker now CLAIMS
// the request first, by transaction, with `picking: { atMs, movementId, by }`
// (atMs = serverNowMs), moves stock, and clears the marker in the same write
// as sentQty / fulfilled. A FRESH marker means "mid-pick": no close, resize or
// withdrawal may touch the request. A marker older than PICK_MARKER_TTL_MS is
// a picker that crashed or gave up before moving anything (a pick that DID
// move stock is caught after that by its linked movement), so it stops
// blocking: a stale marker must never freeze a request forever.
// Client twin: src/components/stock/pickMarker.js (pinned equal by test).
const PICK_MARKER_TTL_MS = 30 * 60e3;
function pickInProgress(rr, nowMs = Date.now()) {
  const p = rr && rr.picking;
  if (!p || typeof p !== "object") return false;
  const at = Number(p.atMs);
  if (!Number.isFinite(at)) return true;            // a marker we cannot date blocks (fail safe)
  // |age|: a marker from a device whose clock ran ahead must not block for
  // hours (Fable review, PR #677).
  return Math.abs(nowMs - at) < PICK_MARKER_TTL_MS;
}

// "Untouched" must be CERTAIN before a request is withdrawn: any sentQty that
// is not the number 0 / absent counts as touched (PR #609 — a string "1"
// reads as 0 to Number-coercion and would cancel over stock that moved), and
// so does a pick in progress.
function requestUntouched(rr, nowMs = Date.now()) {
  if (!rr) return false;
  if (pickInProgress(rr, nowMs)) return false;
  if (rr.sentQty == null) return true;
  return typeof rr.sentQty === "number" && !(rr.sentQty > 0);
}

// ── THE RECONCILE DECISION for one open lock ────────────────────────────────
// Returns null (leave it) or { hub, signals } (withdraw it). Withdraw only
// when ALL hold:
//   • the lock is shop ← Central (dest a shop, lock source Central);
//   • its request is open AND untouched (no sentQty) AND the engine has no
//     in-flight evidence for it (`inFlight` — the caller's plan-gen / ledger
//     link, or a stock movement linked to the request by refillId: Central's
//     fulfil writes the movement BEFORE sentQty, in a separate write, so a
//     movement with no sentQty is a pick in progress) — never cancelled under
//     the picker;
//   • the shop's hub shows presence for the product.
// `snapshot` is the engine's: { stock, openIndex, heldLines, refillRequests }.
// `routing` + `product` (optional): the engine's routing and the product
// record, for a shop the registry routes — see the header.
function shopCentralWithdrawal({ dest, pid, entry, rr, inFlight, routes, locations, routing, product, snapshot = {}, nowMs = Date.now() } = {}) {
  if (!entry || !rr) return null;
  // No createdAt → "prior" cannot be judged: every seed and lock would read as
  // before the request and a legitimate first batch would be withdrawn. Leave
  // it (Fable review, PR #673).
  if (!rr.createdAt || !Number.isFinite(Date.parse(rr.createdAt))) return null;
  const source = entry.source || (routes || {})[dest];
  if (!forbiddenShopSource({ dest, source, routes, locations, routing })) return null;
  if (rr.status !== "open" || !requestUntouched(rr, nowMs) || inFlight) return null;
  const hub = shopHubFor(dest, { routes, locations, routing, product, pid });
  if (!hub) return null;   // a shop with no hub has nowhere else to go — the route itself is refused at intent time
  const { stock = {}, openIndex = {}, heldLines = {}, refillRequests = {} } = snapshot;
  const hubOpenRequests = [];
  for (const r of Object.values(refillRequests || {})) {
    if (r && r.status === "open" && r.productId === pid && r.requestingLocation === hub && !r.shadow) hubOpenRequests.push({ createdAt: r.createdAt });
  }
  const signals = hubPresenceSignals({
    hubNode: stock[hub] ? stock[hub][pid] : null,
    hubLocks: openIndex[hub] ? openIndex[hub][pid] : null,
    hubOpenRequests,
    heldLines: heldLines[hub] || null,
    sinceIso: rr.createdAt,
    pid,
  });
  return signals.length ? { hub, signals } : null;
}

// The cancelReason a withdrawal stamps. The SAME string the first-batch
// trigger stamps for "Hub 2 held it at creation" (first-batch.cjs
// HUB2_PRESENT_REASON): a reason, so the engine reads a withdrawal — no
// cooldown, no rejection learned at the shop's cell — and the trigger reads
// "the hub serves this, raise no Hub 2 leg from it".
const SHOP_HUB_PRESENT_REASON = "first_batch_hub2_present";

module.exports = {
  CENTRAL,
  SHOP_HUB_PRESENT_REASON,
  isShopLoc,
  shopHubFor,
  forbiddenShopSource,
  hubPresenceSignals,
  requestUntouched,
  pickInProgress,
  PICK_MARKER_TTL_MS,
  shopCentralWithdrawal,
};
