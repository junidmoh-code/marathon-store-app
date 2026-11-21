// ── A booking that ended "unknown": ask Courier Guy itself (Junid, 21 Nov 2026) ──
// bookShipment leaves the order's claim (shipping/courierBooking) as "unknown"
// when a create's answer was lost (timeout, 5xx, a 2xx naming no shipment):
// Courier Guy may or may not have made the waybill, so nothing books it again.
// Before this file the order then sat as "Packed, courier not booked" until a
// person checked the portal (#2181: packed 21 Nov 12:32, no waybill). Nobody is
// asked to check the portal any more:
//
//   1. GET /shipments, from the day before the claim, every page (offset works
//      and the list is oldest first — read against the live API 21 Nov 2026): a
//      shipment whose customer_reference is EXACTLY the order's ("#2181", a split
//      "#2181 (1/2)"; "#1941" never matches "#1941-EX" or the other way round),
//      created after the claim time minus 5 minutes, not cancelled. Any answer
//      that is not a list of shipments THROWS: "no answer" is never "no
//      shipment" (that would re-book and charge twice).
//   2. FOUND → merged with the parcels an earlier attempt already booked
//      (shipping/partial), by shipment id, and attached exactly as a booking
//      writes it (shipping.waybill, shipmentId, the locker…). The claim itself
//      carries the waybill first (a crash before the order's fields are written
//      still reads as "booked", as bookShipment's own "booked but not recorded").
//      An order left "courier not booked" goes back to pending: the ship flow
//      finds the waybill, fulfils Shopify, and Jamie's shipped message follows.
//      A split some of whose parcels exist keeps them as the checkpoint and
//      re-books only the rest.
//   3. NONE, inside 10 minutes → nothing yet (a slow create may still land).
//   4. NONE after 10 minutes, live on → the claim is released ("unknown" →
//      "failed", in a transaction on the very claim that was checked) and the
//      order goes back to pending: the ship flow books it once more through
//      bookShipment (live switch, ceiling, locker rules all hold). The allowance
//      is spent only when that booking reaches a create: bookShipment counts it
//      on the claim (courierBooking.rebooks). A claim already re-booked
//      MAX_AUTO_REBOOKS times stays "unknown", with the reason on the order.
//
// SENT TO ATTENTION instead (never guessed): MORE shipments than the order
// needs (a late create after a release — possibly a double booking), and a
// claim written before this file existed (no ref/shipments on it: how many
// parcels it was for is not known). The tick also looks once more, 30 minutes
// after every release, for a second shipment that landed late
// (shipping_recon/unknownReleased).
//
// NEVER TWICE. Every claim move is a transaction that commits only while the
// claim is still the same "unknown" (same `at`); a second sweeper (the tick and
// fast-ship both run this) finds the claim moved on and does nothing. Reads
// only at Courier Guy: nothing here creates or cancels a shipment.
import { bookingRef, readLive } from "./bookShipment.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

export const UNKNOWN_WAIT_MS = 10 * 60 * 1000;
export const CREATED_SLACK_MS = 5 * 60 * 1000;
export const MAX_AUTO_REBOOKS = 1;
export const LATE_CHECK_MS = 30 * 60 * 1000;
export const RELEASED_PATH = "shipping_recon/unknownReleased";
const DAY_MS = 24 * 60 * 60 * 1000;
const SAST_MS = 2 * 60 * 60 * 1000;

const str = (v) => String(v ?? "").trim();
const finiteOrNull = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

/** Is this shipment's customer_reference this order's (exactly, or a split's "ref (i/n)")? Pure. */
export function sameRef(customerReference, ref) {
  const r = str(customerReference);
  const want = str(ref);
  return !!want && (r === want || r.startsWith(`${want} (`));
}

/**
 * Courier Guy shipments that are this order's booking: its reference, made since `sinceMs`, not cancelled, oldest
 * first. Pure. A row of this order whose time_created cannot be read THROWS (never silently dropped).
 */
export function matchShipments(shipments, ref, sinceMs) {
  if (!str(ref)) return [];
  const mine = (Array.isArray(shipments) ? shipments : []).filter((s) => sameRef(s?.customer_reference, ref));
  for (const s of mine) {
    if (!Number.isFinite(Date.parse(s?.time_created))) throw new Error(`Courier Guy shipment ${s?.short_tracking_reference ?? s?.id ?? "?"} (${ref}) has no readable time_created (${JSON.stringify(s?.time_created)})`);
  }
  return mine
    .filter((s) => !/cancel/i.test(str(s?.status)))
    .filter((s) => Date.parse(s.time_created) >= sinceMs)
    .sort((a, b) => Date.parse(a.time_created) - Date.parse(b.time_created));
}

/**
 * Every page of GET /shipments from the day before `sinceMs`, matched to `ref`. THROWS on anything but a list of
 * shipments, on a page that only repeats rows already read (an ignored offset), and when `maxPages` is reached with
 * the last page still full — each of those would otherwise read as "no shipment" and re-book.
 */
export async function findShipments(client, ref, sinceMs, { maxPages = 20 } = {}) {
  const startDate = new Date(sinceMs - DAY_MS + SAST_MS).toISOString().slice(0, 10);
  const found = [];
  const seen = new Set();
  let offset = 0;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`Courier Guy's shipment list did not end within ${maxPages} pages (from ${startDate}) — not read as "no shipment"`);
    const res = await client.getShipments({ limit: 100, offset, start_date: startDate });
    if (!res || !Array.isArray(res.shipments)) throw new Error(`Courier Guy's shipment list answered without a shipments list: ${JSON.stringify(res)?.slice(0, 200)}`);
    const rows = res.shipments;
    if (!rows.length) break;
    const keys = rows.map((s) => String(s?.id ?? s?.short_tracking_reference ?? JSON.stringify(s)));
    if (page > 0 && keys.every((k) => seen.has(k))) throw new Error(`Courier Guy's shipment list repeated page ${page} at offset ${offset} (offset ignored?) — not read as "no shipment"`);
    for (const k of keys) seen.add(k);
    found.push(...matchShipments(rows, ref, sinceMs));
    offset += rows.length;
  }
  // A shipment listed on two pages (the list moved while it was read) counts once.
  const once = new Set();
  return found.filter((s) => { const k = String(s.id ?? s.short_tracking_reference); if (once.has(k)) return false; once.add(k); return true; });
}

const asMade = (s) => ({
  shipmentId: finiteOrNull(s?.id),
  waybill: s?.custom_tracking_reference || s?.short_tracking_reference || null,
  trackingReference: s?.short_tracking_reference ?? null,
  service: s?.service_level_code ?? null,
  cost: finiteOrNull(s?.charged_amount ?? s?.rate),
  createdAt: finiteOrNull(Date.parse(s?.time_created)),
});
const partialShipments = (order) => {
  const p = order?.shipping?.partial?.shipments;
  return (Array.isArray(p) ? p : Object.values(p ?? {})).filter((m) => m && (m.waybill || m.shipmentId != null));
};
/** The earlier parcels first, then the ones found, each shipment once (by id, else waybill). Pure. */
export function mergeMade(earlier, found) {
  const out = [];
  const keys = new Set();
  for (const m of [...earlier, ...found]) {
    const k = m.shipmentId != null ? `id:${m.shipmentId}` : `wb:${m.waybill}`;
    const k2 = m.waybill ? `wb:${m.waybill}` : null;
    if (keys.has(k) || (k2 && keys.has(k2))) continue;
    keys.add(k); if (k2) keys.add(k2);
    out.push(m);
  }
  return out;
}

// The order back to the ship flow: what the POS "Retry courier" writes (attention.js resolveAttentionUpdates).
const backToPending = (order, now) => ({
  fulfilState: "pending",
  "fulfil/state": "pending",
  courierError: null,
  updatedAt: now,
  ...(!order?.attention || order.attention.kind === "courier_failed" ? { attention: null, attentionOpen: null } : {}),
});
const attentionUpdate = (order, reason, t) => (order?.attention?.reason === reason ? null : {
  attention: { kind: "courier_failed", reason, at: t },
  attentionOpen: true,
  updatedAt: t,
});

/**
 * One order whose claim is "unknown".
 * → { action: "none" | "attached" | "partial" | "wait" | "rebook" | "live_off" | "gave_up" | "attention" | "raced", … }
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
  const flag = async (reason, action = "attention") => {
    const u = attentionUpdate(order, reason, t);
    if (u) await db.ref(base).update(u);
    log(`unknownBooking ${key} ${ref}: ${reason}`);
    return { action };
  };

  const found = (await findShipments(client, ref, claimAt - CREATED_SLACK_MS)).map(asMade);
  // A claim written before this file (no `shipments` on it): how many parcels it was for is not known — never guessed.
  const legacy = claim.shipments == null;
  const wanted = Math.max(1, Number(claim.shipments) || 1);
  const locker = claim.locker && typeof claim.locker === "object" ? claim.locker : (order?.shipping?.partial?.locker ?? null);
  const earlier = partialShipments(order);
  const made = mergeMade(earlier, found);

  if (found.length) {
    if (legacy) return flag(`Packed, but the courier booking was never confirmed: Courier Guy shows ${found.map((m) => m.waybill).join(", ")} for ${ref}, and the attempt did not record how many parcels it was for — press Retry courier once the parcels are counted`);
    if (made.length > wanted) return flag(`Packed, but Courier Guy has ${made.length} shipments for ${ref} where ${wanted} ${wanted === 1 ? "was" : "were"} booked (${made.map((m) => m.waybill).join(", ")}) — possibly booked twice; nothing attached`);
    if (made.length < wanted) {
      if (!locker?.id) return flag(`Packed, but only ${made.length} of ${wanted} shipments for ${ref} exist at Courier Guy (${made.map((m) => m.waybill).join(", ")}) and the attempt recorded no locker — nothing re-booked`);
      // The parcels Courier Guy did make become the checkpoint bookShipment finishes from (same locker, only the rest).
      const ok = await moveClaim({ state: "failed", at: t, error: str(claim.error).slice(0, 300), released: `found ${made.length} of ${wanted} shipments at Courier Guy`, rebooks: Number(claim.rebooks) || 0 });
      if (!ok) return { action: "raced" };
      await db.ref(`${base}/shipping/partial`).set(plain({ count: wanted, locker, shipments: made, at: t }));
      await db.ref(base).update(backToPending(order, t));
      log(`unknownBooking ${key} ${ref}: ${made.length} of ${wanted} shipments at Courier Guy (${made.map((m) => m.waybill).join(", ")}) — the rest re-booked`);
      return { action: "partial", waybills: made.map((m) => m.waybill) };
    }
    const first = made[0];
    const waybills = made.map((m) => m.waybill).filter(Boolean);
    // The claim carries the waybill FIRST: a crash before the order's fields land still reads as "booked" (shipOrder
    // takes courierBooking.waybill, bookShipment's "booked but not recorded"), never as free to book again.
    const ok = await moveClaim(plain({ state: "booked", at: t, recovered: true, shipmentId: first.shipmentId, waybill: first.waybill, ...(made.length > 1 ? { waybills } : {}) }));
    if (!ok) return { action: "raced" };
    const bookedAt = Math.max(...found.map((m) => Number(m.createdAt) || 0)) || t;
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
      ...(locker ? { deliveryLocker: plain(locker), deliveryMode: "locker", waybills, shipments: plain(made) } : {}),
      partial: null,
      courierBooking: { state: "booked", at: t, recovered: true, shipmentId: first.shipmentId, waybill: first.waybill },
    };
    // ONE multi-path write: the order's fields and the claim land together.
    const patch = Object.fromEntries(Object.entries(plain(shipping)).map(([k, v]) => [`shipping/${k}`, v]));
    patch["shipping/partial"] = null;
    if (order?.fulfilState === "courier_failed") Object.assign(patch, backToPending(order, t));
    await db.ref(base).update(patch);
    try { await db.ref(`shipping_recon/open/${key}`).set(t); } catch { /* the reconciliation set is a convenience */ }
    log(`unknownBooking ${key} ${ref}: Courier Guy HAS the shipment — ${waybills.join("+") || first.waybill} attached`);
    return { action: "attached", waybill: first.waybill, waybills };
  }

  if (t - claimAt < waitMs) return { action: "wait", inMs: waitMs - (t - claimAt) };
  if (legacy && earlier.length) return flag(`Packed, but the courier booking was never confirmed and an earlier part of the split (${earlier.map((m) => m.waybill).join(", ")}) is on the order — press Retry courier once the parcels are counted`);
  if (Number(claim.rebooks) >= MAX_AUTO_REBOOKS) {
    return flag(`Packed, but Courier Guy was not booked: no shipment for ${ref} at Courier Guy, after one automatic re-book (${str(claim.error).slice(0, 200) || "the answer was lost"})`, "gave_up");
  }
  // The live switch off: nothing is released (the re-book would only be a dry run, and the allowance is kept).
  if (!(await readLive(db))) return { action: "live_off" };
  // Released only while it is the very claim just checked: never a second waybill. `released` lets bookShipment count
  // the re-book on its claim once it gets that far (courierBooking.rebooks).
  const ok = await moveClaim({ state: "failed", at: t, error: str(claim.error).slice(0, 300), released: "no shipment at Courier Guy", rebooks: Number(claim.rebooks) || 0 });
  if (!ok) return { action: "raced" };
  await db.ref(base).update({
    "shipping/unknownRecheck": { releasedAt: t, claimAt, error: str(claim.error).slice(0, 300) },
    ...backToPending(order, t),
  });
  // Looked at once more later: a create that landed after all would be a second shipment.
  try { await db.ref(`${RELEASED_PATH}/${key}`).set({ ref, claimAt, releasedAt: t, wanted }); } catch { /* the late check is a convenience */ }
  log(`unknownBooking ${key} ${ref}: no shipment at Courier Guy ${Math.round((t - claimAt) / 60000)} min after the attempt — claim released, booked once more`);
  return { action: "rebook" };
}

/**
 * 30 minutes after a release: more shipments for the order than it needs (the lost create landed after all, and the
 * re-book made another) → attention on the order. Each released order is looked at once. → [{ key, action }]
 */
export async function lateShipmentCheck({ db, client, now = () => Date.now(), log = () => {} }) {
  const all = (await db.ref(RELEASED_PATH).get()).val() ?? {};
  const out = [];
  const t = now();
  for (const [key, r] of Object.entries(all)) {
    if (!r || t - Number(r.releasedAt) < LATE_CHECK_MS) continue;
    try {
      const found = await findShipments(client, r.ref, Number(r.claimAt) - CREATED_SLACK_MS);
      const wanted = Math.max(1, Number(r.wanted) || 1);
      if (found.length > wanted) {
        const order = (await db.ref(`online_orders/${assertSafeSegment(key, "order key")}`).get()).val();
        const reason = `Courier Guy has ${found.length} shipments for ${r.ref} where ${wanted} ${wanted === 1 ? "was" : "were"} booked (${found.map((s) => s.short_tracking_reference).join(", ")}) — the lost create landed after the re-book; one is a double booking`;
        const u = attentionUpdate(order, reason, t);
        if (u) await db.ref(`online_orders/${key}`).update(u);
        log(`unknownBooking ${key} ${r.ref}: ${reason}`);
        out.push({ key, action: "double" });
      } else out.push({ key, action: "ok" });
      await db.ref(`${RELEASED_PATH}/${key}`).remove();
    } catch (e) {
      log(`unknownBooking ${key}: late check failed — ${String(e?.message || e).slice(0, 200)}; tried again next sweep`);
      out.push({ key, action: "error" });
    }
  }
  return out;
}

/**
 * Every order left "courier not booked" with an "unknown" claim (the indexed fulfilState query), then the late check.
 * → [{ key, ref, action, … }]
 * @param {object} deps { db, client, now, log, waitMs, orders? }
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
  try { for (const r of await lateShipmentCheck(deps)) if (r.action !== "ok") out.push({ ...r, ref: r.key }); }
  catch (e) { log(`unknownBooking: late check failed — ${String(e?.message || e).slice(0, 200)}`); }
  return out;
}
