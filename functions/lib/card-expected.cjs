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
function expectedCardFromEvents(events, { storeId, tillId, startMs, endMs, edgeMs = 0, tailFromMs = null }) {
  const rows = Array.isArray(events) ? events : Object.values(events || {});
  let cardCents = 0, legs = 0;
  const byKind = {};
  // Legs that sit JUST OUTSIDE the window — see the nearEdge note below.
  let nearEdgeLegs = 0, nearEdgeCents = 0;
  // Legs INSIDE the window but after the last transaction on the report — see
  // the tail note below.
  let tailLegs = 0, tailCents = 0;
  for (const e of rows) {
    if (!e || e.method !== "card") continue;
    if (e.storeId !== storeId || e.tillId !== tillId) continue;
    const at = Number(e.at);
    if (!Number.isFinite(at)) continue;
    if (at < startMs || at >= endMs) {
      // ── THE WINDOW EDGE ──────────────────────────────────────────────────
      // A printed slip's window has natural slack: the terminal opens the batch
      // before the first sale and closes it after the last, so the legs that
      // belong to it sit comfortably inside. A window DERIVED from transaction
      // timestamps has no such slack — it starts exactly at the first
      // transaction and ends exactly at the last — so a till leg written a few
      // seconds either side of the terminal's own clock falls outside a window
      // it plainly belongs to, and silently understates the expected figure.
      //
      // Nothing is widened to compensate: a fabricated window would be a
      // fabricated variance. Instead the near-misses are COUNTED and reported,
      // so a variance on a derived window can be read with that in mind
      // instead of being blamed on the person holding the till.
      if (edgeMs > 0 && Number.isInteger(e.amount)
          && at >= startMs - edgeMs && at < endMs + edgeMs) {
        nearEdgeLegs += 1;
        nearEdgeCents += e.amount;
      }
      continue;
    }
    // The ledger writes integer cents; anything else (null, a string) is a
    // malformed row and is skipped — a null must not fold in as a 0-cent leg.
    const amount = e.amount;
    if (!Number.isInteger(amount)) continue;
    cardCents += amount;
    legs += 1;
    // ── THE TAIL ───────────────────────────────────────────────────────────
    // A banking report states no closing time, so its window runs to the moment
    // the report was printed — which is minutes after its last transaction,
    // because a till leg always lands after the terminal's own stamp. Legs in
    // that gap are counted, and rightly: they are the trailing legs of the
    // batch's own sales.
    //
    // But a sale rung up in that gap and settled into the NEXT batch would also
    // fall here, and would then be counted twice — once in this window and once
    // in the next batch's. Nothing can distinguish them from the ledger alone,
    // so the tail is measured and reported rather than hidden inside the
    // expected figure it contributes to.
    if (tailFromMs !== null && at > tailFromMs) { tailLegs += 1; tailCents += amount; }
    const kind = typeof e.kind === "string" && e.kind ? e.kind : "unknown";
    const bucket = byKind[kind] || (byKind[kind] = { cents: 0, legs: 0 });
    bucket.cents += amount;
    bucket.legs += 1;
  }
  return { cardCents, legs, byKind, nearEdgeLegs, nearEdgeCents, tailLegs, tailCents };
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
async function computeExpectedCard(db, { storeId, tillId, startMs, endMs, edgeMs = 0, tailFromMs = null }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("computeExpectedCard: bad window");
  }
  // Defence in depth beside validateExtraction's own cap: no FNB batch runs a
  // week, and a misread year must never become the bounds of a ledger query.
  if (endMs - startMs > MAX_WINDOW_MS) {
    throw new Error("computeExpectedCard: window exceeds the 7-day cap");
  }
  // The query is widened by edgeMs ONLY so the near-edge legs can be counted;
  // the window itself is unchanged, and the pure filter below still admits
  // nothing outside [startMs, endMs) to the expected figure.
  const snap = await db.ref(PAYMENT_EVENTS_PATH)
    .orderByChild("at").startAt(startMs - edgeMs).endAt(endMs + edgeMs)
    .once("value");
  const events = snap.val() || {};
  return {
    ...expectedCardFromEvents(events, { storeId, tillId, startMs, endMs, edgeMs, tailFromMs }),
    cashiers: cashiersFromEvents(events, { storeId, tillId, startMs, endMs }),
  };
}

/**
 * Every card leg in the window, on ANY till.
 *
 * The expected-card sum above is scoped to the till the terminal is mapped to,
 * which is right for a subtraction and wrong for a match: a speedpoint that
 * spent the morning at another shop had its sales rung on that shop's till.
 * The matcher needs to see those, so this returns the unscoped set and leaves
 * the judgement to lib/card-match.cjs.
 *
 * Same query, same index, same bounds — only the store/till filter is dropped.
 */
async function cardLegsInWindow(db, { startMs, endMs, edgeMs = 0 }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("cardLegsInWindow: bad window");
  }
  if (endMs - startMs > MAX_WINDOW_MS) throw new Error("cardLegsInWindow: window exceeds the 7-day cap");
  const snap = await db.ref(PAYMENT_EVENTS_PATH)
    .orderByChild("at").startAt(startMs - edgeMs).endAt(endMs + edgeMs)
    .once("value");
  return Object.values(snap.val() || {})
    .filter((e) => e && e.method === "card" && Number.isInteger(e.amount) && Number.isFinite(Number(e.at)));
}

module.exports = {
  PAYMENT_EVENTS_PATH, cardLegsInWindow,
  expectedCardFromEvents,
  cashiersFromEvents,
  computeExpectedCard,
};
