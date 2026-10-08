// ─── DISPLAY CHECKS — PER-STORE SETTINGS, READ ONCE AND KEPT ─────────────────
// /displayChecks_settings/{store}/enabled and /scope (lib.cjs normStoreSettings).
// Two small keyed reads per store (never the roster or the whole node),
// cached per function instance for a minute like lib/network-load.cjs. A
// failed read is not cached and answers "nothing stored" — the store then
// follows the registry's live rule, exactly today's behaviour.
"use strict";

const TTL_MS = 60 * 1000;
const cache = new Map();   // store → { atMs, value }

async function loadStoreSettings(db, store, { nowMs = Date.now(), ttlMs = TTL_MS } = {}) {
  const hit = cache.get(store);
  if (hit && nowMs - hit.atMs < ttlMs && nowMs >= hit.atMs) return hit.value;
  try {
    const [enabled, scope] = await Promise.all([
      db.ref(`displayChecks_settings/${store}/enabled`).once("value").then((s) => s.val()),
      db.ref(`displayChecks_settings/${store}/scope`).once("value").then((s) => s.val()),
    ]);
    const value = { enabled, scope };
    cache.set(store, { atMs: nowMs, value });
    return value;
  } catch (e) {
    console.error("display check settings read failed; using the live rule", store, e && e.message ? e.message : e);
    return null;
  }
}

async function loadSettingsFor(db, stores, opts) {
  const out = {};
  await Promise.all((stores || []).map(async (s) => { out[s] = await loadStoreSettings(db, s, opts); }));
  return out;
}

function __resetDisplaySettingsCacheForTests() { cache.clear(); }

module.exports = { loadStoreSettings, loadSettingsFor, __resetDisplaySettingsCacheForTests, TTL_MS };
