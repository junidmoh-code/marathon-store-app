// ─── EVERY REJECTION FEEDS THE SHELF CHECK, ANY CUSTOMER ─────────────────────
//
// Junid, 24 Nov 2026 evening (commit 3 of his brief). Until now only a website
// rejection put a shelf on the daily check. Every other "it is not here" is the
// same claim about the same shelf:
//
//   store_order_oos   a hub marks a store customer's order Out of Stock
//   shop_refill_rej   a hub rejects a size on a shop-refill batch ("Shop Refill")
//   stock_depleted    a hub answers a Display Partner refill "Stock Depleted"
//   refill_refused    a refill or transfer request refused at the place it was
//                     asked of (Central's or a hub's Out of Stock in the queue)
//   display_no_stock  a shop's display check says "No Stock Available" — the
//                     shop's own "not found anywhere"
//
// What happens: NOTHING to the count. The shelf (product, size, the place that
// said no) is put under a shelf hold — the same /online_cell_holds row a website
// rejection writes, tagged with its source and order/request id:
//
//   /online_cell_holds/{pid}/{sizeKey}/{loc} = { at, kind, orderId: <ref>, line: 0, qty, src: "store" }
//
// so, until a person checks it, it is held off the website and out of website
// routing (scripts/shopify/pickableStock.mjs reads the row whatever its kind),
// and the daily list picks it up as "store_reject". The hold ends by itself on
// the shelf's next movement — a sale, a delivery, a transfer, a count — and the
// shelf check lifts it when answered.
//
// Not held, and why:
//   • the shelf moved AFTER the rejection (newer evidence);
//   • the shelf shows nothing that should be on it — what it shows is all still
//     on the way (functions/lib/on-the-way.cjs) or it shows none (the "no" agrees
//     with the count);
//   • a website order (customer "Shopify"): those keep their own path, the
//     single-piece write-down (functions/lib/web-writedown.cjs).
//
// WHERE THE REJECTIONS ARE READ (by shelfChecksTick, every ten minutes, from a
// cursor — never a whole node):
//   • /insights_log, push-keyed (time-ordered): out_of_stock and stock_depleted
//     rows carry the hub (placedAtHub), the product, the size and the order no.
//   • the request list, by its resolvedAt index: a request cancelled with no
//     cancel reason is a person's refusal (the same shape the refill engine and
//     the two-day write-off treat as a human "no"). READ ONLY: nothing here
//     changes a request, its creation, a policy or a target.
//   • a display check's "No Stock Available" is held at the moment it is
//     answered (functions/displayChecks/completeCheck.js calls holdRejection).
//
// `db` is injected (firebase-admin Database or a test fake).
"use strict";

const { readOnTheWay, sizeKeyOf } = require("./on-the-way.cjs");

const CELL_HOLDS_PATH = "online_cell_holds";
const REQUESTS_PATH = "refill_requests";
const INSIGHTS_PATH = "insights_log";
const CURSOR_PATH = "shelf_checks_meta/rejects";
// The kinds this file writes; a website rejection's kinds (hub_out_of_stock, shop_not_found, shelf_check) are not.
const STORE_HOLD_KINDS = Object.freeze(["store_order_oos", "shop_refill_rej", "stock_depleted", "refill_refused", "display_no_stock"]);
// A shelf check / list build tells the two apart by this.
const isStoreHold = (hold) => !!hold && STORE_HOLD_KINDS.includes(hold.kind);
const LOCATIONS = Object.freeze(["hub1", "hub2", "hub3", "central", "marathon-pe", "trophy", "concrete", "marathon-pine"]);
const FIRST_RUN_LOOKBACK_MS = 24 * 3600e3;
const OVERLAP_MS = 30 * 60e3;

const keyOk = (k) => typeof k === "string" && k !== "" && !/[.#$[\]/]/.test(k);
const tMs = (v) => { const t = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(t) && t > 0 ? t : null; };
const isWebsiteOrder = (r) => String(r.customerName || "").trim() === "Shopify" || /^[A-Z]{3}(-|$)/.test(String(r.orderNumber || ""));

/** One /insights_log row → a rejection, or null. PURE. */
function fromInsight(key, r) {
  if (!r || typeof r !== "object") return null;
  if (r.action !== "out_of_stock" && r.action !== "stock_depleted") return null;
  if (isWebsiteOrder(r)) return null;
  const loc = r.placedAtHub || r.hub;
  const at = tMs(r.timestamp);
  if (!LOCATIONS.includes(loc) || !keyOk(r.productId) || at == null) return null;
  const kind = r.action === "stock_depleted" ? "stock_depleted" : String(r.customerName || "").trim() === "Shop Refill" ? "shop_refill_rej" : "store_order_oos";
  const day = new Date(at + 2 * 3600e3).toISOString().slice(0, 10);
  return { loc, pid: r.productId, sizeKey: sizeKeyOf(r.size), size: r.size == null ? null : String(r.size), at, kind, ref: `${loc} order ${r.orderNumber ?? "?"} ${day}`, key };
}

/** One request → a refusal, or null. PURE. A person's "no" = cancelled with no cancel reason. */
function fromRequest(id, r) {
  if (!r || typeof r !== "object" || r.status !== "cancelled" || r.cancelReason) return null;
  const loc = r.refusedByLoc || (r.createdFrom && r.createdFrom.source) || null;
  const at = tMs(r.refusedAt) ?? tMs(r.resolvedAt);
  if (!LOCATIONS.includes(loc) || !keyOk(r.productId) || at == null) return null;
  return { loc, pid: r.productId, sizeKey: sizeKeyOf(r.size), size: r.size == null ? null : String(r.size), at, kind: "refill_refused", ref: `request ${id}${r.requestingLocation ? ` for ${r.requestingLocation}` : ""}` };
}

const cellQty = (cell) => (cell && typeof cell === "object" ? Number(cell.qty) || 0 : Number(cell) || 0);
const cellStamp = (cell) => (cell && typeof cell === "object" ? tMs(cell.updatedAt) : null);

/**
 * Should this rejection hold the shelf? PURE.
 *   existing  the hold already on the shelf (any kind), or null
 * → { hold } | { skip: "moved_since" | "nothing_there" | "held_already" }
 */
function holdPlan(rej, cell, otw, existing) {
  const stamp = cellStamp(cell);
  if (stamp != null && stamp > rej.at) return { skip: "moved_since" };
  const qty = cellQty(cell);
  if (qty - Math.max(0, Number(otw) || 0) <= 0) return { skip: "nothing_there" };
  // A hold that still stands keeps its own (earlier) time and source: the earliest "no" is the one the shelf answers to.
  if (existing && tMs(existing.at) != null && (stamp == null || stamp <= Number(existing.at))) return { skip: "held_already" };
  return { hold: { at: rej.at, kind: rej.kind, orderId: String(rej.ref || ""), line: 0, qty, src: "store" } };
}

const read = async (db, path) => (await db.ref(path).once("value")).val();

/**
 * Hold one rejected shelf (the IO around holdPlan). → { held: true } | { held: false, why }
 *   markDirty(pid)  optional: the website sync is told the product changed
 */
async function holdRejection(db, rej, { nowMs = Date.now(), markDirty = null } = {}) {
  if (!rej || !keyOk(rej.loc) || !keyOk(rej.pid) || !keyOk(rej.sizeKey) || !STORE_HOLD_KINDS.includes(rej.kind) || tMs(rej.at) == null) return { held: false, why: "bad_request" };
  // These holds wait for a shelf check. With the routine off
  // (/config/onlineOrders/shelfChecks/off, Junid 26 Nov 2026) nothing would
  // ever check them, so none is written.
  if ((await read(db, "config/onlineOrders/shelfChecks/off")) === true) return { held: false, why: "shelf_checks_off" };
  const cell = await read(db, `stock/${rej.loc}/${rej.pid}/${rej.sizeKey}`);
  const otw = (await readOnTheWay(db, { loc: rej.loc, pid: rej.pid, sizeKey: rej.sizeKey, cell, nowMs })).qty;
  const path = `${CELL_HOLDS_PATH}/${rej.pid}/${rej.sizeKey}/${rej.loc}`;
  const plan = holdPlan(rej, cell, otw, await read(db, path));
  if (plan.skip) return { held: false, why: plan.skip };
  const res = await db.ref(path).transaction((cur) => {
    // Re-judged on the committed value: a hold written in between by a website rejection is kept.
    const again = holdPlan(rej, cell, otw, cur);
    return again.hold ? again.hold : undefined;
  });
  if (!res.committed) return { held: false, why: "held_already" };
  if (markDirty) { try { await markDirty(rej.pid); } catch { /* the nightly sweep corrects the listing */ } }
  return { held: true };
}

/**
 * The tick's step: every new rejection since the cursors.
 *   readInsights(startKey) → { [pushKey]: row }   push keys from startKey (inclusive)
 *   readRequests(fromIso)  → { [id]: row }        requests resolved from fromIso
 * → { insights, requests, held, skipped }
 */
async function scanRejections(db, { nowMs, readInsights, readRequests, markDirty = null, log = () => {} }) {
  const cur = (await read(db, CURSOR_PATH)) || {};
  // Push keys are minted from the DEVICE's clock: a phone a little behind writes a key just under the cursor, so each
  // read starts half an hour before the last key seen (a shelf already held is simply skipped).
  const lastSeen = typeof cur.insightsKey === "string" && cur.insightsKey ? pushKeyTime(cur.insightsKey) : null;
  const startKey = pushKeyAt(lastSeen != null ? lastSeen - OVERLAP_MS : nowMs - FIRST_RUN_LOOKBACK_MS);
  const reqFrom = tMs(cur.requestsAt) != null ? new Date(tMs(cur.requestsAt) - OVERLAP_MS).toISOString() : new Date(nowMs - FIRST_RUN_LOOKBACK_MS).toISOString();
  const [insights, requests] = await Promise.all([readInsights(startKey), readRequests(reqFrom)]);
  const rejections = [];
  let lastKey = typeof cur.insightsKey === "string" && cur.insightsKey > startKey ? cur.insightsKey : startKey;
  for (const [k, r] of Object.entries(insights || {})) {
    // A key minted by a phone whose clock runs ahead must not carry the cursor past rows still to come.
    const kt = pushKeyTime(k);
    if (k > lastKey && kt != null && kt <= nowMs + 5 * 60e3) lastKey = k;
    const x = fromInsight(k, r); if (x) rejections.push(x);
  }
  let lastReq = tMs(cur.requestsAt) || nowMs - FIRST_RUN_LOOKBACK_MS;
  for (const [id, r] of Object.entries(requests || {})) {
    const t = tMs(r && r.resolvedAt); if (t != null && t > lastReq && t <= nowMs + 5 * 60e3) lastReq = t;
    const x = fromRequest(id, r); if (x) rejections.push(x);
  }
  // One shelf answered several times in the window: oldest first, until one holds it (an earlier "no" the shelf has
  // moved past since must not hide a later one).
  const byShelf = new Map();
  for (const x of rejections.sort((a, b) => a.at - b.at)) { const k = `${x.loc}|${x.pid}|${x.sizeKey}`; if (!byShelf.has(k)) byShelf.set(k, []); byShelf.get(k).push(x); }
  const out = { insights: Object.keys(insights || {}).length, requests: Object.keys(requests || {}).length, rejections: rejections.length, held: 0, skipped: {} };
  for (const list of byShelf.values()) {
    let why = null;
    for (const x of list) {
      const r = await holdRejection(db, x, { nowMs, markDirty });
      if (r.held) { out.held += 1; why = null; log(`held off the website until checked: ${x.pid} size ${x.sizeKey} at ${x.loc} (${x.kind}, ${x.ref})`); break; }
      why = r.why;
      if (r.why !== "moved_since") break;
    }
    if (why) out.skipped[why] = (out.skipped[why] || 0) + 1;
  }
  await db.ref(CURSOR_PATH).set({ insightsKey: lastKey, requestsAt: new Date(lastReq).toISOString(), ranAt: nowMs });
  return out;
}

// ── push keys: the first 8 characters are the creation time in ms, base-64 (the SDK's own alphabet) ──
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
function pushKeyAt(ms) {
  let t = Math.floor(Number(ms)); let s = "";
  for (let i = 0; i < 8; i += 1) { s = PUSH_CHARS.charAt(t % 64) + s; t = Math.floor(t / 64); }
  return s;
}

function pushKeyTime(key) {
  if (typeof key !== "string" || key.length < 8) return null;
  let t = 0;
  for (let i = 0; i < 8; i += 1) { const v = PUSH_CHARS.indexOf(key.charAt(i)); if (v < 0) return null; t = t * 64 + v; }
  return t;
}

module.exports = {
  CELL_HOLDS_PATH, REQUESTS_PATH, INSIGHTS_PATH, CURSOR_PATH, STORE_HOLD_KINDS, LOCATIONS,
  isStoreHold, fromInsight, fromRequest, holdPlan, holdRejection, scanRejections, pushKeyAt, pushKeyTime,
};
