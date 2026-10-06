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
  backStockFor, autoRouteAllowed, wallAllows, policyKeyFor, resolveLocationId,
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

// ── "THE SAME POLICY FOR EVERY STORE UNLESS IT HAS ITS OWN" ──────────────────
// A policy map keyed by location, with every location in `locs` that has no
// entry of its own answered by its template (Pine and Concrete follow Marathon
// PE; Hub 3 and the Concrete Stockroom follow Hub 2 — registry policyKeyFor).
// A location WITH an entry keeps it, so Marathon PE, Trophy, Hub 1 and Hub 2
// read exactly what they always read. Returns the SAME object when nothing
// needed filling, so a Section 2-only caller is untouched.
export function withPolicyTemplates(network, byLocation, locs) {
  if (!byLocation || typeof byLocation !== "object" || Array.isArray(byLocation)) return byLocation;
  const N = net(network);
  let out = byLocation;
  for (const loc of locs || []) {
    const key = policyKeyFor(N, byLocation, loc);
    if (key === loc || byLocation[key] === undefined || byLocation[key] === null) continue;
    if (out === byLocation) out = { ...byLocation };
    out[loc] = byLocation[key];
  }
  return out;
}

// The engine config as the Solve reads it, with the templates applied for
// `locs`. Three number maps follow the template: the size run, the subcategory
// run, and each category's policy entry.
//
// THE KILL SWITCH FOLLOWS IT TOO. ruleBasedTargets in its per-destination form
// is a map by location like the others; a location with no entry of its own
// asks its template, and an explicit `false` IS an entry of its own, so a
// location can still be switched off alone. Without this a store on the
// template run could never qualify for a Solve by rule while the switch is in
// its per-destination form. (The engine must resolve the switch the same way:
// Solve only ever seeds what the engine will then refill.)
export function templatedPolicyConfig(network, cfg, locs) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const N = net(network);
  const list = (locs || []).filter(Boolean);
  if (!list.length) return cfg;
  const defaultRunByStore = withPolicyTemplates(N, cfg.defaultRunByStore, list);
  const subcategoryRunByLocation = withPolicyTemplates(N, cfg.subcategoryRunByLocation, list);
  const ruleBasedTargets = withPolicyTemplates(N, cfg.ruleBasedTargets, list);
  let categoryPolicy = cfg.categoryPolicy;
  if (categoryPolicy && typeof categoryPolicy === "object" && !Array.isArray(categoryPolicy)) {
    let changed = false;
    const next = {};
    for (const [cat, entry] of Object.entries(categoryPolicy)) {
      const t = withPolicyTemplates(N, entry, list);
      next[cat] = t;
      if (t !== entry) changed = true;
    }
    if (changed) categoryPolicy = next;
  }
  if (defaultRunByStore === cfg.defaultRunByStore && subcategoryRunByLocation === cfg.subcategoryRunByLocation
    && ruleBasedTargets === cfg.ruleBasedTargets && categoryPolicy === cfg.categoryPolicy) return cfg;
  return { ...cfg, defaultRunByStore, subcategoryRunByLocation, ruleBasedTargets, categoryPolicy };
}
