#!/usr/bin/env node
// ── Fast courier booking (Mac mini, launchd com.marathon.fastship) ───────────
// A long-lived listener on the packed orders waiting to ship
// (fulfilState == "pending"): each one is booked with Courier Guy and fulfilled
// on Shopify the moment the POS Pack writes it, instead of on the reconciler's
// next tick. onlineOrders/fastShip.mjs has the why; poll.mjs shipOrderLocked
// has the lock that keeps it and the tick from ever shipping one order twice.
//
//   node scripts/shopify/fast-ship.mjs                 what launchd runs
//   node scripts/shopify/fast-ship.mjs --bench=<key>   NOTHING WRITTEN, NOTHING BOOKED:
//       times one real order through the whole ship as if it had just been
//       packed. Database writes go to an in-memory overlay (recordingDb),
//       Courier Guy rates are real, the create is SIMULATED (no request is
//       sent), Shopify reads are real and every Shopify mutation is refused.
//
// Credentials as orders-poll.mjs: Shopify through env.mjs (.env), Firebase
// Admin through GOOGLE_APPLICATION_CREDENTIALS, Courier Guy through
// scripts/shipping/env.mjs. None is ever printed.
//
// Runs at all hours: a listener with nothing pending downloads nothing, and a
// parcel packed at 19:05 should not wait for the 06:30 catch-up.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { graphql as shopifyGraphql } from "./client.mjs";
import "./env.mjs";
import { serverNowMs } from "./publishNode.mjs";
import { STORE } from "./storeConfig.mjs";
import { createFastShipper, listenForPacked } from "./onlineOrders/fastShip.mjs";
import { recordingDb } from "./onlineOrders/recordingDb.mjs";
import { ONLINE_ORDERS_PATH, ORDER_STATUS } from "../../src/utils/onlineOrders.js";
import { createCourierClient } from "../shipping/courier-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(resolve(HERE, "../.."), "logs");
const LOG_FILE = join(LOG_DIR, STORE.key === "marathon" ? "fast-ship.log" : `fast-ship-${STORE.key}.log`);
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function stamp() {
  return new Date().toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
const benchArg = process.argv.find((a) => a.startsWith("--bench="));
const BENCH = benchArg ? benchArg.split("=")[1] : null;
function log(line) {
  if (BENCH) { console.log(line); return; }
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try { if (statSync(LOG_FILE).size >= MAX_LOG_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* none yet */ }
    appendFileSync(LOG_FILE, `${stamp()}  ${line}\n`);
  } catch { console.log(line); }
}

const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
}
const liveDb = admin.database();

// The same bounded client the tick's SHIP uses (poll.mjs): reads 2 attempts × 15 s,
// the create never retried. Built once for the life of the process.
const courier = createCourierClient({ maxAttempts: 2, timeoutMs: 15_000 });
const baseDeps = {
  nowMs: () => serverNowMs(liveDb),
  increment: (n) => admin.database.ServerValue.increment(n),
  log,
};

if (BENCH) {
  await bench(BENCH);
} else {
  const shipper = createFastShipper({ ...baseDeps, db: liveDb, graphql: shopifyGraphql, courier });
  const stop = listenForPacked(liveDb, shipper.consider, {
    onCancel: (err) => { log(`✗ fast-ship listener cancelled (${String(err?.message || err).slice(0, 200)}) — exiting; launchd restarts it`); process.exit(1); },
  });
  log(`fast-ship listening (${STORE.key}, pid ${process.pid})`);
  // Proof of life once an hour (a quiet log otherwise looks the same as a dead listener).
  setInterval(() => log(`fast-ship alive (${shipper.inFlight.size} shipping now)`), 3600_000);
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      stop();
      // Let an order already being shipped finish (a booking half-recorded is the one thing worth waiting for).
      const t = setTimeout(() => process.exit(0), 45_000);
      t.unref?.();
      try { await shipper.idle(); } catch { /* logged per order */ }
      log(`fast-ship stopped (${sig})`);
      process.exit(0);
    });
  }
}

// ── --bench=<key> ────────────────────────────────────────────────────────────
async function bench(key) {
  const marks = [];
  const t0 = Date.now();
  const mark = (what) => marks.push([what, Date.now() - t0]);
  const rdb = recordingDb(liveDb, () => {});
  const real = (await liveDb.ref(`${ONLINE_ORDERS_PATH}/${key}`).get()).val();
  if (!real) { console.error(`no order at ${ONLINE_ORDERS_PATH}/${key}`); process.exit(2); }
  // As the POS Pack leaves it, with no booking yet — in the overlay only.
  const { shipping = {}, ...rest } = real;
  const { waybill: _w, shipmentId: _s, courierBooking: _c, booking: _b, bookedAt: _ba, trackingReference: _t, ...shippingKept } = shipping;
  const packAt = Date.now();
  await rdb.ref(`${ONLINE_ORDERS_PATH}/${key}`).set({ ...rest, shipping: shippingKept, status: ORDER_STATUS.PACKED, fulfilState: "pending", fulfil: { state: "pending", attempts: 0, requestedAt: packAt }, pack: { ...(real.pack || {}), at: packAt } });
  const benchCourier = {
    getRates: async (body) => { const r = await courier.getRates(body); mark("rates answered"); return r; },
    // Door-to-locker: the lockers near the customer (a read; books nothing).
    getPickupPoints: async (q) => { const r = await courier.getPickupPoints(q); mark("lockers answered"); return r; },
    // SIMULATED: no request is sent. 450 ms is the median measured create (logs/courier.log, 19–20 Nov).
    createShipment: async () => { mark("create (simulated) sent"); await new Promise((r) => setTimeout(r, 450)); mark("create (simulated) answered"); return { id: 0, short_tracking_reference: "BENCH0", service_level_code: "BENCH", charged_amount: 0 }; },
    cancelShipment: async () => { throw new Error("bench: never cancels"); },
  };
  const benchGraphql = async (query, variables, opts) => {
    if (/^\s*mutation\b/.test(query) || opts?.mutation) { mark("Shopify mutation refused (bench)"); throw new Error("bench: Shopify mutation refused"); }
    const r = await shopifyGraphql(query, variables, opts); mark("Shopify read answered"); return r;
  };
  const planned = { shipping: null, booking: null };
  const watched = {
    ref: (path) => {
      const r = rdb.ref(path);
      if (path === `${ONLINE_ORDERS_PATH}/${key}/shipping`) return { ...r, update: async (v) => { planned.shipping = v; await r.update(v); mark("waybill written (overlay)"); } };
      if (path === `${ONLINE_ORDERS_PATH}/${key}/shipping/booking`) return { ...r, set: async (v) => { planned.booking = v; await r.set(v); } };
      return r;
    },
  };
  const shipper = createFastShipper({ ...baseDeps, db: watched, graphql: benchGraphql, courier: benchCourier, courierLog: () => {}, log: (l) => console.log(l), clock: () => Date.now() });
  mark("seen");
  await shipper.consider(key, { ...rest, status: ORDER_STATUS.PACKED, fulfilState: "pending" });
  mark("ship finished");
  // What the booking would have been (what the ship wrote to the overlay, never the live database).
  const p = planned.shipping ?? planned.booking ?? {};
  const lk = p.deliveryLocker ?? null;
  const d2l = (p.quotes ?? []).filter((q) => q.mode === "door_to_locker").map((q) => `${q.code} R${q.rate}`).join(" | ");
  console.log(lk
    ? `\nplan: DOOR-TO-LOCKER to ${lk.name} (${lk.id}, ${lk.km} km, placed by the ${lk.placedBy}), ${(p.waybills ?? []).length || p.shipments || 1} shipment(s); locker quotes ${d2l || "?"}; door-to-door would be ${p.doorQuote ? `${p.doorQuote.code} R${p.doorQuote.rate}` : "not quoted"}`
    : `\nplan: NOT door-to-locker (${p.reason ?? p.priced?.mode ?? p.quote?.mode ?? "no booking recorded"})`);
  console.log(`\nbench ${real.shopifyName ?? key} (nothing written, nothing booked):`);
  for (const [what, ms] of marks) console.log(`  ${String(ms).padStart(6)} ms  ${what}`);
  process.exit(0);
}
