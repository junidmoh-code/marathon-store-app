#!/usr/bin/env node
// ── ADDRESS HOLD: the gate's order-side half (Junid, 24 Nov 2026) ─────────────
// "No Courier Guy booking unless the waybill's suburb, town and postal code match the customer's address. On a
// mismatch, hold and confirm on WhatsApp." addressCheck.mjs decides whether an address is consistent; this file is
// what happens to the ORDER when it is not:
//
//   the gate        addressGate(order, cfg) is asked by planShipment (bookShipment.mjs: every outgoing booking, from
//                   the fast-ship listener, the tick, rebook-locker, retry-no-locker, the unknown-booking re-book, an
//                   exchange's replacement) and by planReturn (bookReturn.mjs: every return, Jamie's included). A
//                   failing address books NOTHING. /config/shipping/addressCheck false switches the gate off (no deploy).
//   the hold        online_orders/{key}/shipping/addressHold { at, why, kind, zipSays, addressSays, state, sig }:
//                   state "asking" (the customer is asked), "held" (a locker outside the customer's area: a person
//                   looks), "confirmed" (a person or the customer confirmed THIS exact address: sig = its fingerprint;
//                   the gate then lets it through). The order itself shows "Packed, courier not booked: address check:
//                   …" (poll.mjs), and the POS Retry only re-asks the gate, which holds it again until it is fixed.
//                   shipping_recon/addressHolds/{key} indexes the open holds for the sweep.
//   the question    sweepAddressHolds (fast-ship.mjs, every 5 minutes) queues ONE WhatsApp to the customer through
//                   Jamie (marathon-dm-agent bin/jimmy-send.mjs, kind lifecycle, sub order_first, ref address:<key>: a
//                   WhatsApp-first order message) naming the two parts that disagree and asking which is right, and
//                   ONE line to Junid (shipping_recon/junidLines/<key>-address, sent at once through Jamie too).
//   the answer      node scripts/shipping/addressHold.mjs --confirm <key> [--zip 4031] [--suburb X] [--city Y]
//                   [--province Z] [--as-is] [--by jamie]
//                   writes the corrected parts onto shipping/address, re-asks the gate, and only when it now passes (or
//                   --as-is confirms the address exactly as it stands) clears the hold and hands a packed order back to
//                   the ship step (the POS Retry). Jamie's brain can run the same command once the customer answers.
//
//   node scripts/shipping/addressHold.mjs --status <key>      what the gate says about one order (read only)
//   node scripts/shipping/addressHold.mjs --scan [--days 5]   every booking of the last N days the gate would
//                                                             have held (read only; today's wrong-booking audit)
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkAddress, checkLockerArea, addressFingerprint, addressParts } from "./addressCheck.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

export const HOLD_INDEX = "shipping_recon/addressHolds";
export const HOLD_REASON_PREFIX = "address check: ";
const str = (v) => String(v ?? "").trim();
const rawAddress = (order) => order?.shipping?.address ?? order?.shippingAddress ?? order?.shipping_address ?? {};
const firstName = (order) => str(order?.customer?.name || order?.shipping?.address?.name).split(/\s+/)[0] || "";
const orderNo = (order, key) => str(order?.orderNumber ? `#${order.orderNumber}` : order?.shopifyName || key);

/** A confirmation for THIS exact address (a person or the customer said it is right as it stands)? Pure. */
export function confirmedFor(order) {
  const h = order?.shipping?.addressHold;
  return !!h && h.state === "confirmed" && h.sig === addressFingerprint(rawAddress(order));
}

/**
 * THE GATE. → null (book) | { reason, hold, check } (do not book). Pure.
 * hold: the record addressHold gets: { kind, why, zipSays, addressSays, state, sig }.
 */
export function addressGate(order, cfg = {}) {
  if (cfg?.addressCheck === false) return null;
  const check = checkAddress(rawAddress(order));
  if (check.ok || confirmedFor(order)) return null;
  return { reason: `${HOLD_REASON_PREFIX}${check.why}`, check, hold: holdRecord(order, check, "asking") };
}

/**
 * The locker half: the chosen locker must be in the customer's area. → null | { reason, hold }. Pure.
 * A person who confirmed the exact address (confirmedFor) has also accepted its locker area.
 */
export function lockerGate(order, locker, cfg = {}) {
  if (cfg?.addressCheck === false || !locker || confirmedFor(order)) return null;
  const check = checkAddress(rawAddress(order));
  if (!check.ok) return null; // addressGate already holds it
  const lk = checkLockerArea(locker, check);
  if (lk.ok) return null;
  const why = `the chosen locker is not in the customer's area: ${lk.why}`;
  return { reason: `${HOLD_REASON_PREFIX}${why}`, hold: { ...holdRecord(order, { ...check, kind: "locker", why }, "held"), locker: { id: str(locker.id), name: str(locker.name), km: lk.km ?? null } } };
}

function holdRecord(order, check, state) {
  return JSON.parse(JSON.stringify({
    kind: check.kind ?? "mismatch", why: str(check.why).slice(0, 400), state,
    zipSays: check.zipSays?.text ?? check.code ?? null, zipPlace: check.zipSays?.place ?? null, zipProvince: check.zipSays?.province ?? null,
    addressSays: check.addressSays ?? null, addressPlace: check.addressPlace ?? null, addressCodes: check.addressCodes ?? null,
    code: check.code ?? null, sig: addressFingerprint(rawAddress(order)),
  }));
}

/**
 * Write the hold on the order (and the index), ONCE per address: a hold already standing for the same address is
 * kept as it is (its askedAt with it, so the customer is never asked twice). → { raised: boolean, hold }
 */
export async function raiseHold(db, key, hold, { now = Date.now() } = {}) {
  assertSafeSegment(key, "order key");
  let raised = false;
  const tx = await db.ref(`online_orders/${key}/shipping/addressHold`).transaction((cur) => {
    if (cur && cur.sig === hold.sig && cur.state !== "cleared") return undefined;
    raised = true;
    return { ...hold, at: now };
  });
  const value = tx?.snapshot?.val?.() ?? hold;
  if (raised && tx?.committed) await db.ref(`${HOLD_INDEX}/${key}`).set({ at: now, state: value.state, kind: value.kind });
  return { raised: raised && !!tx?.committed, hold: value };
}

/** The ONE WhatsApp to the customer: short, warm, names the two parts that disagree, asks which is right. Pure. */
export function askText(order, hold, key = "") {
  const name = firstName(order);
  const hi = name ? `Hi ${name}, ` : "Hi, ";
  const n = orderNo(order, key);
  const a = addressParts(rawAddress(order));
  const zip = hold.zipPlace ? `${hold.code} (${[hold.zipPlace, hold.zipProvince].filter(Boolean).join(", ")})` : str(hold.code || a.code);
  if (hold.kind === "mismatch" && hold.addressPlace) {
    return `${hi}about your Marathon Club order ${n}: your address says ${hold.addressPlace} but the postal code is ${zip}. Which is right, so your parcel goes to the right place?`;
  }
  if (hold.kind === "unmatched") {
    return `${hi}about your Marathon Club order ${n}: the postal code on it is ${zip}, but we could not match it to the suburb and town on your address (${[a.suburb, a.city].filter(Boolean).join(", ") || a.street}). Please send us your suburb, town and postal code, so your parcel goes to the right place.`;
  }
  return `${hi}about your Marathon Club order ${n}: the postal code on it (${str(a.code) || "none"}) is not a South African postal code we can find. Please send us your suburb, town and postal code, so your parcel goes to the right place.`;
}

/** Junid's one line for a hold. Pure. */
export function junidText(order, hold, key) {
  const n = orderNo(order, key);
  const what = hold.state === "asking" ? (hold.askError === "no customer phone" ? "No customer phone to ask: call or email them." : "Customer asked on WhatsApp which is right.") : "A person needs to look (no customer message).";
  return `${n}: Courier Guy NOT booked, address held: ${hold.why}. ${what} Fix: node scripts/shipping/addressHold.mjs --confirm ${key} --zip <code> (or --as-is).`;
}

/** Queue one WhatsApp through Jamie. → the outbox id (number) | null. */
export function jimmyQueue({ dir = process.env.COURIER_JIMMY_DIR || join(homedir(), "marathon-dm-agent"), log = () => {}, run = execFile } = {}) {
  const bin = join(dir, "bin", "jimmy-send.mjs");
  return (args) => new Promise((resolve) => {
    if (!existsSync(bin)) { log(`address hold: no ${bin} — kept for the next pass`); return resolve(null); }
    run(process.execPath, [bin, ...args], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) { log(`address hold: jimmy-send refused (${String(stderr || err.message).trim().slice(0, 300)}) — kept for the next pass`); return resolve(null); }
      const id = Number(String(stdout).match(/queued #(\d+)/)?.[1]);
      resolve(Number.isFinite(id) ? id : 0);
    });
  });
}

const JUNID = "27813995333";

/**
 * Every open hold not yet asked: the customer's ONE WhatsApp and Junid's ONE line. askedAt is claimed in a transaction
 * BEFORE the send (a crash can lose a question, never send it twice); a refused send releases it for the next pass.
 * → [{ key, asked, outboxId, junid }]
 */
export async function sweepAddressHolds({ db, queue = jimmyQueue(), now = () => Date.now(), log = () => {} }) {
  const open = (await db.ref(HOLD_INDEX).get()).val() ?? {};
  const out = [];
  for (const key of Object.keys(open)) {
    try {
      const order = (await db.ref(`online_orders/${assertSafeSegment(key, "order key")}`).get()).val();
      const hold = order?.shipping?.addressHold;
      if (!hold || ["cleared", "confirmed"].includes(hold.state)) { await db.ref(`${HOLD_INDEX}/${key}`).remove(); continue; }
      if (hold.askedAt || hold.junidAt) continue;
      const at = now();
      const claim = await db.ref(`online_orders/${key}/shipping/addressHold`).transaction((cur) => (cur && cur.sig === hold.sig && !cur.askedAt && !cur.junidAt ? { ...cur, junidAt: at, ...(cur.state === "asking" ? { askedAt: at } : {}) } : undefined));
      if (!claim?.committed) continue;
      const row = { key, asked: false, outboxId: null, junid: false };
      if (hold.state === "asking") {
        const phone = str(order?.customer?.phone || order?.shipping?.address?.phone || order?.exchange?.contactPhone);
        const text = askText(order, hold, key);
        const id = phone ? await queue(["--to", phone, "--kind", "lifecycle", "--sub", "order_first", "--ref", `address:${key}`, "--text", text]) : null;
        if (id == null && phone) {
          // Refused (quiet hours, the gate, the service down): released, asked again on the next pass.
          await db.ref(`online_orders/${key}/shipping/addressHold`).update({ askedAt: null, junidAt: null, askError: "jimmy-send refused (see the log)" });
          out.push(row);
          continue;
        } else if (id == null) {
          // No number to ask: Junid's line says so, once.
          await db.ref(`online_orders/${key}/shipping/addressHold`).update({ askError: "no customer phone" });
          row.error = "no customer phone";
        } else {
          await db.ref(`online_orders/${key}/shipping/addressHold`).update({ askedText: text, outboxId: id, askError: null });
          row.asked = true; row.outboxId = id;
          log(`address hold ${key}: customer asked on WhatsApp (outbox #${id}): ${text}`);
        }
      }
      const line = junidText(order, { ...hold, askError: row.error ?? null }, key);
      const sent = await queue(["--kind", "junid", "--to", JUNID, "--text", line, "--ref", `address-hold-${key}`]);
      await db.ref(`shipping_recon/junidLines/${key}-address`).set({ orderId: key, text: line, at, ...(sent != null ? { sentAt: at } : {}) });
      row.junid = sent != null;
      out.push(row);
    } catch (e) {
      log(`address hold ${key}: sweep failed — ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return out;
}

/**
 * The answer: the corrected parts onto shipping/address, the gate asked again; cleared (and a packed order handed back
 * to the ship step) only when it passes now, or when asIs confirms the address exactly as it stands.
 * → { ok, cleared, check, handedBack, why? }
 */
export async function confirmAddress(db, key, { zip, suburb, city, province, asIs = false, by = "cli", now = Date.now() } = {}) {
  assertSafeSegment(key, "order key");
  const ref = db.ref(`online_orders/${key}`);
  const order = (await ref.get()).val();
  if (!order) return { ok: false, why: `no order at online_orders/${key}` };
  const before = { ...(order.shipping?.address ?? {}) };
  const patch = {};
  if (zip != null) patch.zip = str(zip);
  if (suburb != null) patch.address2 = str(suburb);
  if (city != null) patch.city = str(city);
  if (province != null) patch.province = str(province);
  const after = { ...before, ...patch };
  const check = checkAddress(after);
  if (!check.ok && !asIs) return { ok: false, check, why: `still does not agree: ${check.why} (nothing written; pass --as-is to confirm it exactly as it is)` };
  const sig = addressFingerprint(after);
  const hold = order.shipping?.addressHold ?? {};
  const updates = {
    ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [`shipping/address/${k}`, v])),
    ...(Object.keys(patch).length ? { "shipping/addressBefore": before, "shipping/addressFixedAt": now, "shipping/addressFixedBy": by } : {}),
    "shipping/addressHold": { ...hold, state: check.ok ? "cleared" : "confirmed", sig, resolvedAt: now, resolvedBy: by, ...(check.ok ? {} : { confirmedAsIs: true }) },
    updatedAt: now,
  };
  // A packed order the gate stopped goes back to the ship step (the POS Retry), and only that one.
  const stopped = order.status === "packed" && order.fulfilState === "courier_failed" && str(order.courierError).startsWith(HOLD_REASON_PREFIX);
  if (stopped) Object.assign(updates, { fulfilState: "pending", "fulfil/state": "pending", courierError: null, ...(order.attention?.kind === "courier_failed" ? { attention: null, attentionOpen: null } : {}) });
  await ref.update(updates);
  await db.ref(`${HOLD_INDEX}/${key}`).remove();
  return { ok: true, cleared: check.ok, check, handedBack: stopped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
  const { adminDb } = await import("./adminDb.mjs");
  const db = adminDb();
  if (arg("status")) {
    const key = arg("status");
    const order = (await db.ref(`online_orders/${assertSafeSegment(key, "order key")}`).get()).val();
    console.log(JSON.stringify({ address: rawAddress(order), check: checkAddress(rawAddress(order)), locker: order?.shipping?.deliveryLocker ? checkLockerArea(order.shipping.deliveryLocker, checkAddress(rawAddress(order))) : null, hold: order?.shipping?.addressHold ?? null }, null, 2));
  } else if (arg("confirm")) {
    const out = await confirmAddress(db, arg("confirm"), { zip: arg("zip"), suburb: arg("suburb"), city: arg("city"), province: arg("province"), asIs: argv.includes("--as-is"), by: arg("by") || "cli" });
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.ok ? 0 : 2;
  } else if (argv.includes("--scan")) {
    const days = Number(arg("days") || 5);
    const client = (await import("./courier-client.mjs")).createCourierClient();
    const since = Date.now() - days * 86400e3;
    // /online_orders has no updatedAt index: the newest orders by key (Shopify ids grow; exchange keys sort after).
    const snap = await db.ref("online_orders").orderByKey().limitToLast(Number(arg("last") || 800)).get();
    for (const [key, o] of Object.entries(snap.val() ?? {})) {
      const s = o?.shipping ?? {};
      const bookedAt = Number(s.bookedAt) || 0;
      if (!s.waybill || bookedAt < since || s.cancelledAt) continue;
      const c = checkAddress(rawAddress(o));
      const lk = c.ok && s.deliveryLocker ? checkLockerArea(s.deliveryLocker, c) : null;
      if (c.ok && (!lk || lk.ok)) continue;
      // Still on its way? Courier Guy's own tracking (a read): a delivered or collected parcel is history.
      let status = "?";
      try { status = String((await client.trackShipment(s.waybill))?.shipments?.[0]?.status ?? "?"); } catch (e) { status = `track failed: ${String(e?.message || e).slice(0, 60)}`; }
      if (/delivered|collected/i.test(status)) continue;
      console.log([orderNo(o, key), status, key, new Date(bookedAt).toISOString().slice(0, 16), s.waybill, s.deliveryMode ?? "", s.deliveryLocker ? `${s.deliveryLocker.id} ${s.deliveryLocker.name}` : "", c.ok ? `LOCKER: ${lk.why}` : c.why].join(" | "));
    }
  } else {
    console.error("usage: --status <key> | --confirm <key> [--zip X] [--suburb X] [--city X] [--province X] [--as-is] [--by who] | --scan [--days 5]");
    process.exitCode = 2;
  }
  process.exit();
}
