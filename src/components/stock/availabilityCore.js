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

import { stockSizeKey, decodedCellKey } from "../../utils/sizeKey";
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
// createdAt) is older than this window no longer books a cell. Seven days
// covers every real collection lag observed (the live 3–7-day bucket held 2
// orders; >7d were all month-old ghosts) — a genuinely uncollected order past
// the window errs toward showing availability, the same direction every other
// partial-input rule in this file already leans. An order with NO parseable
// timestamp keeps subtracting (it cannot be aged; erring ✕-ward there keeps
// the pre-2026-09 behaviour for legacy shapes).
export const READY_PROMISE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Is this order's promise inside the freshness window? Exported so the
// display-pull promise map (displayPairCore) ages by the SAME rule.
export function promiseFresh(order, nowMs = Date.now()) {
  const t = Date.parse(order?.readyAt ?? order?.createdAt ?? "");
  if (!Number.isFinite(t)) return true;   // un-ageable — keep the promise
  return nowMs - t <= READY_PROMISE_MAX_AGE_MS;
}

// The ready-but-uncollected promises booked at `loc`, from an /orders slice
// (array of order records — whatever slice this device is allowed to read).
// Footwear only — see the header. Returns { "pid::sizeKey": units }.
//
// `hubOf` mirrors the app's orderInHub convention: hub3/hubC live in
// placedAtHub, everything else defaults through `hub` to hub1.
export function readyPromisedByCell(orders, loc, productsById, nowMs = Date.now()) {
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
  const cell = cells?.[productId]?.[decodedCellKey(String(size))];
  const qty = cell && typeof cell.qty === "number" ? cell.qty : 0;
  return availableUnits(qty, promised?.[promisedKey(productId, size)] || 0);
}

// WHY a cell reads as unavailable — same inputs, the parts kept apart:
//   booked    — clamped on-hand quantity (what a count would find)
//   promised  — units spoken for by ready-but-uncollected orders
//   available — the resolver's answer (availableUnits of the two)
// Exists for the ✕-tile explanation: "none here" and "the last one is
// reserved for an uncollected order" look identical as an ✕, and staff read
// the second as "this size doesn't exist" (owner report 2026-09-01, Lacoste
// Powercourt size 8 — counted stock, ✕ tile). The note needs the split.
export function cellBlockInfo({ cells, promised, productId, size }) {
  const cell = cells?.[productId]?.[decodedCellKey(String(size))];
  const qty = cell && typeof cell.qty === "number" ? cell.qty : 0;
  const booked = Math.max(Number(qty) || 0, 0);
  const spoken = Math.max(Number(promised?.[promisedKey(productId, size)]) || 0, 0);
  return { booked, promised: spoken, available: availableUnits(booked, spoken) };
}
