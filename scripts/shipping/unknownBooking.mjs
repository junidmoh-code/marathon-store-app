// ── A booking that ended "unknown": ask Courier Guy itself (Junid, 21 Nov 2026) ──
// bookShipment leaves the order's claim (shipping/courierBooking) as "unknown"
// when a create's answer was lost (timeout, 5xx, a 2xx naming no shipment):
// Courier Guy may or may not have made the waybill, so nothing books it again.
// Before this file the order then sat as "Packed, courier not booked" until a
// person checked the portal (#2181: packed 21 Nov 12:32, no waybill). Nobody is
// asked to check the portal any more:
//
//   1. GET /shipments, from the day before the claim, every page: a shipment
//      whose customer_reference is the order's ("#2181", a split "#2181 (1/2)")
//      created after the claim time minus 5 minutes, not cancelled.
//   2. FOUND → its waybill is attached to the order exactly as a booking writes
//      it (shipping.waybill, shipmentId, trackingReference, service, cost, the
//      locker the attempt was for) and the claim becomes "booked". An order
//      left "courier not booked" goes back to pending: the ship flow finds the
//      waybill ("already booked"), fulfils Shopify with it, and Jamie's shipped
//      message follows as for any booking.
//   3. NONE, and the claim is younger than 10 minutes → nothing yet (a slow
//      create may still be landing).
//   4. NONE after 10 minutes → the claim is released ("unknown" → "failed", in a
//      transaction on the very claim that was checked) and the order goes back
//      to pending: the ship flow books it ONCE more through bookShipment (live
//      switch, ceiling, locker rules all hold). At most one automatic re-book
//      per order (shipping/unknownRecheck/rebooks); a second "unknown" stays on
//      the order with the reason.
//
// NEVER TWICE. The release is a transaction that commits only while the claim
// is still the same "unknown" (same `at`), right after the list showed no
// shipment; a second sweeper (the tick and fast-ship both run this) finds the
// claim moved on and does nothing. The re-book itself takes bookShipment's own
// claim, under the ship lock, like every booking.
//
// Runs from the orders tick (before SHIP) and from fast-ship.mjs every few
// minutes (all hours). Reads only at Courier Guy: nothing here creates or
// cancels a shipment.
import { bookingRef } from "./bookShipment.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

export const UNKNOWN_WAIT_MS = 10 * 60 * 1000;
export const CREATED_SLACK_MS = 5 * 60 * 1000;
export const MAX_AUTO_REBOOKS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAST_MS = 2 * 60 * 60 * 1000;

const str = (v) => String(v ?? "").trim();
const finiteOrNull = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

/** Courier Guy shipments that are this order's booking: its reference (or a split's "ref (i/n)"), made since `sinceMs`, not cancelled. Pure. */
export function matchShipments(shipments, ref, sinceMs) {
  const want = str(ref);
  if (!want) return [];
  return (Array.isArray(shipments) ? shipments : [])
    .filter((s) => {
      const r = str(s?.customer_reference);
      if (r !== want && !r.startsWith(`${want} (`)) return false;
      if (/cancel/i.test(str(s?.status))) return false;
      const t = Date.parse(s?.time_created);
      return Number.isFinite(t) && t >= sinceMs;
    })
    .sort((a, b) => Date.parse(a.time_created) - Date.parse(b.time_created));
}

/** Every page of GET /shipments from the day before `sinceMs`, matched to `ref`. */
export async function findShipments(client, ref, sinceMs, { maxPages = 20 } = {}) {
  const startDate = new Date(sinceMs - DAY_MS + SAST_MS).toISOString().slice(0, 10);
  const found = [];
  for (let page = 0, offset = 0; page < maxPages; page++) {
    const rows = (await client.getShipments({ limit: 100, offset, start_date: startDate }))?.shipments ?? [];
    if (!rows.length) break;
    found.push(...matchShipments(rows, ref, sinceMs));
    offset += rows.length;
  }
  // A shipment listed on two pages (the list moved while it was read) counts once.
  const seen = new Set();
  return found.filter((s) => { const k = s.id ?? s.short_tracking_reference; if (seen.has(k)) return false; seen.add(k); return true; });
}

const asMade = (s) => ({
  shipmentId: finiteOrNull(s?.id),
  waybill: s?.custom_tracking_reference || s?.short_tracking_reference || null,
  trackingReference: s?.short_tracking_reference ?? null,
  service: s?.service_level_code ?? null,
  cost: finiteOrNull(s?.charged_amount ?? s?.rate),
});

// The order back to the ship flow: what the POS "Retry courier" writes (attention.js resolveAttentionUpdates).
const backToPending = (order, now) => ({
  fulfilState: "pending",
  "fulfil/state": "pending",
  courierError: null,
  updatedAt: now,
  ...(!order?.attention || order.attention.kind === "courier_failed" ? { attention: null, attentionOpen: null } : {}),
});

/**
 * One order whose claim is "unknown". → { action: "none" | "attached" | "partial" | "wait" | "rebook" | "gave_up" | "raced", … }
 * @param {object} deps { db, client, now: () => ms, log, waitMs }
 */
export async function recheckUnknownBooking(key, order, { db, client, now = () => Date.now(), log = () => {}, waitMs = UNKNOWN_WAIT_MS } = {}) {
  assertSafeSegment(key, "order key");
  const claim = order?.shipping?.courierBooking;
  if (claim?.state !== "unknown") return { action: "none", reason: `claim is ${claim?.state ?? "absent"}` };
  if (order?.shipping?.shipmentId || order?.shipping?.waybill) return { action: "none", reason: "the order already carries a waybill" };
  const claimAt = Number(claim.at) || 0;
  const ref = str(claim.ref) || bookingRef({ ...order, key });
  if (!ref) return { action: "none", reason: "no order reference to look for" };
  const base = `online_orders/${key}`;
  const claimRef = db.ref(`${base}/shipping/courierBooking`);
  const sameClaim = (cur) => cur && cur.state === "unknown" && Number(cur.at) === claimAt;
  // A transaction on the very claim that was checked. The Admin SDK's first pass sees null (a cold cache): null is
  // answered with null so the server's real value comes back for the second pass (undefined would abort without
  // asking). Committed only when the claim now holds what was written.
  const moveClaim = async (next) => {
    const tx = await claimRef.transaction((cur) => (cur == null ? null : sameClaim(cur) ? next : undefined));
    const v = tx.snapshot?.val?.();
    return !!(tx.committed && v && v.state === next.state && Number(v.at) === next.at);
  };
  const t = now();

  const found = await findShipments(client, ref, claimAt - CREATED_SLACK_MS);
  const wanted = Math.max(1, Number(claim.shipments) || 1);
  if (found.length) {
    const made = found.map(asMade);
    const first = made[0];
    const locker = claim.locker && typeof claim.locker === "object" ? claim.locker : null;
    if (made.length < wanted && locker?.id) {
      // A split some of whose parcels Courier Guy did make: kept as the checkpoint bookShipment finishes from (same
      // locker, only the rest), and the claim released for that one re-book.
      if (!(await moveClaim({ state: "failed", at: t, error: str(claim.error).slice(0, 300), released: `found ${made.length} of ${wanted} shipments at Courier Guy` }))) return { action: "raced" };
      await db.ref(`${base}/shipping/partial`).set(plain({ count: wanted, locker, shipments: made, at: t }));
      await db.ref(base).update(backToPending(order, t));
      log(`unknownBooking ${key} ${ref}: ${made.length} of ${wanted} shipments found at Courier Guy (${made.map((m) => m.waybill).join(", ")}) — the rest re-booked`);
      return { action: "partial", waybills: made.map((m) => m.waybill) };
    }
    const bookedAt = Date.parse(found[0].time_created) || t;
    if (!(await moveClaim(plain({ state: "booked", at: t, recovered: true, shipmentId: first.shipmentId, waybill: first.waybill })))) return { action: "raced" };
    const costs = made.map((m) => m.cost);
    const shipping = {
      provider: "courier_guy",
      shipmentId: first.shipmentId,
      waybill: first.waybill,
      trackingReference: first.trackingReference,
      service: first.service,
      cost: made.length > 1 && costs.every((c) => c !== null) ? Math.round(costs.reduce((a, c) => a + c, 0) * 100) / 100 : first.cost,
      bookedAt,
      // Found at Courier Guy after the create's answer was lost: no one booked it twice.
      recoveredFromUnknown: { at: t, error: str(claim.error).slice(0, 300) },
      ...(locker ? {
        deliveryLocker: plain(locker),
        deliveryMode: "locker",
        waybills: made.map((m) => m.waybill).filter(Boolean),
        shipments: plain(made),
      } : {}),
      partial: null,
      courierBooking: { state: "booked", at: t, recovered: true },
    };
    await db.ref(`${base}/shipping`).update(plain(shipping));
    // Back to the ship flow, which fulfils Shopify with this waybill ("already booked").
    if (order?.fulfilState === "courier_failed") await db.ref(base).update(backToPending(order, t));
    try { await db.ref(`shipping_recon/open/${key}`).set(t); } catch { /* the reconciliation set is a convenience */ }
    log(`unknownBooking ${key} ${ref}: Courier Guy HAS the shipment — ${shipping.waybills?.join("+") || shipping.waybill} attached`);
    return { action: "attached", waybill: first.waybill, waybills: made.map((m) => m.waybill) };
  }

  if (t - claimAt < waitMs) return { action: "wait", inMs: waitMs - (t - claimAt) };

  const rebooks = Number(order?.shipping?.unknownRecheck?.rebooks) || 0;
  if (rebooks >= MAX_AUTO_REBOOKS) {
    const reason = `Packed, but Courier Guy was not booked: no shipment for ${ref} at Courier Guy, after one automatic re-book (${str(claim.error).slice(0, 200) || "the answer was lost"})`;
    if (order?.attention?.reason !== reason || !order?.shipping?.unknownRecheck?.gaveUpAt) {
      await db.ref(base).update({
        "shipping/unknownRecheck/gaveUpAt": t,
        attention: { kind: "courier_failed", reason, at: t },
        attentionOpen: true,
      });
    }
    return { action: "gave_up" };
  }
  // Released only while it is the very claim just checked: never a second waybill.
  if (!(await moveClaim({ state: "failed", at: t, error: str(claim.error).slice(0, 300), released: "no shipment at Courier Guy" }))) return { action: "raced" };
  await db.ref(base).update({
    "shipping/unknownRecheck": { rebooks: rebooks + 1, at: t, claimAt, error: str(claim.error).slice(0, 300) },
    ...backToPending(order, t),
  });
  log(`unknownBooking ${key} ${ref}: no shipment at Courier Guy ${Math.round((t - claimAt) / 60000)} min after the attempt — claim released, booked once more`);
  return { action: "rebook" };
}

/**
 * Every order left "courier not booked" with an "unknown" claim (the indexed fulfilState query). → [{ key, ref, action, … }]
 * @param {object} deps { db, client, now, log, waitMs }
 */
export async function sweepUnknownBookings(deps) {
  const { db, log = () => {} } = deps;
  // `orders`: the caller's own courier_failed query (the tick's queryEq); else asked here.
  const all = deps.orders ?? ((await db.ref("online_orders").orderByChild("fulfilState").equalTo("courier_failed").get()).val() ?? {});
  const out = [];
  for (const [key, order] of Object.entries(all)) {
    if (order?.shipping?.courierBooking?.state !== "unknown") continue;
    try {
      const res = await recheckUnknownBooking(key, order, deps);
      out.push({ key, ref: order?.shopifyName ?? key, ...res });
    } catch (e) {
      log(`unknownBooking ${key}: check failed — ${String(e?.message || e).slice(0, 200)}; the next sweep tries again`);
      out.push({ key, ref: order?.shopifyName ?? key, action: "error", error: String(e?.message || e).slice(0, 200) });
    }
  }
  return out;
}
