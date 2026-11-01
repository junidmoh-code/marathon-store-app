// The card's "refused on N different days" and the engine's threshold are ONE
// number (Junid, 1 Nov 2026: four → two). The functions file is the source.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { REFUSAL_WRITEOFF_DAYS, digestStatusLine } from "./refusalWriteoffsCore";

const require = createRequire(import.meta.url);
const { MIN_DISTINCT_DAYS } = require("../../../functions/lib/refusal-writeoff.cjs");

describe("refusal write-off threshold", () => {
  it("the card says what the engine does — two different days", () => {
    expect(MIN_DISTINCT_DAYS).toBe(2);
    expect(REFUSAL_WRITEOFF_DAYS).toBe(MIN_DISTINCT_DAYS);
  });

  const AT = Date.parse("2026-11-01T17:40:00.000Z");
  const base = { atMs: AT, outcome: "sent", count: 11, units: 19, delivery: { state: "not_sent", why: "Google raised no alert" } };
  it("Gmail's answer wins over the Monitoring verdict: sent is green with the message id", () => {
    const l = digestStatusLine({ ...base, mail: { state: "sent", to: "gunidmoh@gmail.com", atMs: AT + 9 * 60e3, messageId: "<m@gmail.com>" } }, AT + 3600e3);
    expect(l.tone).toBe("ok");
    expect(l.text).toContain("gunidmoh@gmail.com");
    expect(l.text).toContain("<m@gmail.com>");
  });
  it("queued: amber for 30 minutes, then red naming the mini; failed is red", () => {
    const q = { ...base, mail: { state: "queued", to: "gunidmoh@gmail.com" } };
    expect(digestStatusLine(q, AT + 5 * 60e3).tone).toBe("warn");
    expect(digestStatusLine(q, AT + 31 * 60e3)).toMatchObject({ tone: "fail" });
    expect(digestStatusLine(q, AT + 31 * 60e3).text).toContain("Mac mini");
    expect(digestStatusLine({ ...base, mail: { state: "failed", to: "gunidmoh@gmail.com", attempts: 12, why: "535" } }, AT + 3 * 3600e3).tone).toBe("fail");
  });
  it("no mail field (older runs): the Monitoring verdict as before", () => {
    expect(digestStatusLine(base, AT + 60e3).tone).toBe("fail");
  });
  it("a Gmail receipt beats a Monitoring check that never finished (CodeRabbit #831)", () => {
    const st = { ...base, delivery: { state: "checking" }, mail: { state: "sent", to: "gunidmoh@gmail.com", atMs: AT + 9 * 60e3 } };
    expect(digestStatusLine(st, AT + 3600e3).tone).toBe("ok");
  });
  it("a quiet day never turns an unsent email green", () => {
    const quiet = { atMs: AT + 864e5, outcome: "nothing_new", mail: { state: "retrying", to: "gunidmoh@gmail.com", attempts: 3, why: "timeout" }, pendingCount: 11, pendingAtMs: AT };
    const l = digestStatusLine(quiet, AT + 864e5 + 60e3);
    expect(l.tone).toBe("warn");
    expect(l.text).toContain("11 write-offs");
    expect(digestStatusLine({ atMs: AT + 864e5, outcome: "nothing_new" }, AT + 864e5 + 60e3).tone).toBe("ok");
    // a run that failed to deliver is never hidden behind yesterday's mail
    expect(digestStatusLine({ ...quiet, outcome: "no_channel_delivered" }, AT + 864e5 + 60e3).tone).toBe("fail");
  });
});
