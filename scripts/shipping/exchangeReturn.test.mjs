// Junid, 29 Oct 2026: "when I confirm a return is in good condition, the returned items go back into stock at Marathon PE
// and the outbound is booked", a movement marked "exchange return #<order>", the new items deducted exactly once.
// Driven through the real server-side writer (applyMovementAdmin) on the functions' fake RTDB, which models the cold-null
// transaction and RTDB's delete semantics, so the claim, the ledger row and the cell are the ones production writes.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  confirmExchangeReturn, returnPlan, notReadyWhy, arrivalState, replacementCheck, movementIdFor, reasonFor, RETURN_TO, ACTOR, CLAIM_STALE_MS,
} from "./exchangeReturn.mjs";

const require = createRequire(import.meta.url);
const { makeFakeDb, readAt } = require("../../functions/test/helpers/fake-rtdb.cjs");

const KEY = "exchange-1793-1793333411004";
const NOW = 1793380000000;
const PID_OUT = "p1778144748126";
const record = (extra = {}) => ({
  orderNumber: "1793-EX", shopifyName: "#1793-EX", status: "new",
  exchange: { kind: "exchange", by: "jimmy", paidAt: 1793333411004, paidCents: 21800, relatedOrders: ["18966134358165"] },
  lines: [{ lineId: "l0", pid: PID_OUT, size: "7", sizeKey: "7", qty: 1, title: "Diesel Green Black White Orange", unitPriceCents: 0, source: { locationId: "hub2", status: "pick" } }],
  incoming: {
    orderNumber: "1793", exchangeOrder: "1793-EX", waybill: "TKGFWG", stage: "return_delivered",
    returning: [{ pid: PID_OUT, size: "11", sizeKey: "11", title: "Diesel Green Black White Orange", origOrderKey: "18966134358165", origLineIndex: 0 }],
  },
  ...extra,
});
const world = ({ rec = record(), peQty = null, extra = {} } = {}) => makeFakeDb({
  online_orders: { [KEY]: rec },
  stock: { hub2: { [PID_OUT]: { 7: { qty: 5, v: 3, mv: "seed", lastType: "received" } } }, ...(peQty == null ? {} : { [RETURN_TO]: { [PID_OUT]: { 11: { qty: peQty, v: 1, mv: "seed", lastType: "received" } } } }) },
  online_reservations: { [PID_OUT]: { 7: { [KEY]: { qty: 1, ref: "#1793-EX", locs: { hub2: 1 } } } } },
  ...extra,
});
const at = (db, p) => readAt(db.state.root, p);
const run = (db, opts = {}) => confirmExchangeReturn(KEY, { db, orderNumber: "1793", now: () => NOW, ...opts });
const MV = movementIdFor(KEY, PID_OUT, "11", 0);

describe("pure parts", () => {
  it("the reason is Junid's words and the movement id is fixed per exchange and unit", () => {
    expect(reasonFor("#1785")).toBe("exchange return #1785");
    expect(movementIdFor(KEY, "p1", "5_5", 0)).toBe(`exret_${KEY}_p1_5_5_0`);
    expect(movementIdFor(KEY, "p1", "a.b", 1)).not.toMatch(/[.#$/[\]\s]/);
  });
  it("one plan entry per unit: two of one pair get two ids; the record's list wins over the fallback", () => {
    const p = returnPlan({ incoming: { returning: [{ pid: "p1", size: "8", qty: 2, title: "A" }] } }, KEY, [{ pid: "pX", size: "1" }]);
    expect(p.ok).toBe(true);
    expect(p.items.map((x) => x.movementId)).toEqual([movementIdFor(KEY, "p1", "8", 0), movementIdFor(KEY, "p1", "8", 1)]);
    const f = returnPlan({}, KEY, [{ pid: "pX", size: "5.5", title: "B" }]);
    expect(f.items[0]).toMatchObject({ pid: "pX", size: "5.5", sizeKey: "5_5" });
  });
  it("refuses a plan that cannot name the product", () => {
    expect(returnPlan({}, KEY).ok).toBe(false);
    expect(returnPlan({ incoming: { returning: [{ title: "Shoe", size: "8" }] } }, KEY)).toMatchObject({ ok: false, why: expect.stringMatching(/not recorded/) });
    expect(returnPlan({ incoming: { returning: [{ pid: "a/b", size: "8" }] } }, KEY).ok).toBe(false);
  });
  it("not ready: missing, wrong order, unpaid, finished, nothing reserved", () => {
    expect(notReadyWhy(null)).toMatch(/no exchange record/);
    expect(notReadyWhy(record(), { orderNumber: "1785" })).toMatch(/not #1785/);
    expect(notReadyWhy(record({ exchange: { kind: "exchange" } }))).toMatch(/not paid/);
    expect(notReadyWhy(record({ status: "cancelled" }))).toMatch(/cancelled/);
    expect(notReadyWhy(record({ lines: [] }))).toMatch(/no replacement/);
    expect(notReadyWhy(record(), { orderNumber: "#1793" })).toBeNull();
  });
  it("whose arrival it is", () => {
    expect(arrivalState(null)).toBe("free");
    expect(arrivalState({ state: "done", at: 1 })).toBe("done");
    expect(arrivalState({ returnSaleId: "s1" })).toBe("done");
    expect(arrivalState({ state: "returning", via: "jimmy" })).toBe("ours");
    expect(arrivalState({ state: "failed", via: "jimmy" })).toBe("ours");
    expect(arrivalState({ state: "returning", plan: [{}] })).toBe("till");
    expect(arrivalState({ state: "failed", plan: [{}] })).toBe("till");
  });
  it("the replacement: not deducted until the pack's one sale exists", () => {
    const r = replacementCheck({ record: record(), cells: { [`hub2/${PID_OUT}/7`]: 5 }, holds: { [`${PID_OUT}/7`]: { qty: 1 } } });
    expect(r).toMatchObject({ deducted: "not yet", packed: false, lines: [{ location: "hub2", stockNow: 5, held: 1 }] });
    expect(replacementCheck({ record: record({ status: "packed" }), saleId: "s9", saleExists: true }).deducted).toBe("once");
    expect(replacementCheck({ record: record({ status: "packed" }), saleId: "s9", saleExists: false }).deducted).toBe("packed, sale not found");
  });
});

describe("confirmExchangeReturn", () => {
  it("good condition: one return movement at Marathon PE with the reason, the arrival done, Shopify nudged", async () => {
    const db = world({ peQty: 0 });
    const out = await run(db);
    expect(out).toMatchObject({ ok: true, done: true, orderNumber: "1793", items: [{ pid: PID_OUT, size: "11", to: RETURN_TO, before: 0, after: 1, movementId: MV, already: false }] });
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(1);
    const mv = at(db, `stock_movements/${MV}`);
    expect(mv).toMatchObject({ type: "return", productId: PID_OUT, size: "11", qty: 1, to: RETURN_TO, reason: "exchange return #1793", actor: ACTOR, before: { [RETURN_TO]: 0 }, after: { [RETURN_TO]: 1 } });
    expect(mv.link.orderId).toBe(KEY);
    const arr = at(db, `online_orders/${KEY}/incoming/arrival`);
    expect(arr).toMatchObject({ state: "done", via: "jimmy", at: NOW, stockReturned: [{ movementId: MV, before: 0, after: 1 }] });
    expect(arr.returnSaleId ?? null).toBeNull();
    expect(at(db, `shopify_inventory_dirty/${PID_OUT}`)).toBe(1);
    // The replacement is never touched: its hub cell and its hold stay; nothing sold.
    expect(at(db, `stock/hub2/${PID_OUT}/7/qty`)).toBe(5);
    expect(at(db, `online_reservations/${PID_OUT}/7/${KEY}/qty`)).toBe(1);
    expect(Object.values(at(db, "stock_movements")).every((m) => m.type === "return")).toBe(true);
    expect(out.replacement.deducted).toBe("not yet");
  });

  it("said twice: nothing goes back a second time, the first before/after is reported", async () => {
    const db = world({ peQty: 2 });
    await run(db);
    const again = await run(db);
    expect(again).toMatchObject({ ok: true, already: true, by: "jimmy", items: [{ movementId: MV, before: 2, after: 3 }] });
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(3);
    expect(Object.keys(at(db, "stock_movements"))).toEqual([MV]);
  });

  it("dry run: the plan, nothing written", async () => {
    const db = world({ peQty: 4 });
    const before = JSON.stringify(db.state.root);
    const out = await run(db, { dry: true });
    expect(out).toMatchObject({ ok: true, dryRun: true, items: [{ before: 4, after: 5 }], reason: "exchange return #1793" });
    expect(JSON.stringify(db.state.root)).toBe(before);
  });

  it("not paid / no record: not ready, nothing written", async () => {
    const db = world({ rec: record({ exchange: { kind: "exchange" } }) });
    const before = JSON.stringify(db.state.root);
    expect(await run(db)).toMatchObject({ ok: false, notReady: true, reason: expect.stringMatching(/not paid/) });
    expect(await confirmExchangeReturn("exchange-1785-1", { db, orderNumber: "1785", now: () => NOW })).toMatchObject({ ok: false, notReady: true, reason: expect.stringMatching(/no exchange record/) });
    expect(JSON.stringify(db.state.root)).toBe(before);
  });

  it("the till already confirmed it (its own return sale): nothing added, reported", async () => {
    const db = world({ peQty: 0, rec: record({ incoming: { ...record().incoming, arrival: { state: "done", at: NOW - 1000, by: { uid: "u1", name: "Junid" }, returnSaleId: "s1", receiptNumber: "R-9" } } }) });
    const out = await run(db);
    expect(out).toMatchObject({ ok: true, already: true, by: "till", arrival: { returnSaleId: "s1", receiptNumber: "R-9" }, items: [] });
    expect(at(db, "stock_movements")).toBeNull();
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(0);
  });

  it("a till is confirming it right now, or its claim failed: busy, nothing added", async () => {
    for (const arrival of [{ state: "returning", at: NOW - 1000, by: { name: "Yasmin" }, plan: [{ saleId: "s", lineId: "L1", qty: 1 }] }, { state: "failed", at: NOW - CLAIM_STALE_MS * 3, plan: [{ saleId: "s" }], error: "offline" }]) {
      const db = world({ peQty: 0, rec: record({ incoming: { ...record().incoming, arrival } }) });
      expect(await run(db)).toMatchObject({ ok: false, busy: true });
      expect(at(db, "stock_movements")).toBeNull();
      expect(at(db, `online_orders/${KEY}/incoming/arrival/state`)).toBe(arrival.state);
    }
  });

  it("the till confirmed it 'by hand' (no till return): the by-hand step is done here, once", async () => {
    const arrival = { state: "done", at: NOW - 1000, by: { uid: "u1", name: "Junid" }, returnSaleId: null, byHand: ["Diesel Green Black White Orange · size 11"], note: "put the item back into stock by hand" };
    const db = world({ peQty: 1, rec: record({ incoming: { ...record().incoming, arrival } }) });
    const out = await run(db);
    expect(out).toMatchObject({ ok: true, done: true, items: [{ before: 1, after: 2 }] });
    const arr = at(db, `online_orders/${KEY}/incoming/arrival`);
    expect(arr).toMatchObject({ state: "done", by: { name: "Junid" }, stockReturned: [{ movementId: MV, before: 1, after: 2 }] });
    expect(arr.via ?? null).toBeNull();
    const again = await run(db);
    expect(again).toMatchObject({ ok: true, already: true });
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(2);
  });

  it("a crash after the movement, before done: the next run finishes without a second unit", async () => {
    const db = world({ peQty: 0 });
    const r1 = await run(db, { attemptId: "first" });
    expect(r1.done).toBe(true);
    // Rewind the arrival to Jimmy's unfinished claim (the crash), the ledger row stays.
    await db.ref(`online_orders/${KEY}/incoming/arrival`).set({ state: "returning", via: "jimmy", attemptId: "first", at: NOW - 5000 });
    const r2 = await run(db, { attemptId: "second" });
    expect(r2).toMatchObject({ ok: true, done: true, items: [{ movementId: MV, before: 0, after: 1, already: true }] });
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(1);
    expect(at(db, `online_orders/${KEY}/incoming/arrival/state`)).toBe("done");
  });

  it("a negative cell is cleared the way the till's return clears it (credit from zero)", async () => {
    const db = world({ peQty: -2 });
    const out = await run(db);
    expect(out.items[0]).toMatchObject({ before: -2, after: 1 });
    expect(at(db, `stock_movements/${MV}/negativeCleared`)).toEqual({ [RETURN_TO]: -2 });
  });

  it("two units of one pair back: two movements, 0 → 2", async () => {
    const rec = record({ incoming: { ...record().incoming, returning: [{ pid: PID_OUT, size: "11", title: "D" }, { pid: PID_OUT, size: "11", title: "D" }] } });
    const db = world({ peQty: 0, rec });
    const out = await run(db);
    expect(out.items.map((u) => [u.before, u.after])).toEqual([[0, 1], [1, 2]]);
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(2);
  });

  it("no incoming list: Jimmy's own list is used; none at all: not ready", async () => {
    const rec = record();
    delete rec.incoming;
    const db = world({ peQty: 0, rec });
    expect(await run(db)).toMatchObject({ ok: false, notReady: true, reason: expect.stringMatching(/which item/) });
    const out = await run(db, { returning: [{ pid: PID_OUT, size: "11", title: "D" }] });
    expect(out).toMatchObject({ ok: true, done: true });
    expect(at(db, `online_orders/${KEY}/incoming/arrival/state`)).toBe("done");
  });

  it("packed: the pack's sale is the one deduction, reported as once", async () => {
    const db = world({ peQty: 0, rec: record({ status: "packed", pack: { saleId: "-Ns1" } }), extra: { pos: { sales: { "-Ns1": { channel: "online" } } } } });
    const out = await run(db, { dry: true });
    expect(out.replacement).toMatchObject({ deducted: "once", saleId: "-Ns1" });
  });
});
