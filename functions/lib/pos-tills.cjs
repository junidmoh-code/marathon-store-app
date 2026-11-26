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
// /pos/config/{storeId}/tills (the POS's Add-till records) is merged over the
// registry's tills — see mergeTills below.
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

// ── /pos/config/{storeId}/tills — THE POS's "Add till" RECORDS (26 Nov 2026) ──
// The POS Settings → Tills screen writes one record per till here, keyed by
// the till id: { tillId, name, active }. They are MERGED over the registry's
// tills, never a replacement: a record for a seed till renames or deactivates
// it, a record for a new id adds a till, and a seed till with no record is
// untouched. A deactivated till (active === false) is not offered anywhere a
// till is chosen. Same rule as marathon-pos-app src/shared/tillConfig.js.
const TILL_ID_RE = /^till-[1-9][0-9]{0,2}$/;
const tillNo = (id) => Number(String(id).slice(5));

/** A raw /pos/config/{storeId}/tills value → [{tillId, name, active}] (valid records only). */
function readConfiguredTills(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw).map(([k, v]) => (v && typeof v === "object" && !v.tillId ? { ...v, tillId: k } : v)) : [];
  const out = [];
  for (const t of list) {
    if (!t || typeof t.tillId !== "string" || !TILL_ID_RE.test(t.tillId) || out.some((x) => x.tillId === t.tillId)) continue;
    out.push({ tillId: t.tillId, name: typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 24) : null, active: t.active !== false });
  }
  return out;
}

/** Seed tills + configured records → the merged list, deactivated tills included (active flag). */
function mergeTills(seedTills, raw) {
  const cfg = readConfiguredTills(raw);
  const out = (seedTills || []).map((t) => {
    const c = cfg.find((x) => x.tillId === t.tillId);
    return { tillId: t.tillId, name: (c && c.name) || t.name || t.tillId, active: c ? c.active : true };
  });
  const added = cfg.filter((c) => !out.some((t) => t.tillId === c.tillId)).sort((a, b) => tillNo(a.tillId) - tillNo(b.tillId));
  for (const c of added) out.push({ tillId: c.tillId, name: c.name || `Till ${tillNo(c.tillId)}`, active: c.active });
  return out;
}

/**
 * @param {Record<string, any>} configured  storeId → raw /pos/config/{storeId}/tills
 * @param {object} [registry]  the network registry (loadNetwork); built-in if absent
 * @returns {{storeId:string, label:string, section:number, location:string, tills:{tillId:string,name:string}[], source:string}[]}
 */
function posStores(configured = {}, registry = SEED_REGISTRY) {
  const tills = registryTillsOf(registry);
  return posStoresOf(registry).map((s) => {
    const hasConfig = readConfiguredTills(configured[s.storeId]).length > 0;
    return {
      ...s,
      tills: mergeTills(tills[s.storeId] || [], configured[s.storeId]).filter((t) => t.active).map((t) => ({ tillId: t.tillId, name: t.name })),
      // "pos-fallback" is the name this source has always had on the wire; it
      // means "the registry's tills" (no Add-till records for the store).
      source: hasConfig ? "pos-config" : "pos-fallback",
    };
  });
}

/** One store's offerable (active) tills: registry + its /pos/config records. */
function activeTillsOf(registry, storeId, rawConfig) {
  return mergeTills(registryTillsOf(registry || SEED_REGISTRY)[storeId] || [], rawConfig).filter((t) => t.active);
}

module.exports = { ORIGINAL_ORDER, POS_STORES, TILLS_FALLBACK, posStoresOf, registryTillsOf, readConfiguredTills, mergeTills, activeTillsOf, posStores };
