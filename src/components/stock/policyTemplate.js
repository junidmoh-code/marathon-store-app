// ─── POLICY TEMPLATES, IN THE BROWSER — the one copy ─────────────────────────
// "The same size policy applies to all stores unless a store-specific policy
// already exists." The engine applies that to /config/refillEngine once, before
// it resolves anything (functions/lib/policy-template.cjs withPolicyTemplates):
// every per-location policy map also carries, for each location with NO entry
// of its own, its template's entry under its own id — Marathon Pine and
// Concrete follow Marathon PE; Hub 3 and the Concrete Stockroom follow Hub 2.
//
// Every stock screen that resolves a target mirrors an engine resolver that
// reads `map[location]` and nothing else. So the screens do what the engine
// does: template the config at the ONE point it is loaded (useStock
// useEngineConfig / useEngineConfigState, and NetworkTransfer's own
// subscription), and every mirror below resolves from that, untouched.
//
// withPolicyTemplates / policyTemplateKey / LOCATION_MAP_KEYS are a twin of
// the server module, pinned deep-equal by policyTemplate.parity.test.js over
// the routing fixture and generated configs and registries. There is no other
// browser copy (sectionRouting's older templatedPolicyConfig is gone).
//
// ── NEVER SAVE WHAT THIS RETURNS ─────────────────────────────────────────────
// The result is a VIEW for reading. Written back to /config/refillEngine it
// would give every follower an entry of its own — a frozen copy of its
// template's numbers — and it would never follow a later edit. Nothing in the
// browser writes that node: Engine Policy saves go through the setCategoryPolicy
// callable, which works from its own read of the RAW node and hands the card
// the RAW entry to edit. A caller that needs the stored node asks for it by
// name (the `raw` field of useStock.useEngineConfigState).

import { policyKeyFor, SEED_REGISTRY, autoRouteAllowed, backStockHubsOf, listLocations } from "../../utils/networkRegistry.js";

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// The per-location maps directly under /config/refillEngine (server twin).
export const LOCATION_MAP_KEYS = Object.freeze([
  "defaultRunByStore", "footwearRunByLocation", "subcategoryRunByLocation",
  "footwearReorderPoint", "ruleBasedTargets", "footwearTargets",
]);

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

export function withPolicyTemplates(config, network) {
  if (!isPlainObject(config)) return config;
  const { reg, list } = followers(network);
  if (!list.length) return config;
  let out = config;
  const set = (k, v) => { if (out === config) out = { ...config }; out[k] = v; };

  for (const k of LOCATION_MAP_KEYS) {
    const filled = fillMap(reg, list, config[k]);
    if (filled !== config[k]) set(k, filled);
  }
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

// Which location's entry governs `loc` in ONE map — "follows Hub 2".
export function policyTemplateKey(network, map, loc) {
  const { reg } = followers(network);
  return policyKeyFor(reg, map, loc);
}

// ── WHICH LOCATIONS THE ENGINE PLANS ─────────────────────────────────────────
// The engine templates the whole config, but it only ever RESOLVES a target
// for a destination it plans (refill-engine.cjs networkRouting `dests`): a
// location config.routes names whose leg is open (Auto-refill on at both ends,
// one side of the wall), a hub with Auto-refill on the registry feeds from
// Central, a store with Auto-refill on and at least one such back-stock hub. A
// location whose Auto-refill is off is planned for nothing — so on a screen it
// must read exactly what it read before templates existed, never "armed" off
// numbers the engine will not act on.
// Pinned to networkRouting(...).dests by policyTemplate.parity.test.js.
export function enginePlannedLocations(config, network) {
  const byRegistry = !!(network && network.locations && network.aliasIndex);
  const routes = isPlainObject(config?.routes) ? config.routes : {};
  const out = new Set();
  for (const dest of Object.keys(routes)) if (autoRouteAllowed(network, routes[dest], dest)) out.add(dest);
  if (!byRegistry) return out;
  const named = (id) => Object.prototype.hasOwnProperty.call(routes, id);
  const central = listLocations(network, { type: "central", autoRefillOnly: true })[0]?.id || null;
  for (const l of listLocations(network, { autoRefillOnly: true })) {
    if (named(l.id)) continue;
    if (l.type === "hub" && central && autoRouteAllowed(network, central, l.id)) out.add(l.id);
    if (l.type === "store" && backStockHubsOf(network, l.id).some((h) => autoRouteAllowed(network, h, l.id))) out.add(l.id);
  }
  return out;
}

// ── THE CONFIG AS THE STOCK SCREENS READ IT ──────────────────────────────────
// The engine config with the template applied for the locations the engine
// plans, and for no other: the registry handed to the template step is the
// real one with `policyLike` left off every location that is not planned.
// For a planned location every map reads exactly what the engine's templated
// config reads; for any other, exactly the stored config. Returns the SAME
// object when nothing follows anything (Section 2 only, the seed registry) —
// so a screen that never sees a live Section 1 location is handed the very
// node it always was.
const viewMemo = new WeakMap();   // config → { network, view }
export function engineConfigView(config, network) {
  if (!isPlainObject(config)) return config;
  if (!(network && network.locations && network.aliasIndex)) return config;
  const hit = viewMemo.get(config);
  if (hit && hit.network === network) return hit.view;
  const planned = enginePlannedLocations(config, network);
  const locations = {};
  let any = false;
  for (const id of Object.keys(network.locations)) {
    const l = network.locations[id];
    if (l.policyLike && !planned.has(id)) { const rest = { ...l }; delete rest.policyLike; locations[id] = rest; }
    else { locations[id] = l; if (l.policyLike) any = true; }
  }
  const view = any ? withPolicyTemplates(config, { ...network, locations }) : config;
  viewMemo.set(config, { network, view });
  return view;
}

// { location: the location it follows } for ONE policy map, planned followers
// only — what a screen shows as "follows Marathon PE". Empty on the seed.
export function followersIn(config, network, map) {
  const out = {};
  if (!isPlainObject(map) || !(network && network.locations && network.aliasIndex)) return out;
  for (const loc of enginePlannedLocations(config, network)) {
    const key = policyTemplateKey(network, map, loc);
    if (key && key !== loc && map[key] !== undefined && map[key] !== null) out[loc] = key;
  }
  return out;
}
