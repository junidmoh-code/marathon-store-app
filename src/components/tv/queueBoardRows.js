// ─── QUEUE BOARD — rows for the four columns ─────────────────────────────────
// Pure shaping for the TV queue board (TvDisplayMockup). It takes the orders the
// board is handed — ALREADY filtered by TvWithAutoCollect (refill carts dropped,
// the Hub 2 hold applied, the 8-min / 15-min display-only auto-clear applied) —
// and turns them into what each column draws: the newest rows first, the first
// VISIBLE_ROWS of them, and the column's full total. Nothing here reads or writes
// the database; the live path and the ?demo=1 path both end in the same shape.

export const VISIBLE_ROWS = 5;

// Status strings mirror App.jsx STATUS (no import — App.jsx is the monolith).
export const COLUMN_STATUS = {
  incoming: "incoming",
  ready:    "ready",
  oos:      "out_of_stock",
  tomorrow: "coming_tomorrow",
};

// The stamp that says WHEN an order entered the column it is in. updateStatus
// stamps only the new status and never clears the old ones, so the stamp has to
// be chosen by the current status (the same rule the voice freshness check uses).
export function columnStamp(o, columnId) {
  if (!o) return null;
  if (columnId === "ready")    return o.readyAt || o.updatedAt || o.createdAt || null;
  if (columnId === "oos")      return o.outOfStockAt || o.updatedAt || o.createdAt || null;
  if (columnId === "tomorrow") return o.comingTomorrowAt || o.updatedAt || o.createdAt || null;
  return o.createdAt || null;
}

export function stampMs(ts) {
  if (ts == null || ts === "") return NaN;
  if (typeof ts === "number") return ts;
  return new Date(ts).getTime();
}

// Every clock on the board reads South African time whatever timezone the TV
// itself was set up with (a Google TV out of the box is often on UTC).
export const BOARD_TZ = "Africa/Johannesburg";

// "12:43" in SAST.
export function clockText(ts) {
  const ms = stampMs(ts);
  if (!Number.isFinite(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BOARD_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("hour")}:${get("minute")}`;
}

// "TUESDAY 13 OCT 2026" in SAST.
export function dateText(ms) {
  if (!Number.isFinite(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BOARD_TZ, weekday: "long", day: "numeric", month: "short", year: "numeric",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("weekday")} ${get("day")} ${get("month").replace(".", "")} ${get("year")}`.toUpperCase();
}

// "just now" · "4m ago" · "2h ago". A stamp a little in the future (device clock
// skew) reads as "just now", never as a negative age.
export function agoText(ts, nowMs) {
  const ms = stampMs(ts);
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return "";
  const mins = Math.floor((nowMs - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// What the right-hand side of a row says, per column.
//  incoming → the time it was placed ("12:43")
//  ready / oos → how long ago it got there ("2h ago")
//  tomorrow → "Tomorrow". An order on hold for tomorrow carries NO pickup time
//    (comingTomorrowAt is only when staff put it on hold), so the board does not
//    print a clock time a customer could mistake for a collection slot.
export function rowMeta(o, columnId, nowMs) {
  const ts = columnStamp(o, columnId);
  if (columnId === "incoming") return clockText(ts);
  if (columnId === "tomorrow") return "Tomorrow";
  return agoText(ts, nowMs);
}

// One column's rows + total from the live list.
export function buildColumn(orders, columnId, nowMs) {
  const status = COLUMN_STATUS[columnId];
  const inColumn = (orders || []).filter((o) => o && o.status === status);
  const sorted = inColumn
    .map((o) => ({ o, ms: stampMs(columnStamp(o, columnId)) }))
    .sort((a, b) => (Number.isFinite(b.ms) ? b.ms : -Infinity) - (Number.isFinite(a.ms) ? a.ms : -Infinity));
  return {
    total: inColumn.length,
    rows: sorted.slice(0, VISIBLE_ROWS).map(({ o }) => ({
      key: `${o.id}:${o.createdAt || ""}:${o.isLayby ? "L" : ""}`,
      number: String(o.id ?? ""),
      meta: rowMeta(o, columnId, nowMs),
    })),
  };
}

export function buildBoard(orders, nowMs) {
  return Object.fromEntries(
    Object.keys(COLUMN_STATUS).map((id) => [id, buildColumn(orders, id, nowMs)])
  );
}
