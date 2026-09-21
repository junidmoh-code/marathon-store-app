// A banner on a ten-second screen has to be right, or it trains people to
// ignore it. These pin the cases where it must stay silent as hard as the one
// case where it must speak.
import { describe, it, expect } from "vitest";
import { captureCreditNotice, MAX_STATUS_AGE_MS } from "./creditNotice";

const NOW = Date.parse("2026-09-19T15:00:00Z");
const status = (o) => ({ level: "empty", checkedAt: NOW - 60000, ...o });

describe("it speaks when the wallet is confirmed empty", () => {
  it("names the cause and says retaking will not help", () => {
    const n = captureCreditNotice(status(), NOW);
    expect(n.title).toMatch(/AI credits have run out/i);
    expect(n.detail).toMatch(/no point retaking/i);
  });

  it("says the emailed reports are still landing — the thing that matters", () => {
    // Without this a manager reasonably assumes the whole feature is down and
    // that batches are being lost.
    expect(captureCreditNotice(status(), NOW).detail).toMatch(/email their report are still recording/i);
  });
});

describe("it stays quiet unless it is certain", () => {
  it("says nothing on a healthy wallet", () => {
    expect(captureCreditNotice(status({ level: "ok" }), NOW)).toBe(null);
  });

  it("says nothing when the balance is merely LOW", () => {
    // The owner's business, and it reaches him by email. Photo capture still
    // works, so a manager can do nothing with this.
    expect(captureCreditNotice(status({ level: "low" }), NOW)).toBe(null);
  });

  it("says nothing when no top-up was ever recorded", () => {
    expect(captureCreditNotice(status({ level: "unknown" }), NOW)).toBe(null);
  });

  it("says nothing when the node cannot be read or has never been written", () => {
    // An unreadable node is not evidence of an empty wallet — and this one
    // needs a database rule before any browser can read it at all.
    for (const s of [null, undefined, {}, "denied", 7]) {
      expect(captureCreditNotice(s, NOW)).toBe(null);
    }
  });

  it("says nothing about a STALE verdict", () => {
    // The scan runs hourly. A verdict from last week describes a wallet that
    // may have been topped up since, and announcing an outage that is over is
    // how a screen loses its credibility.
    expect(captureCreditNotice(status({ checkedAt: NOW - MAX_STATUS_AGE_MS - 1000 }), NOW)).toBe(null);
    expect(captureCreditNotice(status({ checkedAt: NOW - MAX_STATUS_AGE_MS + 1000 }), NOW)).not.toBe(null);
  });

  it("says nothing about a verdict from the future", () => {
    // A clock problem, not a wallet problem, and no more trustworthy.
    expect(captureCreditNotice(status({ checkedAt: NOW + 3600000 }), NOW)).toBe(null);
  });

  it("says nothing when the stamp is missing or unreadable", () => {
    for (const checkedAt of [undefined, null, "yesterday", NaN]) {
      expect(captureCreditNotice(status({ checkedAt }), NOW)).toBe(null);
    }
  });
});
