// THE OVER-QUOTE (Junid, 6 Nov 2026). Waybill TCG200369959T, order #1942, five
// pairs: we declared 34×46×39 cm (a 2 × 3 grid with one slot EMPTY), 6.1 kg →
// 16 kg volumetric → R355.68 ECO. TCG measured 59.1×37×26.7 cm, 4.75 kg →
// 15 kg → re-rated R249.60. With the fix the quote must land within 5% of
// R249.60. The rate fake below answers exactly as TCG's /rates did for that
// lane on 6 Nov (fixtures/tcg200369959t.json): price by charged weight, where
// charged = whole kg above max(actual, L×W×H ÷ 4000).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { planShipment, bookShipment, ceilingLine, cheaperOption, quoteList } from "./bookShipment.mjs";
import { estimateParcel } from "../../src/shipping/estimateParcel.js";
import { DEFAULT_SHIPPING_CONFIG } from "../../src/shipping/shippingConfig.js";
import { fakeDb } from "./fakeDb.testutil.mjs";
import fx from "./fixtures/tcg200369959t.json";

const CONTACT = { name: "The Marathon", mobile_number: "0310000000", email: "" };
const pair = (size) => ({ category: "Footwear", subcategory: "Sneakers", name: "Sneaker", size, qty: 1 });
// #1942's five pairs, sizes as on the order.
const LINES_1942 = ["5.5", "8", "5", "6", "6"].map(pair);
const ORDER_1942 = {
  key: "18983862173845", orderNumber: 1942, shopifyName: "#1942", shopifyGid: "gid://shopify/Order/18983862173845",
  lines: LINES_1942,
  shipping: { address: { street: "1 Test Street", suburb: fx.deliveryArea.local_area, city: fx.deliveryArea.city, province: "Gauteng", zip: fx.deliveryArea.code } },
  customer: { name: "A Customer", phone: "0820000000", email: "a@example.com" },
};

const chargedKg = (p) => Math.ceil(Math.max(p.submitted_weight_kg, (p.submitted_length_cm * p.submitted_width_cm * p.submitted_height_cm) / 4000) - 1e-9);
const ecoFor = (kg) => fx.ecoBands.find((b) => kg <= b.upToKg).rate;
function laneClient() {
  const calls = [];
  return {
    calls,
    getRates: async (body) => {
      calls.push(body);
      const kg = chargedKg(body.parcels[0]);
      if (body.collection_pickup_point_id) return { rates: kg <= 15 ? [{ rate: 193.6, charged_weight: kg, service_level: { code: "L2DL - ECO", name: "Locker to Door Large" } }] : null };
      return { rates: [
        { rate: ecoFor(kg), charged_weight: kg, service_level: { code: "ECO", name: "Economy" } },
        { rate: 1897.46, charged_weight: kg, service_level: { code: "SDX", name: "Same Day Express" } },
      ] };
    },
    createShipment: async () => { throw new Error("no booking in this test"); },
    cancelShipment: async () => { throw new Error("no cancel in this test"); },
  };
}

let fetchSpy;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("NETWORK IS FORBIDDEN IN TESTS"); }); });
afterEach(() => fetchSpy.mockRestore());

describe("the rate fake is TCG's own answer for that lane", () => {
  it("replays the three probes recorded on 6 Nov", async () => {
    const c = laneClient();
    for (const p of fx.probes) {
      const [l, w, h, kg] = p.dims;
      const res = await c.getRates({ parcels: [{ submitted_length_cm: l, submitted_width_cm: w, submitted_height_cm: h, submitted_weight_kg: kg }] });
      expect(res.rates[0]).toMatchObject({ rate: p.eco.rate, charged_weight: p.eco.cw });
    }
  });
});

describe("TCG200369959T — the over-declared five pairs", () => {
  it("the old declaration (34×46×39, 16 kg) is what TCG over-charged", async () => {
    const p = fx.shipment.parcels[0];
    expect([p.submitted_length_cm, p.submitted_width_cm, p.submitted_height_cm]).toEqual([34, 46, 39]);
    expect(chargedKg(p)).toBe(16);
    expect(ecoFor(16) / fx.shipment.rate).toBeGreaterThan(1.4);
  });

  it("now declares the five boxes as they are: 34×46×32.5, no empty slot", () => {
    const r = estimateParcel(LINES_1942);
    expect(r.parcels[0]).toMatchObject({ kind: "shoebox", pairs: 5, lengthCm: 34, widthCm: 46, heightCm: 32.5, layout: { columns: 2, rows: 3 } });
    // Five boxes' own volume: 5 × 34 × 23 × 13.
    const p = r.parcels[0];
    expect(p.lengthCm * p.widthCm * p.heightCm).toBe(5 * 34 * 23 * 13);
    expect(p.actualKg).toBe(5.6); // four pairs up to UK 6.5 at 1.1 kg, one UK 8 at 1.2 kg
  });

  it("the quote lands within 5% of the R249.60 TCG invoiced, on ECO", async () => {
    const d = fakeDb({ config: { shipping: { live: true, collectionContact: CONTACT, maxChargeRand: 300 } } });
    const plan = await planShipment(ORDER_1942, { db: d, client: laneClient(), products: {} });
    expect(plan.ok).toBe(true);
    expect(plan.chosen.rate.code).toBe("ECO");
    const q = plan.chosen.rate.rate;
    expect(Math.abs(q - fx.shipment.rate) / fx.shipment.rate).toBeLessThanOrEqual(0.05);
    expect(plan.payload.parcels[0]).toMatchObject({ submitted_length_cm: 34, submitted_width_cm: 46, submitted_height_cm: 32.5 });
    expect(plan.liveBlockers).toEqual([]); // under the R300 ceiling now
  });

  it("every service quoted is on the plan, cheapest first, SDX included but never chosen", async () => {
    const d = fakeDb({ config: { shipping: { collectionContact: CONTACT } } });
    const plan = await planShipment(ORDER_1942, { db: d, client: laneClient(), products: {} });
    expect(plan.quotes.map((q) => q.code)).toEqual(["ECO", "SDX"]);
    expect(plan.chosen.rate.code).toBe("ECO");
  });
});

describe("THE R300 CEILING — one line to Junid with the cheaper option", () => {
  // Seven pairs: 34×46×45.5 → 17.8 kg → R352.72 on this lane.
  const SEVEN = { ...ORDER_1942, lines: ["8", "8", "8", "8", "8", "8", "8"].map(pair) };

  it("over the ceiling → not booked, and the line names the quote, the parcel and the cheaper option", async () => {
    const d = fakeDb({ config: { shipping: { live: true, collectionContact: CONTACT, maxChargeRand: 300 } }, online_orders: { [SEVEN.key]: { shopifyGid: SEVEN.shopifyGid } } });
    const client = laneClient();
    const res = await bookShipment(SEVEN, { db: d, client, log: () => {}, now: () => 1 });
    expect(res.skipped).toBe(true);
    expect(res.reason).toMatch(/over the R300 ceiling/);
    // 60×41×41 locker L holds 34×46×45.5? No (45.5 > 41): no locker asked, no cheaper option.
    expect(res.junidLine).toBe("#1942: Courier Guy quotes R352.72 (ECO, 34×46×45.5 cm, 18 kg), over the R300 ceiling, not booked. No cheaper service quoted. Book it in the portal.");
    expect(client.calls.every((b) => !b.collection_pickup_point_id)).toBe(true);
  });

  it("a parcel that fits a locker gets the locker price as the cheaper option, even with the drop box off", async () => {
    const d = fakeDb({ config: { shipping: { live: true, collectionContact: CONTACT, maxChargeRand: 200 } }, online_orders: { [ORDER_1942.key]: { shopifyGid: ORDER_1942.shopifyGid } } });
    const res = await bookShipment(ORDER_1942, { db: d, client: laneClient(), log: () => {}, now: () => 1 });
    expect(res.junidLine).toBe("#1942: Courier Guy quotes R247.52 (ECO, 34×46×32.5 cm, 13 kg), over the R200 ceiling, not booked. Cheaper: locker drop-off L2DL - ECO R193.60. Book it in the portal.");
  });

  it("ceiling 0 = off: books nothing extra, no line", async () => {
    const d = fakeDb({ config: { shipping: { collectionContact: CONTACT, maxChargeRand: 0 } } });
    const plan = await planShipment({ ...ORDER_1942, lines: ["8", "8", "8", "8", "8", "8", "8"].map(pair) }, { db: d, client: laneClient(), products: {} });
    expect(plan.overCeiling).toBe(null);
    expect(ceilingLine("#1", plan)).toBe(null);
  });

  it("cheaperOption never offers an excluded service or anything dearer", () => {
    const chosen = { code: "ECO", rate: 300 };
    expect(cheaperOption(chosen, [{ code: "SDX", rate: 10 }, { code: "ECO", rate: 300 }], [], { excludeServiceCodes: ["SDX"] })).toBe(null);
    expect(cheaperOption(chosen, [], [{ code: "L2DL - ECO", rate: 193.6 }, { code: "L2DM - ECO", rate: 130.9 }])).toEqual({ mode: "locker", code: "L2DM - ECO", rate: 130.9 });
  });

  it("quoteList sorts door and locker together, cheapest first", () => {
    const l = quoteList({ door: { rates: [{ code: "ECO", rate: 200 }] }, locker: { rates: [{ code: "L2DM - ECO", rate: 130.9 }] } });
    expect(l.map((x) => [x.mode, x.code])).toEqual([["locker", "L2DM - ECO"], ["door", "ECO"]]);
  });
});

describe("no padding anywhere in the defaults", () => {
  it("the divisor is TCG's ECO divisor (4000), measured, not a margin; no overflow bundle", () => {
    expect(DEFAULT_SHIPPING_CONFIG.volumetricDivisor).toBe(4000);
    expect(DEFAULT_SHIPPING_CONFIG.shoebox.overflowBundleCm).toBeUndefined();
    expect(DEFAULT_SHIPPING_CONFIG.shoebox).toMatchObject({ lengthCm: 34, widthCm: 23, heightCm: 13, measured: true });
    expect(DEFAULT_SHIPPING_CONFIG.calibration).toEqual({});
  });
});
