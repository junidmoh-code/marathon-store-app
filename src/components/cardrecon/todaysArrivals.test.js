// REQUIREMENT: a tick means "this till's report for TODAY is in", and nothing
// else. The two ways it can be wrong are the two ways this feature fails:
// ticking a till that has not reconciled (the manager stops looking), and
// failing to tick one that has (the manager captures it twice).
import { describe, it, expect } from "vitest";
import { emailedArrivals, handCaptures, rememberHandCapture } from "./todaysArrivals";
import { saDateStringAt } from "../../utils/serverTime";

const day = saDateStringAt;
// 2026-08-31 15:00 UTC = 17:00 SAST, when the reports actually land.
const TODAY = Date.UTC(2026, 7, 31, 15, 0, 0);
const YESTERDAY = TODAY - 86400000;

const message = (over) => ({ receivedAt: TODAY, attachments: [], ...over });
const recorded = (tid) => ({ outcome: "recorded", tid, batchKey: "17" });

describe("which tills have today's emailed report", () => {
  it("ticks a terminal whose attachment was recorded today", () => {
    const node = { m1: message({ attachments: [recorded("67377843")] }) };
    expect([...emailedArrivals(node, day(TODAY), day)]).toEqual(["67377843"]);
  });

  it("does NOT tick a refused attachment — that is the failure, not the success", () => {
    const node = { m1: message({ attachments: [{ outcome: "refused", tid: "67377843" }] }) };
    expect([...emailedArrivals(node, day(TODAY), day)]).toEqual([]);
  });

  it("does not tick yesterday's report", () => {
    const node = { m1: message({ receivedAt: YESTERDAY, attachments: [recorded("67365901")] }) };
    expect([...emailedArrivals(node, day(TODAY), day)]).toEqual([]);
  });

  it("reads an attachments object as well as an array — RTDB returns either", () => {
    const node = { m1: message({ attachments: { 0: recorded("67364485") } }) };
    expect([...emailedArrivals(node, day(TODAY), day)]).toEqual(["67364485"]);
  });

  it("falls back to `at` when a row carries no receivedAt", () => {
    const node = { m1: { at: TODAY, attachments: [recorded("67364485")] } };
    expect([...emailedArrivals(node, day(TODAY), day)]).toEqual(["67364485"]);
  });

  it("an unreadable or empty feed ticks nothing rather than throwing", () => {
    expect([...emailedArrivals(null, day(TODAY), day)]).toEqual([]);
    expect([...emailedArrivals({ m1: null }, day(TODAY), day)]).toEqual([]);
  });

  it("the day boundary is SA time, not UTC", () => {
    // 22:30 UTC on the 31st is 00:30 SAST on the 1st — already tomorrow here.
    const lateNight = Date.UTC(2026, 7, 31, 22, 30, 0);
    const node = { m1: message({ receivedAt: lateNight, attachments: [recorded("X")] }) };
    expect([...emailedArrivals(node, day(TODAY), day)]).toEqual([]);
    expect([...emailedArrivals(node, day(lateNight), day)]).toEqual(["X"]);
  });
});

describe("the hand-captured tick this device remembers", () => {
  const fakeStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      _map: map,
    };
  };

  it("remembers a capture for today and reads it back", () => {
    const s = fakeStorage();
    rememberHandCapture("0000HP1X", day(TODAY), s);
    expect([...handCaptures(day(TODAY), s)]).toEqual(["0000HP1X"]);
  });

  it("stops matching tomorrow — the ticks reset with the day, uncleared", () => {
    const s = fakeStorage();
    rememberHandCapture("0000HP1X", day(YESTERDAY), s);
    expect([...handCaptures(day(TODAY), s)]).toEqual([]);
  });

  it("keeps one entry per till rather than a growing history", () => {
    const s = fakeStorage();
    rememberHandCapture("A", day(YESTERDAY), s);
    rememberHandCapture("B", day(TODAY), s);
    rememberHandCapture("A", day(TODAY), s);
    expect(JSON.parse(s._map.get("cardRecon.capturedOn"))).toEqual({ B: day(TODAY), A: day(TODAY) });
  });

  it("a storage that throws is an empty set, never an exception", () => {
    const hostile = { getItem: () => { throw new Error("denied"); },
                      setItem: () => { throw new Error("denied"); } };
    expect([...handCaptures(day(TODAY), hostile)]).toEqual([]);
    expect(() => rememberHandCapture("A", day(TODAY), hostile)).not.toThrow();
  });

  it("corrupt stored JSON reads as nothing captured", () => {
    const s = fakeStorage();
    s.setItem("cardRecon.capturedOn", "{not json");
    expect([...handCaptures(day(TODAY), s)]).toEqual([]);
  });
});
