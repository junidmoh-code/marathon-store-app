// ── quoteExchange — a LIVE Courier Guy quote for an online exchange, BOTH WAYS (Junid, 25 Nov 2026: "Changed my mind →
// customer pays the price difference + live Courier Guy quote both ways")
//
// The exchange page (marathon-dm-agent, the exchange desk) has to show a customer what the courier costs BEFORE anything
// is booked. This prices the two legs exactly as they will later be booked, by the same code, ON THE SAME RECORD:
//
//   THE RECORD    the exchange record marathon-dm-agent src/jimmy/reserve.js exchangeOrder writes, rebuilt in memory and
//                 nothing more: its lines are the REPLACEMENT items, shipping.address of the original order, customer
//                 { name } only, exchange.contactPhone. No addressHold, no email: the quote refuses exactly when the
//                 booking would (Sonnet architect review of #997).
//   return leg    planReturn (bookReturn.mjs) on that record: bookReturn estimates the return parcel from the record's
//                 lines (the replacement, the same kind of item coming back), the locker nearest the customer (mode
//                 "locker") or a collection from their door (mode "door", their own choice). With no replacement (nothing
//                 goes out) the returning items stand in for the lines.
//   outbound leg  planShipment (bookShipment.mjs) on the same record, as the poller's SHIP pass books a packed exchange.
//
// RATES ONLY: never a booking, a claim, a hold or a write. The CLI hands it a rates-only client (ratesOnlyClient: no
// createShipment at all). Reads: /online_orders/<orderKey>, /products/<pid> by exact path, /config/shipping.
//
// Blockers: the return leg's ceiling and every outbound live blocker (collection contact missing, the ceiling) are
// REPORTED, never a refusal — the booking still enforces them. A parcel no box fits is a refusal (ok:false), on either leg.
//
// → { ok: true, returnLeg: { rand, service, mode, locker: { name, address, km } | null }, outboundLeg: { rand, service } | null,
//     totalCents, blockers: [] }
//   | { ok: false, reason, transient? }
// THE CALLER MUST READ returnLeg.mode ("locker_dropoff" | "door_collection") to tell the customer how it comes back.
import { planReturn } from "./bookReturn.mjs";
import { planShipment } from "./bookShipment.mjs";
import { assertSafeSegment, stockSizeKey as sizeKeyOf } from "../../src/utils/sizeKey.js";

const str = (v) => String(v ?? "").trim();
const QUOTE_KEY_AT = 0; // the in-memory record's key: exchange-<n>-0 (never written anywhere)
const FOOTWEAR_RE = /\b(sneakers?|trainers?|shoes?|loafers?|slides?|sandals?|boots?|slip[- ]?ons?|runners?|footwear|heels?|mules?|clogs?)\b/i;

export const MAX_QTY = 10; // units of one item in one exchange
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
    const qty = it?.qty == null ? 1 : Number(it.qty);
    // Never silently capped (CodeRabbit #997): a quantity outside 1..MAX_QTY is refused, so the quote prices exactly what was asked.
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new Error(`${what}[${i}]: qty must be a whole number from 1 to ${MAX_QTY}`);
    return { pid, size: str(it?.size) || "_", qty };
  });
}

/** The exchange record the quote is planned on: reserve.js exchangeOrder's shape, nothing more. Pure. */
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
    ...(original?.customer?.name ? { customer: { name: original.customer.name } } : {}),
    // The address only, as reserve.js writes it (no addressHold: the booking's addressGate never sees one either).
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
  // ONE record for both legs: the replacement lines (as reserve.js writes them); no replacement → the returning items.
  const rec = quoteRecord({ original, orderKey: key, items: out.length ? out : back, products, phone });

  const ret = await planReturn(rec, { db, client, products, email, key: rec.key, collection: mode, ...g });
  if (!ret.ok) return { ok: false, reason: `return leg: ${ret.reason}`, ...(ret.transient ? { transient: true } : {}) };
  blockers.push(...(ret.blockers || []).map((b) => `return leg: ${b}`));
  const returnLeg = {
    rand: rand(ret.rate.rate), service: ret.rate.code, mode: ret.mode,
    locker: ret.locker ? { name: ret.locker.name ?? null, address: ret.locker.address ?? null, km: ret.locker.km ?? null } : null,
  };

  let outboundLeg = null;
  if (out.length) {
    const sh = await planShipment(rec, { db, client, products, ...g });
    if (!sh.ok) return { ok: false, reason: `outbound leg: ${sh.reason}`, ...(sh.transient ? { transient: true } : {}) };
    const live = sh.liveBlockers || [];
    const noBox = live.find((b) => /no standard box fits/.test(b));
    if (noBox) return { ok: false, reason: `outbound leg: ${noBox}` };
    const shipments = Array.isArray(sh.payloads) && sh.payloads.length ? sh.payloads.length : 1;
    outboundLeg = { rand: rand(sh.chosen.rate.rate * shipments), service: sh.chosen.rate.code };
    blockers.push(...live.map((b) => `outbound leg: ${b}`));
  }
  const totalCents = Math.ceil(Math.round((returnLeg.rand + (outboundLeg?.rand || 0)) * 10000) / 100);
  return { ok: true, returnLeg, outboundLeg, totalCents, blockers };
}

/** A client that can only price (rates, pickup points): no createShipment, so a quote can never book. Pure. */
export function ratesOnlyClient(client) {
  return Object.freeze({
    getRates: (body) => client.getRates(body),
    getPickupPoints: (q) => client.getPickupPoints(q),
  });
}

/**
 * The flag's value: absent → { present: false }; present with no value (last, or followed by another flag) → throws.
 * A flag that is given must say what it means: never a silent default (architect review of #997). Pure.
 */
export function flag(argv, name, { allowed = null } = {}) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return { present: false, value: null };
  const v = argv[i + 1];
  if (v == null || String(v).startsWith("--")) throw new Error(`--${name} needs a value${allowed ? ` (${allowed.join(" or ")})` : ""}`);
  if (allowed && !allowed.includes(v)) throw new Error(`--${name} must be ${allowed.join(" or ")}, not "${v}"`);
  return { present: true, value: v };
}

/**
 * The CLI (exchange-quote.mjs): writes EXACTLY ONE JSON line, whatever happens. → the exit code (0: an answer, ok or
 * not; 1: a crash, { ok: false, error, transient? }). makeDeps() builds { db, client } (the real ones in the CLI).
 */
export async function runQuoteCli(argv, { makeDeps, write = (s) => process.stdout.write(s) }) {
  let out; let code = 0;
  try {
    const mode = flag(argv, "mode", { allowed: ["locker", "door"] });
    const val = (n) => flag(argv, n).value;
    const { db, client, geocoder } = await makeDeps();
    out = await quoteExchange(
      { orderKey: val("order-key"), returning: val("returning") ?? "[]", replacement: val("replacement") ?? "[]", mode: mode.present ? mode.value : "locker", phone: val("phone") },
      { db, client: ratesOnlyClient(client), email: val("email"), ...(geocoder ? { geocoder } : {}) },
    );
  } catch (err) {
    out = { ok: false, error: String(err?.message || err).slice(0, 400), ...(err?.transient ? { transient: true } : {}) };
    code = 1;
  }
  write(`${JSON.stringify(out)}\n`);
  return code;
}
