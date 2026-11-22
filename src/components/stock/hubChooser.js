// ─── THE SNEAKER HUB CHOOSER — which pills are lit (pure) ─────────────────────
// Junid, 22 Nov 2026. The chooser offers Hub 1, Hub 2 and Hub 3. Hub 1 and Hub 2
// never share a sneaker, so the two are a SWITCH: tapping one turns the other
// off. Hub 3 is its own toggle and keeps its state through that switch.
//
// The bug this replaces: with Hub 1 lit, a tap on Hub 2 built [Hub 1, Hub 2],
// found the pair is not allowed, and refused the tap — so the pill did nothing,
// and the same the other way round. No pill is ever dead to a tap now: every
// tap changes the selection, and anything that would stop the Confirm is said
// on the panel instead (MissingFootwear.jsx).
//
// This decides ONLY what is selected. What a selection may raise, and whether
// the other Marathon hub already has the product seated, is still decided where
// it always was (concreteDivision.js sneakerSolvePairAllowed / marathonHubSeated,
// re-checked live at Confirm).
import { otherMarathonHub } from "./concreteDivision";

/**
 * The selection after a tap on `hub`.
 *   • a lit pill goes off (the selection may become empty — the panel then asks
 *     for a hub, it never re-lights a default behind the tap);
 *   • an unlit Hub 1 / Hub 2 goes on and turns its opposite number off;
 *   • an unlit Hub 3 goes on beside whatever is lit.
 * Order is the order ticked (the split of a short Central is dealt in it).
 */
export function switchHubPick(current, hub) {
  const cur = Array.isArray(current) ? current.filter(Boolean) : [];
  if (!hub) return cur;
  if (cur.includes(hub)) return cur.filter((h) => h !== hub);
  const opposite = otherMarathonHub(hub);
  return [...cur.filter((h) => h !== opposite), hub];
}
