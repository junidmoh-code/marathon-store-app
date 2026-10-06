// ─── SECTION ROUTING — the stock screens' questions to the network registry ──
// Every list in this folder that used to be spelled out ("hub1", "hub2",
// "marathon-pe", "trophy") is a question about the network: which stores are
// in this section, which hub holds this store's back stock, which hubs may be
// routed to automatically. The registry (src/utils/networkRegistry.js) holds
// the answers; this file asks them in the shapes the stock screens need, so no
// screen keeps a list of its own.
//
// Pure: every function takes the registry. The default is the CURRENT one
// (networkStore), which is the seed until /network answers — and the seed
// routes Section 2 exactly as the literal lists did: Marathon PE and Trophy
// behind Hub 2 (sneakers Hub 1), Section 1 present but NOT live.
//
// LIVE vs VISIBLE. "liveOnly" lists are for anything automatic (a request the
// screen raises, a route it follows by itself). The plain lists are for
// anything a person does by hand: viewing, counting, a manual move inside the
// wall. A location that is not live appears in the second and never the first.

import { currentNetwork } from "../../utils/networkStore";
import {
  storesOf, hubsOf, listLocations, locationOf, locationName, sectionOf, isLive,
  backStockFor, backStockHubsOf, autoRouteAllowed, wallAllows, resolveLocationId,
} from "../../utils/networkRegistry";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";

// A caller may hand over a registry, nothing, or (through a careless
// `.map(fn)`) an index — only a real registry is used; anything else means
// "the current one".
export const net = (network) => (network && network.locations && network.aliasIndex ? network : currentNetwork());

// Central's id. One registry location of type "central" is not retired.
export function centralId(network) {
  const c = listLocations(net(network), { type: "central" })[0];
  return c ? c.id : "central";
}

export const isCentral = (loc, network) => locationOf(net(network), loc)?.type === "central";
export const isHub = (loc, network) => locationOf(net(network), loc)?.type === "hub";
export const isStore = (loc, network) => locationOf(net(network), loc)?.type === "store";
export const nameOf = (loc, network) => locationName(net(network), loc);
export const sectionOfLoc = (loc, network) => sectionOf(net(network), loc);

const ids = (list) => list.map((l) => l.id);

// Store / hub ids, registry sort order. `section` omitted = every section.
export function storeIds(network, { section, liveOnly } = {}) {
  return ids(storesOf(net(network), { ...(section ? { section } : {}), ...(liveOnly ? { liveOnly: true } : {}) }));
}
export function hubIds(network, { section, liveOnly } = {}) {
  return ids(hubsOf(net(network), { ...(section ? { section } : {}), ...(liveOnly ? { liveOnly: true } : {}) }));
}

// The section numbers that have at least one LIVE store — the sections whose
// work lists a screen builds by itself. On the seed: [2].
export function liveSections(network) {
  const N = net(network);
  return [...new Set(storesOf(N, { liveOnly: true }).map((l) => l.section))].sort((a, b) => a - b);
}

// ── THE HUB BEHIND A STORE, FOR THE "EVERYTHING EXCEPT SNEAKERS" FLOWS ───────
// Missing Products, Solve and the first batch own every product that is NOT a
// sneaker or a slide. Those two never take these flows, so their category's
// hub (Hub 1 for Marathon PE / Trophy) is never the answer here: a record that
// reaches these screens carrying one of those keys (a clothing-typed record
// with a footwear key) is routed like the rest of the tab, through the store's
// default hub. Every other category asks the mapping by its own key, so
// Concrete's per-category flip to the Concrete Stockroom is honoured, and a
// per-product override always wins.
// Server twin: functions/lib/first-batch.cjs hubForShop (pinned equal by test).
export const NON_HUB_FLOW_KEYS = Object.freeze(["sneakers", "slides"]);
export function solveHubFor(network, store, product, productId) {
  const key = product ? effectiveCategoryKey(product) : null;
  const pid = productId !== undefined && productId !== null ? productId : product?.id;
  return backStockFor(net(network), store, key && !NON_HUB_FLOW_KEYS.includes(key) ? key : null, pid);
}

// The hubs a section's stores keep this product's back stock at (registry
// store order, no repeats). Section 2 on the seed: ["hub2"].
export function solveHubsOfSection(network, section, product, productId, { liveOnly } = {}) {
  const N = net(network);
  const out = [];
  for (const s of storeIds(N, { section, liveOnly })) {
    const h = solveHubFor(N, s, product, productId);
    if (h && !out.includes(h) && (!liveOnly || isLive(N, h))) out.push(h);
  }
  return out;
}

// ── WHERE THE ENGINE REFILLS THIS STORE FROM, FOR THIS PRODUCT ───────────────
// The engine's own answer (functions/lib/refill-engine.cjs networkRouting
// sourceFor), for a screen that must only start what the engine will carry on:
//   • a store config.routes NAMES is routed by that entry and nothing else —
//     when the leg is open (both ends live, one side of the wall);
//   • a LIVE store it does not name (Pine, Concrete) is routed by the registry,
//     per product: the hub holding its back stock for that product, when that
//     hub is live. The category asked is the product's real one — a sneaker
//     asks the sneakers mapping, as the engine does.
// undefined = the engine has no leg into this store for this product.
// Pinned equal to the engine by sectionRouting.engineRoute.test.js.
export function engineSourceFor(network, routes, store, product, productId) {
  const N = net(network);
  const cfg = routes && typeof routes === "object" ? routes : {};
  if (Object.prototype.hasOwnProperty.call(cfg, store)) {
    return autoRouteAllowed(N, cfg[store], store) ? cfg[store] : undefined;
  }
  const loc = N.locations[store];
  if (!loc || loc.live !== true || loc.retired === true) return undefined;
  // (asked of a hub: a live hub config.routes does not name is fed from Central)
  if (loc.type === "hub") {
    const central = listLocations(N, { type: "central", liveOnly: true })[0]?.id;
    return central && autoRouteAllowed(N, central, store) ? central : undefined;
  }
  if (loc.type !== "store") return undefined;
  const hubs = backStockHubsOf(N, store).filter((h) => autoRouteAllowed(N, h, store));
  if (!hubs.length) return undefined;
  const pid = productId !== undefined && productId !== null ? productId : product?.id;
  const hub = backStockFor(N, store, effectiveCategoryKey(product), pid);
  return hub && hubs.includes(hub) ? hub : undefined;
}

// ── MAY SOLVE ROUTE THIS STORE BY ITSELF? ────────────────────────────────────
// null = yes. Otherwise the one plain sentence the screen shows beside the
// disabled tick. `source` is where the product is stranded (Central, or a hub).
//   • the store, and the hub behind it, must be live — a location that has
//     not been counted in gets nothing automatic;
//   • a product stranded at a hub can only be solved into the stores that hub
//     is the back stock for: across the wall it must go back to Central first.
export function solveStoreBlock(network, { source, store, hub }) {
  const N = net(network);
  if (!isLive(N, store)) return "not live yet — counted stock first";
  if (!hub) return "no back-stock hub is set for this store";
  if (!isLive(N, hub)) return `its hub (${locationName(N, hub)}) is not live yet — counted stock first`;
  if (!isCentral(source, N)) {
    if (!wallAllows(N, source, store)) return `the stock is at ${locationName(N, source)}, in the other section — send it back to Central first`;
    if (resolveLocationId(N, source) !== hub) return `the stock is at ${locationName(N, source)}; ${locationName(N, store)} is fed from ${locationName(N, hub)}`;
  }
  if (!autoRouteAllowed(N, centralId(N), hub) || !autoRouteAllowed(N, hub, store)) return "this route is not open";
  return null;
}

// "The same policy for every store unless it has its own" — the policy
// template — lives in ONE place in the browser: policyTemplate.js, pinned to
// the engine's functions/lib/policy-template.cjs.
