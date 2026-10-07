// ─── NETWORK SETTINGS — WHAT EACH CONTROL WRITES ─────────────────────────────
// Pure builders for the multi-path updates the owner card sends. Every one
// returns { ok, updates } or { ok:false, error } and writes the SMALLEST path
// that expresses the change, so two controls never overwrite each other and
// /network is never replaced whole.
//
// `nowMs` is serverNowMs() at the call site — never Date.now(): updatedAt is a
// rules-validated field.
import {
  NETWORK_PATH, DEFAULT_CATEGORY, CREDIT_SCOPES, AUTO_REFILL_MODES, locationOf, seedPayload, normalizeNetwork,
} from "../../utils/networkRegistry";

const stamp = (nowMs, uid) => ({ [`${NETWORK_PATH}/updatedAt`]: nowMs, [`${NETWORK_PATH}/updatedBy`]: uid || null });
const fail = (error) => ({ ok: false, error });

// The store whose category mapping is switchable, and its two choices.
export const SWITCHABLE_STORE = "concrete";
export const SWITCHABLE_HUBS = Object.freeze(["hub3", "concrete-stockroom"]);

// ── THE TWO SWITCHES ─────────────────────────────────────────────────────────
// Solve (on/off) and Auto-refill (off / solved / all), one location at a time.
// EVERY switch write carries BOTH fields — the one changed and the other as the
// registry currently resolves it — so the stored record never holds half a
// pair, and a legacy `live` left on the record can never be read again
// (normLocation reads `live` only when neither new field is present).
export const AUTO_REFILL_LABELS = Object.freeze({ off: "Off", solved: "Solved products only", all: "All products" });

function switchUpdate(registry, id, { solve, autoRefill }, nowMs, uid) {
  const loc = locationOf(registry, id);
  if (!loc) return fail("That location is not in the registry.");
  if (loc.type === "central" || loc.retired) return fail("Central is always on.");
  const s = solve === undefined ? loc.solve === true : solve;
  const a = autoRefill === undefined ? loc.autoRefill : autoRefill;
  if (typeof s !== "boolean") return fail("Solve is on or off.");
  if (!AUTO_REFILL_MODES.includes(a)) return fail("Auto-refill is off, solved products only, or all products.");
  return { ok: true, updates: {
    [`${NETWORK_PATH}/locations/${loc.id}/solve`]: s,
    [`${NETWORK_PATH}/locations/${loc.id}/autoRefill`]: a,
    // The pre-split flag goes in the same write: no reader of an older build
    // can act on a stale `live` once the owner has set the switches.
    [`${NETWORK_PATH}/locations/${loc.id}/live`]: null,
    ...stamp(nowMs, uid),
  } };
}

export function solveUpdate(registry, id, solve, nowMs, uid) {
  if (typeof solve !== "boolean") return fail("Solve is on or off.");
  return switchUpdate(registry, id, { solve }, nowMs, uid);
}

export function autoRefillUpdate(registry, id, mode, nowMs, uid) {
  if (!AUTO_REFILL_MODES.includes(mode)) return fail("Auto-refill is off, solved products only, or all products.");
  return switchUpdate(registry, id, { autoRefill: mode }, nowMs, uid);
}

export function categoryHubUpdate(registry, categoryKey, hub, nowMs, uid) {
  if (typeof categoryKey !== "string" || !categoryKey || /[.#$/[\]]/.test(categoryKey)) return fail("That is not a category.");
  if (!SWITCHABLE_HUBS.includes(hub)) return fail("Concrete's back stock is Hub 3 or the Concrete Stockroom.");
  // Prove the registry would accept it — same section, and the hub serves Concrete.
  const probe = normalizeNetwork({ backStock: { [SWITCHABLE_STORE]: { [categoryKey]: hub } } });
  if (probe.backStock[SWITCHABLE_STORE][categoryKey] !== hub) return fail("That hub cannot hold Concrete's back stock.");
  return { ok: true, updates: { [`${NETWORK_PATH}/backStock/${SWITCHABLE_STORE}/${categoryKey}`]: hub, ...stamp(nowMs, uid) } };
}

// hub === null clears the override; the category mapping then decides again.
export function productOverrideUpdate(registry, productId, hub, nowMs, uid) {
  if (typeof productId !== "string" || !productId || /[.#$/[\]]/.test(productId)) return fail("Pick a product.");
  if (hub !== null && !SWITCHABLE_HUBS.includes(hub)) return fail("Concrete's back stock is Hub 3 or the Concrete Stockroom.");
  return { ok: true, updates: { [`${NETWORK_PATH}/productOverrides/${SWITCHABLE_STORE}/${productId}`]: hub, ...stamp(nowMs, uid) } };
}

// A division's name (/network/sections/{n}/name). The number is the section —
// fixed, it is what the wall and every stamp key on; only the name is the
// owner's. Trimmed; 1–40 characters.
export const SECTION_NAME_MAX = 40;
export function sectionNameUpdate(section, name, nowMs, uid) {
  const n = Number(section);
  if (n !== 1 && n !== 2) return fail("There are two divisions.");
  const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!clean) return fail("A division needs a name.");
  if (clean.length > SECTION_NAME_MAX) return fail(`Keep the name to ${SECTION_NAME_MAX} characters.`);
  return { ok: true, updates: { [`${NETWORK_PATH}/sections/${n}/name`]: clean, ...stamp(nowMs, uid) } };
}

// `creditScopeSince` is the moment section scope began. Owed money recorded
// BEFORE it stays shared after the switch: a debt charged at Pine and paid at
// Marathon PE while everything was shared must not come back as "owing in
// Section 1, in credit in Section 2". The POS and its functions read it; with
// scope "section" and no such time they treat every owed record as shared.
// Switching to the scope already in force leaves the time alone.
export function creditScopeUpdate(scope, nowMs, uid, currentScope = null) {
  if (!CREDIT_SCOPES.includes(scope)) return fail("Credit scope is shared or section.");
  const since = scope === "shared" ? { [`${NETWORK_PATH}/creditScopeSince`]: null }
    : currentScope === "section" ? {}
    : { [`${NETWORK_PATH}/creditScopeSince`]: nowMs };
  return { ok: true, updates: { [`${NETWORK_PATH}/creditScope`]: scope, ...since, ...stamp(nowMs, uid) } };
}

// First-time seed. Writes /network ONLY when it is absent, and registers the
// two new locations in /locations ONLY when they are absent — the movement
// rule validates from/to against /locations, so stock cannot be received at
// Concrete until they exist. Existing /locations records are never touched.
const NEW_STOCK_LOCATIONS = Object.freeze({
  concrete: { id: "concrete", label: "Concrete", kind: "store", sellable: true, active: true },
  "concrete-stockroom": { id: "concrete-stockroom", label: "Concrete Stockroom", kind: "warehouse", sellable: false, active: true },
});

export function seedUpdate(rawNetwork, stockLocations, nowMs, uid) {
  // FILL WHAT IS MISSING, FIELD BY FIELD — never "write only when the node is
  // absent". The other controls on this card each write one small path, so the
  // owner can flip a live switch or the credit scope BEFORE pressing Set up;
  // /network then exists but holds no sections, and the wall clauses in the
  // database rules (which read each location's section from here) would pass
  // everything, for good. Whatever is already stored — a live flip above all —
  // is never touched.
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const raw = isObj(rawNetwork) ? rawNetwork : {};
  const seed = seedPayload();
  const updates = {};
  if (raw.creditScope === undefined || raw.creditScope === null) updates[`${NETWORK_PATH}/creditScope`] = seed.creditScope;
  const fill = (root, have, want) => {
    for (const id of Object.keys(want)) {
      if (!isObj(have?.[id])) { updates[`${NETWORK_PATH}/${root}/${id}`] = want[id]; continue; }
      // A record written before the switch split carries a boolean `live` and
      // neither switch: fill the switches with ITS migrated meaning (true → on
      // + all, false → off + off), never the seed's — the seed must not undo it.
      const legacy = root === "locations" && typeof have[id].live === "boolean"
        && typeof have[id].solve !== "boolean" && !AUTO_REFILL_MODES.includes(have[id].autoRefill)
        ? { solve: have[id].live, autoRefill: have[id].live ? "all" : "off" } : null;
      for (const field of Object.keys(want[id])) {
        const cur = have[id][field];
        if (cur === undefined || cur === null) updates[`${NETWORK_PATH}/${root}/${id}/${field}`] = legacy && field in legacy ? legacy[field] : want[id][field];
      }
    }
  };
  fill("sections", raw.sections, seed.sections);
  fill("locations", raw.locations, seed.locations);
  fill("backStock", raw.backStock, seed.backStock);
  fill("posStores", raw.posStores, seed.posStores);
  for (const id of Object.keys(NEW_STOCK_LOCATIONS)) {
    if (!stockLocations || !stockLocations[id]) updates[`locations/${id}`] = NEW_STOCK_LOCATIONS[id];
  }
  if (!Object.keys(updates).length) return { ok: true, updates: {}, nothingToDo: true };
  return { ok: true, updates: { ...updates, ...stamp(nowMs, uid) } };
}

// Rows for the category control: the default first, then every category.
export function categoryRows(registry, categories) {
  const map = registry.backStock[SWITCHABLE_STORE] || {};
  const dflt = map[DEFAULT_CATEGORY] || SWITCHABLE_HUBS[0];
  const rows = [{ key: DEFAULT_CATEGORY, label: "Every other category", hub: dflt, isDefault: true }];
  for (const c of categories || []) {
    if (!c || !c.key) continue;
    rows.push({ key: c.key, label: c.label || c.key, hub: map[c.key] || dflt, inherits: !map[c.key] });
  }
  return rows;
}

// ── CONCRETE AT THE TILL — THE POS SWITCHES ──────────────────────────────────
// Facts the POS reads from /network/locations/{id}/pos (its
// src/shared/storeTraits.js): whether the store reconciles cash, whether a
// cashier may edit a line price, and which till is the cash recycler. (The
// POS's fourth switch, no-slip returns, is NOT offered here: No Receipt Return
// is held as its own change and its switch ships with it, not before.) Marathon PE, Trophy and Pine have their
// answers built in; Concrete starts with every switch OFF and is set here.
// One small path per switch, so no control overwrites another — and the
// location's own record (live, section, tills) is never rewritten.
export const POS_FLAGS = Object.freeze([
  Object.freeze({ key: "cashRecon", label: "Takes cash (cash-up, payouts and collections at this store)" }),
  Object.freeze({ key: "cashierPriceEdit", label: "Cashiers may edit a line price (not only a manager)" }),
]);

export function posSwitchState(registry, rawNetwork, store = SWITCHABLE_STORE) {
  const loc = locationOf(registry, store);
  const pos = rawNetwork?.locations?.[loc?.id]?.pos;
  const cur = pos && typeof pos === "object" && !Array.isArray(pos) ? pos : {};
  const tills = loc && loc.type === "store" ? loc.tills || [] : [];
  const flags = Object.fromEntries(POS_FLAGS.map((f) => [f.key, cur[f.key] === true]));
  const recyclerTill = typeof cur.recyclerTill === "string" && tills.some((t) => t.tillId === cur.recyclerTill) ? cur.recyclerTill : null;
  return { flags, recyclerTill, tills };
}

export function posFlagUpdate(registry, key, value, nowMs, uid, store = SWITCHABLE_STORE) {
  const loc = locationOf(registry, store);
  if (!loc || loc.type !== "store") return fail("That store is not in the registry.");
  if (!POS_FLAGS.some((f) => f.key === key)) return fail("That is not a till switch.");
  if (typeof value !== "boolean") return fail("A switch is on or off.");
  return { ok: true, updates: { [`${NETWORK_PATH}/locations/${loc.id}/pos/${key}`]: value, ...stamp(nowMs, uid) } };
}

// tillId === null → no recycler at this store (stored as false: a null would
// delete the key and fall back to a built-in answer, which is "none" for
// Concrete today but must not depend on that).
export function recyclerTillUpdate(registry, tillId, nowMs, uid, store = SWITCHABLE_STORE) {
  const loc = locationOf(registry, store);
  if (!loc || loc.type !== "store") return fail("That store is not in the registry.");
  if (tillId !== null && !(loc.tills || []).some((t) => t.tillId === tillId)) return fail("That is not one of this store's tills.");
  return { ok: true, updates: { [`${NETWORK_PATH}/locations/${loc.id}/pos/recyclerTill`]: tillId === null ? false : tillId, ...stamp(nowMs, uid) } };
}
