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
// SWITCHES vs VISIBLE. Each location carries two switches (networkRegistry.js):
// Solve (on/off) and Auto-refill (off / solved / all). "solveOnly" lists are
// for Solve and the first batch it raises; "autoRefillOnly" lists for anything
// the ENGINE does or a screen does on its behalf; "liveOnly" (both on, "all")
// for the readers that predate the split. The plain lists are for anything a
// person does by hand: viewing, counting, a manual move inside the wall.

import { currentNetwork } from "../../utils/networkStore";
import {
  storesOf, hubsOf, listLocations, locationOf, locationName, sectionOf, isLive,
  solveOn, autoRefillOn, solveRouteAllowed, sectionsInOrder,
  backStockFor, backStockHubsOf, autoRouteAllowed, wallAllows, resolveLocationId,
} from "../../utils/networkRegistry";
import { effectiveCategoryKey } from "../../utils/productTaxonomy.js";
import { isCentralFedProduct } from "./centralFed";

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
const filters = ({ section, liveOnly, solveOnly, autoRefillOnly } = {}) => ({
  ...(section ? { section } : {}), ...(liveOnly ? { liveOnly: true } : {}),
  ...(solveOnly ? { solveOnly: true } : {}), ...(autoRefillOnly ? { autoRefillOnly: true } : {}),
});
export function storeIds(network, opts = {}) {
  return ids(storesOf(net(network), filters(opts)));
}
export function hubIds(network, opts = {}) {
  return ids(hubsOf(net(network), filters(opts)));
}

// The section numbers that have at least one ROUTED store — Solve on or
// Auto-refill on — the sections whose work lists a screen builds by itself,
// in the registry's division order (Marathon first, so a screen that opens on
// the first of these still opens on Marathon). On the seed (7 Oct 2026): [2, 1].
export function liveSections(network) {
  const N = net(network);
  return sectionsInOrder(N, [...new Set(storesOf(N).filter((l) => l.solve === true || l.autoRefill !== "off").map((l) => l.section))]);
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
// store order, no repeats). Section 2 on the seed: ["hub2"]. `solveOnly`
// keeps to stores and hubs with Solve on.
export function solveHubsOfSection(network, section, product, productId, { solveOnly } = {}) {
  const N = net(network);
  const out = [];
  for (const s of storeIds(N, { section, solveOnly })) {
    const h = solveHubFor(N, s, product, productId);
    if (h && !out.includes(h) && (!solveOnly || solveOn(N, h))) out.push(h);
  }
  return out;
}

// ── WHERE THE ENGINE REFILLS THIS STORE FROM, FOR THIS PRODUCT ───────────────
// The engine's own answer (functions/lib/refill-engine.cjs networkRouting
// sourceFor), for a screen that must only start what the engine will carry on:
//   • a store config.routes NAMES is routed by that entry and nothing else —
//     when the leg is open (Auto-refill on at both ends, one side of the wall);
//   • a store it does not name with Auto-refill on (Pine, Concrete) is routed
//     by the registry, per product: the hub holding its back stock for that
//     product, when that hub's Auto-refill is on. The category asked is the
//     product's real one — a sneaker asks the sneakers mapping, as the engine does.
// undefined = the engine has no leg into this store for this product.
// Pinned equal to the engine by sectionRouting.engineRoute.test.js.
// `engineConfig` (optional): the engine config, for CENTRAL-FED CLOTHING
// (centralFed.js) — a store keeping its clothing in the shop is fed that
// clothing straight from Central. Absent ⇒ exactly the answer it always gave.
export function engineSourceFor(network, routes, store, product, productId, engineConfig) {
  const N = net(network);
  const cfg = routes && typeof routes === "object" ? routes : {};
  if (Object.prototype.hasOwnProperty.call(cfg, store)) {
    return autoRouteAllowed(N, cfg[store], store) ? cfg[store] : undefined;
  }
  const loc = N.locations[store];
  if (!loc || !autoRefillOn(N, store) || loc.retired === true) return undefined;
  if (loc.type === "store" && engineConfig && isCentralFedProduct(engineConfig, N, store, product)) {
    const central = listLocations(N, { type: "central", autoRefillOnly: true })[0]?.id;
    return central && autoRouteAllowed(N, central, store) ? central : undefined;
  }
  // (asked of a hub: a routed hub config.routes does not name is fed from Central)
  if (loc.type === "hub") {
    const central = listLocations(N, { type: "central", autoRefillOnly: true })[0]?.id;
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
//   • the store, and the hub behind it, must have SOLVE on (the Network card);
//   • a product stranded at a hub can only be solved into the stores that hub
//     is the back stock for: across the wall it must go back to Central first.
//   • CENTRAL-FED (centralFed.js — Concrete's clothing): no hub at all; the
//     product must be at Central, and Central → store must be open.
export function solveStoreBlock(network, { source, store, hub, centralFed = false }) {
  const N = net(network);
  if (!solveOn(N, store)) return "Solve is off for this store (Network card)";
  if (centralFed) {
    if (!isCentral(source, N)) return `${locationName(N, store)} clothing comes from Central — send it back to Central first`;
    if (!solveRouteAllowed(N, centralId(N), store)) return "this route is not open";
    return null;
  }
  if (!hub) return "no back-stock hub is set for this store";
  if (!solveOn(N, hub)) return `Solve is off for its hub (${locationName(N, hub)}) (Network card)`;
  if (!isCentral(source, N)) {
    if (!wallAllows(N, source, store)) return `the stock is at ${locationName(N, source)}, in the other section — send it back to Central first`;
    if (resolveLocationId(N, source) !== hub) return `the stock is at ${locationName(N, source)}; ${locationName(N, store)} is fed from ${locationName(N, hub)}`;
  }
  if (!solveRouteAllowed(N, centralId(N), hub) || !solveRouteAllowed(N, hub, store)) return "this route is not open";
  return null;
}

// "The same policy for every store unless it has its own" — the policy
// template — lives in ONE place in the browser: policyTemplate.js, pinned to
// the engine's functions/lib/policy-template.cjs.
