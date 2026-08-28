// ─── CARD RECON — expected card takings for a till over a timestamp window ───
// What SHOULD the card machine on one till have settled between two moments?
// Computed from TENDER LEGS, not sale totals: /pos/paymentEvents holds one
// dated, signed-cents row per tender leg (marathon-pos-app's paymentEvents.js —
// the cash-basis money ledger), so the card portion of a split payment, a layby
// deposit or instalment taken on card, a card refund (negative) and a voided
// card leg (negative `v~` row) all participate correctly by simply summing the
// signed amounts of the method:"card" rows. Cash, EFT, store credit and
// on-account are excluded by the same method filter.
//
// THE WINDOW IS ARBITRARY TIMESTAMPS — the slip's Opened→Closed, roughly 18:50
// to 18:50 the next day, never a calendar day. Start-inclusive, end-EXCLUSIVE
// ([startMs, endMs)): the moment the batch closes is the moment the next one
// opens, and one transaction must never count in two batches.
//
// SERVER-SIDE ONLY, Admin SDK: the store app's browser has no business reading
// POS sales or payments, so the query lives behind the cardBatchCapture
// callable and only the computed figure travels to the client.
//
// NO WHOLE-NODE READS: the RTDB query is orderByChild("at") bounded to the
// window (the live rules carry `.indexOn: ["at"]` on /pos/paymentEvents —
// verified 2026-08-28), then filtered to the store+till in code. Pure logic
// here; the db wrapper at the bottom is the only IO and is injected for tests.

"use strict";

const PAYMENT_EVENTS_PATH = "pos/paymentEvents";
const { MAX_WINDOW_MS } = require("./card-recon.cjs");

/**
 * Pure: fold payment-event rows into the expected-card summary for one till.
 * `events` is the raw window slice (any store/till/method — the query is only
 * time-bounded); filtering is done here so the boundary rules live in ONE
 * tested place.
 *
 * @param {Object<string,object>|object[]} events
 * @returns {{cardCents:number, legs:number, byKind:Object<string,{cents:number,legs:number}>}}
 */
function expectedCardFromEvents(events, { storeId, tillId, startMs, endMs }) {
  const rows = Array.isArray(events) ? events : Object.values(events || {});
  let cardCents = 0, legs = 0;
  const byKind = {};
  for (const e of rows) {
    if (!e || e.method !== "card") continue;
    if (e.storeId !== storeId || e.tillId !== tillId) continue;
    const at = Number(e.at);
    if (!Number.isFinite(at) || at < startMs || at >= endMs) continue;
    // The ledger writes integer cents; anything else (null, a string) is a
    // malformed row and is skipped — a null must not fold in as a 0-cent leg.
    const amount = e.amount;
    if (!Number.isInteger(amount)) continue;
    cardCents += amount;
    legs += 1;
    const kind = typeof e.kind === "string" && e.kind ? e.kind : "unknown";
    const bucket = byKind[kind] || (byKind[kind] = { cents: 0, legs: 0 });
    bucket.cents += amount;
    bucket.legs += 1;
  }
  return { cardCents, legs, byKind };
}

/**
 * Pure: who transacted on this till inside the window — ANY tender method, so
 * a cash-only cashier still appears. This is the read-only "who was signed in"
 * evidence the submit screen displays: derived from the till's own money
 * movements (there is no separate POS login ledger), never from a picker.
 *
 * @returns {Array<{uid:string|null, name:string|null, firstAt:number, lastAt:number, legs:number}>}
 */
function cashiersFromEvents(events, { storeId, tillId, startMs, endMs }) {
  const rows = Array.isArray(events) ? events : Object.values(events || {});
  const byUid = new Map();
  for (const e of rows) {
    if (!e || e.storeId !== storeId || e.tillId !== tillId) continue;
    const at = Number(e.at);
    if (!Number.isFinite(at) || at < startMs || at >= endMs) continue;
    const key = e.cashierUid || `name:${e.cashierName || "unknown"}`;
    const cur = byUid.get(key) || {
      uid: e.cashierUid || null, name: e.cashierName || null,
      firstAt: at, lastAt: at, legs: 0,
    };
    cur.firstAt = Math.min(cur.firstAt, at);
    cur.lastAt = Math.max(cur.lastAt, at);
    cur.legs += 1;
    if (!cur.name && e.cashierName) cur.name = e.cashierName;
    byUid.set(key, cur);
  }
  return [...byUid.values()].sort((a, b) => a.firstAt - b.firstAt);
}

/**
 * IO wrapper: one time-bounded, indexed query, then the pure folds above.
 * RTDB's endAt is INCLUSIVE, so the query over-fetches the single endMs
 * instant and the [startMs, endMs) rule is enforced by the pure filter.
 *
 * @param {import("firebase-admin").database.Database} db
 */
async function computeExpectedCard(db, { storeId, tillId, startMs, endMs }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("computeExpectedCard: bad window");
  }
  // Defence in depth beside validateExtraction's own cap: no FNB batch runs a
  // week, and a misread year must never become the bounds of a ledger query.
  if (endMs - startMs > MAX_WINDOW_MS) {
    throw new Error("computeExpectedCard: window exceeds the 7-day cap");
  }
  const snap = await db.ref(PAYMENT_EVENTS_PATH)
    .orderByChild("at").startAt(startMs).endAt(endMs)
    .once("value");
  const events = snap.val() || {};
  return {
    ...expectedCardFromEvents(events, { storeId, tillId, startMs, endMs }),
    cashiers: cashiersFromEvents(events, { storeId, tillId, startMs, endMs }),
  };
}

module.exports = {
  PAYMENT_EVENTS_PATH,
  expectedCardFromEvents,
  cashiersFromEvents,
  computeExpectedCard,
};
