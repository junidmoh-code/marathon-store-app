// ─── THE HUBS A NOTIFICATION CAN BE ABOUT — READ FROM THE NETWORK REGISTRY ───
// One vocabulary for both ends of the order alert. This file and
// src/push/pushHubs.js answer the same four questions from the same registry,
// and src/push/pushHubs.test.js runs the two against each other:
//
//   pushHubsOf       the hubs Junid can assign a person to — every hub the
//                    registry holds, so Hub 3 is exactly like Hub 1 and Hub 2
//                    and the Concrete Stockroom is assignable the day it exists.
//   warehouseHubsOf  the hubs a deep link may open: the same list plus "hubC".
//   isCrHub          does this hub have a "CR Orders" (clothing) tab?
//   hubLabel         the words a person reads.
//
// "hubC" IS NOT IN THE REGISTRY AND STAYS WORKING. It is the clothing-customer
// trial queue in the warehouse selector — an order queue, not a stock location —
// so it can be linked to but never assigned, exactly as before.
"use strict";

const { hubsOf, SEED_REGISTRY } = require("./network-registry.cjs");

const LEGACY_WAREHOUSE_HUBS = Object.freeze(["hubC"]);
// The category whose back stock sits in a sneaker hub. A hub holding ONLY this
// category for the stores it serves (Hub 1) works customer orders and has no
// CR Orders tab; every other hub does.
const SNEAKER_CATEGORY = "sneakers";

function reg(registry) {
  return registry && registry.locations && registry.backStock ? registry : SEED_REGISTRY;
}

/** The hubs an assignment may name, in the registry's own order. */
function pushHubsOf(registry) {
  return hubsOf(reg(registry)).map((l) => l.id);
}

/** The hubs a deep link may carry: every registry hub, then the legacy queue. */
function warehouseHubsOf(registry) {
  return [...pushHubsOf(registry), ...LEGACY_WAREHOUSE_HUBS];
}

/** The section (1 | 2) a hub's alerts belong to; null for anything that is not
 *  a registry hub — "hubC" included, which no section owns. */
function hubSectionOf(registry, hub) {
  const l = reg(registry).locations[hub];
  return l && l.type === "hub" ? l.section : null;
}

/** Shop-refill lines at this hub are cards on its CR Orders tab. */
function isCrHub(registry, hub) {
  const R = reg(registry);
  const l = R.locations[hub];
  if (!l || l.type !== "hub" || l.retired === true) return false;
  const held = new Set();
  for (const store of Object.keys(R.backStock)) {
    for (const [cat, h] of Object.entries(R.backStock[store])) if (h === hub) held.add(cat);
  }
  return !(held.size > 0 && [...held].every((c) => c === SNEAKER_CATEGORY));
}

/** A location id → its registry name. Anything the registry does not hold by
 *  that exact id keeps its own text, so an unknown destination still produces a
 *  readable notification rather than an empty one. */
function hubLabel(registry, hub, fallback = "a store") {
  const l = typeof hub === "string" ? reg(registry).locations[hub] : null;
  return l ? l.name : String(hub || fallback);
}

module.exports = {
  LEGACY_WAREHOUSE_HUBS, SNEAKER_CATEGORY,
  pushHubsOf, warehouseHubsOf, hubSectionOf, isCrHub, hubLabel,
};
