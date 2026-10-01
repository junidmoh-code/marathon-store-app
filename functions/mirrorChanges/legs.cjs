// ─── /mirror_changes — THE LEG TABLE, SERVER SIDE ────────────────────────────
//
// ⚠ SECOND COPY OF A SHARED REGISTRY — READ BEFORE EDITING ⚠
//
// The original is src/offline/nodes.js. This is a second copy, and it exists
// only because functions/ is deployed as its own package and cannot reach into
// src/. The same pair of files exists for the photo path convention
// (src/utils/productPhotoPaths.js), for the same reason, with the same warning.
//
// IF THESE TWO DRIFT, NOTHING BREAKS LOUDLY. A leg added to the client and not
// here simply never receives a change record: the client mirrors it once at
// setup and then serves a copy that silently ages, for ever, while every leg
// reports healthy. A leg here and not on the client writes change records
// nothing reads. Both are invisible.
//
// So: src/offline/__tests__/changeLegsMatch.test.js parses THIS FILE and
// asserts it names exactly the change-fed legs in nodes.js, at exactly the same
// depths. Change one, change the other, in the same commit, or the test fails.
//
// ── WHAT A LEG IS HERE ──────────────────────────────────────────────────────
//
//   node   the RTDB path.
//   depth  how many path segments below `node` identify one row. The trigger
//          ref is `node` plus that many wildcards, so the function fires at
//          exactly the granularity the client will re-read.
//   fn     the exported Cloud Function name. Deploys are scoped by name in
//          this project (never a bare --only functions), so every one of these
//          has to be nameable.

const LEGS = [
  { name: "locations",       node: "locations",                       depth: 0, fn: "mirrorChangeLocations" },
  { name: "taxonomy",        node: "settings/productTaxonomy",        depth: 0, fn: "mirrorChangeTaxonomy" },
  { name: "stockHoldConfig", node: "settings/stockHold/config",       depth: 0, fn: "mirrorChangeStockHoldConfig" },
  { name: "stockHoldHeld",   node: "settings/stockHold/held",         depth: 1, fn: "mirrorChangeStockHoldHeld" },
  { name: "hiddenProducts",  node: "settings/missingProductsHidden",  depth: 0, fn: "mirrorChangeHiddenProducts" },
  { name: "transitConfig",   node: "config/transit",                  depth: 0, fn: "mirrorChangeTransitConfig" },
  { name: "clothingOos",     node: "clothing_sold_refills",           depth: 0, fn: "mirrorChangeClothingOos" },
  { name: "users",           node: "users",                           depth: 1, fn: "mirrorChangeUsers" },
  { name: "products",        node: "products",                        depth: 1, fn: "mirrorChangeProducts" },
  { name: "stock",           node: "stock",                           depth: 2, fn: "mirrorChangeStock" },
  { name: "orders",          node: "orders",                          depth: 1, fn: "mirrorChangeOrders" },
  { name: "customers",       node: "customers",                       depth: 1, fn: "mirrorChangeCustomers" },
  { name: "displaySlots",    node: "settings/displaySlots",           depth: 2, fn: "mirrorChangeDisplaySlots" },
  { name: "displayRows",     node: "settings/displayRows",            depth: 3, fn: "mirrorChangeDisplayRows" },
  { name: "displayRegister", node: "settings/hubSneakerCount/register", depth: 2, fn: "mirrorChangeDisplayRegister" },
  { name: "refills",         node: "refill_requests",                 depth: 1, fn: "mirrorChangeRefills" },
  { name: "restockRequests", node: "restock_requests",                depth: 2, fn: "mirrorChangeRestockRequests" },
  { name: "returnsLog",      node: "returns_log",                     depth: 1, fn: "mirrorChangeReturnsLog" },
  { name: "restockLog",      node: "restock_log",                     depth: 2, fn: "mirrorChangeRestockLog" },
];

// The log every trigger appends to, and the node the daily census publishes
// row counts to. Both are read-only to clients — only these functions, which
// run as admin and bypass rules, may write them. See docs §10.1 for the rule
// block to paste.
const CHANGES_ROOT = "mirror_changes";
const COUNTS_ROOT = "mirror_counts";

// How long a change record is kept. A device whose cursor is older than the
// oldest record kept CANNOT catch up from the log, and must not pretend to —
// it re-runs that leg's setup download instead. Thirty days is longer than any
// device in this business is plausibly off, and short enough that the log stays
// small.
const CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// The trigger ref for a leg: the node, plus one wildcard per depth. A depth-0
// node has no wildcards and fires on any descendant write, which is what a
// whole-document leg wants.
function triggerRef(leg) {
  const wildcards = Array.from({ length: leg.depth }, (_, i) => `{seg${i}}`);
  return `/${[leg.node, ...wildcards].join("/")}`;
}

// The row key a change record carries: the wildcard values, in order, joined
// with "|". Mirrors rowKey() in src/offline/nodes.js, including its refusal —
// "|" is a legal RTDB key character, so a segment containing one would collide
// two rows into one and there would be nothing to see afterwards.
function rowKeyFromParams(leg, params) {
  if (leg.depth === 0) return "";
  const segs = [];
  for (let i = 0; i < leg.depth; i += 1) {
    const v = params[`seg${i}`];
    if (typeof v !== "string" || v === "" || v.includes("|")) return null;
    segs.push(v);
  }
  return segs.join("|");
}

module.exports = {
  LEGS, CHANGES_ROOT, COUNTS_ROOT, CHANGE_RETENTION_MS,
  triggerRef, rowKeyFromParams,
};
