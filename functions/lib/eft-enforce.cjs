// ─── EFT ENFORCEMENT — which stores must MATCH every EFT sale (PURE) ─────────
// Junid, 17 Oct 2026: at Trophy and Marathon PE a cashier may no longer
// complete an EFT sale by looking at the customer's phone. An EFT sale at an
// ENFORCED store must consume a confirmed pool payment (eftPoolSettle —
// reference/bank id matched, customer attached and confirmed, consume-once).
// Pine and Concrete keep the looser path for now.
//
// THE SET IS CONFIG, NOT CODE. /eft_enforcement is a top-level node (no client
// rule → Admin SDK only; the owner edits it through eftEnforcementStatus
// "set", or `firebase database:set`), so a store is added or removed without
// a deploy:
//
//   /eft_enforcement = { stores: { trophy: true, pe: true, pine: false,
//                                  concrete: false }, updatedAt, updatedBy }
//
// A MISSING node means the DEFAULT (Trophy + Marathon PE). A present `stores`
// map is honoured exactly — including an empty one, which is the owner
// switching enforcement off everywhere.
//
// THE TILL IS THE WALL FOR PART A (the plain-EFT path never reaches a
// callable), and a till build that pre-dates enforcement, or one whose
// enforcement read failed and fell back wrongly, would slip through it
// silently. So the 5-minute scan (eftRemainderScan) also WALKS NEW SALES —
// a bounded indexed window, never the node — and any regular sale at an
// enforced store carrying an EFT leg with NO pool key is written to
// /eft_enforcement_breaches and logged EFT_ENFORCEMENT_BREACH. Detection,
// not prevention: the sale stands; Junid sees it.
//
// Store ids here are the POS's SHORT ids ("pe", "trophy", "pine", "concrete")
// — what /pos/sales/{id}.storeId and the till's settle payload carry.
// PURE by the house rule: no IO, no clock.
"use strict";

const EFT_ENFORCEMENT_PATH = "eft_enforcement";
const EFT_BREACH_PATH = "eft_enforcement_breaches";
const EFT_ENFORCEMENT_SCAN_PATH = "eft_enforcement_scan";

// Marathon PE is "pe" at the POS (the sale record's storeId), Trophy is "trophy".
const DEFAULT_ENFORCED_STORES = Object.freeze(["trophy", "pe"]);

// A POS store id: short, lower-case, becomes a path segment and a sale field.
const STORE_ID = /^[a-z][a-z0-9-]{0,30}$/;
// A pool key: eftMessageKey's sha256 prefix — 40 hex chars (poolKeyOf).
const POOL_KEY = /^[0-9a-f]{40}$/;

// The sales walk: one bounded page per run, a two-hour sliding window so an
// offline till's late-landing sale (createdAt preserved from the moment it
// was rung) is still seen, and a re-flag is an idempotent set on the same key.
const BREACH_SCAN_WINDOW_MS = 2 * 60 * 60 * 1000;
const BREACH_SCAN_PAGE = 500;

/** The ids enforcement applies to, from the config node — or the default. */
function enforcedStoresOf(node) {
  const stores = node && typeof node === "object" ? node.stores : undefined;
  if (!stores || typeof stores !== "object") return [...DEFAULT_ENFORCED_STORES].sort();
  return Object.entries(stores)
    .filter(([id, on]) => on === true && STORE_ID.test(id))
    .map(([id]) => id)
    .sort();
}

/** Is an EFT sale at this store required to consume a pool payment? */
function isEftEnforcedAt(storeId, node) {
  if (typeof storeId !== "string" || !STORE_ID.test(storeId)) return false;
  return enforcedStoresOf(node).includes(storeId);
}

/**
 * The owner's edit, validated: `{ stores: { id: bool } }` → the node to write,
 * or a refusal. Unknown shapes are refused rather than coerced — a typo in a
 * store id must not silently turn enforcement off there.
 */
function enforcementUpdateOf(data, { at, by }) {
  const stores = data && typeof data === "object" ? data.stores : undefined;
  if (!stores || typeof stores !== "object" || Array.isArray(stores)) {
    return { ok: false, code: "bad-stores", message: "Say which stores are enforced: { stores: { trophy: true, pine: false } }." };
  }
  const out = {};
  for (const [id, on] of Object.entries(stores)) {
    if (!STORE_ID.test(id)) return { ok: false, code: "bad-store-id", message: `"${id}" is not a store id.` };
    if (typeof on !== "boolean") return { ok: false, code: "bad-flag", message: `${id} must be true or false.` };
    out[id] = on;
  }
  if (!Number.isInteger(at)) return { ok: false, code: "bad-time", message: "The update carries no server time." };
  return { ok: true, value: { stores: out, updatedAt: at, updatedBy: String(by ?? "") } };
}

/**
 * What the till is told. `storeId` may be absent (the owner's config screen
 * asks for the whole set).
 */
function enforcementStatusOf(node, storeId) {
  const enforcedStores = enforcedStoresOf(node);
  const configured = !!(node && typeof node === "object" && node.stores && typeof node.stores === "object");
  return {
    enforcedStores,
    enforced: typeof storeId === "string" && storeId ? enforcedStores.includes(storeId) : null,
    source: configured ? "config" : "default",
    updatedAt: configured && Number.isInteger(node.updatedAt) ? node.updatedAt : null,
  };
}

/**
 * One sale, judged. A BREACH is a regular sale (type "sale") at an enforced
 * store with at least one EFT leg that names no pool payment — the sale the
 * till was told not to allow. Refunds, laybys and exchanges are not sales of
 * this kind and are never flagged; a leg with a well-formed pool key is a
 * matched payment (the attach's own sale check already verifies it).
 * @returns {object|null} the breach record to write, or null
 */
function enforcementBreachOf(saleId, sale, enforcedStores) {
  if (!sale || typeof sale !== "object") return null;
  if (sale.type !== "sale") return null;
  const storeId = typeof sale.storeId === "string" ? sale.storeId : null;
  if (!storeId || !(enforcedStores ?? []).includes(storeId)) return null;
  const legs = Object.entries(sale.payments ?? {})
    .filter(([, p]) => p && typeof p === "object" && p.method === "eft")
    .filter(([, p]) => !(typeof p.eftPoolKey === "string" && POOL_KEY.test(p.eftPoolKey)))
    .map(([paymentId, p]) => ({ paymentId, amount: Number.isInteger(p.amount) ? p.amount : null }));
  if (!legs.length) return null;
  return {
    saleId: String(saleId),
    storeId,
    tillId: typeof sale.tillId === "string" ? sale.tillId : null,
    cashierName: typeof sale.cashierName === "string" ? sale.cashierName.slice(0, 80) : null,
    receiptNumber: sale.receiptNumber == null ? null : String(sale.receiptNumber).slice(0, 30),
    createdAt: Number.isInteger(sale.createdAt) ? sale.createdAt : null,
    totalCents: Number.isInteger(sale.total) ? sale.total : null,
    eftCents: legs.reduce((s, l) => s + (l.amount ?? 0), 0),
    legs,
  };
}

/**
 * Where the next scan starts. The window SLIDES (now − 2h) on an ordinary
 * run; a FULL page means sales are still queued behind the cursor, so the
 * next run drains from the last one seen instead of skipping ahead.
 */
function breachScanNext({ state, now, maxSeen, full }) {
  const since = Number.isInteger(state?.sinceMs) ? state.sinceMs : now - BREACH_SCAN_WINDOW_MS;
  // From maxSeen itself, not maxSeen + 1: sales sharing that millisecond
  // must not be skipped, and a re-read is idempotent (create-only record).
  if (full && Number.isInteger(maxSeen)) return { sinceMs: Math.max(since, maxSeen), at: now, drained: false };
  return { sinceMs: Math.max(since, now - BREACH_SCAN_WINDOW_MS), at: now, drained: true };
}

module.exports = {
  EFT_ENFORCEMENT_PATH, EFT_BREACH_PATH, EFT_ENFORCEMENT_SCAN_PATH,
  DEFAULT_ENFORCED_STORES, BREACH_SCAN_WINDOW_MS, BREACH_SCAN_PAGE,
  enforcedStoresOf, isEftEnforcedAt, enforcementUpdateOf, enforcementStatusOf,
  enforcementBreachOf, breachScanNext,
};
