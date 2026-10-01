// REQUIREMENT: a tick means "this till's report for TODAY is in", and nothing
// else. The two ways it can be wrong are the two ways this feature fails:
// ticking a till that has not reconciled (the manager stops looking), and
// failing to tick one that has (the manager captures it twice).
import { describe, it, expect } from "vitest";
import { emailedArrivals, refusedArrivals, tidFromSubject, handCaptures, rememberHandCapture } from "./todaysArrivals";
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

// ─── A REFUSED REPORT MUST NOT LOOK LIKE A SILENCE ───────────────────────────
// Built from the shapes actually in /card_batch_intake on 19 Sept 2026 —
// including the detail that made the bug invisible: a refused attachment
// carries NO tid, where every recorded one does.

describe("refusedArrivals", () => {
  const DAY = "2026-09-19";
  const dayOf = (ms) => new Date(ms + 2 * 3600 * 1000).toISOString().slice(0, 10);
  const at = (hhmm) => Date.parse(`2026-09-19T${hhmm}:00+02:00`);

  /** A refused row exactly as the poller wrote them that day: no tid. */
  const refusal = (subject, reason, ms) => ({
    receivedAt: ms, subject,
    attachments: [{ filename: "FNB-Txn-Notification.pdf", outcome: "refused", reason }],
  });
  const recorded = (tid, ms) => ({
    receivedAt: ms, subject: `Banking Report for Batch 79 of Terminal ${tid}`,
    attachments: [{ filename: "FNB-Txn-Notification.pdf", outcome: "recorded", tid }],
  });

  it("attributes a tid-less refusal to its till via the subject", () => {
    // The real case: Marathon Till 1, refused at 16:40, invisible all day.
    const node = {
      a: refusal("Banking Report for Batch 58 of Terminal 67325636",
                 "Batch #58 for this terminal is already captured.", at("16:40")),
    };
    const out = refusedArrivals(node, DAY, dayOf);
    expect(out.get("67325636")).toContain("already captured");
  });

  it("prefers the row's own tid over the subject once the poller writes one", () => {
    const node = {
      a: { receivedAt: at("16:40"), subject: "Banking Report for Batch 58 of Terminal 99999999",
           attachments: [{ outcome: "refused", tid: "67325636", reason: "Nope." }] },
    };
    expect([...refusedArrivals(node, DAY, dayOf).keys()]).toEqual(["67325636"]);
  });

  it("says NOTHING about a till that was refused and then recorded", () => {
    // Marathon Till 3 on the same day: batch 79 recorded at 16:38, then three
    // re-sends refused as duplicates. That is the system working, not a fault,
    // and reporting it would train the owner to ignore this line.
    const node = {
      ok: recorded("67365901", at("16:38")),
      r1: refusal("Banking Report for Batch 79 of Terminal 67365901", "…already captured.", at("16:38")),
      r2: refusal("Banking Report for Batch 79 of Terminal 67365901", "…already captured.", at("16:41")),
      r3: refusal("Banking Report for Batch 79 of Terminal 67365901", "…already captured.", at("16:43")),
    };
    expect(refusedArrivals(node, DAY, dayOf).size).toBe(0);
  });

  it("shows the LATEST refusal when a till was refused more than once", () => {
    const node = {
      early: refusal("Banking Report for Batch 58 of Terminal 67325636", "First reason.", at("09:00")),
      late:  refusal("Banking Report for Batch 58 of Terminal 67325636", "Second reason.", at("17:00")),
    };
    expect(refusedArrivals(node, DAY, dayOf).get("67325636")).toBe("Second reason.");
  });

  it("ignores refusals from other days", () => {
    const node = { old: refusal("Banking Report for Batch 57 of Terminal 67325636", "…", Date.parse("2026-09-18T17:00:00+02:00")) };
    expect(refusedArrivals(node, DAY, dayOf).size).toBe(0);
  });

  it("ignores a refusal whose till cannot be identified at all", () => {
    // The 16:19 row that day: a "Transaction History report" with no terminal
    // named anywhere. It belongs to no card and must not be pinned to one.
    const node = { x: refusal("Transaction History report for 2026-09-19", "No batch number.", at("16:19")) };
    expect(refusedArrivals(node, DAY, dayOf).size).toBe(0);
  });

  it("falls back to a sentence when a refusal carries no reason", () => {
    const node = {
      a: { receivedAt: at("16:40"), subject: "Banking Report for Batch 58 of Terminal 67325636",
           attachments: [{ outcome: "refused" }] },
    };
    expect(refusedArrivals(node, DAY, dayOf).get("67325636")).toMatch(/not recorded/i);
  });

  it("reads attachments handed back as an object, not only as an array", () => {
    // RTDB returns a sparse array as an object.
    const node = {
      a: { receivedAt: at("16:40"), subject: "Banking Report for Batch 58 of Terminal 67325636",
           attachments: { 0: { outcome: "refused", reason: "Objects too." } } },
    };
    expect(refusedArrivals(node, DAY, dayOf).get("67325636")).toBe("Objects too.");
  });

  it("is empty for an empty or unreadable feed", () => {
    expect(refusedArrivals(null, DAY, dayOf).size).toBe(0);
    expect(refusedArrivals({}, DAY, dayOf).size).toBe(0);
  });
});

describe("tidFromSubject", () => {
  it("reads the terminal out of the bank's own subject line", () => {
    expect(tidFromSubject("Banking Report for Batch 58 of Terminal 67325636")).toBe("67325636");
    expect(tidFromSubject("Banking Report for Batch 480 of Terminal 0000Z4M6")).toBe("0000Z4M6");
  });
  it("returns null when no terminal is named", () => {
    expect(tidFromSubject("Transaction History report for 2026-09-19")).toBe(null);
    expect(tidFromSubject("")).toBe(null);
    expect(tidFromSubject(null)).toBe(null);
  });
});
