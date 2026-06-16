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
