// ─── INSIGHTS COUNT HELPERS (pure, shared) ───────────────────────────────────
// Pure helpers behind the Insights tabs, extracted from App.jsx so they have a
// single definition AND are unit-testable without importing the firebase-bound
// monolith. Behaviour is identical to the former in-App copies.
//
// The OOS count specifically had TWO callers (the Overview "Out of Stock" card
// and the OOS Tracker tab) that each re-implemented the same pipeline. They now
// share `oosEventsForPeriod` so they can never diverge.

// SA-timezone (UTC+2) date slice "YYYY-MM-DD" of an ISO timestamp.
const saDateOf = (iso) => {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

// Composite keys: (SA-date, orderNumber) — orderNumber is only daily-unique
// (the daily counter wraps), so the date prefix keeps yesterday's "001" distinct
// from today's "001".
const eventCompositeKey  = (e) => `${saDateOf(e.timestamp)}::${e.orderNumber}`;
const returnCompositeKey = (r) => `${r.date || saDateOf(r.timestamp)}::${r.orderNumber}`;

// Classify an insights_log entry / order as sneaker | clothing. Prefers explicit
// productType; falls back to a size-letter heuristic for legacy entries (numeric
// 3..11 vs letters S..XXXL don't overlap).
export function inferProductType(entry) {
  if (entry && entry.productType) return entry.productType;
  const sz = entry && entry.size;
  if (sz && /^(S|M|L|XL|XXL|XXXL)$/i.test(sz)) return "clothing";
  return "sneaker";
}

// Collapse events sharing a (SA-date, orderNumber) to the EARLIEST one — an order
// that flapped through a status more than once still counts once.
export function dedupeByOrderNumber(events) {
  const earliest = new Map();
  for (const e of events) {
    if (!e || e.orderNumber == null) continue;
    const key = eventCompositeKey(e);
    const ex = earliest.get(key);
    if (!ex || (e.timestamp || "") < (ex.timestamp || "")) {
      earliest.set(key, e);
    }
  }
  return Array.from(earliest.values());
}

// Set of (SA-date, orderNumber) composite keys for returns within the window
// (optionally category-filtered) — used to drop events whose order was returned.
export function returnedOrderNumberSet(returnsLog, filterStart, filterEnd, catMatch) {
  const s = new Set();
  for (const r of (returnsLog || [])) {
    if (!r || !r.orderNumber) continue;
    const ts = r.timestamp || "";
    if (ts < filterStart || ts >= filterEnd) continue;
    if (catMatch && !catMatch(r)) continue;
    s.add(returnCompositeKey(r));
  }
  return s;
}

export function excludeReturnedOrderNumbers(events, returnsSet) {
  if (!returnsSet || returnsSet.size === 0) return events;
  return events.filter(e => !returnsSet.has(eventCompositeKey(e)));
}

// SINGLE source of truth for "insights_log events of one `action` in a period":
// reads the immutable log within [filterStart, filterEnd), category-filtered,
// deduped by (date, orderNumber), with returned orders excluded. Callers take
// `.length` for a headline count. Reading the log for EVERY period (incl. today)
// is the point — a former live-orders/current-status "today" path drifted from
// the historical days.
function eventsForPeriod(action, { log, returnsLog, filterStart, filterEnd, category = "both" }) {
  const catMatch = (e) => category === "both" || inferProductType(e) === category;
  const raw = (log || []).filter(
    (e) => e.action === action && e.timestamp >= filterStart && e.timestamp < filterEnd && catMatch(e)
  );
  const returnedNums = returnedOrderNumberSet(returnsLog, filterStart, filterEnd, catMatch);
  return excludeReturnedOrderNumbers(dedupeByOrderNumber(raw), returnedNums);
}

// OOS events — shared by the Overview "Out of Stock" card and the OOS Tracker tab.
// Fixes the today UNDERCOUNT: the old live-orders path filtered status===
// OUT_OF_STOCK, which the 8-min auto-collect sweep drained (OOS→collected), so
// ~60 events showed as ~1 then 0. The log keeps every transition.
export function oosEventsForPeriod(args) {
  return eventsForPeriod("out_of_stock", args);
}

// "Ready" (net-sale) events — shared by the Overview Net Sales card and the Sales
// Summary tab. Fixes the today OVERCOUNT: the old live-orders path counted
// status===READY||COLLECTED, so an auto-collected OOS order (OUT_OF_STOCK→
// COLLECTED) was miscounted as a sale, inflating today vs the historical days.
// "ready" is only ever logged on a genuine ready transition, never for OOS.
export function readyEventsForPeriod(args) {
  return eventsForPeriod("ready", args);
}

// Clothing-REFILL demand events for a period (excludes Hub C customer clothing).
// Each event: { orderNumber, productName, size, qty, timestamp }.
//   • TODAY: from live /orders (real-time, qty present), bucketed by createdAt.
//   • PAST: from insights_log action==="placed" clothing events (deduped by
//     orderNumber). These carry `qty` going forward; legacy events predate the
//     field, so qty falls back to 1 (a slight historical under-count of units
//     that ages out). Past MUST use the log because /orders rolls over daily and
//     would otherwise undercount closed windows.
// ─── SOURCE DURABLE-LOG RECONSTRUCTION (past-day restock + on-hold) ──────────
// The Source screen used to read live /orders for its History and On Hold tabs.
// But /orders/{id} is keyed by the DAILY orderNumber (001–999, resets each
// morning), so today's orders overwrite the same slots yesterday/Thursday used
// — past-day and on-hold requests silently vanished. These helpers rebuild
// those views from the immutable insights_log instead (same "today=live,
// past=log" pattern the Insights OOS Tracker / Stock Depleted tabs already use).

// RTDB-illegal chars → "_". Identical to App.jsx's toKey so the (productKey,size)
// cells line up with restock_requests responses written by the live path.
const sanitizeKey = (s) => (s || "").replace(/[.#$[\]/\s]/g, "_");

// Restock requests that hit READY on a given SA date, for one hub, grouped into
// the { key: { productName, sizes:{size:count} } } shape SourceTodayTab renders.
// "ready" is the durable, Net-Sales-consistent signal (see readyEventsForPeriod):
// every warehouse READY transition logs one, deduped by (date, orderNumber) so a
// flipped order counts once. Photos aren't in the log — the component joins them
// from the products catalog by name. returnedIds = orderNumbers returned on that
// SA date (mirrors the live path's returned-order exclusion).
//
// SNEAKERS ONLY. Clothing-refill ("Shop Refill") fulfilment ALSO logs
// action="ready" (productType "clothing", placedAtHub hub2/hub3) but resolves via
// clothingRefillStatus and leaves the order's `status` at INCOMING — so the old
// live path (status===READY||COLLECTED) never showed it in the footwear History.
// Filtering to sneaker reproduces that exactly and keeps clothing refills out of
// hub2's restock list (clothing has its own "Clothing Sold" tab).
export function restockCountsFromLog({ log, dateStr, hub, returnedIds }) {
  const raw = (log || []).filter(
    (e) => e && e.action === "ready" && inferProductType(e) === "sneaker" &&
           saDateOf(e.timestamp) === dateStr && (e.placedAtHub || "hub1") === hub
  );
  const result = {};
  for (const e of dedupeByOrderNumber(raw)) {
    if (returnedIds && returnedIds.has(e.orderNumber)) continue;
    const size = e.size;
    if (!size) continue;
    const name = e.productName || "Unknown";
    const key = sanitizeKey(name);
    if (!result[key]) result[key] = { productName: name, productId: e.productId ?? null, sizes: {} };
    // productId powers the Source "Transfer & Fulfil" flow. Older log events
    // predate the field, so take the first one any event in the group carries;
    // cards without one fall back to name-resolution, then to the plain buttons.
    if (!result[key].productId && e.productId) result[key].productId = e.productId;
    result[key].sizes[size] = (result[key].sizes[size] || 0) + 1;
  }
  return result;
}

// On-hold ("coming tomorrow") requests logged on any of the given SA dates,
// deduped by (date, orderNumber). Returns a flat list the On Hold tab renders.
// `dates` is the retention window (array or Set of "YYYY-MM-DD").
export function onHoldEventsFromLog({ log, dates }) {
  const dateSet = dates instanceof Set ? dates : new Set(dates || []);
  const raw = (log || []).filter(
    (e) => e && e.action === "tomorrow" && dateSet.has(saDateOf(e.timestamp))
  );
  return dedupeByOrderNumber(raw).map((e) => ({
    orderNumber: e.orderNumber,
    productName: e.productName || "Unknown",
    productId: e.productId ?? null,
    size: e.size ?? null,
    hub: e.placedAtHub || "hub1",
    customerName: e.customerName ?? null,
    timestamp: e.timestamp,
    saDate: saDateOf(e.timestamp),
  }));
}

// Composite on-hold "handled" key — date::orderNumber. orderNumber alone is
// daily-reused, so a bare key let yesterday's handled #001 mask today's #001.
export function onHoldKey(saDate, orderNumber) {
  return sanitizeKey(`${saDate}::${String(orderNumber)}`);
}

export function clothingRefillEventsForPeriod({ isToday, orders, log, filterStart, filterEnd }) {
  if (isToday) {
    return (orders || [])
      .filter(o => o.productType === "clothing" && o.placedAtHub !== "hubC"
                && o.createdAt && o.createdAt >= filterStart && o.createdAt < filterEnd)
      .map(o => ({ orderNumber: o.id, productName: o.productName || "Unknown", size: o.size, qty: o.qty || 1, timestamp: o.createdAt }));
  }
  const raw = (log || []).filter(
    e => e.action === "placed" && inferProductType(e) === "clothing" && e.placedAtHub !== "hubC"
      && e.timestamp >= filterStart && e.timestamp < filterEnd
  );
  return dedupeByOrderNumber(raw).map(
    e => ({ orderNumber: e.orderNumber, productName: e.productName || "Unknown", size: e.size, qty: e.qty || 1, timestamp: e.timestamp })
  );
}
