// ─── TRUSTED CELLS — which /stock cells the engine may believe at a "solved" location
//
// A location whose Auto-refill is "solved products only" (network registry)
// holds two kinds of cell: stock the apps PUT there — arrived through Solve or
// a refill, or confirmed by a stock count — and uncounted legacy stock nobody
// has verified (Pine's Lightspeed-era shelves). The first kind is TRUSTED; the
// engine and the refill health scan arm and refill trusted cells only, and the
// till deducts a trusted product's sale.
//
// Trust is an explicit marker on the cell, written IN THE SAME WRITE as the
// stock it describes and never on its own:
//   trusted: true, trustedAt: <ISO>, trustedVia: "solve" | "refill" | "count"
// Written ONLY at a location whose Auto-refill is "solved products only" (at
// any other location trust is never read, so Marathon's cells are untouched).
// Written by: the Solve seed (client NetworkTransfer, server first-batch), an
// inbound refill/order/hold-release leg (client applyMovement, server
// admin-movement — the movement carries link.refillId or link.orderId), and a
// count confirmation (CountSession, the hub count — the caller says so). Never
// by a manual edit alone (Adjust, Set Quantity, a hand transfer): those leave
// the marker exactly as it was.
//
// THREE COPIES, ONE BODY: this file, src/components/stock/stockTrust.js and
// the POS app's src/stock/stockTrust.js. Parity tests pin them.
"use strict";

// ── BEGIN SHARED BODY ────────────────────────────────────────────────────────
const TRUST_SOURCES = Object.freeze(["solve", "refill", "count"]);

function cellTrusted(cell) {
  return !!cell && typeof cell === "object" && cell.trusted === true;
}

// The fields a trusting write adds to a cell. `nowIso` is the server clock as
// the caller already has it (the same stamp as the cell's updatedAt).
function trustStamp(via, nowIso) {
  if (!TRUST_SOURCES.includes(via)) throw new Error(`trustStamp: unknown source ${String(via)}`);
  return { trusted: true, trustedVia: via, trustedAt: nowIso };
}

// Is an inbound movement one that TRUSTS the cell it lands in? A refill or
// order fulfilment (link.refillId / link.orderId — Source fulfilling a request,
// a shop-leg dispatch, a hold-lane release); never a hand transfer, an
// adjustment, a receipt typed in, a return or a sale.
const TRUSTING_TYPES = Object.freeze(["received", "transfer_in", "transfer_out"]);
function arrivalTrust(movement) {
  if (!movement || !TRUSTING_TYPES.includes(movement.type) || !movement.to) return null;
  const link = movement.link && typeof movement.link === "object" ? movement.link : {};
  if (link.refillId || link.orderId) return "refill";
  return null;
}

// May an ARRIVAL trust the cell it lands in? Only when the cell holds no
// uncounted stock already: absent, at or below zero, or trusted. An arrival
// onto 12 Lightspeed-era units must not vouch for those 12 — that cell
// waits for a count. (A count trusts whatever it confirms.)
function arrivalMayTrust(priorCell) {
  if (!priorCell || typeof priorCell !== "object") return true;
  if (cellTrusted(priorCell)) return true;
  const q = priorCell.qty;
  return !(typeof q === "number" && q > 0);
}

// A product node (/stock/{loc}/{pid}) → is ANY size trusted here? The till's
// question: a trusted PRODUCT deducts, whichever size sells.
function productTrustedAt(node) {
  if (!node || typeof node !== "object") return false;
  for (const k of Object.keys(node)) if (cellTrusted(node[k])) return true;
  return false;
}

// Which sizes of a product node are trusted (encoded size keys).
function trustedSizeKeys(node) {
  if (!node || typeof node !== "object") return [];
  return Object.keys(node).filter((k) => cellTrusted(node[k])).sort();
}
// ── END SHARED BODY ──────────────────────────────────────────────────────────

module.exports = { TRUST_SOURCES, cellTrusted, trustStamp, arrivalTrust, arrivalMayTrust, productTrustedAt, trustedSizeKeys };
