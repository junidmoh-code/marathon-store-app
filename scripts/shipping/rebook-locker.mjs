#!/usr/bin/env node
// ── Rebook an order to ANOTHER locker, before it is collected (Junid, 20 Nov 2026)
// A door-to-locker booking names the Courier Guy locker nearest the customer.
// When that is the wrong one (the customer asks for another, the locker is
// full or awkward), and the courier has NOT yet collected the parcel from us,
// this cancels the booked shipment(s) and books the same parcel(s) to another
// locker.
//
//   node scripts/shipping/rebook-locker.mjs <orderKey>                    DRY RUN: the nearest OTHER locker
//   node scripts/shipping/rebook-locker.mjs <orderKey> --locker <id>      DRY RUN: that locker (a pickup_point_id)
//   node scripts/shipping/rebook-locker.mjs <orderKey> --parcels <n>      DRY RUN: as n one-shoe parcels (Courier Guy
//                                                                         refused the parcel as too big for one)
//   … --book                                                             DO IT (and only with /config/shipping/live true)
//
// THE DEFAULT IS A DRY RUN (--dry is accepted and means the same): it reads
// the shipment's status and prices the new locker (reads and rates only),
// prints what it would do and changes nothing. With --book it:
//   1. checks every shipment of the booking is still uncollected at Courier Guy
//   2. prices the new locker FIRST (nothing is cancelled if the new one cannot be booked)
//   3. cancels the old shipment(s) through cancelShipment (bookShipment.mjs)
//   4. keeps the old booking under shipping/rebooks/{ms}, clears it, and
//   5. books again through bookShipment: the same claim, ceiling and live rules.
// Both calls that change anything at Courier Guy go through bookShipment.mjs,
// whose live-switch guard is the one the tests and the mutation proof pin.
//
// NOT DONE HERE: the tracking number on the Shopify order. It still shows the
// cancelled waybill; the new one is on the order's shipping node (what Jamie
// reads). Change it on Shopify by hand if the customer was sent the old link.
import { pathToFileURL } from "node:url";
import { bookShipment, cancelShipment, planShipment, readLive, isExchangeKey, isReshipKey } from "./bookShipment.mjs";
import { shipmentsOf } from "./reconcile.mjs";

// Courier Guy's statuses BEFORE the driver has the parcel (a create answers "collection-assigned").
export const UNCOLLECTED = /^(submitted|collection-(assigned|unassigned|rejected|exception|failed-attempt))$/;
// One rebook at a time per order (two at once could each clear the other's new booking and book a second one).
export const REBOOK_LOCK_MS = 10 * 60_000;
const BOOKING_FIELDS = ["shipmentId", "waybill", "trackingReference", "waybills", "shipments", "service", "cost", "priced", "quotes", "parcel", "deliveryLocker", "doorQuote", "bookedAt", "cancelledAt", "cancel", "courierBooking", "booking", "partial", "invoiced", "adjustment", "costAlert", "provider", "deliveryMode", "doorFallback"];

/**
 * @param {string} key   the /online_orders key
 * @param {object} o     { db, client, lockerId?, parcels?, book?, log?, now?, geocoder? }
 * → { ok: false, reason } | { ok: true, dryRun: true, from, to, quote, shipments } | { ok: true, booked: shipping, from, to }
 */
export async function rebookLocker(key, { db, client, lockerId = null, parcels = null, book = false, log = () => {}, now = () => Date.now(), geocoder } = {}) {
  if (!/^\d+$/.test(key) && !isExchangeKey(key) && !isReshipKey(key)) return { ok: false, reason: `"${key}" is not an /online_orders key` };
  const at = `online_orders/${key}`;
  const order = { ...((await db.ref(at).get()).val() ?? {}), key };
  const s = order.shipping ?? {};
  // A REBOOK LEFT HALF DONE: the old booking was cancelled and cleared, and the new one was not made (Courier Guy
  // refused it, the machine stopped). Only the booking is left to do; run again to do it.
  const last = Object.values(s.rebooks ?? {}).sort((a, b) => (b?.cancelledAt ?? 0) - (a?.cancelledAt ?? 0))[0];
  if (last && !(s.trackingReference || s.waybill) && s.shipmentId == null) {
    const again = { ...order, shipping: { ...s, ...(lockerId ? { lockerChoice: { id: String(lockerId), by: "rebook" }, lockerAvoid: null } : {}), ...(Number.isInteger(parcels) && parcels >= 1 ? { lockerParcels: parcels } : {}) } };
    const plan = await planShipment(again, { db, client, ...(geocoder ? { geocoder } : {}) });
    if (!plan.ok || !plan.locker) return { ok: false, reason: `the new locker cannot be booked: ${plan.reason ?? "deliveryMode is door"}` };
    const from = { id: last.deliveryLocker?.id ?? null, name: last.deliveryLocker?.name ?? "?", waybills: last.waybills ?? [] };
    const to = { id: plan.locker.id, name: plan.locker.name, address: plan.locker.address, km: plan.locker.km };
    if (!book || !(await readLive(db))) return { ok: true, dryRun: true, resume: true, from, to, quote: { code: plan.chosen.rate.code, rate: plan.chosen.rate.rate }, shipments: plan.payloads.length };
    let booked;
    try { booked = await bookShipment(again, { db, client, log, now, ...(geocoder ? { geocoder } : {}) }); }
    catch (err) { return { ok: false, cancelled: true, reason: `the old booking is CANCELLED and the new one failed again (${String(err?.message || err).slice(0, 200)}). Check the portal before another try.` }; }
    if (booked?.skipped) return { ok: false, cancelled: true, reason: `the old booking is CANCELLED and the new one was still not made: ${booked.reason ?? "dry run"}` };
    await db.ref(`shipping_recon/open/${key}`).set(now()).catch(() => {});
    log(`rebook-locker ${key} REBOOKED (resumed) → ${(booked.waybills ?? [booked.waybill]).join("+")} (${to.name})`);
    return { ok: true, booked, from, to, resumed: true };
  }
  if (s.provider !== "courier_guy" || !(s.trackingReference || s.waybill)) return { ok: false, reason: "no Courier Guy booking on this order" };
  // A parcel that went door-to-door because there was no locker (Junid, 24 Nov 2026) has no locker to move from.
  if (!s.deliveryLocker?.id && s.doorFallback?.reason) return { ok: false, reason: `this booking is door-to-door (${s.doorFallback.reason}): there is no locker to rebook from` };
  if (!s.deliveryLocker?.id) return { ok: false, reason: "this booking is not door-to-locker (no shipping/deliveryLocker)" };

  // 1. Still uncollected? Asked of Courier Guy, for every shipment of the booking.
  const old = shipmentsOf(s);
  if (!s.cancelledAt) {
    for (const m of old) {
      const res = await client.getShipments({ tracking_reference: m.ref });
      const row = (res?.shipments ?? []).find((x) => x.short_tracking_reference === m.ref || x.custom_tracking_reference === m.ref);
      const status = String(row?.status ?? "");
      if (!row) return { ok: false, reason: `Courier Guy does not list ${m.ref}` };
      if (!UNCOLLECTED.test(status)) return { ok: false, reason: `${m.ref} is "${status}" at Courier Guy: already collected (or finished), it cannot be rebooked` };
    }
  }

  // 2. The new booking, priced before anything is cancelled.
  const count = Number.isInteger(parcels) && parcels >= 1 ? parcels : (old.length || 1);
  const kept = Object.fromEntries(Object.entries(s).filter(([k]) => !BOOKING_FIELDS.includes(k)));
  const choice = lockerId ? { lockerChoice: { id: String(lockerId), by: "rebook" }, lockerAvoid: null } : { lockerChoice: null, lockerAvoid: [s.deliveryLocker.id] };
  const next = { ...order, shipping: { ...kept, ...choice, lockerParcels: count } };
  const plan = await planShipment(next, { db, client, ...(geocoder ? { geocoder } : {}) });
  if (!plan.ok) return { ok: false, reason: `the new locker cannot be booked: ${plan.reason}` };
  if (!plan.locker) return { ok: false, reason: "/config/shipping/deliveryMode is \"door\": there is no locker to rebook to" };
  if (plan.locker.id === s.deliveryLocker.id && count === old.length && !s.cancelledAt) return { ok: false, reason: `it is already booked to ${plan.locker.name} (${plan.locker.id})` };
  if (plan.liveBlockers.length) return { ok: false, reason: `the new booking would be refused: ${plan.liveBlockers.join(", ")}` };
  const from = { id: s.deliveryLocker.id, name: s.deliveryLocker.name, waybills: old.map((m) => m.waybill) };
  const to = { id: plan.locker.id, name: plan.locker.name, address: plan.locker.address, km: plan.locker.km };
  const quote = { code: plan.chosen.rate.code, rate: plan.chosen.rate.rate };

  const live = await readLive(db);
  if (!book || !live) {
    log(`rebook-locker ${key} DRY RUN${book && !live ? " (live is off)" : ""}: would cancel ${from.waybills.join("+")} (${from.name}) and book ${plan.payloads.length} parcel(s) to ${to.name} (${to.id}) at R${quote.rate} each`);
    return { ok: true, dryRun: true, from, to, quote, shipments: plan.payloads.length };
  }

  // The lock, then the booking read AGAIN under it: a rebook that finished meanwhile is not undone.
  const lockRef = db.ref(`${at}/shipping/rebooking`);
  const lock = await lockRef.transaction((cur) => (cur && now() - Number(cur.at) < REBOOK_LOCK_MS ? undefined : { at: now() }));
  if (!lock.committed) return { ok: false, reason: "another rebook of this order is running (shipping/rebooking); wait for it to finish" };
  try {
    return await rebookUnderLock();
  } finally {
    await lockRef.remove().catch(() => {});
  }

  async function rebookUnderLock() {
  const seen = (await db.ref(`${at}/shipping/waybill`).get()).val() ?? null;
  if (seen !== (s.waybill ?? null)) return { ok: false, reason: "the booking changed while this was being planned; run it again" };
  // 3. Cancel (cancelShipment re-reads live itself; a refusal from Courier Guy throws and nothing below runs).
  if (!s.cancelledAt) {
    const c = await cancelShipment(order, { db, client, log, now });
    if (c?.skipped) return { ok: false, reason: `not cancelled: ${c.reason ?? "live is off"}` };
  }
  // 4. The old booking is kept, then cleared so the order can be booked again.
  const stamp = now();
  await db.ref(`${at}/shipping`).update({
    [`rebooks/${stamp}`]: JSON.parse(JSON.stringify({ waybills: from.waybills, shipments: s.shipments ?? null, shipmentId: s.shipmentId ?? null, deliveryLocker: s.deliveryLocker, service: s.service ?? null, cost: s.cost ?? null, bookedAt: s.bookedAt ?? null, cancelledAt: stamp })),
    ...Object.fromEntries(BOOKING_FIELDS.map((k) => [k, null])),
    // PINNED to the locker that was just priced: if it cannot be booked now, nothing else is chosen silently.
    lockerChoice: { id: plan.locker.id, by: "rebook" }, lockerAvoid: choice.lockerAvoid, lockerParcels: count,
  });
  // 5. Book again: the same claim, ceiling and live rules as any booking.
  const fresh = { ...((await db.ref(at).get()).val() ?? {}), key };
  let booked;
  try { booked = await bookShipment(fresh, { db, client, log, now, ...(geocoder ? { geocoder } : {}) }); }
  catch (err) { return { ok: false, cancelled: true, reason: `the old booking is CANCELLED but the new one failed (${String(err?.message || err).slice(0, 200)}). Run this again with --book, or book it in the portal.` }; }
  if (booked?.skipped) return { ok: false, cancelled: true, reason: `the old booking is CANCELLED but the new one was not made: ${booked.reason ?? "dry run"}. Run this again, or book it in the portal.` };
  await db.ref(`shipping_recon/open/${key}`).set(stamp).catch(() => {});
  log(`rebook-locker ${key} REBOOKED ${from.waybills.join("+")} (${from.name}) → ${(booked.waybills ?? [booked.waybill]).join("+")} (${to.name})`);
  return { ok: true, booked, from, to };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const key = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--locker" && args[args.indexOf(a) - 1] !== "--parcels");
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (!key) { console.error("usage: node scripts/shipping/rebook-locker.mjs <orderKey> [--locker <id>] [--parcels <n>] [--dry | --book]"); process.exit(2); }
  const book = args.includes("--book") && !args.includes("--dry");
  const { adminDb } = await import("./adminDb.mjs");
  const { createCourierClient, fileLogger } = await import("./courier-client.mjs");
  const file = fileLogger();
  const out = await rebookLocker(key, {
    db: adminDb(), client: createCourierClient(), lockerId: opt("--locker"), parcels: opt("--parcels") ? Number(opt("--parcels")) : null, book,
    log: (l) => { console.log(l); file(l); },
  });
  if (!out.ok) { console.error(`NOT REBOOKED: ${out.reason}`); process.exit(1); }
  if (out.dryRun) console.log(`Nothing was changed. From ${out.from.name} (${out.from.id}) to ${out.to.name} (${out.to.id}, ${out.to.address}, ${out.to.km} km), ${out.shipments} parcel(s), ${out.quote.code} R${out.quote.rate} each. Add --book to do it.`);
  else console.log(`Rebooked to ${out.to.name} (${out.to.id}): waybill ${(out.booked.waybills ?? [out.booked.waybill]).join(", ")}. The Shopify order still shows the old tracking number.`);
  process.exit(0);
}
