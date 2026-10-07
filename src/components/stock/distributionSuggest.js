// ============================================================================
// INITIAL DISTRIBUTION — SUGGESTION ENGINE (V1)
//
// Pure module: given a product, propose per-destination per-size quantities
// for the first push out of Central after a receiving event. This is the
// SUGGESTION layer only — it never reads RTDB, never moves stock, and knows
// nothing about transfers. The wizard (InitialDistributionWizard.jsx) shows
// these numbers, the operator edits them, and only the operator's FINAL
// quantities are handed to the transfer layer (applyMovement). Keep that
// boundary: future versions of this module may weigh current stock, sales
// history, assortment and forecasts, and none of that may leak into the
// transfer code.
//
// V1 is deliberately dumb-and-consistent (owner decision, 2026-07-16): every
// product starts from the standard distribution tables below, exactly as
// specified — no reductions based on destination stock. The operator decides.
//
// Size families:
//   letters — clothing tops (S…4XL): per-destination letter tables.
//   waist   — bottoms (28…40): positional mapping onto the letter tables
//             (28↔S … 40↔4XL). No operational curve existed when this
//             shipped — zero waist-size products in the catalog — so the
//             letter curve is the agreed starting point.
//   shoe    — any sneaker (adult 3–11 incl. half sizes, kids 26–35): flat
//             run per size to the hubs; shops get zero by default (shops are
//             fed shoes from the hubs, not from Central directly).
// ============================================================================

import { policyKeyFor, isLive } from "../../utils/networkRegistry";
import { net, storeIds, hubIds, isStore, nameOf } from "./sectionRouting";

// Every operational destination the wizard offers, in display/deal order.
export const DISTRIBUTION_DESTS = ["marathon-pe", "trophy", "marathon-pine", "hub1", "hub2"];

// ── THE DESTINATIONS, FROM THE NETWORK REGISTRY ──────────────────────────────
// The five above, in the order the wizard has always dealt them, then every
// other store and hub the registry knows (Concrete, Hub 3, the Concrete
// Stockroom). The wizard is a person sending stock out of Central BY HAND —
// Central supplies both sections — so a location that is not live is offered
// like any other; it is simply never pre-ticked (see defaultOn below).
export function distributionDests(network) {
  const N = net(network);
  const known = [...storeIds(N), ...hubIds(N)];
  return [...DISTRIBUTION_DESTS.filter((d) => known.includes(d)), ...known.filter((d) => !DISTRIBUTION_DESTS.includes(d))];
}
// A destination's label: the registry's name (a missing id reads as itself).
export const destLabel = (dest, network) => DEST_LABELS[dest] || nameOf(dest, network);

export const DEST_LABELS = {
  "marathon-pe": "Marathon PE",
  trophy: "Trophy",
  "marathon-pine": "Pine",
  hub1: "Hub 1",
  hub2: "Hub 2",
};

const LETTER_SIZES = new Set(["S", "M", "L", "XL", "XXL", "XXXL", "4XL"]);

// Standard runs — owner-specified defaults (spec 2026-07-16). 4XL was not in
// the spec tables → 0 everywhere until the owner says otherwise.
const LETTER_RUNS = {
  "marathon-pe":   { S: 0, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1, "4XL": 0 },
  trophy:          { S: 0, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1, "4XL": 0 },
  "marathon-pine": { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 2, "4XL": 0 },
  hub1:            { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 2, "4XL": 0 },
  hub2:            { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 2, "4XL": 0 },
};

// Shoes: flat units per size. Spec lists 2/size for hubs (3,4,5,5.5,…,11);
// the same flat run applies to whatever shoe sizes the product actually has
// (kids ranges included). Shops default to 0 — hubs feed the shops.
const SHOE_RUN = { "marathon-pe": 0, trophy: 0, "marathon-pine": 0, hub1: 2, hub2: 2 };

// Bottoms → letter-table positional mapping (7 waist sizes ↔ 7 letters).
const WAIST_TO_LETTER = { 28: "S", 30: "M", 32: "L", 34: "XL", 36: "XXL", 38: "XXXL", 40: "4XL" };

// Which family a product's sizes belong to. productType wins for numeric
// sizes: kids sneakers (26–35) would otherwise read as waists.
export function sizeFamily(product) {
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  if (!sizes.length) return "unknown";
  if (sizes.some((s) => LETTER_SIZES.has(String(s).toUpperCase()))) return "letters";
  const numeric = sizes.some((s) => Number.isFinite(parseFloat(s)));
  if (!numeric) return "unknown";
  return (product?.productType || "sneaker") === "clothing" ? "waist" : "shoe";
}

// `dest` here is the POLICY key: the destination itself when it has a run of
// its own, else the location it is declared to be like (Concrete follows
// Marathon PE; Hub 3 and the Concrete Stockroom follow Hub 2 — the registry's
// policyKeyFor). The five original destinations all have their own.
function defaultQty(family, dest, size) {
  if (family === "letters") return LETTER_RUNS[dest]?.[String(size).toUpperCase()] ?? 0;
  if (family === "waist") {
    const letter = WAIST_TO_LETTER[parseFloat(size)];
    return letter ? LETTER_RUNS[dest]?.[letter] ?? 0 : 0;
  }
  if (family === "shoe") return SHOE_RUN[dest] ?? 0;
  return 0;
}

// Hubs are OFFERED but never pre-selected (owner decision, 2026-07-16
// post-launch): a hub buffer send is a deliberate operator choice, so the
// wizard opens with only the shops that have a non-zero suggestion ticked.
const NEVER_DEFAULT_ON = new Set(["hub1", "hub2"]);

// The one entry point the wizard calls. Returns, for every destination and
// every size the product actually has:
//   { family, suggestions: { [dest]: { [size]: qty } }, defaultOn: { [dest]: bool } }
// Quantities are ALWAYS the raw table values — never reduced to fit Central
// (owner decision, 2026-07-16: the tables are the recommendation; a shortage
// is the operator's call, surfaced by the wizard's over-allocation block).
// Destination toggling and operator edits are the wizard's job.
// `dests` defaults to the original five, so a caller that passes nothing gets
// exactly what it always got. The wizard passes distributionDests(network).
// A destination OUTSIDE the original five is pre-ticked only when it is a
// LIVE store: a hub is never pre-ticked (as above), and a location that has
// not been counted in is offered but left for the operator to choose.
export function suggestInitialDistribution({ product, dests = DISTRIBUTION_DESTS, network }) {
  const N = net(network);
  const family = sizeFamily(product);
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  const suggestions = {};
  const defaultOn = {};
  for (const dest of dests) {
    const original = DISTRIBUTION_DESTS.includes(dest);
    const key = original ? dest : policyKeyFor(N, LETTER_RUNS, dest);
    const perSize = {};
    let any = false;
    for (const size of sizes) {
      const q = defaultQty(family, key, size);
      perSize[size] = q;
      if (q > 0) any = true;
    }
    suggestions[dest] = perSize;
    defaultOn[dest] = original
      ? any && !NEVER_DEFAULT_ON.has(dest)
      // Pre-ticked only at a FULLY live store: a wizard send is a hand transfer
      // (it lands untrusted), so Pine and Concrete are offered, never pre-ticked.
      : any && isStore(dest, N) && isLive(N, dest);
  }
  return { family, suggestions, defaultOn };
}
