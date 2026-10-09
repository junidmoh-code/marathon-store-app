// ─── THE DUCKS OF A FEATHER CASE, AS THE SCREEN SEES IT ──────────────────────
//
// Junid's report, 2026-10-08 14:36: "Nike Air Force 1 Low Ducks of a Feather
// University of Oregon Duck or Egg", size 8 → "Size 8 isn't at Hub 1 or Hub 2
// right now" and then "No similar styles in size 8", while dozens of Air
// Force 1s sat on the Hub 1 shelf in an 8.
//
// ducksOfAFeather.json is a read-only slice of the live catalogue, attributes
// and Hub 1 / Hub 2 cells taken the next morning. This harness feeds it to the
// alternatives join through the SAME availability resolver the order screen
// uses for its size chips (resolveSneakerSourcing → sneakerOut), so a test
// that passes here is a statement about what the shop floor would see.
import fixture from "./ducksOfAFeather.json";
import { resolveSneakerSourcing, gatedSneakerHub } from "../availabilityCore";
import { decodeSizeKey } from "../../../utils/sizeKey";

export const DUCKS_PID = "p1790157727504";
export const DUCKS_SIBLING_PID = "p1781530128019";

const decode = (byPid) => {
  const out = {};
  for (const [pid, bySize] of Object.entries(byPid || {})) {
    const d = {};
    for (const [k, cell] of Object.entries(bySize || {})) if (cell) d[decodeSizeKey(k)] = cell;
    out[pid] = d;
  }
  return out;
};

/**
 * Everything alternativesForSize needs, wired the way App.jsx wires it.
 * `products` may be overridden (e.g. to strip attributes or a profile) and
 * `cells` to move stock.
 */
export function ducksWorld({ products = fixture.products, cells = fixture.cells, attributes = fixture.attributes } = {}) {
  const hubData = {
    hub1: { cells: decode(cells.hub1), promised: {}, ready: true },
    hub2: { cells: decode(cells.hub2), promised: {}, ready: true },
  };
  // computeHubForItem: the first of hub1/hub2 on the record's tag, else hub1.
  const tagOf = (p) => gatedSneakerHub(p, (Array.isArray(p.hubs) ? p.hubs : []).find((h) => h === "hub1" || h === "hub2") || "hub1");
  const sourcing = (p, s) => resolveSneakerSourcing({ product: p, taggedHub: tagOf(p), size: s, hubData });
  const sneakerOut = (p, s) => {
    const { hub, available } = sourcing(p, s);
    return !!hub && Number.isFinite(available) && available <= 0;
  };
  const list = Object.values(products);
  return {
    products,
    attributes,
    list,
    sneakerOut,
    args: (product, size) => ({
      sourceProduct: product,
      neighbours: product.alternatives,
      requestedSize: size,
      candidates: list,
      resolveProduct: (pid) => products[pid] || null,
      sizesOf: (p) => (Array.isArray(p.sizes) ? p.sizes : []).filter((x) => x && String(x).trim() && x !== "_"),
      availabilityKnown: (p) => !!tagOf(p),
      sizeAvailable: (p, sz) => !!sourcing(p, sz).hub && !sneakerOut(p, sz),
      isSellable: (p) => !p.deactivated && !p.mergedInto && Number(p.retailPrice) > 0 && !!String(p.photoUrl || "").trim(),
    }),
  };
}

export const isAirForce1 = (p) => /air\s*-?force|\baf-?1\b/i.test(String(p?.name || ""));
