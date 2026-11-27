#!/usr/bin/env node
// ── The first sweep: orders "Packed, courier not booked" because there was NO LOCKER (Junid, 24 Nov 2026)
// "STANDING RULE … if no Courier Guy locker is near the customer (like #2411 Alistair, Jansenville: 'no locker within
// 30 km'), book DOOR-TO-DOOR delivery to their address automatically instead of failing", and: "Retry every order
// that's currently 'courier not booked' for this reason."
//
// Under the 20 Nov rule those orders were refused and sit at fulfilState "courier_failed" (shipping/booking
// { noLocker: true }). The poller's tick now hands each one back ONCE by itself (poll.mjs retryNoLockerOrders); this is
// the same sweep by hand, to see first what it will book and at what price.
//
//   node scripts/shipping/retry-no-locker.mjs                 DRY RUN (--dry means the same): lists every such order
//                                                             and what it WOULD book, with the door-to-door rate
//                                                             Courier Guy quotes now. Rates and lookups only.
//   node scripts/shipping/retry-no-locker.mjs --commit        BOOK them, each through bookShipment (the same claim,
//                                                             ceiling and live switch as every booking), then hand
//                                                             the order back to the ship step, which fulfils Shopify
//                                                             with the waybill and queues the >R250 email.
//   … --only <orderKey>                                       one order
//
// WHICH ORDERS: bookShipment.mjs doorRetryDue — packed, courier_failed, the CURRENT reason a no-locker one ("no Courier
// Guy locker within N km …", "the parcel is bigger or heavier than the largest … locker box", "Courier Guy quoted no
// door-to-locker service to the lockers near …"), nothing booked or half booked, no claim held, no locker a person
// named, and not already handed back. An address that could not be placed on the map is NOT one of them.
//
// ONCE: --commit claims shipping/doorRetry by transaction before it books (bookShipment.mjs claimDoorRetry: doorRetryDue
// re-checked on the order as it is then), exactly as the tick does, so the two never both try an order and neither
// tries it twice. A booking whose hand-back to the ship step does not land is finished by the tick (doorHandBackDue). An order whose door-to-door booking is refused too (over the ceiling,
// no rate) keeps "Packed, courier not booked" with the new reason and waits for a person.
// With /config/shipping/live off, --commit books nothing and claims nothing (it prints the dry run).
import { pathToFileURL } from "node:url";
import { bookShipment, planShipment, readLive, doorRetryDue, bookingRef, claimDoorRetry, handBackBooked } from "./bookShipment.mjs";

const ORDERS = "online_orders";
const short = (v, n = 200) => String(v ?? "").slice(0, n);
const townOf = (order) => String(order?.shipping?.address?.city ?? order?.shipping?.address?.suburb ?? "").trim() || "?";

/** Every order at fulfilState "courier_failed" (the indexed query, never the whole list). → { key: order } */
export async function failedOrders(db) {
  return (await db.ref(ORDERS).orderByChild("fulfilState").equalTo("courier_failed").get()).val() ?? {};
}

/**
 * @param {object} o  { db, client, commit?, only?, orders? (tests: the courier_failed orders), log?, now?, geocoder? }
 * → { live, commit, rows: [{ key, ref, town, reason, would?, quote?, blockers?, booked?, waybill?, cost?, error?, skipped? }] }
 */
export async function retryNoLocker({ db, client, commit = false, only = null, orders = null, log = () => {}, now = () => Date.now(), geocoder } = {}) {
  const all = orders ?? (await failedOrders(db));
  const due = Object.entries(all).filter(([key, o]) => (!only || key === String(only)) && doorRetryDue(o));
  const live = await readLive(db);
  const book = commit && live;
  const geo = geocoder ? { geocoder } : {};
  const rows = [];
  for (const [key, listed] of due) {
    const row = { key, ref: bookingRef({ ...listed, key }), town: townOf(listed), reason: doorRetryDue(listed) };
    rows.push(row);
    try {
      if (!book) {
        // What it would book now: rates and lookups only, nothing written.
        const plan = await planShipment({ ...listed, key }, { db, client, ...geo });
        if (!plan.ok) { row.would = "still refuse"; row.error = short(plan.reason); continue; }
        row.quote = { code: plan.chosen.rate.code, rate: plan.chosen.rate.rate };
        row.blockers = plan.liveBlockers;
        row.would = plan.locker ? `door-to-locker (${plan.locker.name}, ${plan.locker.km} km: a locker is near now)` : plan.doorFallback ? "door-to-door" : "door-to-door (deliveryMode is door)";
        continue;
      }
      // The once, shared with the tick (poll.mjs retryNoLockerOrders): doorRetryDue re-checked on the order as it is
      // NOW and shipping/doorRetry written in the same transaction (CodeRabbit, #984), so an order that was retried,
      // shipped, re-failed for another reason or put on a condition hold since the listing is never booked from it.
      const fresh = await claimDoorRetry(db, key, { by: "cli", at: now() });
      if (!fresh) { row.skipped = "no longer due (already handed back, or it changed since the listing)"; continue; }
      let res;
      try { res = await bookShipment({ ...fresh, key }, { db, client, log, now, ...geo }); }
      catch (err) { res = { skipped: true, error: short(err?.message || err, 300) }; }
      const { shipping: _whole, ...result } = res ?? {};
      // The record the ship step keeps (poll.mjs shipOrder): this attempt's result, the newer reason either way.
      const record = () => db.ref(`${ORDERS}/${key}/shipping/booking`).set(JSON.parse(JSON.stringify({ ...result, at: now() })))
        .catch((e) => log(`retry-no-locker ${key}: booking record not written — ${short(e?.message || e)}`));
      // Junid's line, in the slot the ship step uses: <key>-door (booked) / <key>-door-refused (not booked either).
      const queueLine = async (slot) => {
        if (!res?.junidLine) return;
        try {
          const lineRef = db.ref(`shipping_recon/junidLines/${slot}`);
          if (!(await lineRef.get()).exists()) await lineRef.set({ orderId: key, text: res.junidLine, at: now() });
        } catch (e) { log(`retry-no-locker ${key}: Junid's line not queued — ${short(e?.message || e)}`); }
      };
      if (res && !res.skipped && res.waybill) {
        Object.assign(row, { booked: true, waybill: res.waybill, service: res.service ?? null, cost: res.cost ?? null, mode: res.deliveryMode ?? (res.deliveryLocker ? "locker" : "door") });
        // None of these may undo a booking that is made.
        await record();
        await queueLine(`${key}-door`);
        await db.ref(`shipping_recon/open/${key}`).set(now()).catch(() => {});
        // Back to the ship step (what the POS Retry writes): it finds the waybill ("already booked"), fulfils Shopify
        // with it and queues the cost alert. It never books again: the claim is "booked" and the order has its
        // shipmentId. In one transaction, only while the order still says "courier not booked"; when this write does
        // not land, the tick finishes it (poll.mjs retryNoLockerOrders, doorHandBackDue).
        const handed = await handBackBooked(db, key, { at: now() }).catch((e) => { log(`retry-no-locker ${key}: hand-back failed — ${short(e?.message || e)}`); return false; });
        row.handedBack = handed;
        log(`retry-no-locker ${key} ${row.ref} BOOKED ${res.waybill} ${res.service ?? ""} R${res.cost ?? "?"} (${row.mode}) — ${handed ? "handed to the ship step" : "hand-back left to the tick"}`);
      } else {
        // Still not booked: the order says the NEW reason (it was the door-to-door try that failed), and waits for a person.
        row.error = short(res?.error || res?.reason || "no waybill came back", 300);
        if (res?.dryRun) { row.skipped = "the live switch went off: nothing booked"; continue; }
        await record();
        await queueLine(`${key}-door-refused`);
        await db.ref(`${ORDERS}/${key}`).update({
          courierError: row.error,
          attention: { kind: "courier_failed", reason: `Packed, but Courier Guy was not booked: ${row.error}`, at: now() }, attentionOpen: true,
          updatedAt: now(),
        });
        log(`retry-no-locker ${key} ${row.ref} NOT BOOKED ${row.error}`);
      }
    } catch (err) {
      row.error = short(err?.message || err, 300);
      log(`retry-no-locker ${key} FAILED ${row.error}`);
    }
  }
  return { live, commit: book, asked: commit, failed: Object.keys(all).length, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit") && !args.includes("--dry");
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  // "--only" with no order key after it would fall back to EVERY order (CodeRabbit, #984): refused before anything runs.
  if (args.includes("--only") && (!only || only.startsWith("--"))) {
    console.error("--only needs an order key: node scripts/shipping/retry-no-locker.mjs [--commit] --only <orderKey>");
    process.exit(2);
  }
  const { adminDb } = await import("./adminDb.mjs");
  const { createCourierClient, fileLogger } = await import("./courier-client.mjs");
  const file = fileLogger();
  const out = await retryNoLocker({ db: adminDb(), client: createCourierClient(), commit, only, log: (l) => { console.log(l); file(l); } });
  const R = (n) => (Number.isFinite(Number(n)) ? `R${Number(n).toFixed(2)}` : "R?");
  console.log(`\n${out.rows.length} of ${out.failed} "courier not booked" order(s) are there because of no locker${out.commit ? "" : ` — ${out.asked ? "the live switch is OFF, so this is a " : ""}DRY RUN, nothing booked, nothing written`}:`);
  for (const r of out.rows) {
    const what = r.booked ? `BOOKED ${r.mode} ${r.service ?? ""} ${R(r.cost)}, waybill ${r.waybill}`
      : r.skipped ? `skipped: ${r.skipped}`
      : r.would && r.quote ? `would book ${r.would}: ${r.quote.code} ${R(r.quote.rate)}${r.blockers?.length ? ` — BUT live would refuse: ${r.blockers.join(", ")}` : ""}`
      : `NOT booked: ${r.error ?? "?"}`;
    console.log(`  ${r.ref} (${r.key}) ${r.town}: ${what}\n      was: ${r.reason}`);
  }
  if (!out.commit && out.rows.length) console.log("\nAdd --commit to book them (the poller's tick also hands each back once by itself).");
  process.exit(0);
}
