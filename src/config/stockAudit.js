// ─── STOCK AUDIT — paths, scope and the one access gate ──────────────────────
// The client half of the daily shelf-walk lists. Everything the card renders is
// precomputed by refillHealthScan into ONE small node per hub (the sneaker
// out-of-stock checks) or per shop (the clothing rotation); nothing here reads
// /stock, /products, /stock_movements, /orders or /insights_log.
// That is not an optimisation, it is the design — those nodes are megabytes
// each and a home screen that streams them costs more per open than the whole
// feature saves.
//
// State lives under /settings, which already has working console rules
// (".read": "auth != null", ".write": signed-in non-anonymous). No rules change
// ships with this feature and none is needed.

export const STOCK_AUDIT_ROOT = "settings/stockAudit";

// The two shops with staff to walk a shelf. Matches AUDIT_STORES in
// functions/lib/stock-audit.cjs — the snapshot writer and the reader must agree
// on the set, and a store the function never writes would render an empty card.
export const AUDIT_STORES = [
  { id: "marathon-pe", label: "Marathon PE" },
  { id: "trophy", label: "Trophy" },
];

// The hubs that answer customer orders, and so the hubs that can turn one away.
// Matches AUDIT_HUBS in functions/lib/stock-audit.cjs.
export const AUDIT_HUBS = [
  { id: "hub1", label: "Hub 1" },
  { id: "hub2", label: "Hub 2" },
  { id: "hub3", label: "Hub 3" },
];

// Every place a row can name. Held here rather than read from /locations so the
// screen keeps its promise literally — it reads the snapshot and nothing else.
// Anything outside this set falls through to its raw id, which is honest and
// never blank.
export const LOCATION_LABEL = {
  "marathon-pe": "Marathon PE",
  trophy: "Trophy",
  hub1: "Hub 1",
  hub2: "Hub 2",
  hub3: "Hub 3",
};
export const locationLabel = (id) => LOCATION_LABEL[id] || id || "—";

// Hubs live under their own prefix so a hub id can never collide with a shop
// id at the same level, and so the two halves can be read, pruned and reasoned
// about separately.
export const hubSnapshotPath = (hub) => `${STOCK_AUDIT_ROOT}/hub/${hub}/latest`;
export const hubResultsPath = (hub, saDate) => `${STOCK_AUDIT_ROOT}/hub/${hub}/results/${saDate}`;
export const snapshotPath = (store) => `${STOCK_AUDIT_ROOT}/${store}/latest`;
export const resultsPath = (store, saDate) => `${STOCK_AUDIT_ROOT}/${store}/results/${saDate}`;
export const rotationPath = (store) => `${STOCK_AUDIT_ROOT}/rotation/${store}`;

// Same identity as the Stock section: this screen adjusts stock, so it cannot
// be open to anyone Stock is not. The route re-checks the same gate.
export function stockAuditVisibleForViewer({ canAccessStock, isSuperAdmin }) {
  return !!(canAccessStock || isSuperAdmin);
}

// The SA calendar day, for the results day-node key. Mirrors
// functions/lib/sa-time.cjs saDateStringFromMs — SAST is UTC+2 with no DST, so
// a shift and an ISO slice is exact. It takes an instant so the caller can pass
// serverNowMs() and a wrong device clock cannot file a result under the wrong
// day (the #236 lesson).
export function saDateOf(ms) {
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
