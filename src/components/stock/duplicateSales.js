// ─── SALES PER PRODUCT ID, BOUNDED ───────────────────────────────────────────
// The Duplicates screen has to say "62 sold, last sold 12 Aug" for each copy —
// that is the fact that decides which record the shop actually uses.
//
// WHERE THE NUMBER COMES FROM, AND WHY IT IS BOUNDED THIS WAY:
//
//   • /insights_log is the only durable record of past-day activity
//     (/orders/{id} is daily-counter-ephemeral). It is 18.73 MB and has no
//     `.indexOn`, so orderByChild is unavailable — but push keys encode write
//     time, so orderByKey IS a time range (src/insights/insightsLogRange.js).
//
//   • The join key is `productId`, added 2026-06-10. Every entry written before
//     that date carries no productId at all, so it can only be joined by NAME —
//     and joining duplicates by name is precisely the thing that is broken
//     (twin records with near-identical names). An unjoinable event counted
//     against the wrong copy would recommend the WRONG survivor, so this reader
//     ignores name-only entries entirely and the screen says which window the
//     number covers. Honest and narrow beats complete and wrong.
//
//   • So the window IS the joinable era: from SINCE_MS forward, read in pages
//     with orderByKey + limitToFirst. Never a whole-node read.
//
// Sale events are `collected` (handed over) and `ready` (picked, awaiting
// collection) — the same pair the product card's "last sold" line counts.

import { get, limitToFirst, orderByKey, query, ref, startAt } from "firebase/database";
import { database } from "../../firebase";
import { pushKeyForMs } from "../../insights/insightsLogRange";

/** 2026-06-10 — the day /insights_log started carrying productId. */
export const SINCE_MS = Date.UTC(2026, 5, 10);
export const SINCE_LABEL = "10 Jun 2026";

const PAGE = 3000;
const SALE_ACTIONS = new Set(["collected", "ready"]);

/**
 * { [productId]: { units, lastMs } } over the joinable window.
 * Paged; startAt is inclusive, so each page after the first drops its cursor.
 */
export async function loadSalesByPid({ sinceMs = SINCE_MS, page = PAGE } = {}) {
  const out = {};
  let cursor = pushKeyForMs(sinceMs);
  let first = true;
  for (;;) {
    const snap = await get(query(ref(database, "insights_log"), orderByKey(), startAt(cursor), limitToFirst(page)));
    const keys = [];
    // forEach, not Object.keys — the snapshot's own iteration order is the only
    // reliable cursor source, and a BRACED body is load-bearing: a truthy
    // implicit return cancels RTDB's forEach after one child.
    snap.forEach((child) => { keys.push(child.key); });
    if (!keys.length) break;
    let added = 0;
    for (const k of keys) {
      if (!first && k === cursor) continue;   // inclusive-startAt overlap
      added += 1;
      const e = snap.child(k).val();
      if (!e || !e.productId || !SALE_ACTIONS.has(e.action)) continue;
      const row = out[e.productId] || (out[e.productId] = { units: 0, lastMs: 0 });
      row.units += 1;
      const ms = Date.parse(e.timestamp || "") || 0;
      if (ms > row.lastMs) row.lastMs = ms;
    }
    if (added === 0 || keys.length < page) break;
    cursor = keys[keys.length - 1];
    first = false;
  }
  return out;
}
