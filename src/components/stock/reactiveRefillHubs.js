// ─── WHICH HUBS TAKE REACTIVE REFILL LINES ───────────────────────────────────
// (Owner order 2026-08-25, Hub 1 single-path decision.)
//
// HUB 1 IS ENGINE-ONLY: the per-size sneaker policy scan is the ONLY thing
// that raises a request from Central for hub1. No sale-driven row, no on-hold
// "Coming Tomorrow" line, no Missing Sneakers pick — a hub1 cell refills when
// the scan sees it at its reorder point, and nothing else asks on its behalf.
// Hub 2 keeps every reactive lane exactly as it was.
//
// One constant, imported by every reactive writer, so "which hubs react"
// can never drift between the on-hold planner, the Missing Sneakers buttons
// and the sale-driven queue rows. Removing a hub here silences its reactive
// lanes ONLY — open rows already written complete normally, and the engine's
// own requests are untouched (they are not "reactive").
import { backStockFor, isLive } from "../../utils/networkRegistry";
import { net, storeIds } from "./sectionRouting";

export const REACTIVE_REFILL_HUBS = Object.freeze(["hub2"]);

// ── THE SAME RULE, ASKED OF THE NETWORK REGISTRY ─────────────────────────────
// "Hub 2" was never the rule — the rule is "the hub that holds a shop's
// everyday back stock". Hub 2 is that for Marathon PE and Trophy; Hub 3 is
// that for Pine and Concrete. Hub 1 is a back-stock hub for ONE category
// (sneakers) and stays engine-only, exactly as decided above; the Concrete
// Stockroom is the same kind of hub until the owner makes it a default.
//
// LIVE ONLY. A reactive line is a request raised automatically, and nothing
// automatic routes to a location that has not been counted in. So on the
// registry's seed this answers ["hub2"] — the constant above, which is kept
// for the callers that still import it (pinned equal by test). When Hub 3
// goes live it joins, with no code change.
export function reactiveRefillHubs(network) {
  const N = net(network);
  const out = [];
  for (const s of storeIds(N, { liveOnly: true })) {
    const h = backStockFor(N, s, null, null);
    if (h && isLive(N, h) && !out.includes(h)) out.push(h);
  }
  return out.sort();
}

export function isReactiveRefillHub(hub, network) {
  return reactiveRefillHubs(network).includes(hub);
}
