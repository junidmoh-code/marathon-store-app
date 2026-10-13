import { describe, it, expect } from "vitest";
import { BLACK_FRIDAY_MS, showBlackFridayTape } from "./blackFridayTape";

describe("Black Friday tape", () => {
  it("runs until Black Friday starts in SAST, then takes itself down", () => {
    expect(showBlackFridayTape(Date.parse("2026-10-13T12:00:00Z"))).toBe(true);
    // 23:59 SAST on Thursday 26 Nov is 21:59Z — still coming soon.
    expect(showBlackFridayTape(Date.parse("2026-11-26T21:59:00Z"))).toBe(true);
    // 00:00 SAST Friday 27 Nov is 22:00Z on the 26th — Black Friday has come.
    expect(showBlackFridayTape(Date.parse("2026-11-26T22:00:00Z"))).toBe(false);
    expect(BLACK_FRIDAY_MS).toBe(Date.parse("2026-11-26T22:00:00Z"));
  });

  it("no clock, no tape", () => {
    expect(showBlackFridayTape(NaN)).toBe(false);
    expect(showBlackFridayTape(undefined)).toBe(false);
  });
});
