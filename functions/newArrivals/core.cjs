// ─── NEW ARRIVALS — THE QUEUE'S PURE CORE ────────────────────────────────────
// One record per uploaded product at /new_arrivals/items/{pid}, plus a small
// per-status index at /new_arrivals/by_status/{status}/{pid} = enqueuedAt.
//
// THE ITEM IS THE TRUTH; THE INDEX IS A HINT. Every move is a transaction on
// the item that checks the status it is moving FROM, followed by an index
// update. If the second write is lost, the reader that finds an index entry
// whose item says otherwise repairs it (indexRepair) — so a crash between the
// two writes can delay an item, never mis-route it.
//
// WHY AN INDEX AT ALL: the card and the Mac mini agents must never read a
// whole node. by_status/new is a handful of keys; /products is the catalogue.
// No query on /new_arrivals needs an .indexOn rule — every read here is a
// child path or orderByKey — so database.rules.json is untouched.
//
// Statuses, and the card tab each one shows under:
//   new, generating            → New
//   ready                      → Ready     (a generated photo passed the checker)
//   rejected                   → Rejected  (reason in plain words; Retry = fresh generation)
//   approved, chaining, done   → Done      (Junid tapped Approve; where it went, and when)
"use strict";

const ROOT = "new_arrivals";
const ITEMS = `${ROOT}/items`;
const BY_STATUS = `${ROOT}/by_status`;

const STATUSES = Object.freeze(["new", "generating", "ready", "rejected", "approved", "chaining", "done"]);
const TAB_OF = Object.freeze({
  new: "new", generating: "new", ready: "ready", rejected: "rejected",
  approved: "done", chaining: "done", done: "done",
});
const TABS = Object.freeze(["new", "ready", "rejected", "done"]);
const STATUSES_IN_TAB = Object.freeze(TABS.reduce((acc, t) => {
  acc[t] = STATUSES.filter((s) => TAB_OF[s] === t);
  return acc;
}, {}));

// The upload path stamps createdBy.at with serverNowMs() at save time. A
// product created by anything else (a merge, an import, a restore script)
// carries no createdBy and is not a new arrival. The window absorbs a slow
// trigger delivery; the negative slack absorbs client/server clock skew.
const ENQUEUE_WINDOW_MS = 15 * 60 * 1000;
const ENQUEUE_SKEW_MS = 5 * 60 * 1000;
const PRICE_RECORD_CATEGORY = "Price Products"; // src/utils/productCategory.js PRICE_RECORD_CATEGORY

const PID_RE = /^p\d{10,}$/;

function enqueueDecision(pid, product, nowMs) {
  if (!PID_RE.test(String(pid || ""))) return { ok: false, why: "not an uploaded product id" };
  if (!product || typeof product !== "object") return { ok: false, why: "no record" };
  if (product.mergedInto) return { ok: false, why: "merged record" };
  if (product.category === PRICE_RECORD_CATEGORY) return { ok: false, why: "price record" };
  // THE MARKER the upload form writes (addProductOnce: newArrivalAt). Explicit,
  // so no time window applies — a late trigger delivery still queues it.
  if (Number.isFinite(Number(product.newArrivalAt)) && Number(product.newArrivalAt) > 0) return { ok: true };
  // Fallback for devices still running the previous bundle (no marker yet):
  // the upload form's own createdBy stamp, if fresh.
  const at = Number(product.createdBy && product.createdBy.at);
  if (!Number.isFinite(at)) return { ok: false, why: "not created by the upload form" };
  if (nowMs - at > ENQUEUE_WINDOW_MS) return { ok: false, why: "created too long ago to be a new upload" };
  if (at - nowMs > ENQUEUE_SKEW_MS) return { ok: false, why: "creation stamp is in the future" };
  if (product.mergedInto) return { ok: false, why: "merged record" };
  if (product.category === PRICE_RECORD_CATEGORY) return { ok: false, why: "price record" };
  return { ok: true };
}

function buildItem(pid, product, at) {
  const item = {
    pid,
    status: "new",
    enqueuedAt: at,
    statusAt: at,
    name: String(product.name || "").slice(0, 200),
    attempts: 0,
    attemptsSinceRetry: 0,
  };
  // Optional fields are OMITTED, never written as undefined (the SDK throws on
  // undefined, and null would just be dropped).
  if (product.categoryKey) item.categoryKey = String(product.categoryKey);
  if (product.photoUrl) item.originalUrl = String(product.photoUrl);
  return item;
}

/**
 * A transaction mutator that moves an item from one of `from` to `to`.
 * `fields` are merged into the item; a field set to null is removed, exactly
 * as RTDB would.
 *
 * THE COLD-CACHE TRAP: the SDK's first call passes null even when the item
 * exists. Aborting there would refuse every move made from a cold process, so
 * a null `cur` returns null — the server's compare-and-retry then supplies the
 * real value. If the item truly is absent, null commits as a no-op. Either
 * way the caller decides by `moved(res, to)`, never by `committed` alone.
 * A present item in the wrong status aborts (undefined) with `out.refusal`.
 */
function moveMutator({ from, to, fields = {}, at }, out = {}) {
  if (!STATUSES.includes(to)) throw new Error(`unknown status ${to}`);
  const allowed = Array.isArray(from) ? from : [from];
  return (cur) => {
    if (!cur) { out.refusal = "not in the New Arrivals queue"; return null; }
    if (!allowed.includes(cur.status)) { out.refusal = `it is ${cur.status}, not ${allowed.join(" or ")}`; return undefined; }
    out.refusal = null;
    out.from = cur.status;
    const next = { ...cur, ...fields, status: to, statusAt: at };
    for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
    return next;
  };
}

/** Did a moveMutator transaction actually land the item in `to`? */
function moved(res, to) {
  if (!res || !res.committed) return null;
  const v = res.snapshot && res.snapshot.val();
  return v && v.status === to ? v : null;
}

/** The index writes that follow a committed move: one multi-path update at ROOT. */
function indexMove(pid, from, to, enqueuedAt) {
  const u = {};
  if (from && from !== to) u[`by_status/${from}/${pid}`] = null;
  u[`by_status/${to}/${pid}`] = Number(enqueuedAt) || 0;
  return u;
}

/**
 * The repair for an index entry that disagrees with its item. Returns the
 * multi-path update to apply at ROOT, or null if the entry is right.
 */
function indexRepair(pid, listedUnder, item) {
  if (!item) return { [`by_status/${listedUnder}/${pid}`]: null };
  if (item.status === listedUnder) return null;
  return indexMove(pid, listedUnder, item.status, item.enqueuedAt);
}

// The Done tab grows for ever; its reads are bounded to the most recent.
const LIST_LIMIT_DEFAULT = 60;
const LIST_LIMIT_MAX = 200;
function listLimit(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return LIST_LIMIT_DEFAULT;
  return Math.min(v, LIST_LIMIT_MAX);
}

/** What the card needs from /products/{pid}. Price and sizes are read live. */
function productSummary(p) {
  if (!p) return null;
  const sizes = Array.isArray(p.sizes) ? p.sizes.filter((s) => s !== null && s !== undefined && s !== "")
    : (p.sizes && typeof p.sizes === "object" ? Object.values(p.sizes).filter(Boolean) : []);
  return {
    name: p.name || "",
    brand: p.brand || null,
    retailPrice: Number.isFinite(Number(p.retailPrice)) ? Number(p.retailPrice) : null,
    // Cost too: the Ready card fills BOTH missing prices through the Missing
    // prices save, so the product leaves Missing prices.
    stockPrice: Number.isFinite(Number(p.stockPrice)) ? Number(p.stockPrice) : null,
    sizes: sizes.map(String),
    photoUrl: p.photoUrl || null,
    photoUrlOriginal: p.photoUrlOriginal || null,
    categoryKey: p.categoryKey || null,
  };
}

module.exports = {
  ROOT, ITEMS, BY_STATUS, STATUSES, TABS, TAB_OF, STATUSES_IN_TAB,
  ENQUEUE_WINDOW_MS, ENQUEUE_SKEW_MS, PID_RE,
  enqueueDecision, buildItem, moveMutator, moved, indexMove, indexRepair,
  listLimit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, productSummary,
};
