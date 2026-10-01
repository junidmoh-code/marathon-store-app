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

// ── THE SLACK ON A DERIVED WINDOW ────────────────────────────────────────────
// A banking report prints no Opened/Closed, so its window is the span of its
// own transactions — zero slack at either end. But the terminal stamps a sale
// at APPROVAL and the till writes its leg at COMPLETION, minutes later, so the
// last sales' legs land after the window closes. On 25 Sept 2026 that put
// Pine Till 1's R800 (17:33 → leg 17:37) and R250 (17:34 → leg 17:39) outside a
// window ending 17:36, and showed both as money with no sale.
//
// TEN MINUTES, from the live ledger (measured 2026-09-25 across every derived-
// window batch on file — Pine Till 1, Marathon Till 1 and 3, Trophy Till 1:
// 1,491 paired transactions): the leg is never earlier than the terminal line
// (2 of 1,491, both amount coincidences hours apart), the lag runs p50 147 s,
// p95 312 s, and 97% of pairs land within 600 s. Thirteen legs fell past a
// derived close, the furthest by 204 s; none fell before an open. Ten minutes
// covers the worst of those three times over and is nowhere near a neighbouring
// batch (the next one opens the following morning on every terminal).
//
// A LEG IN THE SLACK COUNTS ONLY IF IT ANSWERS ONE OF THIS BATCH'S OWN
// TRANSACTIONS: a line of the same amount that no in-window leg answered, AND
// stamped within the slack of the leg. Amount alone is not enough — a line
// from noon with no leg at all must not be "answered" by the next batch's sale
// of the same amount at 17:40, or the slack would hide the very gap it must
// leave alone. (CodeRabbit, PR #649.) A slack leg nothing claims is not counted
// (it may be the next batch's), so the slack can close a false gap but can
// never invent a sale, and money on the terminal with no leg at any time still
// shows as a gap.
const DERIVED_WINDOW_SLACK_MS = 10 * 60 * 1000;
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
function expectedCardFromEvents(events, { storeId, tillId, startMs, endMs, edgeMs = 0, tailFromMs = null, slackMs = 0, lines = null }) {
  const rows = Array.isArray(events) ? events : Object.values(events || {});
  let cardCents = 0, legs = 0;
  const byKind = {};
  const addToKind = (e, amount) => {
    const kind = typeof e.kind === "string" && e.kind ? e.kind : "unknown";
    const bucket = byKind[kind] || (byKind[kind] = { cents: 0, legs: 0 });
    bucket.cents += amount;
    bucket.legs += 1;
  };
  // Legs in the derived-window slack, and the ones a transaction claimed.
  const slackCandidates = [];
  let slackLegs = 0, slackCents = 0;
  // This report's transactions, each answered at most once — first by an
  // in-window leg, then (only if still unanswered) by a slack leg near it.
  const canClaim = slackMs > 0 && Array.isArray(lines) && lines.length > 0;
  const open = canClaim
    ? lines.filter((l) => l && Number.isInteger(l.amountCents) && Number.isFinite(Number(l.at)))
      .map((l) => ({ amount: l.amountCents, at: Number(l.at), answered: false }))
    : [];
  const windowLegsSeen = [];
  // The unanswered line of this amount nearest `at`, within `reach` (or any
  // distance when reach is Infinity).
  const nearestOpen = (amount, at, reach) => {
    let best = null;
    for (const l of open) {
      if (l.answered || l.amount !== amount) continue;
      const d = Math.abs(l.at - at);
      if (d <= reach && (best === null || d < Math.abs(best.at - at))) best = l;
    }
    return best;
  };
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
      if (canClaim && Number.isInteger(e.amount) && at >= startMs - slackMs && at < endMs + slackMs) {
        slackCandidates.push(e);   // decided below, once every in-window leg is known
        continue;
      }
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
    addToKind(e, amount);
    if (canClaim) windowLegsSeen.push({ amount, at });
  }
  // In-window legs answer lines first, earliest leg first, each taking the
  // nearest line of its amount — so the lines left open are specific ones.
  windowLegsSeen.sort((a, b) => a.at - b.at);
  for (const w of windowLegsSeen) {
    const hit = nearestOpen(w.amount, w.at, Infinity);
    if (hit) hit.answered = true;
  }
  // ── THE SLACK, CLAIMED — nearest the window first ───────────────────────────
  const distance = (at) => (at < startMs ? startMs - at : at - endMs);
  slackCandidates.sort((a, b) => distance(Number(a.at)) - distance(Number(b.at)));
  for (const e of slackCandidates) {
    const at = Number(e.at);
    const line = nearestOpen(e.amount, at, slackMs);
    if (line) {
      line.answered = true;
      cardCents += e.amount; legs += 1;
      slackLegs += 1; slackCents += e.amount;
      addToKind(e, e.amount);
    } else if (edgeMs > 0 && at >= startMs - edgeMs && at < endMs + edgeMs) {
      // Unclaimed: reported exactly as an unclaimed near-edge leg always was.
      nearEdgeLegs += 1;
      nearEdgeCents += e.amount;
    }
  }
  return { cardCents, legs, byKind, nearEdgeLegs, nearEdgeCents, tailLegs, tailCents, slackLegs, slackCents };
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
async function computeExpectedCard(db, { storeId, tillId, startMs, endMs, edgeMs = 0, tailFromMs = null, slackMs = 0, lines = null }) {
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
  const reach = Math.max(edgeMs, slackMs);
  const snap = await db.ref(PAYMENT_EVENTS_PATH)
    .orderByChild("at").startAt(startMs - reach).endAt(endMs + reach)
    .once("value");
  const events = snap.val() || {};
  return {
    ...expectedCardFromEvents(events, { storeId, tillId, startMs, endMs, edgeMs, tailFromMs, slackMs, lines }),
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
  PAYMENT_EVENTS_PATH, cardLegsInWindow, DERIVED_WINDOW_SLACK_MS,
  expectedCardFromEvents,
  cashiersFromEvents,
  computeExpectedCard,
};
