// ─── SELLABLE AVAILABILITY AT A LOCATION — the one shared resolver ───────────
//
// "How many units of product P size S can this location actually give out
// right now?" answered the same way on every surface that asks it. Introduced
// for the Hub 1 availability work (2026-08-25): the shop ordering grid greys
// out sizes Hub 1 cannot supply, and the warehouse Tomorrow action checks
// Central before promising. Both go through HERE — a second copy of this
// arithmetic on either screen would drift the first time the definition moved.
//
// THE DEFINITION (owner decisions, 2026-08-25 brief — do not relitigate):
//
//   available = max(0, cellQty) − readyPromised, floored at 0
//
//   • A NEGATIVE cell reads as zero. Negatives are count artifacts; they are
//     also being zeroed for real by scripts/zero-negative-cells.mjs, so the
//     clamp is a belt for the window between a new oversell and its heal.
//   • DISPLAY units are NOT subtracted. A display pair sits on the same shelf
//     as the stock at its hub — it IS available stock (owner decision; the
//     #324 "displays are hub stock" policy).
//   • READY-BUT-UNCOLLECTED ORDERS are subtracted where the caller can see
//     them. Footwear is not deducted at dispatch (recordDispatchTransfer:
//     "footwear_sells_from_hub" — the POS deducts at the till), so a sneaker
//     order marked Ready has physically left the hub while its unit is still
//     booked in the hub cell. Measured 2026-08-25: 45 such units at Hub 1
//     across 43 cells of 2,807 — small, but concentrated exactly on the cells
//     a customer is most likely to ask for next. Clothing DOES deduct at
//     dispatch, so only footwear promises are counted (a clothing subtraction
//     would double-count).
//   • LAYBY PULLS are NOT subtracted — /laybyPulls carries an itemCount only,
//     no productId and no size, so those units (215 at Hub 1 when this was
//     built, ~4% of its 5,150 booked units) cannot be attributed to any cell.
//     Known, quantified residual: availability can overstate by at most that
//     much in aggregate, never traceably per cell.
//   • FULFILLED-BUT-UNCOLLECTED REFILL LINES need no term: the fulfil already
//     moves the source cell (transfer_out at fulfil), and a held line credits
//     in_transit — never the destination — until release. The cell arithmetic
//     is already right by construction.
//
// PARTIAL INPUTS ARE EXPECTED AND SAFE. Store-assigned devices can only read
// their own shop's /orders (rule-enforced), so on the shop grid the promised
// map covers just that shop's ready orders; warehouse/admin devices see the
// full queue and net everything. A missing promised map means "no promises
// visible", which errs toward showing availability — the same failure the
// screens had before this module existed, never a new false X.
//
// No missed-demand logging: a blocked size is just an X (owner decision).
// Pure module — no firebase imports; callers feed it data they already hold.
//
// ONE HUB-2 FACT WORTH KNOWING (2026-09-05). The 20-minute window is measured
// from the RAW record's readyAt, which is stamped when the warehouse marks the
// order Sent. Hub 2 alone holds the CUSTOMER-facing reveal for 6 minutes after
// that (HUB2_DISPATCH_HOLD_MS — the parcel is on the van), so a Hub 2 customer
// gets roughly 14 minutes of hold after being told, not 20. Deliberate, not
// corrected here: the owner's directive is "don't reserve anything for anyone",
// so erring SHORT frees the size sooner, which is the direction they asked for.
// Reading notifyReadyAt instead would lengthen every Hub 2 ✕ — a behaviour
// change nobody asked for.
//
// HUB-AGNOSTIC BY CONSTRUCTION (restated 2026-09-05, when Hub 2 sneakers
// joined). `loc` is a parameter, not a constant: the same arithmetic answers
// for Hub 1, Hub 2 and Central, and there is no second definition of
// "available" anywhere in the tree — the clothing grey-out's zero-test routes
// through availableUnits too (App.jsx hubQty). Anything that needs a DIFFERENT
// answer per hub belongs in the caller's data (which cells, which promises),
// never in a fork of this file. Pinned by hub2SneakerAvailability.test.js.

import { stockSizeKey, decodedCellKey } from "../../utils/sizeKey";
import { serverNowMs } from "../../utils/serverTime";
import { isFootwearProduct } from "./missingFootwearCore";
export { isFootwearProduct };

// One key per cell in the promised map. Encoded size key space ("5.5" → "5_5"),
// because that is the space /stock cells live in and the one space every
// caller can reach from either a raw size or a stored key.
export const promisedKey = (productId, size) => `${productId}::${stockSizeKey(String(size))}`;

// ─── THE GHOST-PROMISE BOUND (2026-09-01) ────────────────────────────────────
// /orders is keyed by the DAILY order number, so a record survives until some
// later day's volume reaches its number again — measured 2026-09-01: 166
// "ready" records live, 56 of them older than 30 days. A ready order that was
// physically collected weeks ago (the till sale already moved the cell; only
// the status write was missed) still subtracts here, and because nothing ever
// expires it, the size reads ✕ FOREVER while real stock sits on the shelf —
// the "Lacoste Powercourt size 8" class of false ✕ (3 cells were blocked by
// promises from exactly one month before; 7 of the 14 blocked cells were
// stale). So a promise now has a shelf life: an order whose readyAt (fallback
// createdAt) is older than this window no longer books a cell.
//
// TWENTY MINUTES — OWNER DIRECTIVE, 2026-09-01 (supersedes the 14-day window
// #545 shipped with, same day): "don't reserve anything for anyone — if the
// item is not collected in 15 minutes you can allow it to be ordered; 20
// minutes is the deadline." A ready order holds its size for 20 minutes from
// readyAt; past that the size is orderable again, deliberately — collections
// here are same-visit, not layby. The failure direction is stated and
// accepted: a slower collector's pair can be ordered by someone else, and the
// warehouse resolves it on the shelf (the visible out-of-stock path, never a
// silent double-sell — the pair itself is at the shop, not on the hub shelf).
// An order with NO parseable timestamp keeps subtracting (it cannot be aged;
// erring ✕-ward keeps the legacy-shape behaviour).
export const READY_PROMISE_MAX_AGE_MS = 20 * 60 * 1000;

// Is this order's promise inside the freshness window? `maxAgeMs` lets a
// caller with a DIFFERENT lane age by its own deadline (displayPairCore's
// pull claims must survive "coming tomorrow"; the 20-minute collection
// deadline is a READY-lane rule only).
// serverNowMs, not Date.now(): the stamps being aged were written through
// serverNowIso, and a till whose clock runs ahead (the documented 2026-07-17
// failure) would otherwise silently expire FRESH promises fleet-wide.
// serverTime is deliberately dependency-free, so the no-firebase purity of
// this module holds. readyAt is preferred but an unparseable readyAt (an
// "" default exists in the wild) falls THROUGH to createdAt, not to "keep".
export function promiseFresh(order, nowMs = serverNowMs(), maxAgeMs = READY_PROMISE_MAX_AGE_MS) {
  let t = Date.parse(order?.readyAt ?? "");
  if (!Number.isFinite(t)) t = Date.parse(order?.createdAt ?? "");
  if (!Number.isFinite(t)) return true;   // un-ageable — keep the promise
  return nowMs - t <= maxAgeMs;
}

// The ready-but-uncollected promises booked at `loc`, from an /orders slice
// (array of order records — whatever slice this device is allowed to read).
// Footwear only — see the header. Returns { "pid::sizeKey": units }.
//
// `hubOf` mirrors the app's orderInHub convention: hub3/hubC live in
// placedAtHub, everything else defaults through `hub` to hub1.
export function readyPromisedByCell(orders, loc, productsById, nowMs = serverNowMs()) {
  const out = {};
  if (!loc) return out;
  for (const o of orders || []) {
    if (!o || o.status !== "ready") continue;
    if (!promiseFresh(o, nowMs)) continue;   // ghost record — see the bound above
    // EXACTLY the app's orderInHub rule (App.jsx): hub3/hubC read placedAtHub
    // ONLY; every other hub reads `hub` (defaulted hub1). A looser
    // `placedAtHub || hub` here booked a {placedAtHub:"hub1", hub:"hub2"}
    // record against Hub 1 that the warehouse lists under Hub 2 — a false ✕.
    const inHub = (loc === "hub3" || loc === "hubC")
      ? o.placedAtHub === loc
      : (o.hub || "hub1") === loc;
    if (!inHub) continue;
    if (!o.productId) continue;
    const p = productsById ? productsById[o.productId] : null;
    if (!p || !isFootwearProduct(p)) continue;
    const size = o.sentSize ?? o.size ?? "";
    const key = promisedKey(o.productId, size);
    if (key.endsWith("::_")) continue;   // sizeless order — not attributable to a cell
    out[key] = (out[key] || 0) + (Number(o.qty) || 1);
  }
  return out;
}

// ─── WHICH HUB ANSWERS FOR A SNEAKER TILE (2026-09-05) ───────────────────────
// The shop ordering grid gates a sneaker size on the availability of the hub
// that would actually have to supply it. `routedHub` is the caller's own
// routing answer (App.jsx computeHubForItem — the same routing the order
// itself will take); this returns the hub whose data should gate, or NULL for
// "no gate, yesterday's behaviour".
//
// TWO HUBS, and deliberately only two:
//   • hub1 — the original build (2026-08-25)
//   • hub2 — joined 2026-09-05, this file's whole reason for existing twice
//   • hub3 (Pine) and everything else — NULL. Pine replenishes on its own
//     terms and its grid has never been gated; the shops never run this gate
//     at all (they are order DESTINATIONS, not the supplying hub).
//
// isFootwearProduct, not merely "not clothing": the sneaker browse grid also
// carries perfumes, bags and one-size accessories (no productType), whose
// availability promises this gate does not model — they keep yesterday's
// behaviour. (Adversarial review, PR #446.)
export const GATED_SNEAKER_HUBS = ["hub1", "hub2"];

// ── WHERE A DISPLAY PAIR LIVES ───────────────────────────────────────────────
// The display-pair lane is hub1-scoped by construction: the slots node, the
// register and sneakerServedByHub1 all name hub1. A line flagged
// displayPairRequest is therefore a HUB 1 pull of one identified physical pair,
// and its hub is a FACT rather than a routing question — see the placement
// path, where sending it through the stock-aware resolver could redirect it to
// a hub that has no display register at all.
export const DISPLAY_PAIR_HUB = "hub1";
export function gatedSneakerHub(product, routedHub) {
  if (!isFootwearProduct(product)) return null;
  if ((product?.productType || "sneaker") === "clothing") return null;
  return GATED_SNEAKER_HUBS.includes(routedHub) ? routedHub : null;
}

// The resolver itself. `cellQty` is the raw booked quantity (may be negative);
// `promised` is the units already spoken for in that cell (absent → 0).
export function availableUnits(cellQty, promised = 0) {
  const booked = Math.max(Number(cellQty) || 0, 0);
  const spoken = Math.max(Number(promised) || 0, 0);
  return Math.max(booked - spoken, 0);
}

// Convenience over a DECODED cells map ({ pid: { decodedKey: cell } }, the
// useStockCells shape) plus a promised map from readyPromisedByCell.
// decodedCellKey, NOT the raw size: a decoded map is keyed by
// decodeSizeKey(storedKey), so "Free Size" lives under "_" and a
// space-padded " 8" under "_8" — indexing by the raw catalogue size read
// both as qty 0 and produced a false ✕ (adversarial review, PR #446).
export function cellAvailability({ cells, promised, productId, size }) {
  return cellBlockInfo({ cells, promised, productId, size }).available;
}

// WHY a cell reads as unavailable — same inputs, the parts kept apart:
//   booked    — clamped on-hand quantity (what a count would find)
//   promised  — units spoken for by ready-but-uncollected orders
//   available — the resolver's answer (availableUnits of the two)
// Exists for the ✕-tile explanation: "none here" and "the last one is
// reserved for an uncollected order" look identical as an ✕, and staff read
// the second as "this size doesn't exist" (owner report 2026-09-01, Lacoste
// Powercourt size 8 — counted stock, ✕ tile). The note needs the split.
// cellAvailability above is DEFINED as this split's `available` — one copy of
// the arithmetic, per this module's own header rule.
// NOTE: like every helper here, this does not know whether the cells map has
// settled — callers gate on their read state (the screens gate via
// sneakerOut) before treating booked:0 as "truly empty".
export function cellBlockInfo({ cells, promised, productId, size }) {
  const cell = cells?.[productId]?.[decodedCellKey(String(size))];
  const qty = cell && typeof cell.qty === "number" ? cell.qty : 0;
  const booked = Math.max(Number(qty) || 0, 0);
  const spoken = Math.max(Number(promised?.[promisedKey(productId, size)]) || 0, 0);
  return { booked, promised: spoken, available: availableUnits(booked, spoken) };
}

// ─── WHICH HUB SHOULD ACTUALLY SUPPLY THIS SIZE (2026-09-06) ─────────────────
//
// THE DEFECT THIS EXISTS FOR. On 2026-09-06 a shop opened the order sheet for
// CHRISTINA LOUBOUTIN LOUIS PARIS black and every one of its six sizes read ✕,
// under a heading that said "Hub 1". The gate was RIGHT: /stock/hub1 held no
// row for that product at all. All eleven units were at HUB 2 (sizes 6–11 =
// 2,2,2,2,2,1), moved there from Central by transfers on 3 and 5 September.
// What was wrong sat one step upstream — gatedSneakerHub above is handed
// `routedHub` from App.jsx computeHubForItem, which reads the product record's
// `hubs` TAG and nothing else. The tag still said hub1. So the sheet asked the
// empty hub whether it could supply, got a truthful no, and refused the sale
// of stock the company was holding two doors down.
//
// A TAG IS AN INTENTION; A CELL IS A FACT. Nothing moves the `hubs` tag when
// stock moves: it is set by hand in the product editor and by append-on-toggle,
// while /stock is written by every transfer, count and till sale. The two drift
// silently and permanently, and the ✕ turns that drift into a refused sale.
// Catalogue census the day this shipped: of 1,438 active gated sneakers, 31
// were WHOLLY unorderable this way (187 units stranded at the other hub, 26 of
// them tagged hub1 with the stock at hub2, 5 the other way), across 107
// product×size chips of 9,053. This one product was 11 of those units.
//
// NOT THE 1-SEPTEMBER SEAM. That report (Lacoste Powercourt size 8) was a
// GHOST PROMISE — real stock in the right hub's cell, subtracted by a ready
// order that was never closed, fixed by READY_PROMISE_MAX_AGE_MS above. This
// is a different seam entirely: the promised term is zero here and the cell is
// not merely empty but ABSENT. Same symptom on the tile, unrelated cause.
//
// THE RULE, and it is deliberately narrow:
//
//   • THE TAG STILL WINS WHENEVER IT CAN SUPPLY. If the tagged hub has one or
//     more units available for this size, it answers — full stop. This is not
//     a "pick the fuller hub" balancer, and it must never become one: the tag
//     encodes where the owner wants a shoe served from, and re-routing a
//     suppliable size would change live Hub 1 behaviour beyond the defect.
//   • ONLY A ZERO REROUTES, and only to a hub that actually has the size.
//     Tagged hub 0 + other gated hub >0 → the other hub answers, the size is
//     orderable again, and the ✕ note (when some other reason blocks it) names
//     the hub that will really pick it.
//   • BOTH ZERO → THE TAGGED HUB, unchanged. The ✕ still fires and still says
//     "Hub 1", which is the true and useful answer: nobody has it.
//   • NEVER ON UNSETTLED OR ERRORED DATA. A hub whose subtree has not settled,
//     or errored, is not evidence of zero — it is silence, and silence must
//     not move an order. `ready` false on the tagged hub means no reroute at
//     all (the gate is already open in that state); `ready` false on the
//     alternate means it cannot be chosen.
//   • ONLY BETWEEN THE GATED HUBS (hub1 ⇄ hub2) AND ONLY FOR GATED SNEAKERS.
//     Pine/hub3 is not a candidate and is never rerouted away from: Pine
//     replenishes on its own terms, its grid has never been gated, and
//     gatedSneakerHub already refuses it. Clothing, perfume, bags and one-size
//     accessories keep exactly yesterday's routing.
//
// PER SIZE, NOT PER PRODUCT. The 107 affected chips are not all whole products
// — a shoe can hold 8s at Hub 1 and 9s at Hub 2. The gate has always been a
// per-size question; this makes the ROUTING one too, so the tile and the order
// line placed from it can never disagree about who is picking.
//
// Pure, like everything here: the caller passes the two hubs' data in.
// `hubData[hub]` is { cells, promised, ready } — cells/promised in exactly the
// shapes cellAvailability takes, `ready` the caller's settled-and-not-errored
// read state for that hub's subtree.
// ── THE CART IS PART OF THE QUESTION (2026-09-06) ────────────────────────────
// The first version of this decided from cellAvailability alone — booked minus
// ready-promises — and did NOT subtract what the DEVICE'S OWN CART has already
// committed. The screen then subtracted the cart AFTERWARDS, against whichever
// hub this had already chosen, so the two disagreed in one specific and very
// reachable way:
//
//   resolver:   available(tag) > 0        -> "the tag can supply", tag wins
//   sneakerOut: available(tag) <= inCart  -> ✕
//
// ...and the alternate hub was never consulted, however much it held. An
// assistant with one pair of a size in the cart was refused a second pair that
// physically exists at the other hub. Measured on live stock 2026-09-06: 14
// product/size cells at cart depth 1, 46 at depth 2, 60 at depth 3 — 20, 95 and
// 121 strandable units respectively.
//
// So routing and availability are ONE computation now, returning both answers,
// and the screen reads `available` rather than recomputing it. That is this
// file's own standing rule — there is no second definition of "available" — and
// the split is exactly how the two came to disagree.
//
// THE CART DRAINS THE TAGGED HUB FIRST, then spills. A cart line is a claim on
// one unit of a product+size, not on a hub: the tag wins whenever it can
// supply, so the first `taggedRaw` units of the cart come off the tag and only
// the excess reaches the alternate. Subtracting the whole cart from BOTH hubs
// would double-count it and refuse a pair that exists (tagged 1 + alternate 1 +
// cart 1 must leave one orderable, not none).
//
// Everything else is unchanged, and identical at cart depth 0 — verified
// branch by branch. See resolveSneakerSourcingHub below for the original rule,
// which still reads exactly as it did.
export function resolveSneakerSourcing({ product, taggedHub, size, hubData, consumedByHub = null }) {
  // `available: null` means "this rule does not answer for it" — NOT zero. A
  // caller must test it with Number.isFinite, because `null <= 0` is true in
  // JavaScript and would turn "not our business" into "out of stock".
  const NO_ANSWER = { hub: taggedHub, available: null };

  // Not a gated sneaker, or tagged at a hub this rule does not cover (hub3,
  // hubC, anything new) — the tag is the answer, untouched.
  if (!gatedSneakerHub(product, taggedHub)) return NO_ANSWER;
  if (!size) return NO_ANSWER;                 // no size, no per-cell question

  const alternate = GATED_SNEAKER_HUBS.find((h) => h !== taggedHub);
  const tagged = hubData?.[taggedHub];
  const alt = hubData?.[alternate];
  // Silence is not zero. A hub we have not read cannot be judged empty, and
  // cannot be chosen instead.
  if (!tagged?.ready) return NO_ANSWER;

  // ── CONSUMPTION IS PER HUB, BECAUSE ALLOCATION IS ─────────────────────────
  // This took a scalar `consumed` and drained the tagged hub first, spilling
  // the excess. That models a cart as "N units of this size from wherever", and
  // it is wrong the moment a line is PINNED to a hub: a display pull is a Hub 1
  // unit by construction, and charging it against a Hub-2 tag made the next
  // line believe Hub 2 was empty and route to a Hub 1 that only ever had the
  // display pair — allocating that one pair twice while Hub 2's ordinary pair
  // sat unused (independent review, reproduced 2026-09-06).
  //
  // The caller allocates line by line and tells us what it has taken FROM EACH
  // HUB. The arithmetic is then simply per-hub subtraction — no spill rule, and
  // no way for a unit to be charged to a shelf it never came off.
  const takenAt = (h) => Math.max(Number(consumedByHub?.[h]) || 0, 0);
  const taggedRaw = cellAvailability({ cells: tagged.cells, promised: tagged.promised, productId: product?.id, size });
  const taggedLeft = Math.max(taggedRaw - takenAt(taggedHub), 0);
  if (taggedLeft > 0) return { hub: taggedHub, available: taggedLeft };

  // The tag is exhausted. Only now does the alternate matter — and only if we
  // have actually read it.
  if (!alt?.ready) return { hub: taggedHub, available: 0 };
  const altRaw = cellAvailability({ cells: alt.cells, promised: alt.promised, productId: product?.id, size });
  const altLeft = Math.max(altRaw - takenAt(alternate), 0);
  if (altLeft > 0) return { hub: alternate, available: altLeft };

  // BOTH EMPTY → THE TAGGED HUB, and a true ✕ that names the right shelf.
  return { hub: taggedHub, available: 0 };
}

// ── ALLOCATING A CART, LINE BY LINE ──────────────────────────────────────────
// Every question the ordering screen asks about a sneaker size depends on what
// the DEVICE'S CART has already claimed and, crucially, FROM WHICH HUB. Two
// earlier attempts at this lived in the screen and were wrong in ways that
// routed real orders to empty shelves, so it is a pure function now, and one
// walk feeds both the tile ("can I add one more?") and the checkout ("where
// does THIS line come from?").
//
// THE THREE RULES, each of which was a defect first:
//
//   1. A CLASSIC DISPLAY PARTNER REQUEST CONSUMES NOTHING. It asks for what a
//      hub does NOT have — it is a request, never a pull. Counting it made the
//      next ordinary line believe the stock was gone and routed it to an empty
//      hub.
//   2. A DISPLAY PULL IS PINNED, AND CHARGED WHERE IT IS PINNED. The lane is
//      hub1-scoped, so the unit comes off Hub 1 whatever the product's tag
//      says. Charging it against the tag let the next line allocate Hub 1's
//      single display pair a SECOND time while the alternate's ordinary pair
//      sat unused.
//   3. CONSUMPTION IS PER HUB. A cart is not "N units from wherever": each line
//      draws from one shelf, and the next line must see that shelf shorter and
//      the other one untouched.
//
// Cart ORDER is allocation order — stable, and what the assistant sees. A line
// added first keeps its hub when a later one is added.
//
// `taggedHubFor(product)` is the caller's tag router; `hubData` is the same
// { cells, promised, ready } map resolveSneakerSourcing takes.
export function allocateSneakerCart({ lines, hubData, taggedHubFor, displayPairHub = DISPLAY_PAIR_HUB }) {
  const hubOf = new Map();        // line -> the hub it draws from
  const consumed = new Map();     // "pid::size" -> { hub1, hub2 }
  for (const line of lines || []) {
    if ((line?.productType || "sneaker") === "clothing") continue;
    if (line?.requestDisplayPartner && line?.displayPairRequest !== true) continue;   // rule 1
    const pid = line?.product?.id;
    if (!pid || !line?.size) continue;
    const key = `${pid}::${line.size}`;
    const taken = consumed.get(key) || {};
    const hub = line.displayPairRequest === true
      ? displayPairHub                                                                 // rule 2
      : resolveSneakerSourcing({
          product: line.product, taggedHub: taggedHubFor(line.product),
          size: line.size, hubData, consumedByHub: taken,                              // rule 3
        }).hub;
    if (!hub) continue;
    hubOf.set(line, hub);
    consumed.set(key, { ...taken, [hub]: (taken[hub] || 0) + 1 });
  }
  return { hubOf, consumed };
}

export function resolveSneakerSourcingHub(args) {
  return resolveSneakerSourcing(args).hub;
}
