// Junid, 29 Oct 2026: "when I confirm a return is in good condition, the returned items go back into stock at Marathon PE
// and the outbound is booked", a movement marked "exchange return #<order>", the new items deducted exactly once.
// Driven through the real server-side writer (applyMovementAdmin) on the functions' fake RTDB, which models the cold-null
// transaction and RTDB's delete semantics, so the claim, the ledger row and the cell are the ones production writes.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  confirmExchangeReturn, returnPlan, notReadyWhy, arrivalState, replacementCheck, movementIdFor, reasonFor, RETURN_TO, ACTOR, CLAIM_STALE_MS,
  destinationFor, priorArrivalRow,
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
// The default returned item is CLOTHING (it goes to the Marathon PE shop); the sneaker cases below use SNK.
const SNK = "pSNK";
const PRODUCTS = { [PID_OUT]: { name: "Diesel Green Black White Orange", category: "Clothing" }, [SNK]: { name: "Nike Shox TL", category: "Footwear" } };
const world = ({ rec = record(), peQty = null, extra = {}, products = PRODUCTS, orig = [{ pid: PID_OUT, size: "11", title: "Diesel", source: { locationId: "marathon-pe", status: "handed" } }] } = {}) => makeFakeDb({
  products,
  online_orders: { [KEY]: rec, 18966134358165: { orderNumber: "1793", lines: orig, pack: { saleId: "-NsOrig" } } },
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
    expect(mv.link).toMatchObject({ orderId: KEY, saleId: "-NsOrig" }); // the original's pack sale named, never changed
    expect(at(db, "pos")).toBeNull();
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

  it("a sneaker goes back to the Marathon PE hub its original line came from, never the shop's cell", async () => {
    const rec = record({ incoming: { ...record().incoming, returning: [{ pid: SNK, size: "8", sizeKey: "8", title: "Nike Shox TL", origOrderKey: "18966134358165", origLineIndex: 0 }] } });
    const db = world({ rec, orig: [{ pid: SNK, size: "8", title: "Shox", source: { locationId: "hub2", status: "handed" } }] });
    const out = await run(db);
    expect(out.items[0]).toMatchObject({ to: "hub2", place: "Hub 2", before: 0, after: 1 });
    expect(at(db, `stock/hub2/${SNK}/8/qty`)).toBe(1);
    expect(at(db, `stock/${RETURN_TO}/${SNK}`)).toBeNull();
  });

  it("an unknown product, or a fallback item not on the original order: refused, nothing written", async () => {
    const db = world({ products: { [SNK]: PRODUCTS[SNK] } });
    expect(await run(db)).toMatchObject({ ok: false, notReady: true, reason: expect.stringMatching(/not a product in the app/) });
    const rec = record(); delete rec.incoming;
    const db2 = world({ rec });
    expect(await run(db2, { returning: [{ pid: SNK, size: "9", title: "Shox" }] })).toMatchObject({ ok: false, notReady: true, reason: expect.stringMatching(/not on the exchange's original order/) });
    expect(at(db2, "stock_movements")).toBeNull();
  });

  it("a deactivated product that comes back is reactivated, as every arrival on the client does", async () => {
    const db = world({ peQty: 0, products: { ...PRODUCTS, [PID_OUT]: { ...PRODUCTS[PID_OUT], deactivated: { at: 1 } } } });
    const out = await run(db);
    expect(out.reactivated).toEqual([PID_OUT]);
    expect(at(db, `products/${PID_OUT}/deactivated`)).toBeNull();
    expect(at(db, `products/${PID_OUT}/reactivated`)).toMatchObject({ by: ACTOR, reason: "stock_received" });
  });

  it("by hand: the ledger already shows it put back since the arrival → refused, nothing added", async () => {
    const arrival = { state: "done", at: NOW - 3600e3, returnSaleId: null, byHand: ["Diesel · size 11"] };
    const db = world({ peQty: 1, rec: record({ incoming: { ...record().incoming, arrival } }), extra: { stock_movements: { m1: { type: "adjustment", productId: PID_OUT, size: "11", qty: 1, to: "marathon-pe", ts: new Date(NOW - 1800e3).toISOString(), reason: "put back" } } } });
    expect(await run(db)).toMatchObject({ ok: false, notReady: true, reason: expect.stringMatching(/already shows .* put back since the exchange was paid \(adjustment at Marathon PE, "put back"\)/) });
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(1);
    expect(priorArrivalRow({ x: { type: "sold", productId: PID_OUT, size: "11", to: null } }, { pid: PID_OUT, sizeKey: "11", key: KEY })).toBeNull();
  });

  it("said again after a by-hand arrival: reported as Jimmy's own units", async () => {
    const arrival = { state: "done", at: NOW - 1000, returnSaleId: null, byHand: ["x"] };
    const db = world({ peQty: 0, rec: record({ incoming: { ...record().incoming, arrival } }) });
    await run(db);
    expect(await run(db)).toMatchObject({ ok: true, already: true, by: "jimmy", items: [{ before: 0, after: 1 }] });
  });

  it("the till confirmed it: its own ledger rows give the before/after", async () => {
    const arrival = { state: "done", at: NOW - 1000, claimedAt: NOW - 2000, returnSaleId: "-NsRet", receiptNumber: "R-9", lines: [{ pid: PID_OUT, size: "11", title: "Diesel" }] };
    const db = world({ rec: record({ incoming: { ...record().incoming, arrival } }), extra: { stock_movements: { r1: { type: "return", productId: PID_OUT, size: "11", qty: 1, to: "marathon-pe", before: { "marathon-pe": 2 }, after: { "marathon-pe": 3 }, ts: new Date(NOW - 1500).toISOString(), link: { saleId: "-NsRet" } } } } });
    expect(await run(db)).toMatchObject({ ok: true, already: true, by: "till", items: [{ title: "Diesel", place: "Marathon PE", before: 2, after: 3 }] });
  });

  it("NOT good: the hold is written, nothing goes back; good later clears it; already back → refused", async () => {
    const db = world({ peQty: 0 });
    expect(await run(db, { condition: "not_good", words: "torn sole" })).toMatchObject({ ok: true, held: true });
    expect(at(db, `online_orders/${KEY}/incoming/conditionHold`)).toMatchObject({ at: NOW, words: "torn sole" });
    expect(at(db, "stock_movements")).toBeNull();
    expect(at(db, `online_orders/${KEY}/incoming/arrival`)).toBeNull();
    const good = await run(db);
    expect(good).toMatchObject({ ok: true, done: true, heldBefore: true });
    expect(at(db, `online_orders/${KEY}/incoming/conditionHold`)).toBeNull();
    expect(await run(db, { condition: "not_good" })).toMatchObject({ ok: false, alreadyBack: true, by: "jimmy" });
  });

  it("the second of two units fails: the first stays once, the claim stays Jimmy's, the re-run finishes with no double", async () => {
    const rec = record({ incoming: { ...record().incoming, returning: [{ pid: PID_OUT, size: "11", title: "D" }, { pid: SNK, size: "8", title: "S" }] } });
    const db = world({ peQty: 0, rec, orig: [{ pid: PID_OUT, size: "11" }, { pid: SNK, size: "8", source: { locationId: "hub1" } }] });
    // The sneaker's cell refuses once (a write error on the way).
    let failed = false;
    const orig = db.ref.bind(db);
    db.ref = (p) => {
      const r = orig(p);
      if (String(p).startsWith(`stock/hub1/${SNK}/`) && !failed) return { ...r, transaction: async () => { failed = true; throw new Error("network"); } };
      return r;
    };
    await expect(run(db, { attemptId: "a1" })).rejects.toThrow(/network/);
    expect(at(db, `online_orders/${KEY}/incoming/arrival`)).toMatchObject({ state: "returning", via: "jimmy" });
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(1);
    const again = await run(db, { attemptId: "a2" });
    expect(again).toMatchObject({ ok: true, done: true });
    expect(again.items.map((u) => [u.to, u.before, u.after, u.already])).toEqual([["marathon-pe", 0, 1, true], ["hub1", 0, 1, false]]);
    expect(at(db, `stock/${RETURN_TO}/${PID_OUT}/11/qty`)).toBe(1);
    expect(at(db, `stock/hub1/${SNK}/8/qty`)).toBe(1);
  });

  it("the till takes the arrival between our claim and our done: an error that says check the POS", async () => {
    const db = world({ peQty: 0 });
    const orig = db.ref.bind(db);
    db.ref = (p) => {
      const r = orig(p);
      if (p === `online_orders/${KEY}/incoming/arrival`) {
        return { ...r, transaction: async (fn) => {
          const cur = at(db, p);
          if (cur?.state === "returning" && cur.via === "jimmy") await orig(p).set({ state: "returning", at: NOW, by: { name: "Till" }, plan: [{ saleId: "s" }] });
          return r.transaction(fn);
        } };
      }
      return r;
    };
    await expect(run(db)).rejects.toThrow(/a till took over/);
  });
});

describe("round 2: the hold and the ledger check", () => {
  it("not good, then the till confirms, then good: the hold goes and the held order is released to book", async () => {
    const db = world({ peQty: 0 });
    await run(db, { condition: "not_good" });
    await db.ref(`online_orders/${KEY}`).update({ status: "packed", fulfilState: "courier_failed", courierError: "Junid said the returned item is not in good condition: nothing ships until he tells Jimmy otherwise", attentionOpen: true });
    await db.ref(`online_orders/${KEY}/incoming/arrival`).set({ state: "done", at: NOW, returnSaleId: "-NsRet", by: { name: "Till" } });
    const out = await run(db);
    expect(out).toMatchObject({ ok: true, already: true, by: "till", heldBefore: true, released: true });
    expect(at(db, `online_orders/${KEY}/incoming/conditionHold`)).toBeNull();
    expect(at(db, `online_orders/${KEY}/fulfilState`)).toBe("pending");
    expect(at(db, `online_orders/${KEY}/attentionOpen`)).toBeNull();
  });

  it("a held order failing for another reason is not released (only the hold's own text)", async () => {
    const db = world({ peQty: 0 });
    await run(db, { condition: "not_good" });
    await db.ref(`online_orders/${KEY}`).update({ fulfilState: "courier_failed", courierError: "HTTP 400 bad address" });
    expect(await run(db)).toMatchObject({ ok: true, done: true, heldBefore: true, released: false });
    expect(at(db, `online_orders/${KEY}/fulfilState`)).toBe("courier_failed");
  });

  it("by hand: a till return BEFORE the arrival (since payment) is found; a delivery (received) is not a match; force goes past", async () => {
    const arrival = { state: "done", at: NOW - 1000, returnSaleId: null, byHand: ["x"] };
    const early = { m1: { type: "return", productId: PID_OUT, size: "11", qty: 1, to: "hub2", ts: new Date(1793333411004 + 3600e3).toISOString(), reason: "till return" } };
    const db = world({ peQty: 0, rec: record({ incoming: { ...record().incoming, arrival } }), extra: { stock_movements: early } });
    expect(await run(db)).toMatchObject({ ok: false, notReady: true, reason: expect.stringMatching(/since the exchange was paid \(return at Hub 2, "till return"\).*add it anyway/) });
    const forced = await run(db, { force: true });
    expect(forced).toMatchObject({ ok: true, done: true });
    const db2 = world({ peQty: 0, rec: record({ incoming: { ...record().incoming, arrival } }), extra: { stock_movements: { r: { type: "received", productId: PID_OUT, size: "11", qty: 3, to: "marathon-pe", ts: new Date(NOW - 5000).toISOString() } } } });
    expect(await run(db2)).toMatchObject({ ok: true, done: true });
  });

  it("the fallback list (no return on record) is checked against the ledger too", async () => {
    const rec = record(); delete rec.incoming;
    const db = world({ rec, orig: [{ pid: PID_OUT, size: "11" }], extra: { stock_movements: { a: { type: "adjustment", productId: PID_OUT, size: "11", qty: 1, to: "marathon-pe", ts: new Date(NOW - 5000).toISOString(), reason: "found in back" } } } });
    expect(await run(db, { returning: [{ pid: PID_OUT, size: "11", title: "D" }] })).toMatchObject({ ok: false, notReady: true, reason: expect.stringMatching(/already shows/) });
  });

  it("not good while an earlier good of ours is unfinished: says the stock may be back, writes no hold", async () => {
    const db = world({ rec: record({ incoming: { ...record().incoming, arrival: { state: "returning", via: "jimmy", attemptId: "x", at: NOW - 1000 } } }) });
    expect(await run(db, { condition: "not_good" })).toMatchObject({ ok: false, alreadyBack: true, reason: expect.stringMatching(/may already be back/) });
    expect(at(db, `online_orders/${KEY}/incoming/conditionHold`)).toBeNull();
  });
});

describe("round 2: where the original sale deducted, and how much", () => {
  const snkRec = () => record({ incoming: { ...record().incoming, returning: [{ pid: SNK, size: "8", sizeKey: "8", title: "Nike Shox TL", origOrderKey: "18966134358165", origLineIndex: 0 }] } });
  it("the sale's own ledger row names the hub (over the line's plan location)", async () => {
    const db = world({ rec: snkRec(), orig: [{ pid: SNK, size: "8", source: { locationId: "hub2" } }], extra: { pos: { sales: { "-NsOrig": { lineItems: { L1: { productId: SNK, size: "8", qty: 1 } } } } }, stock_movements: { [`sold:-NsOrig:hub1:${SNK}:8`]: { type: "sold", productId: SNK, size: "8", qty: 1, from: "hub1", ts: "2026-10-20T10:00:00.000Z" } } } });
    const out = await run(db);
    expect(out.items[0]).toMatchObject({ to: "hub1", before: 0, after: 1 });
  });
  it("a sale that never deducted the unit (shortfall): nothing credited, reported as withheld; the arrival still done", async () => {
    const db = world({ rec: snkRec(), orig: [{ pid: SNK, size: "8", source: { locationId: "hub2" } }], extra: { pos: { sales: { "-NsOrig": { lineItems: { L1: { productId: SNK, size: "8", qty: 1 } } } } }, stock_movements: { [`sold:-NsOrig:hub2:${SNK}:8`]: { type: "sold", productId: SNK, size: "8", qty: 1, shortfall: 1, from: "hub2", ts: "2026-10-20T10:00:00.000Z" } } } });
    const out = await run(db);
    expect(out).toMatchObject({ ok: true, done: true, withheld: [{ pid: SNK, size: "8" }] });
    expect(out.items).toEqual([]);
    expect(at(db, `stock/hub2/${SNK}`)).toBeNull();
    expect(at(db, `online_orders/${KEY}/incoming/arrival`)).toMatchObject({ state: "done", withheld: [{ pid: SNK }] });
  });
  it("our claim carries a plan no till can read (a stale takeover stops) and each unit's place; a re-run keeps the place", async () => {
    const db = world({ rec: snkRec(), orig: [{ pid: SNK, size: "8" }], extra: { stock: { hub2: { [SNK]: { 9: { qty: 5 } } } } } });
    let seen = null;
    const orig = db.ref.bind(db);
    db.ref = (p) => {
      const r = orig(p);
      if (String(p).startsWith(`stock/hub2/${SNK}/8`) && !seen) return { ...r, transaction: async () => { seen = at(db, `online_orders/${KEY}/incoming/arrival`); throw new Error("network"); } };
      return r;
    };
    await expect(run(db, { attemptId: "a1" })).rejects.toThrow(/network/);
    expect(seen.plan[0].saleId).toBe("jimmy-exchange-return");
    expect(seen.items[0].to).toBe("hub2"); // hub2 held most
    // The stock moves meanwhile (hub1 now holds more): the re-run still lands on hub2.
    await orig(`stock/hub1/${SNK}/10`).set({ qty: 9 });
    const out = await run(db, { attemptId: "a2" });
    expect(out.items[0]).toMatchObject({ to: "hub2" });
  });
});

describe("destinationFor", () => {
  const shoe = { category: "Footwear" };
  it("footwear: the original line's hub, else the hub holding most, else Hub 1; anything else the shop", () => {
    expect(destinationFor({ product: shoe, size: "8", origLine: { source: { locationId: "hub2" } } })).toBe("hub2");
    expect(destinationFor({ product: shoe, size: "8", origLine: { source: { locationId: "marathon-pe" } }, hubQty: { hub1: 1, hub2: 4 } })).toBe("hub2");
    expect(destinationFor({ product: shoe, size: "8", hubQty: { hub1: 2, hub2: 2 } })).toBe("hub1");
    expect(destinationFor({ product: shoe, size: "8", origLine: { source: { locationId: "hub3" } } })).toBe("hub1"); // never outside section 2
    expect(destinationFor({ product: shoe, size: "M" })).toBe("marathon-pe"); // a slide in S/M/L is a shop item
    expect(destinationFor({ product: { category: "Clothing" }, size: "M", origLine: { source: { locationId: "hub2" } } })).toBe("marathon-pe");
  });
});
