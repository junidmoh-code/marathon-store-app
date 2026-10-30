import { describe, it, expect } from "vitest";
import { costAlertMail, expensiveWhy, costAlertThreshold, DEFAULT_COST_ALERT_RAND } from "./costAlert.mjs";

// #1859 as it was really booked on 29 Oct 2026: six caps + a bag in the LARGE box.
const caps = {
  waybill: "39PPFL", service: "ECO", cost: 355.68,
  parcel: {
    actualKg: 2.05, chargeableKg: 19.25, unmeasured: ["item:cap", "item:bag", "box:LARGE"],
    parcels: [{ boxCode: "LARGE", kind: "box", lengthCm: 55, widthCm: 40, heightCm: 35, actualKg: 2.05, volumetricKg: 19.25, chargeableKg: 19.25,
      contents: [...Array(6).fill({ kind: "cap", kg: 0.15 }), { kind: "bag", kg: 0.5 }] }],
  },
  priced: { quoted: 355.68, base: 300, surcharges: [], adjustments: [{ name: "Fuel surcharge", charge: 55.68 }], chargedKg: 19.25, actualKg: 3, volumetricKg: 19.25 },
};
const order = { shopifyName: "#1859", customer: { name: "Thabo N" }, shipping: { address: { city: "Bloemfontein", province: "Free State" } } };

describe("costAlertMail — over R250 only", () => {
  it("at or under the threshold, or with no waybill: no email", () => {
    expect(costAlertMail(order, { ...caps, cost: 250 })).toBeNull();
    expect(costAlertMail(order, { ...caps, cost: 120 })).toBeNull();
    expect(costAlertMail(order, { ...caps, waybill: null })).toBeNull();
    expect(costAlertMail(order, null)).toBeNull();
  });

  it("#1859: names the order, the box and that the box size is why", () => {
    const m = costAlertMail(order, { ...caps, address: order.shipping.address });
    expect(m.subject).toBe("Waybill R355.68 for #1859 — box size (LARGE)");
    expect(m.text).toMatch(/#1859 for Thabo N was booked at R355\.68 — over your R250 alert/);
    expect(m.text).toMatch(/Box size: charged on 19\.25 kg because of the box's volume, while the goods weigh only 3 kg/);
    expect(m.text).toMatch(/Box: LARGE box 55×40×35 cm — 6 × cap, 1 × bag\./);
    expect(m.text).toMatch(/Waybill: 39PPFL \(ECO\) to Bloemfontein, Free State\./);
    expect(m.text).toMatch(/Price: base R300\.00 \+ Fuel surcharge R55\.68 = R355\.68/);
    expect(m.text).toMatch(/Estimated, not measured: cap, bag, box LARGE/);
  });

  it("a threshold override applies", () => {
    expect(costAlertMail(order, caps, 400)).toBeNull();
    expect(costAlertMail(order, { ...caps, cost: 260 }, 250)).not.toBeNull();
  });
});

describe("expensiveWhy", () => {
  it("each surcharge is named with its charge", () => {
    const why = expensiveWhy({ service: "ECO", priced: { base: 119.6, surcharges: [{ name: "High risk", charge: 80.5 }], chargedKg: 5, actualKg: 5, volumetricKg: 2 } });
    expect(why).toContain("Surcharge: High risk R80.50.");
  });
  it("heavy goods (charged on their own weight) read as weight", () => {
    expect(expensiveWhy({ priced: { chargedKg: 9, actualKg: 9, volumetricKg: 4 } })[0]).toBe("Weight: the goods themselves weigh 9 kg.");
  });
  it("nothing stands out: the base rate for the service is the reason", () => {
    expect(expensiveWhy({ service: "ECOR", priced: { base: 260, chargedKg: 2, actualKg: 2, volumetricKg: 2 } })).toEqual([
      "Distance/service: no box or surcharge problem — the base rate R260.00 for ECOR to this address is the cost.",
    ]);
  });
  it("an old booking with no breakdown still explains from the parcel", () => {
    const { priced: _p, ...noPriced } = caps;
    expect(expensiveWhy(noPriced)[0]).toMatch(/^Box size: charged on 19\.25 kg .* 2\.05 kg/);
  });
});

describe("the price line and the wording", () => {
  it("charges that add up to the cost are shown as a sum (TCG lists them incl. VAT)", () => {
    const m = costAlertMail(order, { ...caps, cost: 224.02, priced: { base: 119.6, surcharges: [{ name: "High risk", charge: 80.5 }], adjustments: [{ name: "Fuel surcharge", charge: 23.92 }] } }, 200);
    expect(m.text).toMatch(/Price: base R119\.60 \+ High risk R80\.50 \+ Fuel surcharge R23\.92 = R224\.02 \(incl\. VAT\)\./);
  });
  it("charges that don't add up are listed, never claimed to equal the cost", () => {
    const m = costAlertMail(order, { ...caps, cost: 400, priced: { base: 100, surcharges: [], adjustments: [] } });
    expect(m.text).toMatch(/Price: R400\.00 \(incl\. VAT\); Courier Guy's quote listed base R100\.00\./);
  });
  it("shoeboxes are not told to use a smaller box", () => {
    const why = expensiveWhy({ parcel: { parcels: [{ kind: "shoebox", pairs: 4, volumetricKg: 12 }] }, priced: { chargedKg: 12, actualKg: 5, volumetricKg: 12 } });
    expect(why[0]).toMatch(/^Box size:/);
    expect(why[0]).not.toMatch(/smaller box/);
  });
  it("a fuel-only make-up names the fuel in the distance/service reason", () => {
    expect(expensiveWhy({ service: "ECO", priced: { base: 230, adjustments: [{ name: "Fuel surcharge", charge: 30 }], chargedKg: 2, actualKg: 2, volumetricKg: 2 } })[0]).toMatch(/\(plus Fuel surcharge R30\.00\)/);
  });
  it("a null parcel entry never throws", () => {
    expect(() => expensiveWhy({ parcel: { parcels: [null, { kind: "box", volumetricKg: 4 }] } })).not.toThrow();
  });
});

describe("costAlertThreshold", () => {
  it("defaults to R250; a positive number overrides", () => {
    expect(DEFAULT_COST_ALERT_RAND).toBe(250);
    expect(costAlertThreshold(null)).toBe(250);
    expect(costAlertThreshold(0)).toBe(250);
    expect(costAlertThreshold("x")).toBe(250);
    expect(costAlertThreshold(300)).toBe(300);
  });
});
