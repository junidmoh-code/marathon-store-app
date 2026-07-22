import { describe, it, expect } from "vitest";
import { formatDuration, refillAgeTone } from "./duration";

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

describe("formatDuration", () => {
  it("renders minutes under an hour", () => {
    expect(formatDuration(42 * MIN)).toBe("42m");
    expect(formatDuration(1 * MIN)).toBe("1m");
  });
  it("renders Hh Mm under a day", () => {
    expect(formatDuration(19 * HOUR + 42 * MIN)).toBe("19h 42m");
    expect(formatDuration(1 * HOUR)).toBe("1h 0m");
  });
  it("renders Dd Hh beyond a day (drops minutes)", () => {
    expect(formatDuration(9 * DAY + 6 * HOUR + 30 * MIN)).toBe("9d 6h");
    expect(formatDuration(1 * DAY)).toBe("1d 0h");
  });
  it("handles sub-minute and invalid spans", () => {
    expect(formatDuration(30e3)).toBe("<1m");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("refillAgeTone (normal <12h · amber 12–24h · red ≥24h)", () => {
  it("is normal below 12h", () => {
    expect(refillAgeTone(0)).toBe("normal");
    expect(refillAgeTone(11 * HOUR + 59 * MIN)).toBe("normal");
  });
  it("is amber from 12h up to 24h", () => {
    expect(refillAgeTone(12 * HOUR)).toBe("amber");
    expect(refillAgeTone(23 * HOUR + 59 * MIN)).toBe("amber");
  });
  it("is red at or beyond 24h", () => {
    expect(refillAgeTone(24 * HOUR)).toBe("red");
    expect(refillAgeTone(9 * DAY)).toBe("red");
  });
  it("boundaries are exact (12h amber, 24h red)", () => {
    expect(refillAgeTone(12 * HOUR - 1)).toBe("normal");
    expect(refillAgeTone(24 * HOUR - 1)).toBe("amber");
  });
  it("respects custom thresholds", () => {
    expect(refillAgeTone(5 * HOUR, { amberHours: 4, redHours: 8 })).toBe("amber");
    expect(refillAgeTone(9 * HOUR, { amberHours: 4, redHours: 8 })).toBe("red");
  });
  it("non-finite is normal (never a false alarm)", () => {
    expect(refillAgeTone(NaN)).toBe("normal");
    expect(refillAgeTone(-1)).toBe("normal");
  });
});
