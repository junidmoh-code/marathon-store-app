// ─── /network, READ ONCE AND KEPT ────────────────────────────────────────────
// One small node, cached per function instance for a minute. Every function
// that needs to know a location's section, whether it is live, or where a
// store's back stock sits asks here — never /locations, never a literal list.
//
// A failed read is NOT cached and resolves to the seed: Section 2 routes as it
// always has, every Section 1 location is not live, and the wall still holds.
"use strict";

const { NETWORK_PATH, normalizeNetwork, SEED_REGISTRY } = require("./network-registry.cjs");

const TTL_MS = 60 * 1000;
let cache = null; // { atMs, registry }

async function loadNetwork(db, { nowMs = Date.now(), ttlMs = TTL_MS, fresh = false } = {}) {
  if (!fresh && cache && nowMs - cache.atMs < ttlMs && nowMs >= cache.atMs) return cache.registry;
  try {
    const snap = await db.ref(NETWORK_PATH).once("value");
    const registry = normalizeNetwork(snap.val());
    cache = { atMs: nowMs, registry };
    return registry;
  } catch (e) {
    console.error("network registry read failed; using the seed", e && e.message ? e.message : e);
    return SEED_REGISTRY;
  }
}

function __resetNetworkCacheForTests() {
  cache = null;
}

module.exports = { loadNetwork, TTL_MS, __resetNetworkCacheForTests };
