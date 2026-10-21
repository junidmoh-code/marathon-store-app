import { describe, it, expect } from "vitest";
import { normalizeRates, chooseRate } from "./chooseService.js";
import doorDurban from "../../scripts/shipping/fixtures/rates-door-durban.json";
import doorCpt from "../../scripts/shipping/fixtures/rates-door-capetown.json";
import lockerCpt from "../../scripts/shipping/fixtures/rates-locker-capetown.json";

const cfg = { excludeServiceCodes: ["SDX"] };
const r = (code, rate) => ({ code, name: code, rate });

describe("normalizeRates", () => {
  it("reads TCG's recorded response", () => {
    expect(normalizeRates(doorDurban).map((x) => x.code)).toEqual(["LPF", "LPP", "LSF", "LSP", "SDX"]);
    expect(normalizeRates(lockerCpt)[0]).toMatchObject({ code: "L2DM - ECO", rate: 100, group: "L2D" });
  });
  it("tolerates null / empty / junk", () => {
    expect(normalizeRates(null)).toEqual([]);
    expect(normalizeRates({ rates: null })).toEqual([]);
    expect(normalizeRates({ rates: [{ rate: "x", service_level: { code: "A" } }, { rate: 1 }] })).toEqual([]);
  });
});

describe("chooseRate — the cheapest service that matches the drop-box rule", () => {
  it("drop-box eligible → cheapest LOCKER rate even when a door rate is cheaper", () => {
    expect(chooseRate({ locker: [r("L2DL - ECO", 193), r("L2DM - ECO", 130)], door: [r("LPF", 90)] }, { dropBoxEligible: true }, cfg))
      .toEqual({ mode: "locker", rate: r("L2DM - ECO", 130) });
  });
  it("not eligible → cheapest DOOR rate even when a locker rate is cheaper", () => {
    expect(chooseRate({ locker: [r("L2DM - ECO", 50)], door: [r("PRI", 309), r("ECO", 143)] }, { dropBoxEligible: false }, cfg))
      .toEqual({ mode: "door", rate: r("ECO", 143) });
  });
  it("eligible but TCG offers no locker → falls back to the door", () => {
    expect(chooseRate({ locker: [], door: [r("ECO", 143)] }, { dropBoxEligible: true }, cfg)).toMatchObject({ mode: "door" });
  });
  it("never chooses an excluded service", () => {
    expect(chooseRate({ door: [r("SDX", 1), r("ECO", 143)] }, { dropBoxEligible: false }, cfg).rate.code).toBe("ECO");
    expect(chooseRate({ door: [r("SDX", 1)] }, { dropBoxEligible: false }, cfg)).toBeNull();
  });
  it("on the recorded fixtures: CPT door → ECO, CPT locker → L2DM", () => {
    expect(chooseRate({ door: normalizeRates(doorCpt) }, { dropBoxEligible: false }, cfg).rate.code).toBe("ECO");
    expect(chooseRate({ locker: normalizeRates(lockerCpt), door: normalizeRates(doorCpt) }, { dropBoxEligible: true }, cfg).rate.code).toBe("L2DM - ECO");
  });
});
