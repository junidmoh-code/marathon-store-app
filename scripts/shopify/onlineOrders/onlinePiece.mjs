// ── Releasing ONLY the online order's piece of a request (Junid, 25 Oct 09:52) ─
// "When the watcher finds stock for a waiting online-order line:
//   - Only touch requests that were raised FOR that online order. A genuine
//     refill request (raised by the refill scan for a real shortage) is never
//     cancelled or reduced.
//   - If a request mixes both, e.g. Central request for 3 where 1 is for the
//     online order and 2 are genuine refill, reduce it by exactly 1 (the
//     online-order piece) and leave the other 2 untouched.
//   - Pull exactly the quantity the online order needs (usually 1), never more.
//   - If you can't tell which part of a request belongs to the online order,
//     don't change it; tell me on WhatsApp instead.
//   Log every change with the before and after quantity."
//
// WHAT "RAISED FOR THAT ONLINE ORDER" MEANS, exactly as escalate.mjs writes it:
//   refill row   refill_requests/{key}.createdFrom = { via: "online_escalation",
//                orderKey: <order id>, lineIndex: <i>, … }
//   Shop Refill  orders/{key}.onlineEscalationKey === requestKey(order, line, esc)
// Anything else at that key — no tag, another order's tag — is NOT the online
// order's, so nothing in it can be attributed: "can't tell" → left alone.
//
// THE PIECE is the line's quantity (the escalation asked for exactly that).
// A tagged record holding exactly the piece is withdrawn whole; one holding
// MORE is reduced by exactly the piece; one holding less is "can't tell".
// A record somebody is already working on (picking, part-sent, answered, a
// card Hub 2 has moved) is left to them.
//
// planRelease is PURE and is re-run inside the transaction against the
// server's value, so the write is only ever the plan for what is there NOW.
import { ESCALATION_VIA, STEP } from "../../../src/utils/onlineEscalation.js";

export const RELEASE = Object.freeze({
  CANCEL: "cancel",     // the whole record was the online order's piece → withdrawn
  REDUCE: "reduce",     // mixed: the piece comes off, the rest stays
  GONE: "gone",         // nothing there (or already withdrawn as no longer needed)
  BUSY: "busy",         // being worked on / answered — left to the people doing it
  UNCLEAR: "unclear",   // can't tell which part is the online order's → Junid
});

const qtyOf = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/**
 * → { action, before, after, why }
 *   kind    "refill" | "store_order" (the escalation request's kind)
 *   record  the record at the request's key, as read (null = absent)
 *   orderId, lineIndex, escKey (requestKey for the line), piece (the line's qty)
 */
export function planRelease({ kind, record, orderId, lineIndex, escKey, piece }) {
  const p = qtyOf(piece);
  if (record == null) return { action: RELEASE.GONE, before: 0, after: 0, why: "the request is not there any more" };
  // This line's piece already came off (a re-run after a crash): nothing more to take.
  if (record.onlineReleased && record.onlineReleased.escKey === escKey) return { action: RELEASE.GONE, before: 0, after: 0, why: "this order's part was already taken back" };
  if (kind === STEP.REFILL) {
    if (record.status === "cancelled" && record.cancelReason === "no_longer_needed") {
      return { action: RELEASE.GONE, before: 0, after: 0, why: "already withdrawn as no longer needed" };
    }
    const cf = record.createdFrom;
    const ours = cf && cf.via === ESCALATION_VIA && String(cf.orderKey) === String(orderId) && Number(cf.lineIndex) === Number(lineIndex);
    if (!ours) return { action: RELEASE.UNCLEAR, why: cf?.via === ESCALATION_VIA ? "the refill request is tagged for another website order line" : "the refill request carries no website-order tag (it looks like a genuine refill)" };
    if (record.status !== "open") return { action: RELEASE.BUSY, why: `the refill request is already ${record.status}` };
    if (record.picking || Number(record.sentQty) > 0) return { action: RELEASE.BUSY, why: "Central is already picking or has sent part of it" };
    const q = qtyOf(record.qty);
    if (!q || !p) return { action: RELEASE.UNCLEAR, why: "the quantities cannot be read" };
    if (q === p) return { action: RELEASE.CANCEL, before: q, after: 0 };
    if (q > p) return { action: RELEASE.REDUCE, before: q, after: q - p };
    return { action: RELEASE.UNCLEAR, why: `the request holds ${q}, less than the ${p} the online order asked for` };
  }
  // A Shop Refill card at Hub 2.
  if (record.onlineEscalationKey !== escKey) {
    return { action: RELEASE.UNCLEAR, why: record.onlineEscalationKey ? "the card at that number is for another website order line" : "the card at that number carries no website-order tag" };
  }
  if (record.status !== "incoming" || record.clothingRefillStatus != null) return { action: RELEASE.BUSY, why: "Hub 2 has already answered or moved the card" };
  const q = qtyOf(record.qty);
  if (!q || !p) return { action: RELEASE.UNCLEAR, why: "the quantities cannot be read" };
  if (q === p) return { action: RELEASE.CANCEL, before: q, after: 0 };
  if (q > p) return { action: RELEASE.REDUCE, before: q, after: q - p };
  return { action: RELEASE.UNCLEAR, why: `the card holds ${q}, less than the ${p} the online order asked for` };
}

/** The record as it should be after `plan` (undefined = abort; null = remove). PURE. */
export function applyPlan(kind, record, plan, { nowMs, ref, escKey = null }) {
  if (plan.action === RELEASE.CANCEL) {
    if (kind === STEP.REFILL) {
      return { ...record, status: "cancelled", cancelReason: "no_longer_needed", resolvedAt: new Date(nowMs).toISOString(),
               onlineReleased: { qty: plan.before, at: nowMs, ref, escKey, before: plan.before, after: 0 } };
    }
    return null; // an untouched card is removed, as a cancelled hub order is (escalate.mjs withdrawRequest did the same)
  }
  if (plan.action === RELEASE.REDUCE) {
    // What is left is NOT the online order's any more: its tag comes off, so
    // nothing can take it back a second time or mistake it for this line's
    // request. The original tag is kept inside onlineReleased.
    const released = { qty: plan.before - plan.after, at: nowMs, ref, escKey, before: plan.before, after: plan.after };
    if (kind === STEP.REFILL) {
      return { ...record, qty: plan.after, onlineRef: null,
               createdFrom: { ...record.createdFrom, via: `${ESCALATION_VIA}_released` },
               onlineReleased: { ...released, tag: record.createdFrom || null } };
    }
    return { ...record, qty: plan.after, onlineRef: null, onlineEscalationKey: null,
             onlineReleased: { ...released, tag: record.onlineEscalationKey || null } };
  }
  return undefined;
}

/**
 * Release the online order's piece of the line's open request, by
 * transaction, re-planned against the server's value. Logs every change with
 * its before and after quantity, to the tick's log AND to the order
 * (online_orders/{id}/requestChanges/{at}_{i}).
 *   ctx: { db, now, log }   esc.request: { kind, key, from }
 * → the plan that was applied (or that stopped it).
 */
export async function releaseOnlinePiece(ctx, { orderId, orderRef, lineIndex, esc, escKey, piece, by }) {
  const { kind, key } = esc.request;
  const path = kind === STEP.REFILL ? `refill_requests/${key}` : `orders/${key}`;
  let plan = null;
  const res = await ctx.db.ref(path).transaction((cur) => {
    if (cur == null) { plan = { action: RELEASE.GONE, before: 0, after: 0 }; return null; } // cold-cache pass: re-read, never abort
    plan = planRelease({ kind, record: cur, orderId, lineIndex, escKey, piece });
    const next = applyPlan(kind, cur, plan, { nowMs: ctx.now, ref: orderRef, escKey });
    return next === undefined ? undefined : next;
  });
  if (!plan) plan = { action: RELEASE.UNCLEAR, why: "the request could not be read" };
  const changed = (plan.action === RELEASE.CANCEL || plan.action === RELEASE.REDUCE) && res.committed;
  if (changed) {
    const what = kind === STEP.REFILL ? "refill request" : "Shop Refill card";
    (ctx.log || (() => {}))(`  ⇣ ${orderRef} line ${lineIndex + 1}: ${what} ${key} ${plan.action === RELEASE.CANCEL ? "withdrawn" : "reduced"} ${plan.before} → ${plan.after} (the online order's ${plan.before - plan.after}; ${by})`);
    await ctx.db.ref(`online_orders/${orderId}/requestChanges/${ctx.now}_${lineIndex}`).set({
      lineIndex, kind, key, action: plan.action, before: plan.before, after: plan.after, by, at: ctx.now,
    });
  }
  return { ...plan, changed, path };
}

/**
 * WhatsApp to Junid (ctx.whatsappJunid); email (ctx.send) when WhatsApp is
 * missing or fails; ONCE per request record (`once` = a path to mark), so a
 * second tap on the same line does not send it again. Never throws.
 */
export async function tellJunid(ctx, text, { once = null } = {}) {
  const log = ctx.log || (() => {});
  // No channel on this run: nothing is marked, so a run that has one still tells him.
  if (!ctx.whatsappJunid && !ctx.send) { log(`  ⚠ Junid NOT told (no WhatsApp or mail on this run): ${text.split("\n")[0]}`); return; }
  if (once) {
    try {
      const res = await ctx.db.ref(once).transaction((cur) => (cur == null ? ctx.now : undefined));
      if (!res.committed) { log(`  · Junid already told about this (${once})`); return; }
    } catch { /* tell anyway */ }
  }
  try {
    if (ctx.whatsappJunid) { await ctx.whatsappJunid(text); log(`  ✉ WhatsApp to Junid: ${text.split("\n")[0]}`); return; }
  } catch (e) { log(`  ✗ WhatsApp to Junid failed (${String(e?.message || e)}) — emailing instead`); }
  try {
    if (ctx.send) { await ctx.send({ subject: "Website order: a request needs your eye", text }); log(`  ✉ emailed Junid: ${text.split("\n")[0]}`); return; }
  } catch (e) { log(`  ✗ email to Junid failed (${String(e?.message || e)})`); }
  log(`  ⚠ Junid NOT told (no WhatsApp or mail on this run): ${text.split("\n")[0]}`);
}

/** The WhatsApp to Junid when the online piece cannot be told apart. PURE. */
export function unclearMessage({ orderRef, lineIndex, line, esc, why }) {
  const what = esc.request.kind === STEP.REFILL ? `the refill request ${esc.request.key} (${esc.request.from} → ${esc.request.to})` : `the Shop Refill card ${esc.request.key} at ${esc.request.from}`;
  return [
    `Website order ${orderRef}, line ${lineIndex + 1} (${line?.title || line?.pid || "?"} size ${line?.size ?? "?"}, qty ${Number(line?.qty) || 1}): the stock is back, but I could not tell which part of ${what} is the online order's — ${why}.`,
    "I changed nothing. Please check that request and adjust it by hand.",
  ].join("\n");
}
