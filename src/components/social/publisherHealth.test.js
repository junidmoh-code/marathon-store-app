// The danger here is a status light that lies in the reassuring direction.
import { describe, it, expect } from "vitest";
import { publisherStatus, formatAge, WARN_MINUTES, DOWN_MINUTES } from "./publisherHealth.js";

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const agoMin = (m) => NOW - m * 60000;

describe("publisher status", () => {
  it("calls a recent tick healthy", () => {
    expect(publisherStatus(agoMin(1), NOW).state).toBe("ok");
  });

  it("goes late at the watchdog's own threshold", () => {
    expect(publisherStatus(agoMin(WARN_MINUTES - 1), NOW).state).toBe("ok");
    expect(publisherStatus(agoMin(WARN_MINUTES), NOW).state).toBe("late");
  });

  it("goes down well past any plausible slow run", () => {
    expect(publisherStatus(agoMin(DOWN_MINUTES - 1), NOW).state).toBe("late");
    expect(publisherStatus(agoMin(DOWN_MINUTES), NOW).state).toBe("down");
  });

  it("reports the real 31 Aug outage as down", () => {
    expect(publisherStatus(agoMin(625), NOW).state).toBe("down");
    expect(publisherStatus(agoMin(625), NOW).text).toMatch(/10h 25m/);
  });

  it("no heartbeat is UNKNOWN, never down", () => {
    // A publisher that has never written and one that died look identical from
    // the browser. Claiming "down" would be a guess dressed as a fact.
    for (const v of [null, undefined, 0, NaN, "yesterday"]) {
      expect(publisherStatus(v, NOW).state).toBe("unknown");
    }
  });

  it("a heartbeat from the future is a clock problem, not health", () => {
    const s = publisherStatus(NOW + 10 * 60000, NOW);
    expect(s.state).toBe("unknown");
    expect(s.text).toMatch(/clock/i);
  });

  it("a tick a few seconds in the future is tolerated, not flagged", () => {
    expect(publisherStatus(NOW + 5000, NOW).state).toBe("ok");
  });
});

describe("age formatting", () => {
  it("minutes under an hour", () => expect(formatAge(42)).toBe("42 min"));
  it("whole hours drop the minutes", () => expect(formatAge(120)).toBe("2h"));
  it("hours and minutes", () => expect(formatAge(625)).toBe("10h 25m"));
  it("nonsense gives a dash, not NaN", () => expect(formatAge(NaN)).toBe("—"));
});
