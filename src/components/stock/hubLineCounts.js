// ─── SOURCE: HOW MANY REQUESTS SIT BEHIND EACH HALF OF A HUB TOGGLE ──────────
// Junid, 24 Nov 2026. Hub 2's (and Hub 3's) refill tab opens on "Sneakers"
// every visit; 519 Hub 2 clothing requests waited behind "Clothing" with
// nothing on the button to say so. The buttons now carry the count.
//
// Same count as the tab badge (countsTowardSourceQueue: open, has a product,
// not a shadow preview), split by the toggle's own classifier (isFootwearLine).
// Pure: the screen hands in what it already holds; nothing is read.
import { countsTowardSourceQueue } from "./firstBatchCore";
import { isFootwearLine } from "../../utils/footwearLine";

export const TOGGLE_HUBS = Object.freeze(["hub2", "hub3"]);

/**
 * requests   the open-request list the Source screen holds (array)
 * productOf  (pid) → product (or undefined)
 * shopLocs   Set of shop ids (countsTowardSourceQueue's own argument)
 * → { hub2: { sneakers, clothing }, hub3: { sneakers, clothing } }
 */
export function hubLineCounts(requests, productOf, shopLocs = new Set()) {
  const out = Object.fromEntries(TOGGLE_HUBS.map((h) => [h, { sneakers: 0, clothing: 0 }]));
  for (const r of Array.isArray(requests) ? requests : []) {
    const c = out[r?.requestingLocation];
    if (!c || !countsTowardSourceQueue(r, shopLocs)) continue;
    c[isFootwearLine(productOf(r.productId), r.size) ? "sneakers" : "clothing"] += 1;
  }
  return out;
}
