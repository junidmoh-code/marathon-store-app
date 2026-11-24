// ─── MISSING PRODUCTS — WHAT THE NUMBER ON A CARD MEANS (pure) ────────────────
// Junid, 24 Nov 2026: "The numbers on Missing Products must be 100% accurate.
// Staff solve based on the quantity a card shows."
//
//   "Central N" on a card = the units PHYSICALLY AT CENTRAL, in the sizes the
//   card's buttons would send, that are FREE TO SEND: on hand, less every unit
//   still owed to an OPEN request that Central supplies (its qty less what has
//   already been sent — sent units have left Central's shelf). A shadow request
//   never counts. Each size is floored at 0 on its own, then the sizes are
//   added, so the sizes always add up to the total exactly.
//
// Central's units on their way somewhere have already left Central's cell
// (a send moves them), so they are never counted here; units Central has
// picked but not yet sent are still owed to their open request, so they are
// not free either. Two people can therefore never both see the same unit as
// available.
//
// This module only ANSWERS. It reads what it is handed and writes nothing.
import { decodedCellKey } from "../../utils/sizeKey";
import { lockKeyFor } from "./firstBatchCore";

const qty = (c) => Math.max(Number(c?.qty) || 0, 0);

/** Which location supplies an open request: its stamped source, else its route, else Central. */
export function requestSource(r, routes = {}) {
  const stamped = r && r.createdFrom && typeof r.createdFrom === "object" ? r.createdFrom.source : null;
  return stamped || routes?.[r?.requestingLocation] || "central";
}

/** Is this request still owed units by Central? → the units, else 0. */
export function owedByCentral(r, routes = {}, central = "central") {
  if (!r || typeof r !== "object" || r.status !== "open" || r.shadow || !r.productId) return 0;
  if (requestSource(r, routes) !== central) return 0;
  return Math.max((Number(r.qty) || 0) - (Number(r.sentQty) || 0), 0);
}

/** size key → units Central still owes, for ONE product, from its request records. */
export function owedBySize(requests, pid, { routes = {}, central = "central" } = {}) {
  const out = {};
  for (const r of Array.isArray(requests) ? requests : Object.values(requests || {})) {
    if (!r || r.productId !== pid) continue;
    const n = owedByCentral(r, routes, central);
    if (!n) continue;
    const k = lockKeyFor(r.size);
    out[k] = (out[k] || 0) + n;
  }
  return out;
}

/** One size at Central: { onHand, owed, free }. `cells` is the product's Central node. */
export function centralSize(cells, owed, size) {
  const onHand = qty(cells?.[decodedCellKey(String(size))]);
  const o = Math.max(Number(owed?.[lockKeyFor(size)]) || 0, 0);
  return { onHand, owed: o, free: Math.max(onHand - o, 0) };
}

/** The sizes a card's buttons would send (every offered destination's, once each). */
export const rowSizes = (row) => [...new Set((row?.dests || []).flatMap((d) => (d.sizes || []).map(String)))];

/**
 * The card's figure from `cells` + `owed`: { total, sizes: [{ size, onHand, owed, free }] }.
 * `total` is exactly the sum of `sizes[].free`.
 */
export function cardFigure(row, cells, owed) {
  const sizes = rowSizes(row).map((size) => ({ size, ...centralSize(cells, owed, size) }));
  return { total: sizes.reduce((t, s) => t + s.free, 0), sizes };
}

/** Whole-product totals at Central (for "Not listed"): { onHand, owed, free }. */
export function productAtCentral(cells, owed) {
  let onHand = 0, free = 0, o = 0;
  const seen = new Set();
  for (const [k, c] of Object.entries(cells || {})) {
    if (k === "_meta") continue;
    const key = lockKeyFor(k);   // cells are DECODED (useStockCells): "5.5" → the request key "5_5"
    const n = qty(c);
    const ow = seen.has(key) ? 0 : Math.max(Number(owed?.[key]) || 0, 0);
    seen.add(key);
    onHand += n; o += Math.min(ow, n); free += Math.max(n - ow, 0);
  }
  return { onHand, owed: o, free };
}

/**
 * Did the data a card was drawn from change for the sizes it sends? Compares
 * per size, so a swap between two sizes that keeps the total is still caught.
 * → null when identical, else { was, now } (each a cardFigure).
 */
export function figureChanged(row, before, after) {
  const was = cardFigure(row, before.cells, before.owed);
  const now = cardFigure(row, after.cells, after.owed);
  const same = was.sizes.length === now.sizes.length && was.sizes.every((s, i) => s.free === now.sizes[i].free && s.onHand === now.sizes[i].onHand);
  return same ? null : { was, now };
}

/** pid → (size key → units owed by Central), in ONE pass over the records. */
export function owedIndex(requests, { routes = {}, central = "central" } = {}) {
  const out = new Map();
  for (const r of Array.isArray(requests) ? requests : Object.values(requests || {})) {
    const n = owedByCentral(r, routes, central);
    if (!n) continue;
    let m = out.get(r.productId);
    if (!m) { m = {}; out.set(r.productId, m); }
    const k = lockKeyFor(r.size);
    m[k] = (m[k] || 0) + n;
  }
  return out;
}
