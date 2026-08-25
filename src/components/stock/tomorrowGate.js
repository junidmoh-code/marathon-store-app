// ─── THE TOMORROW GATE — data-driven "Schedule for Tomorrow" ─────────────────
//
// Warehouse staff click Tomorrow when they do not have the item, because they
// cannot see what Central holds. This module makes the action data-driven:
//
//   • the ROW's button label comes from a one-time read of the single Central
//     cell the promise would draw on ("Schedule for Tomorrow" when Central has
//     any available, "Out of stock" when it has none);
//   • the TAP re-reads that same cell fresh, so a screen left open cannot send
//     a promise the data no longer supports — an expired promise converts
//     silently to the out-of-stock outcome, and a promise that became
//     supportable again converts back to Tomorrow. One action, outcome
//     decided by the data at the moment of the tap.
//
// COST (measured 2026-08-25, the Refinement A decision): RTDB download is the
// project's largest bill line (~$346 of $409 in one month), so the gate reads
// SINGLE CELLS, never a subtree. Hub 1 sees ~84 warehouse rows and ~25
// Tomorrow taps per day (17-day insights_log means); one cell is ~250 B, so
// this whole feature costs ~(84+25) × 250 B ≈ 27 KB/day/device — against
// prefetching /stock/central at 1.05 MB per load. A 60 s session cache keeps
// scroll-driven remounts from re-reading rows.
//
// AVAILABILITY is the shared resolver's: max(0, qty), displays counted in.
// Central books no ready orders (orders are hub-placed) and refill fulfils
// deduct Central at fulfil, so the cell quantity needs no promise netting —
// see availabilityCore.js.
//
// FAIL-OPEN, DELIBERATELY AND ASYMMETRICALLY: an UNRESOLVABLE input (no
// productId, no size) or a FAILED read keeps today's behaviour (offer
// Tomorrow) — a false "Out of stock" wrongly messages a customer that their
// order is dead, while a false Tomorrow merely keeps the promise a human just
// chose to make. A MISSING CELL is not that: Central genuinely holds none, so
// it resolves 0.

import { ref, get } from "firebase/database";
import { database } from "../../firebase";
import { stockCellPath, assertSafeSegment } from "../../utils/sizeKey";
import { availableUnits } from "./availabilityCore";

const CENTRAL = "central";
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();   // "pid::rawSize" → { at, avail }

// Central's available units for one product+size, or NULL when the question
// cannot be asked (missing product/size, unsafe key, read failure). 0 is a
// real answer ("none available"); null is "unknown — keep today's behaviour".
export async function fetchCentralAvailability(productId, size, { fresh = false } = {}) {
  if (!productId || size == null || String(size).trim() === "") return null;
  let path;
  try {
    assertSafeSegment(String(productId), "productId");
    path = stockCellPath(CENTRAL, productId, String(size));
  } catch {
    return null;
  }
  const key = `${productId}::${String(size)}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.avail;
  try {
    const snap = await get(ref(database, path));
    const cell = snap.val();
    const avail = availableUnits(cell && typeof cell.qty === "number" ? cell.qty : 0);
    // Evict dead entries before growing — a warehouse tab lives all day and
    // the map would otherwise only ever gain keys.
    if (cache.size > 200) {
      const cutoff = Date.now() - CACHE_TTL_MS;
      for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
    }
    cache.set(key, { at: Date.now(), avail });
    return avail;
  } catch {
    return null;
  }
}

// The outcome a tap must produce, from a fresh availability answer.
// null (unknown) → "tomorrow": see the fail-open note above.
export function tomorrowTapOutcome(avail) {
  return avail !== null && avail <= 0 ? "out_of_stock" : "tomorrow";
}

// test seam
export const _cache = cache;
