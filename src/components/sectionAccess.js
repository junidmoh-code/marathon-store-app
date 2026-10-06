// ─── A STAFF ACCOUNT'S SECTION, AS THE OWNER SETS IT AND THE SCREENS READ IT ─
// The answer to "which sections may this account see?" is sectionsFor() in the
// network registry. This file is the small layer around it that the owner's
// screens share (User Management, Order Alerts, Device Codes, Card machines):
//
//   /users/{uid}/sections      { "1": true } or { "2": true } — a MAP
//   /users/{uid}/allSections   true — an admin Junid has given both sections
//
// ── ONE SECTION IS A MAP WITH ONE KEY; BOTH IS allSections ──────────────────
// "Both" is never written as { 1: true, 2: true }. RTDB hands a map with dense
// integer keys back as an ARRAY ([null, true, true]), and an array is not a
// sections map to anything that reads one. So the three choices write:
//
//   Section 1  → sections: { 1: true }, allSections removed
//   Section 2  → sections: { 2: true }, allSections removed
//   Both       → allSections: true,     sections removed
//
// and sectionsMap() below still reads the array form correctly, in case a
// record is ever written that way by hand.
//
// An account with NEITHER field follows its Store Access lock (destShop) if it
// has one, and otherwise sees both — every account that predates sections.
//
// Pure: no firebase, no React.
import { sectionsFor } from "../utils/networkRegistry";

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A stored `sections` value → a map, or null when there is none. */
export function sectionsMap(raw) {
  if (Array.isArray(raw)) {
    const out = {};
    raw.forEach((v, i) => { if (v === true) out[String(i)] = true; });
    return out;
  }
  return isObj(raw) ? raw : null;
}

/** A /users record → the record sectionsFor() reads (array form repaired). */
export function sectionRecord(rec) {
  const r = isObj(rec) ? rec : {};
  const out = {};
  const map = sectionsMap(r.sections);
  if (map) out.sections = map;
  if (r.allSections === true) out.allSections = true;
  if (typeof r.destShop === "string" && r.destShop) out.destShop = r.destShop;
  return out;
}

/** The sections this account may see: [1], [2], [1, 2] or []. */
export function accountSections(registry, rec, opts) {
  return sectionsFor(registry, sectionRecord(rec), opts);
}

/**
 * What the owner has SET on this account: "1", "2", "both", or "" when neither
 * field is there (the account then follows its shop lock, or sees both).
 */
export function sectionChoiceOf(rec) {
  const r = sectionRecord(rec);
  if (r.allSections === true) return "both";
  if (!r.sections) return "";
  const one = r.sections["1"] === true;
  const two = r.sections["2"] === true;
  if (one && two) return "both";
  if (one) return "1";
  if (two) return "2";
  return "";
}

/** The /users/{uid} patch for a choice. null removes a field. */
export function sectionPatch(choice) {
  if (choice === "1" || choice === 1) return { sections: { 1: true }, allSections: null };
  if (choice === "2" || choice === 2) return { sections: { 2: true }, allSections: null };
  if (choice === "both") return { sections: null, allSections: true };
  throw new Error(`section choice must be "1", "2" or "both" — got "${choice}"`);
}

/** "Section 1" — the registry's own name for a section. */
export function sectionName(registry, n) {
  return (registry && registry.sections && registry.sections[n] && registry.sections[n].name) || `Section ${n}`;
}
