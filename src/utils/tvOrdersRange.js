// ─── TV ORDERS KEY RANGE ──────────────────────────────────────────────────────
// The always-on TV kiosk needs CUSTOMER orders only, but /orders is shared:
// customer orders are keyed by their daily numeric orderNumber ("001"…"999")
// while clothing-refill carts are keyed "R###-…" (each cart's own R-number —
// see project memory refill_own_number_path). The TV has always dropped the
// refill rows client-side (customerName === "Shop Refill"), but a full-node
// listen still DOWNLOADED them: measured 2026-08-13, /orders was 2,150 KB of
// which 1,744 KB (1,914 rows) were refill carts and only 465 KB (565 rows)
// customer orders — and the refill share grows daily while customer keys are
// bounded by the ≤999 daily id space.
//
// An orderByKey range [START, END] keeps every numeric key and excludes every
// "R…" key SERVER-SIDE (verified live via REST: the ranged read returns
// exactly the 565 customer rows). Key queries need no .indexOn, and the live
// /orders read rule allows any query shape for users with no destShop pin
// (the anonymous TV session). RTDB orders integer-like keys before string
// keys, and both bounds bracket the numeric keys under either ordering.
export const TV_ORDER_KEY_START = "0";
export const TV_ORDER_KEY_END = "9";

// Pure mirror of the range for tests: would this /orders key reach the TV?
// (String compare is exact for the string-ordered case and equivalent for
// integer-like keys, which all begin with a digit.)
export function keyInTvOrdersRange(key) {
  const k = String(key);
  return k >= TV_ORDER_KEY_START && k <= TV_ORDER_KEY_END && /^[0-9]/.test(k);
}

// ─── WEBSITE ORDERS ON THE BOARD ─────────────────────────────────────────────
// A website order's hub orders are keyed by its three-letter code ("KQZ",
// "KQZ-2", "KQZ-2-1" — letters A–Z without I/O, then optional suffixes). They
// sit outside the numeric range above, so the board reads two more key ranges
// that bracket every code and NO refill cart: carts are "R" + digits ("R123-…"),
// and a digit sorts before every letter, so all of them fall below "RAA".
//   ["AAA", "QZZ"]  codes A…Q      ["RAA", "ZZZ"]  codes R…Z
// ( is the high end of the string range — never "tidy" it away.)
export const TV_ONLINE_ORDER_KEY_RANGES = Object.freeze([
  Object.freeze(["AAA", "QZZ"]),
  Object.freeze(["RAA", "ZZZ"]),
]);

// The ranges also bracket a prefixed store's keys ("P001": Pine's own board)
// — so a row is a website order only if its key IS a code: three letters (no
// I/O), then nothing or "-…". Applied to both sources, like the numeric bound.
const ONLINE_CODE_KEY = /^[A-HJ-NP-Z]{3}(?:-[0-9A-Za-z-]*)?$/;

/** Would this /orders key reach the board as a website order? */
export function keyInTvOnlineOrdersRange(key) {
  const k = String(key);
  return ONLINE_CODE_KEY.test(k) && TV_ONLINE_ORDER_KEY_RANGES.some(([a, b]) => k >= a && k <= b);
}

/** Keep only the board's rows from one range read (numeric keys, or website codes). */
export function tvRowsOf(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if ((k >= TV_ORDER_KEY_START && k <= TV_ORDER_KEY_END && /^[0-9]/.test(k)) || keyInTvOnlineOrdersRange(k)) out[k] = v;
  }
  return out;
}
