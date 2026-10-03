// ─── THE SUBMIT-TIME STOCK GUARD (2026-10-03) ────────────────────────────────
//
// THE DEFECT. Order #148 (Diesel slide black, size 10) was placed for Marathon
// PE against Hub 1 while size 10 read 0 at Hub 1 AND Hub 2, and the warehouse
// marked it Out of Stock seventeen minutes later. The grid's ✕ is the only
// thing that ever stood between a size and an order, and it is deliberately
// OPEN while the hub subtree has not settled (a still-loading screen must not
// blank a grid), on a device whose offline copy is mid-download, and — before
// this change — for every Pine shoe. `placeOrders` itself checked nothing.
//
// THE RULE. Before anything is written, every stock-drawing line re-reads the
// ONE cell it will draw from — stock/{hub}/{pid}/{sizeKey}, never the hub
// subtree — and the whole checkout is refused, cart intact, unless that cell
// holds at least as many units as the cart is about to take from it. One
// shortfall refuses the lot: the lines are written one by one, and placing
// half a customer's order while the sheet reports a refusal is the confusing
// outcome, not the safe one.
//
//   • Zero, a missing cell, a negative cell and a cleared ("uncounted") cell
//     all hold nothing — clamped quantity, the same arithmetic as the grid
//     (availableUnits; negatives are count artefacts).
//   • An UNREADABLE cell refuses too. "Could not check" is not "in stock", and
//     the whole point of this guard is that it never silently accepts.
//   • The cart is counted PER CELL: two lines of size 8 against a cell of 1
//     is a shortfall even though each line alone would pass.
//
// It deliberately does NOT net ready-promises or the display-pull lane: the
// grid already does that from the maps it streams, and this guard's job is the
// floor beneath it — "the shelf this order goes to holds nothing" — read live,
// at the moment of commitment. A size the grid ✕'d for a promise cannot reach
// the cart in the first place.
//
// A FLOOR, NOT AN ORACLE. Firebase `get` answers from the device's cache when
// a listener on an ancestor path is already open and settled, so on a device
// streaming the hub subtree live this re-read equals what the grid saw. What it
// closes is the case #148 came from: a grid whose hub read had not settled (or
// was served by an incomplete offline copy) — there `get` goes to the server.
//
// WHICH LINES. The caller decides (it knows the routing); this module only
// counts and judges. Pure: the cell reader is injected, so the tests drive it
// through a fake RTDB and the screen through firebase `get`.

import { availableUnits } from "./availabilityCore";

// A read that never answers (a device that has lost its connection mid-tap)
// must not hold the Place button forever. Long enough for a slow 3G till.
export const SUBMIT_GUARD_READ_TIMEOUT_MS = 10_000;

// `lines`: [{ key, hub, productId, size, label }] — one entry per unit the
// checkout is about to take (a line of qty 1; the screen's customer lines are
// one unit each). `readCell(hub, productId, size)` resolves to the raw cell
// value (an object with `qty`, or null when absent) and may reject.
//
// Resolves to null when every line is covered, or to the first refusal:
//   { reason: "short",      hub, productId, size, label, have, want }
//   { reason: "unreadable", hub, productId, size, label, error }
// `isOnline()` (optional) resolves true only while the device holds a live
// server connection. Firebase `get` falls back to the local cache when it is
// offline, so a cached POSITIVE cell could otherwise pass a pair that sold out
// since (CodeRabbit, PR #671). Offline → every line is "unreadable": refused.
// While connected, a cache answer is kept current by the live listener that
// put it there, which is the floor this guard claims and no more.
export async function findSubmitShortfall({ lines, readCell, isOnline = null, timeoutMs = SUBMIT_GUARD_READ_TIMEOUT_MS }) {
  // Demand per cell, in first-appearance order so the refusal names the line
  // the assistant added first.
  const demand = new Map();
  for (const line of lines || []) {
    if (!line || !line.hub || !line.productId || line.size == null || line.size === "") continue;
    const k = `${line.hub}::${line.productId}::${line.size}`;
    const d = demand.get(k);
    if (d) d.want += 1;
    else demand.set(k, { hub: line.hub, productId: line.productId, size: line.size, label: line.label || "", want: 1 });
  }
  if (demand.size && isOnline) {
    let online = false;
    try { online = (await withTimeout(isOnline(), timeoutMs)) === true; } catch { online = false; }
    if (!online) {
      const first = demand.values().next().value;
      return { reason: "unreadable", ...first, error: "offline" };
    }
  }
  // Every cell read at once — a cart of five shoes is five small reads, not
  // five round trips in a row in front of the customer.
  const checks = [...demand.values()].map(async (d) => {
    try {
      const cell = await withTimeout(readCell(d.hub, d.productId, d.size), timeoutMs);
      const qty = cell && typeof cell === "object" ? cell.qty : null;
      const have = availableUnits(typeof qty === "number" ? qty : 0);
      return have >= d.want ? null : { reason: "short", ...d, have };
    } catch (error) {
      return { reason: "unreadable", ...d, error: String(error?.message || error) };
    }
  });
  const results = await Promise.all(checks);
  return results.find(Boolean) || null;
}

// The sentence the sheet shows. Names the size and the hub, says nothing was
// placed, and says what to do next.
export function submitShortfallMessage(refusal, hubLabel = (h) => h, formatSize = (s) => s) {
  if (!refusal) return "";
  const where = hubLabel(refusal.hub) || refusal.hub;
  const size = formatSize(refusal.size);
  const what = refusal.label ? `${refusal.label} size ${size}` : `Size ${size}`;
  if (refusal.reason === "unreadable") {
    return `Couldn't confirm stock for ${what} at ${where} — check the connection and try again. Nothing was placed.`;
  }
  if (refusal.have <= 0) {
    return `${what} is out of stock at ${where} — remove it from the cart to place the rest. Nothing was placed.`;
  }
  return `${where} only holds ${refusal.have} of ${what}, and the cart has ${refusal.want} — remove ${refusal.want - refusal.have} to place the order. Nothing was placed.`;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("stock check timed out")), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
