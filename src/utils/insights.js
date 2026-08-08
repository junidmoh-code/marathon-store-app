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

// RTDB-illegal chars → "_". Exported as the LEGACY name key: response cells and
// movement ids written before the pid-key cutover used it, and the dual-read
// paths still need to derive it. New cells never use it when a productId exists.
// String()-coerced for the same reason as normalizeName: the log feeds carry no
// schema, and a non-string productName would throw inside the group builders'
// useMemo and take the whole Source view down instead of one card.
export const sourceNameKey = (s) => String(s ?? "").replace(/[.#$[\]/\s]/g, "_");
const sanitizeKey = sourceNameKey;

// ── THE Source group key — productId first, sanitized name only as fallback ──
// Duplicate product names are real (three byte-identical "Nike SB Dunk Low
// Green White" records as of 2026-08-03), so keying by name merged twins into
// one card, one shared restock_requests response cell and one colliding
// movement id — the wrong-product deduction bug. The pid is unique; the name
// key survives ONLY for legacy records that predate the productId field.
// EVERY Source group builder (computeRestockCounts for Today,
// restockCountsFromLog for History) MUST use this one function — the two feeds
// meet at the same restock_requests/{date}/{key}/{size} response paths, so a
// key divergence between them desynchronizes Today and History.
// The "Unknown" tail is load-bearing, not defensive dressing: a row with no
// productId AND no usable name would otherwise sanitize to "", and an empty key
// makes sourceResponsePath collapse to the DATE NODE — writing a size leaf
// directly under restock_requests/{date} and corrupting that day's response
// tree. restockCountsFromLog already defaulted its name to "Unknown"; this puts
// the guarantee in the shared key builder so both feeds inherit it.
export function sourceGroupKey(productId, productName) {
  return productId || sanitizeKey(productName) || "Unknown";
}

// The one place the Source response/progress cell path is shaped. Two products
// with the same name now yield two DIFFERENT paths (distinct group keys), so a
// response to one can no longer close the other's card.
// The DATE node is exported separately because during the cutover a cell can
// live under two keys (its pid key and its legacy name key), and clearing both
// must be ONE multi-path update rooted at their common parent — see
// clearSourceResponse in App.jsx.
export function sourceResponseDatePath(date) {
  return `restock_requests/${date}`;
}
export function sourceResponsePath(date, productKey) {
  return `${sourceResponseDatePath(date)}/${productKey}`;
}

// Shared duplicate-name tripwire for the group builders. The old collision
// warning compared NAMES and so could never fire for byte-identical twins —
// exactly the case that bit in July (three products all named "Nike SB Dunk
// Low Green White"). This one compares product IDS behind the same name: seen
// (Map name→pid) accumulates per build. Default handler console.warns once per
// distinct collision per session; tests inject their own via onNameCollision.
const _warnedNameCollisions = new Set();
function noteNameCollision(seen, name, productId, onCollision) {
  if (!name || !productId) return;
  const prev = seen.get(name);
  if (prev == null) { seen.set(name, productId); return; }
  if (prev === productId) return;
  const msg = `[Source] Duplicate product name "${name}": ids ${prev} and ${productId}. ` +
    "Cards are kept separate by id, but rename one product — name-based analytics still merge them.";
  if (onCollision) { onCollision(msg); return; }
  const dedupe = `${name}::${prev}::${productId}`;
  if (_warnedNameCollisions.has(dedupe)) return;
  _warnedNameCollisions.add(dedupe);
  console.warn(msg);
}

// Today's-sales group builder (moved from App.jsx so it sits next to
// restockCountsFromLog — the two MUST share sourceGroupKey, see above).
// entries = restock_log/{SA-date} rows the POS writes on every collected order:
// { productId, productName, photo, photoUrl, size, hub, orderNumber, ... }.
// Shape out: { key: { productName, productId, nameKey, photo, photoUrl, sizes } }.
// nameKey rides along so consumers can dual-read response/progress cells and
// movement ids written under the pre-cutover name key.
export function computeRestockCounts(entries, { onNameCollision } = {}) {
  const result = {};
  const seenNames = new Map();
  (entries || []).forEach(entry => {
    if (!entry) return;
    // Default the name once, then derive BOTH keys from it — mirroring
    // restockCountsFromLog. A bare `entry.productName` would leave the group
    // title undefined (SourceTodayTab sorts with .productName.localeCompare and
    // would throw) and give nameKey "", which then reads as a bogus legacy key.
    const name = entry.productName || "Unknown";
    noteNameCollision(seenNames, name, entry.productId, onNameCollision);
    const key = sourceGroupKey(entry.productId, name);
    if (!result[key]) result[key] = {
      productName: name,
      // `??` not `||`, matching restockCountsFromLog below: the two builders are
      // required to produce identical group shapes for the same record, and a
      // silent divergence here is the drift their lock-step comment warns about.
      productId: entry.productId ?? null,
      nameKey: sanitizeKey(name),
      photo: entry.photo || "",
      photoUrl: entry.photoUrl || null,
      sizes: {},
    };
    // Back-fill both image fields: ProductPhoto renders either, so a group
    // whose first row carried neither must still pick up a later row's.
    if (entry.photoUrl && !result[key].photoUrl) result[key].photoUrl = entry.photoUrl;
    if (entry.photo && !result[key].photo) result[key].photo = entry.photo;
    if (entry.size) result[key].sizes[entry.size] = (result[key].sizes[entry.size] || 0) + 1;
  });
  return result;
}

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
export function restockCountsFromLog({ log, dateStr, hub, returnedIds, onNameCollision }) {
  const raw = (log || []).filter(
    (e) => e && e.action === "ready" && inferProductType(e) === "sneaker" &&
           saDateOf(e.timestamp) === dateStr && (e.placedAtHub || "hub1") === hub
  );
  const result = {};
  const seenNames = new Map();
  for (const e of dedupeByOrderNumber(raw)) {
    if (returnedIds && returnedIds.has(e.orderNumber)) continue;
    const size = e.size;
    if (!size) continue;
    const name = e.productName || "Unknown";
    noteNameCollision(seenNames, name, e.productId, onNameCollision);
    // productId is the group key (sourceGroupKey) — identically-named twins get
    // separate cards. A pid-less legacy event groups under the sanitized name
    // and its productId stays null ON PURPOSE: the old "adopt the first pid any
    // same-named event carries" backfill is exactly how a twin's id got bound
    // to the wrong card. Pid-less cards resolve via the (ambiguity-refusing)
    // name fallback, else keep the plain buttons.
    const key = sourceGroupKey(e.productId, name);
    if (!result[key]) result[key] = { productName: name, productId: e.productId ?? null, nameKey: sanitizeKey(name), sizes: {} };
    result[key].sizes[size] = (result[key].sizes[size] || 0) + 1;
  }
  return result;
}

// (onHoldEventsFromLog / onHoldKey removed 2026-08-08: the On Hold surface they
// rebuilt is abolished — holds are ordinary /refill_requests rows now.)

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
