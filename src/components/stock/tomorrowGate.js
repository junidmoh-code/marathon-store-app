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
import { availableUnits, isFootwearProduct } from "./availabilityCore";

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

// ─── WHICH ROWS THE GATE COVERS (2026-09-05) ─────────────────────────────────
// The warehouse queue is hub-switched and the order card is shared, so the
// button itself decides whether the Central question applies to this row.
//
// CENTRAL-FED SNEAKER ROWS ONLY — hub1 (2026-08-25) and hub2 (2026-09-05).
// Hub 2 draws the same Central replenishment Hub 1 does, so "does Central hold
// this?" is the right question before promising a Hub 2 customer a pair
// tomorrow. hub3/hubC are NOT in that class: they replenish from hub stock
// Central may never carry, so a missing Central cell there would read as a
// false "Out of stock" — the one failure this feature must never produce. They
// keep yesterday's behaviour verbatim (Tomorrow always offered, no probe, no
// re-check), and so do the shops, which never render this button.
//
// AND THE HUB 2 ARM IS FOOTWEAR ONLY — the correction that took two review
// rounds, because Hub 2 is where everything that is not a Hub 1 sneaker lives.
//
//   ROUND 1: a customer CLOTHING order placed in the central universe is
//   stamped hub:"hub2", placedAtHub:"hub2" (App.jsx: placedHub =
//   CR_HUB_BY_UNIVERSE[...] for a clothing line), so a bare hub2 disjunct swept
//   every Hub 2 clothing row into the gate.
//
//   ROUND 2: excluding productType "clothing" was still not enough, because
//   "not clothing" is not "footwear". A PERFUME record carries hubs:["hub2"],
//   no productType at all (63 of 65 perfumes have the field absent — the new
//   product form omits it for that category), and its customer order takes the
//   SNEAKER checkout branch, which stamps productType: "sneaker". So a perfume
//   row read as a gated Hub 2 sneaker row, and a perfume Central does not hold
//   would have offered "Out of stock" and auto-sent that outcome to a customer.
//   Perfume is not one of the seven sneaker categories, and "nothing else
//   changes" is the whole brief.
//
// So the hub2 arm asks the SAME question the grid gate asks — isFootwearProduct,
// the category test — instead of guessing from the order's own stamped type. An
// UNKNOWN product (no record in hand) is not probed: that is fail-open toward
// yesterday's behaviour, matching this module's stated asymmetry (a false
// "Out of stock" wrongly tells a customer their order is dead; a false Tomorrow
// merely keeps the promise a human just chose to make).
//
// Hub 1's arm is untouched and asks NOTHING about the product — hub1 carries
// neither clothing nor perfume, and "unchanged" beats "consistent" on a rule
// that was already right.
//
// The hub rule matches the app's orderInHub VERBATIM: hub3/hubC live in
// placedAtHub, hub1/hub2 in `hub` (defaulted hub1).
export const CENTRAL_FED_HUBS = ["hub1", "hub2"];
export function centralFedRow(order, product) {
  if (order?.placedAtHub === "hub3" || order?.placedAtHub === "hubC") return false;
  const hub = order?.hub || "hub1";
  if (!CENTRAL_FED_HUBS.includes(hub)) return false;
  if (hub === "hub1") return true;                                  // 2026-08-25, verbatim
  return isFootwearProduct(product);                                // hub2: the seven categories, only
}

// The outcome a tap must produce, from a fresh availability answer.
// null (unknown) → "tomorrow": see the fail-open note above.
export function tomorrowTapOutcome(avail) {
  return avail !== null && avail <= 0 ? "out_of_stock" : "tomorrow";
}

// test seam
export const _cache = cache;
