// ─── THE NETWORK REGISTRY (functions copy) ───────────────────────────────────
// Same body as the store app's src/utils/networkRegistry.js and the POS app's
// src/shared/networkRegistry.js — see the header there. The text between the
// BEGIN/END markers is pinned identical by src/utils/networkRegistry.parity.test.js.
"use strict";

// ── BEGIN SHARED BODY ────────────────────────────────────────────────────────
const NETWORK_PATH = "network";
const DEFAULT_CATEGORY = "_default";
const CREDIT_SCOPES = Object.freeze(["shared", "section"]);

const DEFAULT_NETWORK = Object.freeze({
  creditScope: "shared",
  // The two divisions. The NAME is the owner's (Network card, stored at
  // /network/sections/{n}/name); these are the seed. Sort puts Marathon, the
  // division that has always traded, first in every list of divisions.
  sections: Object.freeze({
    1: Object.freeze({ id: 1, name: "Concrete", sort: 2 }),
    2: Object.freeze({ id: 2, name: "Marathon", sort: 1 }),
  }),
  locations: Object.freeze({
    central: Object.freeze({
      id: "central", name: "Central", type: "central", section: null, live: true, sort: 0,
      aliases: Object.freeze(["Central"]),
    }),
    // Merged into Central on 2026-07-26 and deactivated. Still registered
    // because historic movements name them; both were Central's own building.
    studio: Object.freeze({
      id: "studio", name: "Studio", type: "central", section: null, live: false, retired: true, sort: 1,
      aliases: Object.freeze(["Studio"]),
    }),
    base: Object.freeze({
      id: "base", name: "Base", type: "central", section: null, live: false, retired: true, sort: 2,
      aliases: Object.freeze(["Base"]),
    }),
    "marathon-pine": Object.freeze({
      id: "marathon-pine", name: "Marathon Pine", type: "store", section: 1, live: false, sort: 10,
      posId: "pine", universe: "pine", policyLike: "marathon-pe", numberPrefix: "P",
      aliases: Object.freeze(["pine", "Pine", "Marathon Pine", "marathon pine", "Pinetown"]),
      tills: Object.freeze([Object.freeze({ tillId: "till-1", name: "Till 1" })]),
    }),
    concrete: Object.freeze({
      id: "concrete", name: "Concrete", type: "store", section: 1, live: false, sort: 11,
      posId: "concrete", universe: "concrete", policyLike: "marathon-pe", numberPrefix: "C",
      aliases: Object.freeze(["Concrete", "marathon-concrete", "Marathon Concrete"]),
      tills: Object.freeze([
        Object.freeze({ tillId: "till-1", name: "Till 1" }),
        Object.freeze({ tillId: "till-2", name: "Till 2" }),
      ]),
    }),
    hub3: Object.freeze({
      id: "hub3", name: "Hub 3", type: "hub", section: 1, live: false, sort: 12, policyLike: "hub2",
      aliases: Object.freeze(["Hub 3", "hub 3", "Hub3"]),
    }),
    "concrete-stockroom": Object.freeze({
      id: "concrete-stockroom", name: "Concrete Stockroom", type: "hub", section: 1, live: false, sort: 13, policyLike: "hub2",
      serves: Object.freeze(["concrete"]),
      aliases: Object.freeze(["Concrete Stockroom", "concrete stockroom", "concreteStockroom"]),
    }),
    "marathon-pe": Object.freeze({
      id: "marathon-pe", name: "Marathon PE", type: "store", section: 2, live: true, sort: 20,
      posId: "pe", universe: "central",
      aliases: Object.freeze(["pe", "PE", "Marathon PE", "marathon pe", "Marathon", "marathon"]),
      tills: Object.freeze([
        Object.freeze({ tillId: "till-1", name: "Till 1" }),
        Object.freeze({ tillId: "till-2", name: "Till 2" }),
        Object.freeze({ tillId: "till-3", name: "Till 3" }),
      ]),
    }),
    trophy: Object.freeze({
      id: "trophy", name: "Trophy", type: "store", section: 2, live: true, sort: 21,
      posId: "trophy", universe: "central",
      aliases: Object.freeze(["Trophy"]),
      tills: Object.freeze([
        Object.freeze({ tillId: "till-1", name: "Till 1" }),
        Object.freeze({ tillId: "till-2", name: "Till 2" }),
      ]),
    }),
    hub1: Object.freeze({
      id: "hub1", name: "Hub 1", type: "hub", section: 2, live: true, sort: 22,
      aliases: Object.freeze(["Hub 1", "hub 1", "Hub1"]),
    }),
    hub2: Object.freeze({
      id: "hub2", name: "Hub 2", type: "hub", section: 2, live: true, sort: 23,
      aliases: Object.freeze(["Hub 2", "hub 2", "Hub2"]),
    }),
  }),
  // store → category key → the hub holding that store's back stock.
  // DEFAULT_CATEGORY covers every category not named.
  backStock: Object.freeze({
    "marathon-pe": Object.freeze({ _default: "hub2", sneakers: "hub1" }),
    trophy: Object.freeze({ _default: "hub2", sneakers: "hub1" }),
    "marathon-pine": Object.freeze({ _default: "hub3" }),
    concrete: Object.freeze({ _default: "hub3" }),
  }),
  // store → product id → hub. Empty at seed.
  productOverrides: Object.freeze({}),
});

const TRANSIT_ID = "in_transit";

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// RTDB hands an array back as an array, as an object with integer keys, or —
// if it was ever empty — as nothing at all. All three become a clean array.
function asList(v) {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined);
  if (isObj(v)) return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]).filter((x) => x !== null && x !== undefined);
  return [];
}

function aliasKey(s) {
  return typeof s === "string" ? s.trim().toLowerCase().replace(/[\s_]+/g, " ") : "";
}

function normSection(v) {
  const n = Number(v);
  return n === 1 || n === 2 ? n : null;
}

function normTills(v) {
  const out = [];
  for (const t of asList(v)) {
    if (!isObj(t) || typeof t.tillId !== "string" || !t.tillId) continue;
    out.push({ tillId: t.tillId, name: typeof t.name === "string" && t.name ? t.name : t.tillId });
  }
  return out;
}

const LOCATION_TYPES = Object.freeze(["store", "hub", "central"]);

// One location, raw overlaid on its seed. `live` is true ONLY when something
// says true: an unknown location, or a raw record with no live field and no
// seed, is not live.
function normLocation(id, raw, seed) {
  const r = isObj(raw) ? raw : {};
  const s = isObj(seed) ? seed : {};
  const type = LOCATION_TYPES.includes(r.type) ? r.type : (LOCATION_TYPES.includes(s.type) ? s.type : null);
  if (!type) return null;
  // A junk section in the node is not a section: fall back to the seed's
  // rather than drop a known location or leave it unwalled.
  const section = type === "central" ? null : (normSection(r.section) !== null ? normSection(r.section) : normSection(s.section));
  if (type !== "central" && section === null) return null;
  const live = typeof r.live === "boolean" ? r.live : s.live === true;
  const aliases = [...new Set([...asList(s.aliases), ...asList(r.aliases)].filter((a) => typeof a === "string" && a.trim()))];
  const tills = r.tills !== undefined && normTills(r.tills).length ? normTills(r.tills) : normTills(s.tills);
  const serves = asList(r.serves !== undefined ? r.serves : s.serves).filter((x) => typeof x === "string");
  const out = {
    id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : (s.name || id),
    type, section, live,
    sort: Number.isFinite(Number(r.sort)) && r.sort !== null && r.sort !== undefined ? Number(r.sort) : (Number.isFinite(s.sort) ? s.sort : 999),
    aliases,
  };
  const posId = typeof r.posId === "string" && r.posId ? r.posId : s.posId;
  if (posId) out.posId = posId;
  const universe = typeof r.universe === "string" && r.universe ? r.universe : s.universe;
  if (universe) out.universe = universe;
  if (type === "store") out.tills = tills;
  if (serves.length) out.serves = serves;
  if (typeof r.retired === "boolean" ? r.retired : s.retired === true) out.retired = true;
  const policyLike = typeof r.policyLike === "string" && r.policyLike ? r.policyLike : s.policyLike;
  if (policyLike && policyLike !== id) out.policyLike = policyLike;
  const numberPrefix = typeof r.numberPrefix === "string" && /^[A-Z]{1,3}$/.test(r.numberPrefix) ? r.numberPrefix : s.numberPrefix;
  if (numberPrefix) out.numberPrefix = numberPrefix;
  return out;
}

// The two sections: their ids are fixed (1, 2 — the wall and every stamp key on
// them); only the name and the sort are the owner's. A blank or junk name falls
// back to the seed's, so a section is never nameless.
function normSections(raw) {
  const r = isObj(raw) ? raw : (Array.isArray(raw) ? Object.fromEntries(raw.map((v, i) => [i, v])) : {});
  const out = {};
  for (const n of [1, 2]) {
    const s = DEFAULT_NETWORK.sections[n];
    const x = isObj(r[n]) ? r[n] : (isObj(r[String(n)]) ? r[String(n)] : {});
    const name = typeof x.name === "string" && x.name.trim() ? x.name.trim().slice(0, 40) : s.name;
    const sort = typeof x.sort === "number" && Number.isFinite(x.sort) ? x.sort : s.sort;
    out[n] = { id: n, name, sort };
  }
  return out;
}

// Raw /network value (or null) → a complete, validated registry. Never throws.
function normalizeNetwork(raw) {
  const r = isObj(raw) ? raw : {};
  const rawLocs = isObj(r.locations) ? r.locations : {};
  const locations = {};
  const ids = [...new Set([...Object.keys(DEFAULT_NETWORK.locations), ...Object.keys(rawLocs)])];
  for (const id of ids) {
    if (id === TRANSIT_ID) continue;
    const loc = normLocation(id, rawLocs[id], DEFAULT_NETWORK.locations[id]);
    if (loc) locations[id] = loc;
  }

  const aliasIndex = {};
  const claim = (alias, id) => {
    const k = aliasKey(alias);
    if (k && !(k in aliasIndex)) aliasIndex[k] = id;
  };
  // Canonical ids first, so an alias can never shadow another location's id.
  for (const id of Object.keys(locations)) claim(id, id);
  for (const id of Object.keys(locations)) {
    const l = locations[id];
    claim(l.name, id);
    if (l.posId) claim(l.posId, id);
    for (const a of l.aliases) claim(a, id);
  }

  const backStock = {};
  const productOverrides = {};
  const hubOk = (store, hub) => {
    const s = locations[store];
    const h = locations[hub];
    if (!s || s.type !== "store" || !h || h.type !== "hub") return false;
    if (h.section !== s.section) return false;            // the wall, at the mapping
    if (h.serves && !h.serves.includes(store)) return false;
    return true;
  };
  const rawBack = isObj(r.backStock) ? r.backStock : {};
  for (const store of Object.keys(locations)) {
    if (locations[store].type !== "store") continue;
    const merged = { ...(DEFAULT_NETWORK.backStock[store] || {}), ...(isObj(rawBack[store]) ? rawBack[store] : {}) };
    const clean = {};
    for (const cat of Object.keys(merged)) {
      if (typeof merged[cat] === "string" && hubOk(store, merged[cat])) clean[cat] = merged[cat];
      else if (DEFAULT_NETWORK.backStock[store] && hubOk(store, DEFAULT_NETWORK.backStock[store][cat])) clean[cat] = DEFAULT_NETWORK.backStock[store][cat];
    }
    backStock[store] = clean;
    const rawOv = isObj(r.productOverrides) && isObj(r.productOverrides[store]) ? r.productOverrides[store] : {};
    const ov = {};
    for (const pid of Object.keys(rawOv)) if (typeof rawOv[pid] === "string" && hubOk(store, rawOv[pid])) ov[pid] = rawOv[pid];
    productOverrides[store] = ov;
  }

  return {
    creditScope: CREDIT_SCOPES.includes(r.creditScope) ? r.creditScope : DEFAULT_NETWORK.creditScope,
    sections: normSections(r.sections),
    locations, aliasIndex, backStock, productOverrides,
  };
}

const SEED_REGISTRY = normalizeNetwork(null);
function reg(registry) {
  return registry && registry.locations && registry.aliasIndex ? registry : SEED_REGISTRY;
}

// Any spelling → canonical id, or null. STRICT: never guesses, never returns
// the raw input for something it does not know.
function resolveLocationId(registry, anyName) {
  if (anyName === TRANSIT_ID) return TRANSIT_ID;
  const k = aliasKey(anyName);
  if (!k) return null;
  const id = reg(registry).aliasIndex[k];
  return id || null;
}

function locationOf(registry, anyName) {
  const id = resolveLocationId(registry, anyName);
  return id && id !== TRANSIT_ID ? reg(registry).locations[id] : null;
}

function locationName(registry, anyName) {
  const l = locationOf(registry, anyName);
  if (l) return l.name;
  return anyName === TRANSIT_ID ? "In Transit" : (anyName || "—");
}

function sectionOf(registry, anyName) {
  const l = locationOf(registry, anyName);
  return l ? l.section : null;
}

function isLive(registry, anyName) {
  const l = locationOf(registry, anyName);
  return !!l && l.live === true;
}

function listLocations(registry, filter) {
  const f = filter || {};
  return Object.values(reg(registry).locations)
    .filter((l) => (f.includeRetired ? true : l.retired !== true))
    .filter((l) => (f.type ? l.type === f.type : true))
    .filter((l) => (f.section ? l.section === f.section : true))
    .filter((l) => (f.liveOnly ? l.live === true : true))
    .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}

function storesOf(registry, filter) {
  return listLocations(registry, { ...(filter || {}), type: "store" });
}

function hubsOf(registry, filter) {
  return listLocations(registry, { ...(filter || {}), type: "hub" });
}

function tillsFor(registry, anyStore) {
  const l = locationOf(registry, anyStore);
  return l && l.type === "store" ? l.tills || [] : [];
}

// THE WALL. { ok, reason }.
//   • a null/absent side is a single-location write — nothing to cross.
//   • in_transit is a holding state, not a place: the caller passes the REAL
//     origin and destination of the transfer, and this refuses to judge a pair
//     where one side is still in_transit rather than wave it through.
//   • an id the registry does not know is refused: a guess is how stock ends
//     up somewhere no screen will ever look.
//   • Central pairs with anything. Two sectioned locations must match.
function wallCheck(registry, from, to) {
  if (from === null || from === undefined || from === "" || to === null || to === undefined || to === "") {
    return { ok: true, reason: "single_location" };
  }
  if (from === TRANSIT_ID || to === TRANSIT_ID) return { ok: false, reason: "transit_needs_real_endpoints" };
  const a = locationOf(registry, from);
  const b = locationOf(registry, to);
  if (!a || !b) return { ok: false, reason: "unknown_location" };
  if (a.type === "central" || b.type === "central") return { ok: true, reason: "central" };
  if (a.section === b.section) return { ok: true, reason: "same_section" };
  return { ok: false, reason: "cross_section" };
}

function wallAllows(registry, from, to) {
  return wallCheck(registry, from, to).ok;
}

function wallMessage(registry, from, to) {
  const c = wallCheck(registry, from, to);
  if (c.ok) return null;
  if (c.reason === "cross_section") {
    return `${locationName(registry, from)} and ${locationName(registry, to)} are in different sections. Send the stock back to Central first.`;
  }
  if (c.reason === "unknown_location") return "That location is not in the network registry.";
  return "A transfer in transit must name where it came from and where it is going.";
}

// The hub holding THIS store's back stock for THIS product.
//   product override → the category's hub → the store's default hub → null.
// Every candidate was validated against the wall and `serves` at normalise
// time, so whatever this returns is in the store's own section.
function backStockFor(registry, anyStore, categoryKey, productId) {
  const R = reg(registry);
  const store = resolveLocationId(R, anyStore);
  if (!store || !R.backStock[store]) return null;
  const ov = productId !== undefined && productId !== null ? R.productOverrides[store]?.[productId] : null;
  if (ov) return ov;
  const map = R.backStock[store];
  const key = typeof categoryKey === "string" && categoryKey ? categoryKey : null;
  if (key && map[key]) return map[key];
  return map[DEFAULT_CATEGORY] || null;
}

// Every hub that holds ANY of this store's back stock (default, per category,
// per product) — the read set for a screen about that store.
function backStockHubsOf(registry, anyStore) {
  const R = reg(registry);
  const store = resolveLocationId(R, anyStore);
  if (!store || !R.backStock[store]) return [];
  return [...new Set([...Object.values(R.backStock[store]), ...Object.values(R.productOverrides[store] || {})])].sort();
}

// The stores a hub holds back stock for.
function storesServedBy(registry, anyHub) {
  const R = reg(registry);
  const hub = resolveLocationId(R, anyHub);
  if (!hub) return [];
  return Object.keys(R.backStock).filter((s) => backStockHubsOf(R, s).includes(hub)).sort();
}

// Routing gate for anything AUTOMATIC: both ends live, and the wall holds.
function autoRouteAllowed(registry, from, to) {
  if (!isLive(registry, from) || !isLive(registry, to)) return false;
  return wallAllows(registry, from, to);
}

function creditScopeOf(registry) {
  return reg(registry).creditScope;
}

// May a credit/layby/owed record issued at `issuingStore` (with an optional
// stamped section) be used at `spendingStore`?
//   shared            → always.
//   section           → only inside the issuing section.
//   no stamp at all   → always, under BOTH scopes. Historic records carry no
//                       section and are never rewritten, so they stay spendable
//                       everywhere exactly as they were.
function creditSpendableAt(registry, record, spendingStore) {
  if (creditScopeOf(registry) !== "section") return true;
  const stamped = normSection(record && record.section);
  const issued = stamped !== null ? stamped : sectionOf(registry, record && (record.issuingStore || record.storeId));
  if (issued === null) return true;
  const here = sectionOf(registry, spendingStore);
  if (here === null) return false;
  return here === issued;
}

// The stamp every NEW credit / layby / owed record carries.
function issuingStamp(registry, anyStore) {
  const l = locationOf(registry, anyStore);
  if (!l || l.type !== "store") return null;
  return { issuingStore: l.id, section: l.section };
}

// ── POLICY TEMPLATE ──────────────────────────────────────────────────────────
// "The same size policy applies to all stores unless a store-specific policy
// already exists." A location with NO numbers of its own in a policy map
// follows the location it is declared to be like: Pine and Concrete follow
// Marathon PE; Hub 3 and the Concrete Stockroom follow Hub 2. A location WITH
// its own entry always uses its own — so Marathon PE, Trophy, Hub 1 and Hub 2,
// which all have entries today, resolve exactly as they always have.
//
// `byLocation` is any policy map keyed by location id ({ loc: numbers }).
// Returns the key to read: the location itself when it has an entry (or has
// no template), else its template when THAT has one, else the location.
function policyKeyFor(registry, byLocation, anyLoc) {
  const id = resolveLocationId(registry, anyLoc) || anyLoc;
  const map = isObj(byLocation) ? byLocation : {};
  if (map[id] !== undefined && map[id] !== null) return id;
  const like = locationOf(registry, id)?.policyLike;
  if (like && map[like] !== undefined && map[like] !== null) return like;
  return id;
}

// ── NUMBERING ────────────────────────────────────────────────────────────────
// A store with a numberPrefix has its OWN sale/order sequences, starting at 1
// (Pine "P", Concrete "C"). A store without one shares the original global
// sequence, unchanged (Marathon PE, Trophy). Returns the prefix or null.
function numberPrefixFor(registry, anyStore) {
  const l = locationOf(registry, anyStore);
  return l && l.type === "store" && l.numberPrefix ? l.numberPrefix : null;
}

// ── SECTION ACCESS ───────────────────────────────────────────────────────────
// Which sections a staff account (or enrolled device) may see and act in.
//   • the owner, and anyone he marks allSections            → both
//   • an explicit sections map on the record { 1: true }     → those
//   • a device claim / record field `section` (1 or 2)       → that one
//   • a destShop (the existing single-shop lock)             → that shop's
//   • nothing at all (every account that predates sections)  → both, so no
//     one is locked out by the deploy; Junid narrows them from User Management.
// WRITTEN as a map, never an array: RTDB deletes an empty array, and "no
// sections" must not read back as "all sections". READ as either — see below.
function sectionsFor(registry, record, opts) {
  const o = opts || {};
  if (o.isOwner === true) return [1, 2];
  const r = isObj(record) ? record : {};
  if (r.allSections === true) return [1, 2];
  // RTDB hands a map with small integer keys back as an ARRAY: { "1": true }
  // reads as [null, true], { "2": true } as [null, null, true] (or stays a map,
  // depending on density). Both shapes are the same answer here.
  const sec = Array.isArray(r.sections) ? Object.fromEntries(r.sections.map((v, i) => [i, v])) : r.sections;
  if (isObj(sec)) return [1, 2].filter((n) => sec[n] === true || sec[String(n)] === true);
  const one = normSection(r.section !== undefined ? r.section : o.deviceSection);
  if (one !== null) return [one];
  const shop = r.destShop ? sectionOf(registry, r.destShop) : null;
  if (shop !== null) return [shop];
  return [1, 2];
}

// ── DIVISION NAMES ───────────────────────────────────────────────────────────
// sectionName: the owner's name for a section ("Marathon", "Concrete"), exactly
// as stored — nothing is added to it in code, in any picker.
// sectionsInOrder: [n, …] by the section's sort, then its number.
function sectionName(registry, n) {
  const s = reg(registry).sections && reg(registry).sections[n];
  return (s && s.name) || (DEFAULT_NETWORK.sections[n] && DEFAULT_NETWORK.sections[n].name) || `Section ${n}`;
}

function sectionsInOrder(registry, list) {
  const R = reg(registry);
  const sortOf = (n) => (R.sections && R.sections[n] && Number.isFinite(R.sections[n].sort) ? R.sections[n].sort : n);
  const ns = (list === undefined ? [1, 2] : asList(list)).map(normSection).filter((n) => n !== null);
  return [...new Set(ns)].sort((a, b) => sortOf(a) - sortOf(b) || a - b);
}

function canSeeLocation(registry, sections, anyLoc) {
  const l = locationOf(registry, anyLoc);
  if (!l) return false;
  if (l.type === "central") return true;
  return asList(sections).includes(l.section);
}

// What the seed writes to /network. Arrays that would be empty are left out:
// RTDB deletes an empty array on write, so the stored shape never has one.
function seedPayload() {
  const locations = {};
  for (const id of Object.keys(DEFAULT_NETWORK.locations)) {
    const l = DEFAULT_NETWORK.locations[id];
    const o = { id: l.id, name: l.name, type: l.type, live: l.live, sort: l.sort };
    if (l.section !== null) o.section = l.section;
    if (l.posId) o.posId = l.posId;
    if (l.universe) o.universe = l.universe;
    if (l.aliases && l.aliases.length) o.aliases = [...l.aliases];
    if (l.tills && l.tills.length) o.tills = l.tills.map((t) => ({ tillId: t.tillId, name: t.name }));
    if (l.serves && l.serves.length) o.serves = [...l.serves];
    if (l.retired) o.retired = true;
    if (l.policyLike) o.policyLike = l.policyLike;
    if (l.numberPrefix) o.numberPrefix = l.numberPrefix;
    locations[id] = o;
  }
  const backStock = {};
  for (const s of Object.keys(DEFAULT_NETWORK.backStock)) backStock[s] = { ...DEFAULT_NETWORK.backStock[s] };
  const sections = {};
  for (const n of Object.keys(DEFAULT_NETWORK.sections)) {
    const s = DEFAULT_NETWORK.sections[n];
    sections[n] = { id: s.id, name: s.name, sort: s.sort };
  }
  return { creditScope: DEFAULT_NETWORK.creditScope, sections, locations, backStock, posStores: posStoreIndex(DEFAULT_NETWORK.locations) };
}

// POS store id → { location, section }. A DERIVED index, stored under
// /network/posStores for one reader only: the database rules, which see a POS
// record's short store id ("pe") and must know its section without a lookup
// table of their own. Code never reads it — code resolves through aliases.
function posStoreIndex(locations) {
  const out = {};
  for (const id of Object.keys(locations || {})) {
    const l = locations[id];
    if (l && l.type === "store" && l.posId && (l.section === 1 || l.section === 2)) out[l.posId] = { location: l.id, section: l.section };
  }
  return out;
}
// ── END SHARED BODY ──────────────────────────────────────────────────────────

module.exports = {
  NETWORK_PATH, DEFAULT_CATEGORY, CREDIT_SCOPES, DEFAULT_NETWORK, TRANSIT_ID, SEED_REGISTRY,
  normalizeNetwork, resolveLocationId, locationOf, locationName, sectionOf, isLive,
  listLocations, storesOf, hubsOf, tillsFor,
  wallCheck, wallAllows, wallMessage,
  backStockFor, backStockHubsOf, storesServedBy, autoRouteAllowed,
  creditScopeOf, creditSpendableAt, issuingStamp, seedPayload, posStoreIndex,
  policyKeyFor, numberPrefixFor, sectionsFor, canSeeLocation,
  sectionName, sectionsInOrder,
};
