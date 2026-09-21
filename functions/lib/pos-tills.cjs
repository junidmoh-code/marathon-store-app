// ─── THE POS'S STORES AND TILLS, AS THE SERVER SEES THEM ─────────────────────
// A card terminal is mapped to a (storeId, tillId) that must be a REAL POS
// till: the expected-card figure joins those two keys to /pos/paymentEvents,
// and a key the POS never writes makes every variance for that machine 100%
// short. So the terminal settings sheet offers only what this returns, and the
// callable checks every write against it again.
//
// THE POS'S OWN ORDER OF PRECEDENCE, kept exactly: /pos/config/{storeId}/tills
// is its runtime source of truth, and TILLS_FALLBACK in marathon-pos-app
// src/shared/stores.js is what it uses while that node is unseeded — which it
// is, for all three stores, as of 21 Sept 2026. KEEP THIS COPY IN SYNC with
// that file; functions/test/card-terminal-admin.test.cjs pins the shape.
//
// PURE: the callable does the reads and hands them in.
"use strict";

const POS_STORES = Object.freeze([
  { storeId: "pe", label: "Marathon PE" },
  { storeId: "pine", label: "Marathon Pine" },
  { storeId: "trophy", label: "Trophy" },
]);

const TILLS_FALLBACK = Object.freeze({
  pe: [{ tillId: "till-1", name: "Till 1" }, { tillId: "till-2", name: "Till 2" }, { tillId: "till-3", name: "Till 3" }],
  pine: [{ tillId: "till-1", name: "Till 1" }],
  trophy: [{ tillId: "till-1", name: "Till 1" }, { tillId: "till-2", name: "Till 2" }],
});

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
 * @returns {{storeId:string, label:string, tills:{tillId:string,name:string}[], source:string}[]}
 */
function posStores(configured = {}) {
  return POS_STORES.map((s) => {
    const fromConfig = readConfiguredTills(configured[s.storeId]);
    return {
      ...s,
      tills: fromConfig || TILLS_FALLBACK[s.storeId].map((t) => ({ ...t })),
      source: fromConfig ? "pos-config" : "pos-fallback",
    };
  });
}

module.exports = { POS_STORES, TILLS_FALLBACK, readConfiguredTills, posStores };
