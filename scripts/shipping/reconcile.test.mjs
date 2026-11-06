import { describe, it, expect } from "vitest";
import {
  reconcileOrder, learnCalibration, weeklyLine, lastWeekStart, weeklyDue, runReconcile, isFinal, RECON_PATH,
} from "./reconcile.mjs";
import { estimateParcel, parcelClass, calibrationFactor } from "../../src/shipping/estimateParcel.js";
import { mergeShippingConfig } from "../../src/shipping/shippingConfig.js";
import { fakeDb } from "./fakeDb.testutil.mjs";
import fx from "./fixtures/tcg200369959t.json";

const NOW = Date.parse("2026-11-09T08:30:00+02:00"); // a Monday, 08:30 SAST
const declared5 = { kind: "shoebox", pairs: 5, lengthCm: 34, widthCm: 46, heightCm: 39, actualKg: 6.1 };
const order1942 = { shipping: { provider: "courier_guy", waybill: "VL4G7H", trackingReference: "VL4G7H", cost: 355.68, priced: { quoted: 355.68 }, bookedAt: NOW - 7 * 86400e3, parcel: { ruleVersion: 4, parcels: [declared5] } } };

describe("reconcileOrder — what TCG invoiced, kept on the order", () => {
  it("TCG200369959T: invoiced R249.60 against our R355.68 → a −30% diff and a measurement sample", () => {
    const r = reconcileOrder("18983862173845", order1942, fx.shipment, NOW);
    expect(r.invoiced).toMatchObject({ rand: 249.6, quoted: 355.68, chargedKg: 15, service: "ECO", alternativeRef: "TCG200369959T", measured: [59.1, 37, 26.7, 4.75] });
    expect(r.diff).toMatchObject({ orderId: "18983862173845", waybill: "VL4G7H", quoted: 355.68, invoiced: 249.6, share: -0.3, class: "shoebox:3+" });
    // 59.1×37×26.7 ÷ 34×46×39 = 0.96
    expect(r.sample).toMatchObject({ class: "shoebox:3+", ratio: 0.96, implied: 0.96 });
  });

  it("within 5% → invoiced kept, no diff", () => {
    const r = reconcileOrder("1", { shipping: { ...order1942.shipping, cost: 247.52, priced: { quoted: 247.52 } } }, fx.shipment, NOW);
    expect(r.invoiced.rand).toBe(249.6);
    expect(r.diff).toBe(null);
  });

  it("not delivered, or not invoiced yet → nothing", () => {
    expect(reconcileOrder("1", order1942, { ...fx.shipment, status: "in-transit" }, NOW)).toBe(null);
    expect(reconcileOrder("1", order1942, { ...fx.shipment, has_been_invoiced: false }, NOW)).toBe(null);
    expect(isFinal(null)).toBe(false);
  });

  it("a parcel TCG never measured gives no sample; the sample divides out the factor the declaration carried", () => {
    const unmeasured = { ...fx.shipment, parcels: [{ ...fx.shipment.parcels[0], has_been_dimensioned: false }] };
    expect(reconcileOrder("1", order1942, unmeasured, NOW).sample).toBe(null);
    const withFactor = { shipping: { ...order1942.shipping, parcel: { ruleVersion: 4, parcels: [{ ...declared5, calibrationFactor: 0.9 }] } } };
    expect(reconcileOrder("1", withFactor, fx.shipment, NOW).sample).toMatchObject({ ratio: 0.96, implied: 0.86 });
  });
});

describe("only the current rule's parcels teach the table (Sonnet review of #853)", () => {
  it("a parcel declared under the old padded rule is reconciled and diffed but gives no sample", () => {
    const old = { shipping: { ...order1942.shipping, parcel: { parcels: [declared5] } } };
    const r = reconcileOrder("1", old, fx.shipment, NOW);
    expect(r.invoiced.rand).toBe(249.6);
    expect(r.diff).not.toBe(null);
    expect(r.sample).toBe(null);
  });
  it("a sample is dated by TCG's delivery, not the pass", () => {
    const r = reconcileOrder("1", order1942, { ...fx.shipment, delivered_date: "2026-11-03T09:09:01.95Z" }, NOW);
    expect(r.sample.at).toBe(Date.parse("2026-11-03T09:09:01.95Z"));
  });
});

describe("learnCalibration — the parcel table follows TCG's own measurements, DOWN only", () => {
  const s = (implied, at, waybill = `W${at}`) => ({ implied, at, waybill });

  it("three parcels of a class all measured > 5% smaller → the factor is their median", () => {
    expect(learnCalibration([s(0.8, 1), s(0.82, 2), s(0.79, 3)], undefined)).toEqual({ factor: 0.8, samples: 3, from: ["W3", "W2", "W1"] });
  });

  it("fewer than three, or mixed directions → nothing", () => {
    expect(learnCalibration([s(0.8, 1), s(0.8, 2)], undefined)).toBe(null);
    expect(learnCalibration([s(0.8, 1), s(1.1, 2), s(0.8, 3)], undefined)).toBe(null);
    expect(learnCalibration([s(0.97, 1), s(0.98, 2), s(0.96, 3)], undefined)).toBe(null); // within 5%
  });

  it("only the latest five count", () => {
    const old = [s(1.0, 1), s(1.0, 2), s(1.0, 3)];
    const fresh = [s(0.8, 10), s(0.8, 11), s(0.8, 12), s(0.8, 13), s(0.8, 14)];
    expect(learnCalibration([...old, ...fresh], undefined)?.factor).toBe(0.8);
  });

  it("BIGGER than declared is reported, never padded (Junid: no multiplier that inflates size)", () => {
    expect(learnCalibration([s(1.4, 1), s(1.3, 2), s(1.5, 3)], undefined)).toEqual({ report: "bigger", median: 1.4, samples: 3 });
  });

  it("an earlier correction that now under-declares is walked back toward 1 (never above it)", () => {
    expect(learnCalibration([s(0.95, 1), s(0.97, 2), s(0.99, 3)], { factor: 0.8 })).toEqual({ factor: 0.97, samples: 3, from: ["W3", "W2", "W1"] });
    expect(learnCalibration([s(1.3, 1), s(1.3, 2), s(1.3, 3)], { factor: 0.8 })?.factor).toBe(1);
  });

  it("no change smaller than 0.02 is written; the floor is 0.75", () => {
    expect(learnCalibration([s(0.8, 1), s(0.81, 2), s(0.8, 3)], { factor: 0.8 })).toBe(null);
    expect(learnCalibration([s(0.5, 1), s(0.5, 2), s(0.5, 3)], undefined)?.factor).toBe(0.75);
  });
});

describe("the estimator applies a learned factor to its class only", () => {
  const two = [{ category: "Footwear", subcategory: "Sneakers", size: "8", qty: 2 }];
  it("shoebox:2 at ×0.9 → 34×23×23.4; other classes untouched; the parcel names its class", () => {
    const cfg = mergeShippingConfig({ calibration: { "shoebox:2": { factor: 0.9 } } });
    expect(estimateParcel(two, cfg).parcels[0]).toMatchObject({ heightCm: 23.4, calibrationClass: "shoebox:2", calibrationFactor: 0.9 });
    expect(estimateParcel([{ ...two[0], qty: 1 }], cfg).parcels[0]).toMatchObject({ heightCm: 13, calibrationClass: "shoebox:1" });
    expect(estimateParcel([{ ...two[0], qty: 1 }], cfg).parcels[0].calibrationFactor).toBeUndefined();
  });
  it("classes and clamping", () => {
    expect(parcelClass({ kind: "shoebox", pairs: 7 })).toBe("shoebox:3+");
    expect(parcelClass({ kind: "flatBag" })).toBe("flatBag");
    expect(parcelClass({ kind: "custom" })).toBe("box");
    expect(calibrationFactor({ box: { factor: 9 } }, "box")).toBe(1.25);
    expect(calibrationFactor({ box: { factor: "x" } }, "box")).toBe(1);
  });
});

describe("the weekly line", () => {
  const sh = (over) => ({ created_by: "marathon-pos", status: "delivered", has_been_invoiced: true, time_created: "2026-11-04T09:00:00Z", original_rate: 100, rate: 100, ...over });

  it("Monday 08:00 SAST onwards; last week runs Monday to Sunday SAST", () => {
    expect(weeklyDue(Date.parse("2026-11-09T07:59:00+02:00"))).toBe(false);
    expect(weeklyDue(Date.parse("2026-11-09T08:00:00+02:00"))).toBe(true);
    expect(new Date(lastWeekStart(NOW)).toISOString()).toBe("2026-11-01T22:00:00.000Z"); // Mon 2 Nov 00:00 SAST
  });

  it("bookings, our quotes vs invoiced, overpaid — one line", () => {
    const line = weeklyLine([
      sh({ original_rate: 355.68, rate: 249.6 }),
      sh({ original_rate: 143.52, rate: 205.92 }),
      sh({ original_rate: 142.32, rate: 142.32 }),
      sh({ status: "cancelled", original_rate: 999 }),
      sh({ created_by: "distreda-794196", original_rate: 999 }), // staff portal bookings are not ours
      sh({ time_created: "2026-10-30T09:00:00Z", original_rate: 999 }), // the week before
    ], lastWeekStart(NOW));
    expect(line).toBe("Courier 2 Nov–8 Nov: 3 bookings, our quotes R641.52 vs invoiced R597.84; overpaid R106.08 on 1 (re-rated down by TCG), under-quoted R62.40 on 1.");
  });

  it("says when not everything is invoiced yet, and when there was nothing", () => {
    expect(weeklyLine([sh({}), sh({ has_been_invoiced: false })], lastWeekStart(NOW))).toMatch(/invoiced R100\.00 \(1 of 2 invoiced so far\); overpaid R0\.00\.$/);
    expect(weeklyLine([], lastWeekStart(NOW))).toBe("Courier 2 Nov–8 Nov: no bookings.");
  });
});

describe("runReconcile — one pass", () => {
  // fakeDb has no queries: orderByChild/equalTo read the whole node, as an unindexed RTDB query does.
  const withQueries = (d) => ({ ...d, ref: (p) => { const r = d.ref(p ?? ""); return { ...r, orderByChild: () => ({ equalTo: () => r }) }; } });
  const client = (weekly = []) => ({
    getShipments: async (q) => (q.tracking_reference ? { shipments: [fx.shipment] } : { shipments: q.offset ? [] : weekly }),
  });

  it("writes invoiced + the diff + the sample, sends the queued ceiling line and the weekly line once", async () => {
    const d = fakeDb({
      online_orders: { 18983862173845: order1942, 2: { shipping: { provider: "courier_guy", waybill: "X", invoiced: { rand: 1 } } } },
      shipping_recon: { junidLines: { "9_352": { orderId: "9", text: "#9: over the ceiling" } } },
    });
    const sent = [];
    const sendJunid = async (text, ref) => { sent.push([ref, text]); return true; };
    const out = await runReconcile({ db: withQueries(d), client: client([{ ...fx.shipment, time_created: "2026-11-04T09:00:00Z" }]), sendJunid, now: NOW });
    expect(out).toMatchObject({ reconciled: 1, diffs: 1, lines: 1 });
    expect(d.root.online_orders["18983862173845"].shipping.invoiced.rand).toBe(249.6);
    expect(d.root[RECON_PATH].diffs.VL4G7H).toMatchObject({ share: -0.3 });
    expect(Object.keys(d.root[RECON_PATH].samples["shoebox_3_"])).toEqual(["VL4G7H"]);
    expect(sent.map((x) => x[0])).toEqual(["courier-ceiling-9_352", "courier-week-2026-11-02"]);
    expect(out.weekly).toMatch(/^Courier 2 Nov–8 Nov: 1 booking, our quotes R355\.68 vs invoiced R249\.60; overpaid R106\.08 on 1/);

    // A second pass sends nothing again and re-reconciles nothing.
    sent.length = 0;
    const again = await runReconcile({ db: withQueries(d), client: client(), sendJunid, now: NOW + 3600e3 });
    expect(again).toMatchObject({ reconciled: 0, lines: 0, weekly: null });
    expect(sent).toEqual([]);
  });

  it("only an exact waybill match is reconciled; a waybill 45 days old is given up", async () => {
    const d = fakeDb({ online_orders: {
      1: { shipping: { ...order1942.shipping, waybill: "OTHER", trackingReference: "OTHER" } },
      2: { shipping: { ...order1942.shipping, waybill: "OLD1", trackingReference: "OLD1", bookedAt: NOW - 46 * 86400e3 } },
    }, shipping_recon: { weekly: { "2026-11-02": { sentAt: 1 } } } });
    const out = await runReconcile({ db: withQueries(d), client: client(), sendJunid: async () => true, now: NOW });
    expect(out.reconciled).toBe(0);
    expect(d.root.online_orders[1].shipping.invoiced).toBeUndefined();
    expect(d.root.online_orders[2].shipping.invoiced).toMatchObject({ unreconciled: expect.any(String) });
  });

  it("the weekly fetch reads until an empty page, whatever size TCG's pages are", async () => {
    const d = fakeDb({});
    const page = (n, base) => Array.from({ length: n }, (_, i) => ({ created_by: "marathon-pos", status: "delivered", has_been_invoiced: true, time_created: "2026-11-04T09:00:00Z", original_rate: 100, rate: 100, id: base + i }));
    const pages = [page(50, 0), page(50, 50), []];
    const c = { getShipments: async (q) => (q.tracking_reference ? { shipments: [] } : { shipments: pages[q.offset / 50] ?? [] }) };
    const out = await runReconcile({ db: withQueries(d), client: c, sendJunid: async () => true, now: NOW });
    expect(out.weekly).toMatch(/: 100 bookings,/);
  });

  it("a line Jamie could not take is kept for the next pass", async () => {
    const d = fakeDb({ shipping_recon: { junidLines: { a: { text: "x" } }, weekly: { "2026-11-02": { sentAt: 1 } } } });
    await runReconcile({ db: withQueries(d), client: client(), sendJunid: async () => false, now: NOW });
    expect(d.root[RECON_PATH].junidLines.a.sentAt).toBeUndefined();
    expect(d.root[RECON_PATH].weekly["2026-11-02"]).toMatchObject({ sentAt: 1 });
  });

  it("three consistent samples write the calibration; a 'bigger' class is only reported", async () => {
    const samp = (r, i) => ({ class: "flatBag", implied: r, at: i, waybill: `B${i}` });
    const big = (r, i) => ({ class: "shoebox:1", implied: r, at: i, waybill: `S${i}` });
    const d = fakeDb({
      shipping_recon: { weekly: { "2026-11-02": { sentAt: 1 } }, samples: { flatBag: { a: samp(0.8, 1), b: samp(0.8, 2), c: samp(0.8, 3) }, "shoebox_1": { a: big(1.4, 1), b: big(1.4, 2), c: big(1.4, 3) } } },
    });
    const out = await runReconcile({ db: withQueries(d), client: client(), sendJunid: async () => true, now: NOW });
    expect(out.learned).toEqual([{ class: "flatBag", factor: 0.8 }]);
    expect(d.root.config.shipping.calibration.flatBag).toMatchObject({ factor: 0.8, samples: 3 });
    expect(d.root.config.shipping.calibration["shoebox:1"]).toBeUndefined();
    expect(d.root[RECON_PATH].bigger["shoebox_1"]).toMatchObject({ class: "shoebox:1", median: 1.4 });
  });
});
