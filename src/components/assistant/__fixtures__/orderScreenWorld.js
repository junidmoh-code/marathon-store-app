// ─── THE ORDER SCREEN'S AVAILABILITY, FOR ONE SHOP, AS App.jsx WIRES IT ──────
//
// AssistantView (App.jsx) answers "which hub, how many, is this size out, what
// else is there" with closures over hooks, so it cannot be called from a test.
// This is the same wiring over plain data: every decision is made by the REAL
// modules the screen imports (assistantCatalogue, sectionRouting,
// sectionSneakerHubs, availabilityCore, alternativesCore, divisionAvailability)
// and only the plumbing between them is restated here. The lines it restates
// are pinned against App.jsx in divisionAvailability.wiring.test.js, so the two
// cannot drift apart silently. Same idea as stock/__fixtures__/ducksHarness.js,
// for any shop in either division.
//
//   rawNetwork   what /network holds (null = the built-in seed)
//   shop         the signed-in user's store
//   products     the catalogue
//   stock        { hub1, hub2, hub3 } — DECODED cells, { pid: { size: { qty } } }
//   cart         the device's cart lines ({ product, size, productType? })
import { normalizeNetwork, backStockHubsOf } from "../../../utils/networkRegistry";
import { setCurrentNetworkFromRaw } from "../../../utils/networkStore";
import { shopUniverse } from "../../../utils/stores";
import { decodedCellKey } from "../../../utils/sizeKey";
import { usesSection2Hubs, servingHubFor, placementHub } from "../../../utils/sectionRouting";
import { sectionSneakerHubs, sneakerPlacementHub, clothingHubFor } from "../../../utils/sectionSneakerHubs";
import {
  gatedSneakerHub, resolveSneakerSourcing, allocateSneakerCart, availableUnits, GATED_SNEAKER_HUBS,
} from "../../stock/availabilityCore";
import { alternativesForSize, MAX_ALTERNATIVES_SHOWN } from "../../stock/alternativesCore";
import { assistantCatalogue, productHubsOf } from "../assistantCatalogue";
import * as division from "../divisionAvailability";

// App.jsx CR_HUB_BY_UNIVERSE.
const CR_HUB_BY_UNIVERSE = { central: "hub2", pine: "hub3" };
const NOT_READ = { cells: {}, promised: {}, ready: false };
const sizesOf = (p) => (Array.isArray(p.sizes) ? p.sizes : []).filter((x) => x && String(x).trim() && x !== "_");

export function orderScreenWorld({ rawNetwork = null, shop, products = [], stock = {}, cart = [], hubsRead = null }) {
  // The screen's registry (useNetwork) and the module-level copy the pure
  // helpers fall back to (networkStore) are the same node.
  setCurrentNetworkFromRaw(rawNetwork);
  const network = normalizeNetwork(rawNetwork);
  const universe = shopUniverse(shop, network);
  const onSection2Hubs = usesSection2Hubs(network, shop);
  const sectionHubIds = sectionSneakerHubs(network, shop);
  // The hub subtrees this device SUBSCRIBES to — the only stock it can see.
  const subscribed = onSection2Hubs ? ["hub1", "hub2"] : sectionHubIds;
  const read = (h) => (hubsRead ? hubsRead.includes(h) : true);
  const hubState = (h) => (subscribed.includes(h) && read(h) ? { cells: stock[h] || {}, promised: {}, ready: true } : NOT_READ);
  const hubData = {
    hub1: hubState("hub1"),
    hub2: hubState("hub2"),
    ...Object.fromEntries(sectionHubIds.map((h) => [h, hubState(h)])),
  };
  const sneakerHubsOfShop = onSection2Hubs ? GATED_SNEAKER_HUBS : sectionHubIds;
  const gateReady = (hub) => !!hub && hubData[hub]?.ready === true;

  // computeHubForItem.
  const computeHub = (p) => (!onSection2Hubs
    ? placementHub(network, shop, p, () => null)
    : (productHubsOf(p).find((h) => h === "hub1" || h === "hub2") || "hub1"));
  const taggedHubFor = (p) => gatedSneakerHub(p, computeHub(p));
  const allocation = allocateSneakerCart({ lines: cart, hubData, taggedHubFor });
  const sourcing = (p, s) => resolveSneakerSourcing({
    product: p, taggedHub: taggedHubFor(p), size: s, hubData,
    consumedByHub: allocation.consumed.get(`${p?.id}::${s}`) || null,
  });
  const sneakerHubOf = (p, s) => sourcing(p, s).hub;
  const sneakerOut = (p, s) => {
    if (!s) return false;
    const { hub, available } = sourcing(p, s);
    return gateReady(hub) && Number.isFinite(available) && available <= 0;
  };

  // Clothing: the serving hub's cell, per product.
  const servingHub = servingHubFor(network, shop, CR_HUB_BY_UNIVERSE[universe] || "hub2") || "__off__";
  const clothingHubOf = (p) => clothingHubFor(network, shop, p, servingHub);
  const hubQty = (p, size) => availableUnits(stock[clothingHubOf(p)]?.[p.id]?.[decodedCellKey(size)]?.qty);

  // The pool.
  const stockedHere = typeof division.stockedAtHubs === "function" && !onSection2Hubs
    ? division.stockedAtHubs(sectionHubIds.map((h) => hubData[h])) : undefined;
  const catalogue = (wantsClothing) => assistantCatalogue({
    products, wantsClothing, storeMode: universe, showDeactivated: false,
    isDeactivated: (p) => p.deactivated === true,
    servedHubs: onSection2Hubs ? null : backStockHubsOf(network, shop),
    stockedHere,
  });

  // The cards that read "Unavailable" (unavailableIds).
  const unavailable = (wantsClothing = false) => {
    if (onSection2Hubs || !sectionHubIds.length) return new Set();
    return division.unavailableProductIds(catalogue(wantsClothing), (p) => {
      if (p.deactivated === true) return null;
      const sizes = sizesOf(p);
      if ((p.productType || "sneaker") === "clothing") {
        const lane = sectionHubIds.includes(clothingHubOf(p)) ? hubData[clothingHubOf(p)] : null;
        return {
          sizes, known: !!lane && lane.ready === true,
          sizeOut: (sz) => availableUnits(lane.cells?.[p.id]?.[decodedCellKey(sz)]?.qty) <= 0,
        };
      }
      const hub = sneakerHubOf(p);
      return { sizes, known: !!hub && gateReady(hub), sizeOut: (sz) => sneakerOut(p, sz) };
    });
  };

  // The alternatives sheet (computeAlternatives).
  const alternatives = (product, size) => {
    if (!product || !size) return null;
    if ((product.productType || "sneaker") === "clothing") return null;
    const result = alternativesForSize({
      sourceProduct: product, neighbours: product.alternatives, requestedSize: size,
      candidates: products, limit: MAX_ALTERNATIVES_SHOWN,
      resolveProduct: (pid) => products.find((p) => p.id === pid) || null,
      sizesOf,
      availabilityKnown: (p) => !!sneakerHubOf(p),
      sizeAvailable: (p, sz) => gateReady(sneakerHubOf(p, sz)) && !sneakerOut(p, sz),
      isSellable: (p) => p.deactivated !== true && !p.mergedInto && Number(p.retailPrice) > 0 && !!String(p.photoUrl || "").trim(),
    });
    const hubLoading = sneakerHubsOfShop.some((h) => !gateReady(h));
    if (!result.rows.length && (hubLoading || !sneakerHubsOfShop.length)) return null;
    return { ...result, rows: result.rows.map((row) => ({ ...row, hub: sneakerHubOf(row.product, row.matchedSize) })) };
  };

  // Where a cart line is placed (placedHubFor, sneaker branch).
  const placedHub = (line) => sneakerPlacementHub(network, shop, line.product, allocation.hubOf.get(line),
    () => (allocation.hubOf.get(line) || computeHub(line.product)));

  return {
    network, universe, onSection2Hubs, sectionHubIds, subscribed, sneakerHubsOfShop, hubData, servingHub,
    computeHub, taggedHubFor, sourcing, sneakerHubOf, sneakerOut, gateReady, hubQty, clothingHubOf,
    catalogue, alternatives, allocation, placedHub, sizesOf, unavailable,
  };
}
