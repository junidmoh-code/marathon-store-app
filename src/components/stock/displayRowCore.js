// ─── DISPLAY ROWS — a display is a ROW with a life, not a cell that gets overwritten ──
//
// (Owner ask, 2026-09-08. The structural gap the display work kept running
// into, stated plainly and then closed.)
//
// ── WHY A NEW LEDGER, WHEN TWO RECORDS ALREADY EXIST ─────────────────────────
// The display work has two stores and NEITHER can answer "what is on this
// shop's wall, and what was there before":
//
//   /settings/hubSneakerCount/register/{hub}/{pid}__{sizeKey}
//       Multiple rows per product, qty 0 + retiredAt as a tombstone, never
//       deleted — a real ledger. But it is HUB-scoped and carries NO store
//       field at all (verified field by field across all 558 live rows,
//       docs/DISPLAY-WORK-HANDOFF.md §3d). It structurally cannot say whose
//       wall a pair is on.
//
//   /settings/displaySlots/{store}/{productId}
//       Store-scoped and trusted by the count — but it is ONE RECORD PER
//       PRODUCT PER STORE. A second send OVERWRITES the first. So when a wall
//       physically holds two pairs of the same shoe, the record holds one, and
//       "more than one display registered for this product at this store" is
//       not merely absent from the data, it is UNREPRESENTABLE. Measured live
//       2026-09-08: 479 live slots, 0 store+product pairs with more than one —
//       and it could never have been any other number.
//
// So the duplicate the operator is looking at on the wall has never had a
// place to live. This node gives it one.
//
// ── SHAPE ────────────────────────────────────────────────────────────────────
//   /settings/displayRows/{store}/{productId}/{rowId} = {
//     rowId, store, productId, productName,
//     size, sizeKey, bookedHub,
//     status: "open" | "closed",
//     openedAt, openedBy, openedVia,   // send | wall_walk | seed | registration
//     requestOrderId,                  // the display-partner order that drove it
//     closedAt, closedBy, closedReason, closedVia, closedRef,
//     events: { eventId: { at, what, by, detail } },
//   }
//
// MANY rows may exist per (store, product) — that is the entire point. At most
// one SHOULD be open; when more than one is, the Duplicate Displays tab shows
// them and a human keeps the one that is really on the wall.
//
// A CLOSED ROW IS NEVER DELETED. `closedReason` is one of replaced / sold /
// returned / corrected / cancelled, and the row keeps its whole `events`
// timeline. This is the same rule the register learned the hard way in PR #460
// — a deleted row takes its history with it.
//
// Under /settings because that is the one subtree the live rules let a
// signed-in app user write without a rules change (same reasoning as
// displaySlots.js and hubSneakerCount). The hardening rule to paste later is
// printed in docs/DISPLAY-ROWS.md; nothing here depends on it.
//
// ── RELATIONSHIP TO THE SLOT: MIRROR, NOT REPLACEMENT ────────────────────────
// /settings/displaySlots stays exactly as it is and keeps every reader it has
// (offShelf's expected-on-shelf, the shop marker, the count card,
// displayPairCore's replay). Opening a row also writes the slot; closing the
// LAST open row also clears it. The rows are the history and the duplicate
// evidence; the slot remains "current state" for everything already built on
// it. Replacing the slot instead of mirroring it would have meant re-proving
// four merged PRs' worth of behaviour, for no gain the operator can see.
//
// PURE — no firebase, no react. Every writer below is a PLAN BUILDER: it
// returns the multi-path update object, and displayRowStore.js is the only
// thing that hands one to RTDB. That is what makes "ONE atomic write" a
// testable claim rather than a promise in a comment.

import { stockSizeKey } from "../../utils/sizeKey";

export const DISPLAY_ROWS_ROOT = "settings/displayRows";
/** Where the sale-close function parks its idempotency leases. */
export const DISPLAY_ROWS_META_ROOT = "settings/displayRows_meta";

/** Every way a row can end. `replaced` is the ordinary one — a new pair went out. */
export const CLOSE_REASONS = ["replaced", "sold", "returned", "corrected", "cancelled"];

export const CLOSE_REASON_TEXT = {
  replaced: "Replaced by a new pair",
  sold:     "Sold at the till",
  returned: "Returned to the hub",
  corrected:"Corrected — this size was not on the wall",
  cancelled:"Cancelled",
};

/** How a row came to be open. */
export const OPEN_VIA_TEXT = {
  send:         "Sent from the warehouse",
  wall_walk:    "Registered on a wall walk",
  registration: "Registered on the display card",
  seed:         "Carried over from the display slot",
};

const seg = (s) => String(s ?? "").replace(/[.#$/[\]\s]/g, "_");

export const rowPath = (store, productId, rowId) =>
  `${DISPLAY_ROWS_ROOT}/${seg(store)}/${seg(productId)}/${seg(rowId)}`;

export const storeRowsPath = (store) => `${DISPLAY_ROWS_ROOT}/${seg(store)}`;

/** A row is OPEN when it says so. Anything else — closed, malformed, missing —
 *  is not a display anyone should be told about. Read positively, so a field
 *  this module has never seen cannot accidentally count as open. */
export function rowIsOpen(row) {
  return !!row && row.status === "open" && typeof row.sizeKey === "string"
    && row.sizeKey.length > 0 && row.sizeKey !== "_";
}

/** Flatten the ledger → [row] with store/productId/rowId guaranteed present,
 *  whatever the stored record was missing. */
export function allRows(rows) {
  const out = [];
  for (const [store, byPid] of Object.entries(rows || {})) {
    for (const [productId, byRow] of Object.entries(byPid || {})) {
      for (const [rowId, row] of Object.entries(byRow || {})) {
        if (!row || typeof row !== "object") continue;
        out.push({ ...row, store, productId, rowId });
      }
    }
  }
  return out;
}

/** The open rows for one (store, product), oldest first — a stable order, so
 *  "close all but the one you keep" is the same list on every device.
 *
 *  THE LOOKUP IS SANITISED, and it has to be: rowPath() runs store and product
 *  id through `seg()` before writing, so a caller who passes a raw id
 *  containing an RTDB-illegal character would WRITE to the sanitised key and
 *  READ from the raw one. The send would then find no open row to close, open a
 *  second beside it, and manufacture the exact duplicate this ledger exists to
 *  surface. Every id in play today is already segment-safe, which is precisely
 *  why the mismatch would sit there unnoticed until one was not. */
export function openRowsFor(rows, store, productId) {
  const byRow = ((rows || {})[seg(store)] || {})[seg(productId)] || {};
  return Object.entries(byRow)
    .map(([rowId, row]) => ({ ...row, store: seg(store), productId: seg(productId), rowId }))
    .filter(rowIsOpen)
    .sort((a, b) => String(a.openedAt || "").localeCompare(String(b.openedAt || "")) || a.rowId.localeCompare(b.rowId));
}

/** Every open row, keyed `${store}::${productId}`. */
export function openRowIndex(rows) {
  const m = new Map();
  for (const r of allRows(rows)) {
    if (!rowIsOpen(r)) continue;
    const k = `${r.store}::${r.productId}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  for (const list of m.values()) {
    list.sort((a, b) => String(a.openedAt || "").localeCompare(String(b.openedAt || "")) || a.rowId.localeCompare(b.rowId));
  }
  return m;
}

/**
 * CLAUSE 4 — every product holding MORE THAN ONE open row at a store.
 *
 * @param rows          the ledger
 * @param productsById  Map or object pid → product (for the name and the photo)
 * @param hubs          only rows booked at these hubs are considered. Hub 1 and
 *                      Hub 2 only, per GATED_SNEAKER_HUBS — a Pine display is
 *                      booked at hub3 and this screen has no business offering
 *                      an action on it. Rows with NO bookedHub are kept: a row
 *                      that cannot name its hub is exactly the kind a human
 *                      should look at, and hiding it would hide a duplicate.
 * → [{ store, productId, product, productName, photo, rows: [row] }]
 */
export function duplicateDisplayGroups({ rows, productsById, hubs = ["hub1", "hub2"] }) {
  const get = (pid) =>
    productsById && typeof productsById.get === "function" ? productsById.get(pid) : (productsById || {})[pid];
  const out = [];
  for (const [key, list] of openRowIndex(rows)) {
    const inScope = list.filter((r) => !r.bookedHub || hubs.includes(r.bookedHub));
    if (inScope.length < 2) continue;
    const [store, productId] = [key.slice(0, key.indexOf("::")), key.slice(key.indexOf("::") + 2)];
    const product = get(productId) || null;
    out.push({
      store, productId, product,
      productName: product?.name || inScope[0].productName || "(name not on file)",
      rows: inScope,
    });
  }
  // Most rows first — the worst wall is the one to walk to.
  out.sort((a, b) => b.rows.length - a.rows.length
    || String(a.productName).localeCompare(String(b.productName)));
  return out;
}

/** How many duplicate ROWS exist — the surplus, not the group count. Two groups
 *  of three open rows are four rows too many, not two. */
export function duplicateRowCount(groups) {
  return (groups || []).reduce((t, g) => t + Math.max(0, g.rows.length - 1), 0);
}

/**
 * CLAUSE 5 — products holding stock at the serving hub with NO open row for
 * this store. The wall-walk worklist.
 *
 * @param cells        /stock/{hub} → { pid: { sizeKey: { qty } } } — the hub's
 *                     own cells, which the Stock section already streams.
 * @param rows         the ledger
 * @param store        whose wall we are walking
 * @param hub          which hub serves it
 * @param productsById catalogue
 * @param isFootwear   predicate; a wall holds shoes, and offering a t-shirt on
 *                     a sneaker wall walk is how a worklist gets ignored.
 *
 * → [{ productId, product, productName, brand, hubUnits, sizes }]
 *
 * WHAT THIS CANNOT SEE, and the empty state says so out loud: a product with
 * no stock left at the hub. A display standing on a wall whose hub cell has
 * gone to zero is REAL and is not in this list — the list is built from hub
 * stock because that is the only complete catalogue of what could be on that
 * wall, and a sold-out line is not a candidate for a NEW display.
 */
export function unregisteredDisplayCandidates({ cells, rows, store, hub, productsById, isFootwear = () => true }) {
  const get = (pid) =>
    productsById && typeof productsById.get === "function" ? productsById.get(pid) : (productsById || {})[pid];
  const openIdx = openRowIndex(rows);
  const out = [];
  for (const [productId, bySize] of Object.entries(cells || {})) {
    if (openIdx.has(`${store}::${productId}`)) continue;      // already on the wall, on the record
    const product = get(productId) || null;
    if (!isFootwear(product)) continue;
    let units = 0;
    const sizes = [];
    for (const [sizeKey, cell] of Object.entries(bySize || {})) {
      const qty = Number(cell && typeof cell === "object" ? cell.qty : cell) || 0;
      if (qty <= 0) continue;
      units += qty;
      sizes.push({ sizeKey, size: cell?.size ?? null, qty });
    }
    if (units <= 0) continue;
    sizes.sort((a, b) => a.sizeKey.localeCompare(b.sizeKey, undefined, { numeric: true }));
    out.push({
      productId, product, hub, store,
      productName: product?.name || "(name not on file)",
      brand: product?.brand || "",
      hubUnits: units,
      sizes,
    });
  }
  out.sort((a, b) => String(a.productName).localeCompare(String(b.productName)));
  return out;
}

/** Free-text + brand filter for the wall-walk list. Pure so the tab's paging
 *  and the tests agree on what "page 2" means. */
export function filterCandidates(list, { q = "", brand = "" } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  const b = String(brand || "").trim().toLowerCase();
  return (list || []).filter((c) => {
    if (b && String(c.brand || "").toLowerCase() !== b) return false;
    if (!needle) return true;
    return String(c.productName || "").toLowerCase().includes(needle)
      || String(c.productId || "").toLowerCase().includes(needle)
      || String(c.brand || "").toLowerCase().includes(needle);
  });
}

/** The brands present in a candidate list, for the filter chips. */
export function brandsOf(list) {
  return [...new Set((list || []).map((c) => c.brand).filter(Boolean))].sort();
}

// ─── CLAUSE 6 — THE TIMELINE ────────────────────────────────────────────────
// Every row carries its own events, so the history reads the row and nothing
// else. No cross-node join, no /orders walk (which would be worthless anyway:
// /orders ids are recycled daily, so an order id is not a durable handle).

/**
 * One row → readable lines, oldest first.
 * → [{ at, what, text, by }]
 */
export function rowTimeline(row) {
  if (!row) return [];
  const evs = Object.entries(row.events || {})
    .map(([id, e]) => ({ id, ...e }))
    .filter((e) => e && e.at);
  evs.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  return evs.map((e) => ({
    at: e.at,
    what: e.what,
    by: e.by || null,
    text: timelineText(e, row),
  }));
}

function timelineText(e, row) {
  const size = e.detail?.size ?? row.size;
  switch (e.what) {
    case "requested":
      return `Display requested${e.detail?.orderId ? ` — order #${e.detail.orderId}` : ""}`;
    case "sent":
      return `Sent and put on the wall — size ${size ?? "?"}${e.detail?.orderId ? ` (order #${e.detail.orderId})` : ""}`;
    case "registered":
      return `Registered on the wall — size ${size ?? "?"}`;
    case "seeded":
      return `Carried over from the display slot — size ${size ?? "?"}`;
    case "closed":
      return `Closed — ${CLOSE_REASON_TEXT[e.detail?.reason] || e.detail?.reason || "no reason recorded"}`;
    default:
      return e.what ? String(e.what) : "—";
  }
}

// ─── PLAN BUILDERS — the writes, as data ────────────────────────────────────
//
// Each returns a flat { path: value } object for ONE RTDB multi-path update.
// RTDB applies a multi-path update atomically, so "close the old row, open the
// new one, clear the request" is one write that either all happens or none of
// it does. Building them here rather than inside the firebase wrapper is what
// lets a test assert the atomicity instead of trusting a comment.
//
// NOTE ON EVENT IDS: they are DERIVED, never pushed. A replayed send (a retried
// tap, a re-delivered trigger) rewrites the same event key with the same value
// instead of appending a second copy of the same fact to the timeline.

const evId = (what, stamp) => `${what}_${String(stamp).replace(/[.#$/[\]\s:]/g, "-")}`;

/**
 * CLAUSE 2 — the SEND. One update:
 *   • every currently-open row for this (store, product) is CLOSED, reason
 *     `replaced`, with the instant and the actor;
 *   • the new row is OPENED at the size THE OPERATOR PICKED;
 *   • the triggering request is cleared, by whatever patch the caller passes.
 *
 * `size` is required and is never defaulted, inferred or suggested anywhere in
 * this module. If the caller has no size, this refuses — see the ABSOLUTE RULE
 * in docs/DISPLAY-ROWS.md. A plan that guessed a size would be a plan that put
 * the wrong pair on the record, and the till would then take the sale off the
 * wrong hub cell.
 *
 * @returns { ok, updates, rowId, closed: [rowId], message }
 */
export function sendPlan({ rows, store, productId, productName = "", size, bookedHub,
                          rowId, at, by = null, orderId = null, orderPatch = null, via = "send" }) {
  const raw = String(size ?? "").trim();
  const sizeKey = stockSizeKey(raw);
  if (!store || !productId) return { ok: false, message: "Store and product are required." };
  if (!raw || sizeKey === "_") return { ok: false, message: "A display row needs the size the operator picked." };
  if (!rowId) return { ok: false, message: "A display row needs an id." };
  if (!at) return { ok: false, message: "A display row needs the instant of the transition." };

  const updates = {};
  const closed = [];
  for (const open of openRowsFor(rows, store, productId)) {
    closed.push(open.rowId);
    Object.assign(updates, closeFields(open, {
      at, by, reason: "replaced", via,
      detail: { reason: "replaced", replacedBy: rowId, orderId },
    }));
  }

  const events = {};
  if (orderId) events[evId("requested", orderId)] = { at, what: "requested", by, detail: { orderId } };
  events[evId("sent", at)] = { at, what: via === "send" ? "sent" : "registered", by, detail: { size: raw, orderId } };

  updates[rowPath(store, productId, rowId)] = {
    rowId, store, productId, productName: productName || "",
    size: raw, sizeKey, bookedHub: bookedHub || null,
    status: "open",
    openedAt: at, openedBy: by, openedVia: via,
    requestOrderId: orderId || null,
    closedAt: null, closedBy: null, closedReason: null, closedVia: null, closedRef: null,
    events,
  };

  if (orderPatch && typeof orderPatch === "object") Object.assign(updates, orderPatch);
  return { ok: true, updates, rowId, closed };
}

/** The fields ONE close writes, as paths under the row. A close never rewrites
 *  the whole row — that would drop a concurrent timeline event and re-mint the
 *  fields a merge might have changed. It writes exactly what it knows. */
function closeFields(row, { at, by, reason, via, detail }) {
  const base = rowPath(row.store, row.productId, row.rowId);
  const e = evId("closed", at);
  return {
    [`${base}/status`]: "closed",
    [`${base}/closedAt`]: at,
    [`${base}/closedBy`]: by || null,
    [`${base}/closedReason`]: reason,
    [`${base}/closedVia`]: via || null,
    [`${base}/closedRef`]: (detail && (detail.movementId || detail.orderId || detail.replacedBy)) || null,
    [`${base}/events/${e}`]: { at, what: "closed", by: by || null, detail: detail || { reason } },
  };
}

/**
 * Close ONE named row. The Duplicate tab's per-size tap, the sale trigger, the
 * return and the cancellation all land here.
 *
 * Closing NEVER moves stock, and the module says so in the only place a reader
 * can act on it: `stockMoved: false` on the result, and the sentence the UI
 * prints comes from `closeEffectLine` below rather than being retyped per site.
 */
export function closeRowPlan({ row, at, by = null, reason, via = "manual", detail = null }) {
  if (!row || !row.rowId) return { ok: false, message: "No row to close." };
  if (!CLOSE_REASONS.includes(reason)) return { ok: false, message: `Unknown close reason "${reason}".` };
  if (!at) return { ok: false, message: "A close needs the instant of the transition." };
  return {
    ok: true,
    stockMoved: false,
    updates: closeFields(row, { at, by, reason, via, detail: detail || { reason } }),
  };
}

/**
 * Open a row with no request behind it — the wall walk's "ON THE WALL", and the
 * seed. Still closes anything already open for that (store, product): a wall
 * walk that finds a pair is a statement about the whole wall, not an addition
 * to it. `keepOpen: true` is how the Duplicate tab's "the real size is not
 * listed" adds a row WITHOUT closing the others, because the operator is about
 * to decide which of them stays.
 */
export function openRowPlan({ rows, store, productId, productName = "", size, bookedHub,
                             rowId, at, by = null, via = "wall_walk", keepOpen = false }) {
  const plan = sendPlan({ rows: keepOpen ? {} : rows, store, productId, productName,
                          size, bookedHub, rowId, at, by, orderId: null, via });
  if (!plan.ok) return plan;
  if (via === "seed") {
    // The seed's one event is a seed, not a send: it records where the row came
    // from and makes no claim that anybody sent anything today.
    const p = rowPath(store, productId, rowId);
    const row = plan.updates[p];
    plan.updates[p] = { ...row, events: { [evId("seeded", at)]: { at, what: "seeded", by, detail: { size: String(size) } } } };
  }
  return plan;
}

/** The one sentence every close surface prints. Clause 4's "say so in the UI",
 *  in one place so three screens cannot drift into three different promises. */
export const closeEffectLine = (row) =>
  `Closes the display record for size ${row?.size ?? "?"}. No stock moves — the pair stays booked exactly where it is; this only corrects what the record says is on the wall.`;

// ─── CLAUSE 1 — AT MOST ONE OPEN REQUEST PER PRODUCT PER STORE ──────────────
//
// A display request is an ORDER carrying `requestDisplayPartner: true`. It is
// OPEN from the moment it is placed until the refill task resolves
// (`displayRefillStatus` set) or the order leaves the lane. The 15-minute timer
// only decides WHEN the task becomes visible in the warehouse tab — it raises
// nothing and it picks nothing.
//
// The store a request belongs to is the store whose wall the pair goes on:
// `displayPairStore` when the order is a cross-store pull, otherwise the
// ordering shop. That is displaySlotStoreFor's rule and it must not be
// re-derived differently here, or the guard would fence a different store than
// the send writes.

/** The store whose wall this request is about. Mirrors displayPairCore's
 *  displaySlotStoreFor; kept as its own tiny function so this module stays
 *  free of the display-pair pull machinery. */
export const requestStoreFor = (order) =>
  (order?.displayPairRequest === true && order?.displayPairStore) || order?.destShop || null;

/** Is this order an OPEN display request? */
export function isOpenDisplayRequest(order) {
  if (!order || order.requestDisplayPartner !== true) return false;
  if (order.displayRefillStatus) return false;          // resolved: refilled / stockDepleted
  if (order.status === "collected" || order.status === "out_of_stock") return false;
  if (order.cancelled === true) return false;
  return true;
}

/** Open requests keyed `${store}::${productId}`. */
export function openRequestIndex(orders) {
  const m = new Map();
  for (const [id, o] of Object.entries(orders || {})) {
    const order = o && typeof o === "object" ? { id, ...o } : null;
    if (!isOpenDisplayRequest(order)) continue;
    const store = requestStoreFor(order);
    if (!store || !order.productId) continue;
    const k = `${store}::${order.productId}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(order);
  }
  return m;
}

/**
 * THE GUARD. Anything that would raise a display request asks this first, and a
 * `true` answer means DO NOT RAISE — the wall already has one coming.
 *
 * It answers from the orders the caller already holds. It deliberately does not
 * read: a guard that needs a round trip is a guard that gets skipped on a slow
 * tab, and the failure it prevents (a second pair walked to a wall that is
 * already getting one) is cheap to get wrong in the safe direction — the
 * operator can always raise it again once the first resolves.
 */
export function hasOpenDisplayRequest(orders, { store, productId }) {
  if (!store || !productId) return false;
  return (openRequestIndex(orders).get(`${store}::${productId}`) || []).length > 0;
}

/** Products holding MORE THAN ONE open request, for the census and the report. */
export function duplicateOpenRequests(orders) {
  const out = [];
  for (const [key, list] of openRequestIndex(orders)) {
    if (list.length < 2) continue;
    out.push({ store: key.slice(0, key.indexOf("::")), productId: key.slice(key.indexOf("::") + 2), orders: list });
  }
  return out;
}
