// ── Fast courier booking: ship a packed order the moment it is packed ────────
// (Junid, 20 Nov 2026: "under 10 seconds from Pack to the waybill on the
// packer's screen".)
//
// WHY. The orders poller books Courier Guy in its SHIP phase, and that phase
// came round only when (a) launchd respawned the reconciler runner (at most
// every 120 s, 07:00–19:00 only) and (b) the tick had got through PULL and
// KEEP for every open order (~65–75 s with ~80 open orders). Measured over
// the 259 orders packed 6–20 Nov: Pack → waybill median 73 s, p90 123 s; the
// Courier Guy calls themselves are ~1.7 s of that (rates 0.6 s, create 0.4 s).
//
// WHAT. One long-lived listener (fast-ship.mjs, launchd com.marathon.fastship)
// on the indexed query fulfilState == "pending" — the exact state the POS Pack
// (and its Retry) writes. Each packed order that appears is shipped at once
// with the SAME shipOrder the tick runs (poll.mjs shipPendingOrder): same
// booking, same service choice, same locker/door rules, same addresses, same
// Shopify fulfilment, same failure states. Only WHEN changes.
//
// NEVER TWICE. shipOrderLocked takes the order's ship lock
// (online_orders_meta/shipLocks/{id}) and re-reads the order before shipping;
// the tick's SHIP does the same, so whichever comes first ships and the other
// finds the lock or a finished order. Under that, bookShipment's own
// courierBooking claim still refuses a second waybill.
//
// The tick stays the fallback: an order this listener misses (process down, a
// throw, a lock it lost) is still pending, and the next tick ships it.
import { ONLINE_ORDERS_PATH, ORDER_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { shipPendingOrder, ownsOrderAt } from "./poll.mjs";

export const PENDING_QUERY = { child: "fulfilState", value: "pending" };

const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "?");

/**
 * @param {object} deps  everything shipPendingOrder needs ({ db, nowMs, graphql,
 *   increment, courier, log, … }), plus optional `clock` (ms, default Date.now)
 *   and `shipOne` (tests).
 * → { consider(id, order), idle(), inFlight }
 */
export function createFastShipper(deps) {
  const { db, log = () => {}, clock = () => Date.now(), shipOne = shipPendingOrder } = deps;
  const get = async (path) => (await db.ref(path).get()).val();
  const inFlight = new Map();

  async function run(id, order, seenAt) {
    if (!(await ownsOrderAt({ get }, id, order))) return "not_ours";
    const label = orderLabel(order ?? {}) || id;
    let out;
    try {
      out = await shipOne(deps, id, order, { owner: "fast" });
    } catch (e) {
      // Left pending: the tick's SHIP retries it (as it always has).
      log(`  ✗ ${label}: fast ship failed — ${String(e?.message || e).slice(0, 300)}; the next tick retries`);
      return "error";
    }
    const result = out?.result ?? out;
    if (result !== "shipped") {
      if (result === "locked") log(`  · ${label}: the tick is shipping it`);
      return result;
    }
    // The timings, for the log (the BEFORE/AFTER measure): pack.at is the POS's
    // server-clock stamp, bookedAt this machine's.
    let rec = null;
    try { rec = await get(`${ONLINE_ORDERS_PATH}/${id}`); } catch { /* the timings are a convenience */ }
    const packAt = Number(rec?.pack?.at);
    const bookedAt = Number(rec?.shipping?.bookedAt);
    const waybill = rec?.shipping?.waybill;
    const doneAt = clock();
    log(`  ⚡ ${label}: ${waybill ? `waybill ${waybill} ${secs(bookedAt - packAt)} after the Pack` : `no waybill (${rec?.fulfilState ?? "?"}${rec?.courierError ? `: ${String(rec.courierError).slice(0, 120)}` : ""})`}` +
      ` · seen ${secs(seenAt - packAt)} after the Pack · ${rec?.fulfilState === "done" ? "Shopify done" : `fulfil ${rec?.fulfilState ?? "?"}`} ${secs(doneAt - packAt)} after`);
    return result;
  }

  /** Called for every child the pending query reports (added or changed). */
  function consider(id, order) {
    if (!order || order.status !== ORDER_STATUS.PACKED || order.fulfilState !== "pending") return null;
    // Our own writes while shipping fire child_changed: one run per order at a time.
    if (inFlight.has(id)) return inFlight.get(id);
    const p = run(id, order, clock()).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  return { consider, idle: () => Promise.all([...inFlight.values()]), inFlight };
}

/**
 * Attach the listener. → stop(). Every pending child is offered when the
 * listener attaches (so orders packed while this process was down go at once)
 * and again on each change.
 */
export function listenForPacked(db, consider) {
  const q = db.ref(ONLINE_ORDERS_PATH).orderByChild(PENDING_QUERY.child).equalTo(PENDING_QUERY.value);
  const cb = (snap) => { try { consider(snap.key, snap.val()); } catch { /* consider never throws; belt and braces */ } };
  q.on("child_added", cb);
  q.on("child_changed", cb);
  return () => { q.off("child_added", cb); q.off("child_changed", cb); };
}
