// ─── THE POS'S STORES AND TILLS, AS THE SERVER SEES THEM ─────────────────────
// A card terminal is mapped to a (storeId, tillId) that must be a REAL POS
// till: the expected-card figure joins those two keys to /pos/paymentEvents,
// and a key the POS never writes makes every variance for that machine 100%
// short. So the terminal settings sheet offers only what this returns, and the
// callable checks every write against it again.
//
// WHERE THE LIST COMES FROM (sections build). The stores and their tills are
// the NETWORK REGISTRY's — every location of type "store" that carries a POS
// id, with the tills on its record (lib/network-registry.cjs; the live copy is
// /network, edited on the owner's Network card). It used to be typed here as
// pe / pine / trophy, which is why Concrete could not be given a terminal. The
// POS reads the same registry for the same list (marathon-pos-app
// src/shared/stores.js), so the two cannot drift apart the way two typed lists
// could — and a store or a till the owner adds is offered here with no deploy.
//
// The storeId is still the POS's own short id ("pe", "pine", "trophy",
// "concrete"), never the registry's location id: it is the JOIN KEY.
//
// /pos/config/{storeId}/tills still wins over the registry's tills where it is
// seeded, exactly as before (it is unseeded for every store as of 21 Sept 2026).
//
// PURE: the callable does the reads and hands them in.
"use strict";

const { storesOf, SEED_REGISTRY } = require("./network-registry.cjs");

// The three original outlets keep the positions they have always had in the
// store picker (PE, Pine, Trophy) — the same order the POS keeps them in. Any
// store not named here follows, in the registry's own order.
const ORIGINAL_ORDER = Object.freeze(["pe", "pine", "trophy"]);

/**
 * The POS stores in a registry: [{ storeId, label, section, location }].
 * `storeId` is the POS id; `location` the registry's own id for the same shop.
 */
function posStoresOf(registry) {
  const all = storesOf(registry || SEED_REGISTRY).filter((l) => typeof l.posId === "string" && l.posId);
  const rank = (l) => {
    const i = ORIGINAL_ORDER.indexOf(l.posId);
    return i === -1 ? ORIGINAL_ORDER.length : i;
  };
  // Array.prototype.sort is stable: equal ranks keep the registry's order.
  return [...all].sort((a, b) => rank(a) - rank(b))
    .map((l) => ({ storeId: l.posId, label: l.name, section: l.section, location: l.id }));
}

/** storeId → [{ tillId, name }], the tills on each store's registry record. */
function registryTillsOf(registry) {
  const out = {};
  for (const l of storesOf(registry || SEED_REGISTRY)) {
    if (typeof l.posId === "string" && l.posId) out[l.posId] = (l.tills || []).map((t) => ({ tillId: t.tillId, name: t.name }));
  }
  return out;
}

// The same two answers on the built-in registry: what applies while /network
// is unseeded, and what functions/test/card-terminal-admin.test.cjs pins.
const POS_STORES = Object.freeze(posStoresOf(SEED_REGISTRY).map((s) => Object.freeze({ storeId: s.storeId, label: s.label })));
const TILLS_FALLBACK = Object.freeze(registryTillsOf(SEED_REGISTRY));

/** A /pos/config/{storeId}/tills value → [{tillId, name}], or null if unusable. */
function readConfiguredTills(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : null;
  if (!list) return null;
  const out = list
    .filter((t) => t && typeof t.tillId === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(t.tillId))
    .map((t) => ({ tillId: t.tillId, name: typeof t.name === "string" && t.name.trim() ? t.name.trim() : t.tillId }));
  return out.length ? out : null;
}

/**
 * @param {Record<string, any>} configured  storeId → raw /pos/config/{storeId}/tills
 * @param {object} [registry]  the network registry (loadNetwork); built-in if absent
 * @returns {{storeId:string, label:string, section:number, location:string, tills:{tillId:string,name:string}[], source:string}[]}
 */
function posStores(configured = {}, registry = SEED_REGISTRY) {
  const tills = registryTillsOf(registry);
  return posStoresOf(registry).map((s) => {
    const fromConfig = readConfiguredTills(configured[s.storeId]);
    return {
      ...s,
      tills: fromConfig || (tills[s.storeId] || []).map((t) => ({ ...t })),
      // "pos-fallback" is the name this source has always had on the wire; it
      // now means "the registry's tills", which is what the POS falls back to.
      source: fromConfig ? "pos-config" : "pos-fallback",
    };
  });
}

module.exports = { ORIGINAL_ORDER, POS_STORES, TILLS_FALLBACK, posStoresOf, registryTillsOf, readConfiguredTills, posStores };
