// ── quoteExchange — a LIVE Courier Guy quote for an online exchange, BOTH WAYS (Junid, 25 Nov 2026: "Changed my mind →
// customer pays the price difference + live Courier Guy quote both ways")
//
// The exchange page (marathon-dm-agent, the exchange desk) has to show a customer what the courier costs BEFORE anything
// is reserved, paid or booked. This prices the two legs exactly as they will later be booked, by the same code:
//
//   return leg    planReturn (bookReturn.mjs): the customer → our door, from the Courier Guy locker nearest them
//                 (mode "locker") or collected from their door (mode "door", their own choice: planReturn collection)
//   outbound leg  planShipment (bookShipment.mjs): our door → the customer, the replacement lines, as a packed exchange
//                 record is booked by the poller's SHIP pass
//
// Both are planned against an IN-MEMORY exchange record built from the original order the way marathon-dm-agent
// src/jimmy/reserve.js exchangeOrder writes the real one (shipping.address of the original, exchange.contactPhone,
// lines from /products/<pid>), so nothing is written: RATES ONLY, never a booking, never a claim, never a hold.
// Reads: /online_orders/<orderKey> and /products/<pid> by exact path, /config/shipping. Never a whole node.
//
// The spend ceiling (maxChargeRand) is REPORTED (blockers), never a refusal: the customer pays the quote, and the booking
// itself still enforces it later.
//
// → { ok: true, returnLeg: { rand, service, mode, locker: { name, address, km } | null }, outboundLeg: { rand, service } | null,
//     totalCents, blockers: [] }
//   | { ok: false, reason, transient? }
import { planReturn } from "./bookReturn.mjs";
import { planShipment } from "./bookShipment.mjs";
import { assertSafeSegment, stockSizeKey as sizeKeyOf } from "../../src/utils/sizeKey.js";

const str = (v) => String(v ?? "").trim();
const QUOTE_KEY_AT = 0; // the in-memory record's key: exchange-<n>-0 (never written anywhere)
const FOOTWEAR_RE = /\b(sneakers?|trainers?|shoes?|loafers?|slides?|sandals?|boots?|slip[- ]?ons?|runners?|footwear|heels?|mules?|clogs?)\b/i;

/** "[{pid,size,qty?}]" (a JSON string or an array) → [{ pid, size, qty }]; throws on a bad item. Pure. */
export function parseItems(raw, what) {
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw || "[]"); } catch { throw new Error(`${what}: not JSON`); }
  }
  if (list == null) list = [];
  if (!Array.isArray(list)) throw new Error(`${what}: must be a list of {pid,size,qty?}`);
  return list.map((it, i) => {
    const pid = str(it?.pid);
    if (!pid) throw new Error(`${what}[${i}]: no pid`);
    assertSafeSegment(pid, "productId");
    const qty = Math.max(1, Math.min(10, Math.floor(Number(it?.qty) || 1)));
    return { pid, size: str(it?.size) || "_", qty };
  });
}

/** The exchange-shaped record the quote is planned on (reserve.js exchangeOrder's shape). Pure. */
export function quoteRecord({ original, orderKey, items, products = {}, phone = null }) {
  const n = str(original?.orderNumber ?? original?.order_number ?? original?.shopifyName).replace(/^#/, "").replace(/\D/g, "");
  const lines = [];
  for (const it of items) {
    const p = products[it.pid] || {};
    const size = it.size || "_";
    const units = Math.max(1, Math.floor(Number(it.qty) || 1));
    for (let u = 0; u < units; u++) {
      lines.push({
        pid: it.pid, size, sizeKey: sizeKeyOf(size), qty: 1, title: p.name || it.pid, category: p.category ?? null,
        isFootwear: typeof p.isFootwear === "boolean" ? p.isFootwear : FOOTWEAR_RE.test(`${p.name || ""} ${p.category || ""}`),
        unitPriceCents: 0,
      });
    }
  }
  const contact = str(phone) || str(original?.customer?.phone) || str(original?.shipping?.address?.phone);
  return {
    key: `exchange-${n || "0"}-${QUOTE_KEY_AT}`,
    orderNumber: `${n}-EX`, shopifyName: `#${n}-EX`,
    ...(original?.customer?.name ? { customer: { name: original.customer.name, ...(original.customer.email ? { email: original.customer.email } : {}) } } : {}),
    ...(original?.shipping?.address ? { shipping: { address: original.shipping.address } } : {}),
    lines,
    status: "new",
    exchange: { kind: "exchange", by: "quote", paidAt: QUOTE_KEY_AT, contactPhone: contact || null, relatedOrders: [String(orderKey)] },
  };
}

const rand = (r) => Math.round(Number(r) * 100) / 100;

/**
 * @param {object} a  { orderKey, returning: [{pid,size,qty}], replacement: [{pid,size,qty}], mode: "locker"|"door", phone? }
 * @param {object} deps { db, client, geocoder?, email? }
 */
export async function quoteExchange({ orderKey, returning = [], replacement = [], mode = "locker", phone = null }, { db, client, geocoder, email = null } = {}) {
  const key = str(orderKey);
  if (!key) return { ok: false, reason: "--order-key is required" };
  assertSafeSegment(key, "order key");
  if (!["locker", "door"].includes(mode)) return { ok: false, reason: `mode must be locker or door, not "${mode}"` };
  let back; let out;
  try {
    back = parseItems(returning, "returning");
    out = parseItems(replacement, "replacement");
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
  if (!back.length) return { ok: false, reason: "nothing is coming back: returning is empty" };
  const original = (await db.ref(`online_orders/${key}`).get()).val();
  if (!original) return { ok: false, reason: `no order at /online_orders/${key}` };
  const products = {};
  for (const pid of new Set([...back, ...out].map((i) => i.pid))) {
    const snap = await db.ref(`products/${pid}`).get();
    if (!snap.exists()) return { ok: false, reason: `no product ${pid}` };
    products[pid] = snap.val();
  }
  const g = geocoder ? { geocoder } : {};
  const blockers = [];

  // Return leg: the items coming back, as bookReturn plans them.
  const retRec = quoteRecord({ original, orderKey: key, items: back, products, phone });
  const ret = await planReturn(retRec, { db, client, products, email, key: retRec.key, collection: mode, ...g });
  if (!ret.ok) return { ok: false, reason: `return leg: ${ret.reason}`, ...(ret.transient ? { transient: true } : {}) };
  blockers.push(...(ret.blockers || []).map((b) => `return leg: ${b}`));
  const returnLeg = {
    rand: rand(ret.rate.rate), service: ret.rate.code, mode: ret.mode,
    locker: ret.locker ? { name: ret.locker.name ?? null, address: ret.locker.address ?? null, km: ret.locker.km ?? null } : null,
  };

  // Outbound leg: the replacement lines, as a packed exchange record is shipped.
  let outboundLeg = null;
  if (out.length) {
    const outRec = quoteRecord({ original, orderKey: key, items: out, products, phone });
    const sh = await planShipment(outRec, { db, client, products, ...g });
    if (!sh.ok) return { ok: false, reason: `outbound leg: ${sh.reason}`, ...(sh.transient ? { transient: true } : {}) };
    const shipments = Array.isArray(sh.payloads) && sh.payloads.length ? sh.payloads.length : 1;
    outboundLeg = { rand: rand(sh.chosen.rate.rate * shipments), service: sh.chosen.rate.code };
    blockers.push(...(sh.liveBlockers || []).filter((b) => /ceiling/.test(b)).map((b) => `outbound leg: ${b}`));
  }
  const totalCents = Math.ceil(Math.round((returnLeg.rand + (outboundLeg?.rand || 0)) * 10000) / 100);
  return { ok: true, returnLeg, outboundLeg, totalCents, blockers };
}
