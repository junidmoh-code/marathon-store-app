// ─── POLICY TEMPLATES — a location with no numbers of its own follows its like ─
//
// "The same size policy applies to all stores unless a store-specific policy
// already exists." The network registry says which location each one is LIKE
// (Marathon Pine and Concrete → Marathon PE; Hub 3 and the Concrete Stockroom
// → Hub 2). Every policy in /config/refillEngine is a map keyed by location id,
// and the resolvers (refill-engine.cjs resolveTarget, policy-resolve.cjs
// locationPolicyFor) read `map[location]` and nothing else.
//
// So the template is applied to the CONFIG, once, before anything resolves:
// withPolicyTemplates returns a config in which every per-location map also
// carries, for each location that has NO entry of its own, its template's
// entry under its own id. The resolvers are untouched — there is still exactly
// one implementation of "which numbers govern this cell", and the browser
// mirrors that are pinned to it byte for byte stay pinned.
//
// WHAT IT NEVER DOES
//   • It never overrides an entry. A location named in a map keeps its own
//     numbers, garbled ones included (a present-but-unusable entry arms
//     nothing — the engine's standing direction, and the way to say "not at
//     this location": give it an entry of its own).
//   • It never touches /stock_targets. An explicit row is still the first
//     priority and is read under the location's own id only.
//   • It never writes. The result is an in-memory view for ONE resolution
//     pass; nothing derived from it may be saved back to the config node, or
//     the copy would stop following its template.
//   • It never changes a location that has no `policyLike` — Marathon PE,
//     Trophy, Hub 1 and Hub 2 resolve from exactly the maps they always did.
"use strict";

const { policyKeyFor, SEED_REGISTRY } = require("./network-registry.cjs");

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// The per-location maps directly under /config/refillEngine.
//   size runs:  defaultRunByStore, footwearRunByLocation, subcategoryRunByLocation
//   ask-at:     footwearReorderPoint
//   switches:   ruleBasedTargets, footwearTargets — ONLY in their per-location
//               map form; `true` / `false` already speak for every location.
const LOCATION_MAP_KEYS = Object.freeze([
  "defaultRunByStore", "footwearRunByLocation", "subcategoryRunByLocation",
  "footwearReorderPoint", "ruleBasedTargets", "footwearTargets",
]);

// [location, template] for every location the registry gives a template.
function followers(network) {
  const reg = network && network.locations && network.aliasIndex ? network : SEED_REGISTRY;
  const out = [];
  for (const id of Object.keys(reg.locations).sort()) {
    const like = reg.locations[id].policyLike;
    if (like && like !== id) out.push([id, like]);
  }
  return { reg, list: out };
}

// One location-keyed map with the followers filled in — or the SAME object
// when no follower needed anything, so an untouched map stays identical.
function fillMap(reg, list, map) {
  if (!isPlainObject(map)) return map;
  let out = map;
  for (const [id] of list) {
    const key = policyKeyFor(reg, map, id);
    if (key === id) continue;                 // its own entry, or nothing to follow
    if (out === map) out = { ...map };
    out[id] = map[key];
  }
  return out;
}

function withPolicyTemplates(config, network) {
  if (!isPlainObject(config)) return config;
  const { reg, list } = followers(network);
  if (!list.length) return config;
  let out = config;
  const set = (k, v) => { if (out === config) out = { ...config }; out[k] = v; };

  for (const k of LOCATION_MAP_KEYS) {
    const filled = fillMap(reg, list, config[k]);
    if (filled !== config[k]) set(k, filled);
  }
  // categoryPolicy: { "<categoryKey>": { perSize?, "<location>": entry } }
  if (isPlainObject(config.categoryPolicy)) {
    let cp = config.categoryPolicy;
    for (const key of Object.keys(config.categoryPolicy)) {
      const filled = fillMap(reg, list, config.categoryPolicy[key]);
      if (filled === config.categoryPolicy[key]) continue;
      if (cp === config.categoryPolicy) cp = { ...config.categoryPolicy };
      cp[key] = filled;
    }
    if (cp !== config.categoryPolicy) set("categoryPolicy", cp);
  }
  // policyGroups: { "<groupKey>": { armed, memberCategoryKeys, policy: { perSize?, "<location>": entry } } }
  if (isPlainObject(config.policyGroups)) {
    let pg = config.policyGroups;
    for (const gk of Object.keys(config.policyGroups)) {
      const g = config.policyGroups[gk];
      if (!isPlainObject(g)) continue;
      const filled = fillMap(reg, list, g.policy);
      if (filled === g.policy) continue;
      if (pg === config.policyGroups) pg = { ...config.policyGroups };
      pg[gk] = { ...g, policy: filled };
    }
    if (pg !== config.policyGroups) set("policyGroups", pg);
  }
  return out;
}

// Which location's entry governs `loc` in ONE map — for a screen or report
// that wants to say "follows Hub 2". Same answer withPolicyTemplates applies.
function policyTemplateKey(network, map, loc) {
  const { reg } = followers(network);
  return policyKeyFor(reg, map, loc);
}

module.exports = { withPolicyTemplates, policyTemplateKey, LOCATION_MAP_KEYS };
