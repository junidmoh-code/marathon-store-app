// ─── WHICH SECTIONS AN ACCOUNT MAY ACT IN, AS THE SERVER READS IT ────────────
// The answer itself is sectionsFor() in the network registry — the same
// function the screens ask through useMySections. This file only fetches what
// that function needs, and fetches it the cheap way:
//
//   /users/{uid}/sections      { "1": true } — a MAP, never an array
//   /users/{uid}/allSections   true for an admin Junid has given both
//   /users/{uid}/destShop      the older single-shop lock; its shop's section
//
// THREE LEAVES, NEVER THE RECORD AND NEVER /users. A /users record carries the
// permission list, the device gate and the hidden cards; the fan-out that calls
// this runs on every order.
//
// An account with none of the three sees both sections — every account that
// predates sections — so nobody is locked out by the deploy.
"use strict";

const { sectionsFor, sectionOf, SEED_REGISTRY } = require("./network-registry.cjs");

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// RTDB hands { "1": true, "2": true } back as the ARRAY [null, true, true]
// (dense integer keys). sectionsFor() reads a map, so the array is turned back
// into one here rather than being mistaken for "no sections set".
function sectionsMap(raw) {
  if (Array.isArray(raw)) {
    const out = {};
    raw.forEach((v, i) => { if (v === true) out[String(i)] = true; });
    return out;
  }
  return isObj(raw) ? raw : null;
}

/** The three leaves → the record sectionsFor() reads. Absent leaves are left out. */
function sectionRecord({ sections, allSections, destShop } = {}) {
  const rec = {};
  const map = sectionsMap(sections);
  if (map) rec.sections = map;
  if (allSections === true) rec.allSections = true;
  if (typeof destShop === "string" && destShop) rec.destShop = destShop;
  return rec;
}

/** A custom-token `section` claim (1 or 2), or null. */
function readSectionClaim(v) {
  return v === 1 || v === 2 ? v : null;
}

/**
 * The sections one account may act in: [1], [2], [1, 2] or [].
 * Throws if a leaf cannot be read — the CALLER decides which way to fail.
 */
async function readAccountSections(db, registry, uid, { isOwner = false, deviceSection = null } = {}) {
  if (isOwner) return [1, 2];
  const [sections, allSections, destShop] = await Promise.all(
    ["sections", "allSections", "destShop"].map(async (leaf) => {
      const snap = await db.ref(`users/${uid}/${leaf}`).get();
      return snap ? snap.val() : null;
    }));
  return sectionsFor(registry || SEED_REGISTRY, sectionRecord({ sections, allSections, destShop }), { deviceSection });
}

/** Is this location inside those sections? Central, and anything the registry
 *  gives no section, is inside everyone's. */
function locationInSections(registry, sections, anyLoc) {
  const s = sectionOf(registry || SEED_REGISTRY, anyLoc);
  return s === null ? true : (sections || []).includes(s);
}

module.exports = { sectionsMap, sectionRecord, readSectionClaim, readAccountSections, locationInSections };
