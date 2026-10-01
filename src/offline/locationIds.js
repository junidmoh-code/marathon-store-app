// ─── THE TWO ID NAMESPACES FOR THE SAME SHOP ─────────────────────────────────
//
// WHY THIS FILE EXISTS. The POS names a shop "pe". This app, /stock and
// /orders.destShop name the same shop "marathon-pe". The POS mirror crossed
// that boundary by building a path from the short id, read `/stock/pe`, got
// nothing back, and stamped itself healthy — every till in the shop served an
// empty catalogue and nothing anywhere said so. That is the whole reason this
// mirror treats "empty" as a failure, and it is the whole reason the mapping
// lives in ONE file that is STRICT.
//
// STRICT means: an id this file does not know returns null. It never guesses,
// never falls through to the raw id, and never prefixes "marathon-" onto
// something hopefully. A null is a loud, answerable failure at the call site;
// a guessed path is a silent empty read weeks later.
//
// SOURCE OF TRUTH is the live /locations registry, read 2026-09-19:
//
//   base           warehouse   inactive
//   central        warehouse
//   hub1 hub2 hub3 warehouse
//   in_transit     transit
//   marathon-pe    store       sellable
//   marathon-pine  store       sellable
//   studio         warehouse   inactive
//   trophy         store       sellable
//
// The warehouse ids have ONE spelling each and cross the boundary unchanged.
// Only the two Marathon shops are double-named, because the POS shortened them
// and this app did not.

// POS/short id → canonical id used by /stock and /orders.destShop.
const SHORT_TO_CANONICAL = Object.freeze({
  pe: "marathon-pe",
  pine: "marathon-pine",
  trophy: "trophy",
});

// Every canonical location id the mirror will accept in a /stock row key.
// A change record naming anything else is recorded and skipped rather than
// stored under a location that no screen will ever ask for.
export const CANONICAL_LOCATION_IDS = Object.freeze([
  "base", "central", "hub1", "hub2", "hub3", "in_transit",
  "marathon-pe", "marathon-pine", "studio", "trophy",
]);

const CANONICAL_SET = new Set(CANONICAL_LOCATION_IDS);

export function isCanonicalLocationId(id) {
  return typeof id === "string" && CANONICAL_SET.has(id);
}

// "pe" → "marathon-pe"; "hub1" → "hub1"; "marathon-pe" → "marathon-pe".
// Anything else → null. See the strictness note above.
export function canonicalLocationId(id) {
  if (typeof id !== "string" || id === "") return null;
  if (CANONICAL_SET.has(id)) return id;
  return SHORT_TO_CANONICAL[id] ?? null;
}

// The reverse, for reading a POS-written record. Only the two double-named
// shops have a short form; everything else is its own short form.
const CANONICAL_TO_SHORT = Object.freeze(
  Object.fromEntries(Object.entries(SHORT_TO_CANONICAL).map(([s, c]) => [c, s])),
);

export function shortLocationId(id) {
  if (typeof id !== "string" || id === "") return null;
  if (CANONICAL_TO_SHORT[id]) return CANONICAL_TO_SHORT[id];
  return CANONICAL_SET.has(id) ? id : null;
}

export class UnknownLocationError extends Error {
  constructor(id, where) {
    super(
      `offline mirror: "${id}" is not a location this app knows${where ? ` (${where})` : ""}. ` +
      "Refusing to build a path from it — a guessed path reads empty and looks healthy.",
    );
    this.name = "UnknownLocationError";
    this.id = id;
  }
}

// The form to use where a null would be swallowed. Callers that can degrade
// use canonicalLocationId; callers that would otherwise build a path use this.
export function requireCanonicalLocationId(id, where = null) {
  const canonical = canonicalLocationId(id);
  if (!canonical) throw new UnknownLocationError(id, where);
  return canonical;
}
