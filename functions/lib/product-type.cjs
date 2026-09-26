// ─── CHANGING A PRODUCT'S TYPE — THE DECISIONS, PURE ─────────────────────────
//
// 25 Sep 2026: the Nike Air Force 1 White — 496 orders, stock at three
// locations — was switched to Type Clothing from a shop phone. Clothing strips
// Hub 1, the order sheet hides a clothing-typed shoe from the Hub 1/Hub 2 grid,
// and nobody could say who did it. So a Type change now goes through
// setProductType (functions/productType/), which uses this:
//
//   · WHO: a product with stock or sales — any /stock cell at any location,
//     which every receive, count and sale leaves behind (cells are never
//     deleted; a sale needs a cell to sell from) — may only be retyped
//     by a manager (Junid, or MC's enrolled code-making device). A brand-new
//     product with no cells may be retyped by anyone who can edit it.
//   · WHAT: the same patch the edit page always wrote (Clothing strips Hub 1
//     and the shoebox flag), plus, going BACK to Sneaker, the hubs it had
//     before the last switch to Clothing (from its own typeLog) — or Hub 1 if
//     it has Hub 1 cells — so a switch and its undo are one round trip.
//   · NEVER LOSE STOCK: switching to Clothing is refused while Hub 1 holds
//     units — Clothing cannot be stocked at Hub 1, so those units would sit on
//     a shelf nothing can see. Nothing here moves or deletes a cell.
//   · LOGGED: product_type_log/{pid}/{key} with from, to, when (server
//     clock), the person, the device, the uid, and hubs/sizes before and after.
//     Its own top-level node with NO client rule, so no device can add, alter
//     or delete an entry — only the Admin SDK writes it. (CodeRabbit, PR #651:
//     a log inside the client-writable product could be rewritten.)
"use strict";

const TYPES = new Set(["sneaker", "clothing"]);

function readType(x) {
  return typeof x === "string" && TYPES.has(x) ? x : null;
}

function cellsExist(cellsByLoc) {
  return Object.values(cellsByLoc || {}).some((c) => c && typeof c === "object" && Object.keys(c).length > 0);
}

function unitsAt(cellsByLoc, loc) {
  return Object.values(cellsByLoc?.[loc] || {}).reduce((n, c) => n + Math.max(Number(c?.qty) || 0, 0), 0);
}

// The hubs recorded just before the most recent switch TO clothing, if any.
function hubsBeforeLastClothing(typeLog) {
  const entries = Object.values(typeLog || {}).filter((e) => e && e.to === "clothing" && Array.isArray(e.hubsBefore))
    .sort((a, b) => (Number(b.atMs) || 0) - (Number(a.atMs) || 0));
  return entries.length ? entries[0].hubsBefore : null;
}

const HUB_ORDER = ["hub1", "hub2", "hub3"];
const orderHubs = (hubs) => [...new Set(hubs)].sort((a, b) =>
  (HUB_ORDER.indexOf(a) + 1 || 99) - (HUB_ORDER.indexOf(b) + 1 || 99));

/**
 * @returns {{ ok:false, code, message }
 *          | { ok:true, noop?:true, patch, before, after }}
 */
const TYPE_LOG_ROOT = "product_type_log";

function planTypeChange(product, to, { cellsByLoc = {}, isManager = false, typeLog = null } = {}) {
  const next = readType(to);
  if (!next) return { ok: false, code: "invalid-argument", message: "Type must be Sneaker or Clothing." };
  if (!product || typeof product !== "object") return { ok: false, code: "not-found", message: "That product no longer exists." };
  const from = product.productType || "sneaker";
  const hubsNow = Array.isArray(product.hubs) ? product.hubs.slice() : (product.hub ? [product.hub] : []);
  const before = { productType: product.productType ?? null, hubs: hubsNow, sizes: Array.isArray(product.sizes) ? product.sizes : [] };
  if (from === next) return { ok: true, noop: true, patch: {}, before, after: before };

  const hasHistory = cellsExist(cellsByLoc);
  if (hasHistory && !isManager) {
    return {
      ok: false, code: "permission-denied",
      message: "This product has stock or sales, so only Junid or MC can change its Type. Ask one of them.",
    };
  }

  const patch = { productType: next };
  let hubs = hubsNow;
  if (next === "clothing") {
    const hub1Units = unitsAt(cellsByLoc, "hub1");
    if (hub1Units > 0) {
      return {
        ok: false, code: "failed-precondition",
        message: `Hub 1 holds ${hub1Units} unit${hub1Units === 1 ? "" : "s"} of this product, and Clothing cannot be stocked at Hub 1 — `
          + "those units would be stranded. Move them off Hub 1 first.",
      };
    }
    const stripped = hubsNow.filter((h) => h !== "hub1");
    hubs = stripped.length ? stripped : ["hub2"];
    patch.hasShoeBoxOption = false;
  } else {
    const remembered = hubsBeforeLastClothing(typeLog);
    const hub1Cells = !!(cellsByLoc.hub1 && Object.keys(cellsByLoc.hub1).length);
    hubs = orderHubs([...hubsNow, ...(remembered || []), ...(hub1Cells ? ["hub1"] : [])]);
  }
  if (JSON.stringify(hubs) !== JSON.stringify(hubsNow)) patch.hubs = hubs;
  if (hubs.length && product.hub !== hubs[0]) patch.hub = hubs[0];
  return { ok: true, patch, before, after: { productType: next, hubs, sizes: before.sizes } };
}

module.exports = { planTypeChange, readType, cellsExist, unitsAt, hubsBeforeLastClothing, TYPE_LOG_ROOT };
