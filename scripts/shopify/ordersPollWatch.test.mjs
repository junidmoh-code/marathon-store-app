// The website-orders poller watchdog (ordersPollWatch.mjs): pure, no mail, no files.
import { describe, test, expect } from "vitest";
import { parseLog, runsOf, assess, decide, inTradingHours } from "./ordersPollWatch.mjs";

const at = (hhmm, date = "2026-10-29") => Date.parse(`${date}T${hhmm}:00+02:00`);
const stampOf = (ms) => {
  const d = new Date(ms + 2 * 3600e3).toISOString();
  return `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}, ${d.slice(11, 19)}`;
};
const L = (ms, text) => `${stampOf(ms)}  ${text}`;
const quiet = (ms) => L(ms, "orders: quiet (25 open)");
const err504 = (ms) => [
  L(ms, "✗ orders poll failed: Token request failed: HTTP 504 <html>"),
  L(ms, "<head><title>504 Gateway Time-out</title></head>"),
  L(ms, "<center><h1>504 Gateway Time-out</h1></center>"),
].join("\n");
const every2 = (from, to, fn) => { const out = []; for (let t = from; t <= to; t += 2 * 60e3) out.push(fn(t)); return out.join("\n"); };

describe("reading the log", () => {
  test("the runner's en-ZA SAST stamp parses to the right instant", () => {
    const [l] = parseLog("2026/10/29, 10:05:07  ✗ orders poll failed: x");
    expect(l.at).toBe(Date.parse("2026-10-29T10:05:07+02:00"));
    expect(l.text).toBe("✗ orders poll failed: x");
  });
  test("a run is a top-level verdict; details and error-page HTML are not runs", () => {
    const text = [
      quiet(at("14:00")),
      L(at("14:09"), "  ✗ #1859: courier not booked (no standard box fits)"),
      L(at("14:09"), "orders: 0 new · 0 cancelled · 12 open"),
      err504(at("14:11")),
      L(at("14:12"), "⚠ RULES NOT PASTED: /online_orders needs"),
    ].join("\n");
    expect(runsOf(parseLog(text)).map((r) => r.ok)).toEqual([true, true, false]);
  });
});

describe("trading hours are 07:00–19:00 SAST", () => {
  test("in and out", () => {
    for (const t of ["07:00", "10:15", "19:00"]) expect(inTradingHours(at(t))).toBe(true);
    for (const t of ["06:30", "06:59", "19:01", "19:10", "23:00", "03:00"]) expect(inTradingHours(at(t))).toBe(false);
  });
});

describe("STALE: no new line for 15 minutes in trading hours", () => {
  test("a line 14 minutes ago is fine; 15 is down", () => {
    const lines = parseLog(quiet(at("11:00")));
    expect(assess({ lines, now: at("11:14") }).down).toBe(false);
    expect(assess({ lines, now: at("11:15") })).toMatchObject({ stale: true, down: true });
  });
  test("the overnight gap is never an outage: the 06:30 catch-up then nothing until 07:00", () => {
    const lines = parseLog([quiet(at("19:00", "2026-10-28")), quiet(at("06:30"))].join("\n"));
    expect(assess({ lines, now: at("07:00") }).down).toBe(false);
    expect(assess({ lines, now: at("07:10") }).down).toBe(false);
    // …but if nothing at all came by 07:15, it is down.
    expect(assess({ lines, now: at("07:15") }).stale).toBe(true);
  });
  test("27 Oct: the log 'stopped' at 19:01 — the end of trading hours, not an outage", () => {
    const lines = parseLog(quiet(at("19:01", "2026-10-27")));
    const r = decide({ lines, now: at("21:00", "2026-10-27"), state: {} });
    expect(r.mail).toBeNull();
  });
  test("an empty or missing log in trading hours is down", () => {
    expect(assess({ lines: [], now: at("12:00") }).down).toBe(true);
  });
});

describe("FAILING: the last 5 runs all failed (29 Oct 10:01–10:26, Shopify 504s)", () => {
  const log = [every2(at("09:40"), at("09:58"), quiet), every2(at("10:01"), at("10:26"), err504), every2(at("10:30"), at("10:40"), quiet)].join("\n");
  const upTo = (ms) => parseLog(log).filter((l) => l.at <= ms);

  test("4 failures in a row is not yet an outage; 5 is", () => {
    expect(assess({ lines: upTo(at("10:07")), now: at("10:08") }).failing).toBe(false);
    expect(assess({ lines: upTo(at("10:09")), now: at("10:10") }).failing).toBe(true);
  });
  test("ONE mail when it starts, nothing while it lasts, ONE mail when it is back", () => {
    let state = {};
    const mails = [];
    for (let t = at("10:00"); t <= at("10:40"); t += 10 * 60e3) {
      const r = decide({ lines: upTo(t), now: t, state });
      if (r.mail) mails.push({ t, ...r.mail });
      state = r.state;
    }
    expect(mails.map((m) => m.subject)).toEqual([
      "Website orders poller is DOWN: the last 5 runs all failed",
      "Website orders poller is working again",
    ]);
    expect(mails[0].text).toContain("HTTP 504");
    expect(mails[0].t).toBe(at("10:10"));
    expect(mails[1].t).toBe(at("10:40")); // three good runs in a row (10:30, 10:32, 10:34) first
    expect(state.outage).toBeNull();
  });
  test("a failure among good runs is not an outage", () => {
    const lines = parseLog([quiet(at("12:00")), err504(at("12:02")), quiet(at("12:04")), quiet(at("12:06")), err504(at("12:08"))].join("\n"));
    expect(decide({ lines, now: at("12:09"), state: {} }).mail).toBeNull();
  });
  test("an outage only ends on a GOOD run, not on a mix that is merely not 5 failures", () => {
    const lines = parseLog([every2(at("12:00"), at("12:08"), err504), quiet(at("12:10")), err504(at("12:12"))].join("\n"));
    const r = decide({ lines, now: at("12:13"), state: { outage: { since: at("12:09"), reason: "x" } } });
    expect(r.mail).toBeNull();
    expect(r.state.outage).toBeTruthy();
  });
});

describe("outside trading hours it stays silent", () => {
  test("no outage mail at night, however stale or failing", () => {
    const lines = parseLog(every2(at("18:50"), at("19:00"), err504));
    expect(decide({ lines, now: at("19:10"), state: {} }).mail).toBeNull();
    expect(decide({ lines, now: at("02:00", "2026-10-30"), state: {} }).mail).toBeNull();
  });
  test("an outage still open at 19:00 stays open overnight and recovers in the morning", () => {
    const state = { outage: { since: at("18:30"), reason: "the last 5 runs all failed", startedAt: at("18:20") } };
    const night = parseLog([every2(at("18:20"), at("19:00"), err504)].join("\n"));
    const n = decide({ lines: night, now: at("22:00"), state });
    expect(n.mail).toBeNull();
    expect(n.state.outage).toEqual(state.outage);
    const morning = parseLog([every2(at("18:20"), at("19:00"), err504), quiet(at("06:30", "2026-10-30")), quiet(at("07:02", "2026-10-30")), quiet(at("07:04", "2026-10-30"))].join("\n"));
    const m = decide({ lines: morning, now: at("07:05", "2026-10-30"), state: n.state });
    expect(m.mail.subject).toBe("Website orders poller is working again");
    expect(m.state.outage).toBeNull();
  });
});

describe("the mails", () => {
  test("a stale outage says how long the log has been quiet", () => {
    const r = decide({ lines: parseLog(quiet(at("11:00"))), now: at("11:20"), state: {} });
    expect(r.mail.subject).toBe("Website orders poller is DOWN: no new poll run in logs/orders-poll.log for 20 minutes");
    expect(r.state.outage).toMatchObject({ since: at("11:20"), startedAt: at("11:00") });
  });
  test("never twice for the same outage", () => {
    const lines = parseLog(quiet(at("11:00")));
    const first = decide({ lines, now: at("11:20"), state: {} });
    expect(decide({ lines, now: at("11:30"), state: first.state }).mail).toBeNull();
    expect(decide({ lines, now: at("13:30"), state: first.state }).mail).toBeNull();
  });
});

// The REAL 29 Oct 2026 run lines (logs/orders-poll.log), with the one good run at
// 10:12:20 in the middle of the outage (spec review): every check timing gives
// exactly one DOWN mail and one recovery mail.
const REAL_29_OCT = `2026/10/29, 09:46:35  orders: quiet (26 open)
2026/10/29, 09:48:42  orders: 1 new · 0 cancelled · 0 flagged · 25 open
2026/10/29, 09:50:33  orders: quiet (25 open)
2026/10/29, 09:53:12  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 09:53:12  <head><title>504 Gateway Time-out</title></head>
2026/10/29, 09:54:12  ✗ orders poll failed: Token request failed: HTTP 503 <html>
2026/10/29, 09:57:21  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 09:58:44  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:01:42  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:05:07  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:09:19  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:12:20  orders: quiet (25 open)
2026/10/29, 10:13:58  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:16:56  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:17:58  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:20:57  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:22:58  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:24:59  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:26:18  ✗ orders poll failed: Token request failed: HTTP 504 <html>
2026/10/29, 10:28:39  orders: quiet (25 open)
2026/10/29, 10:30:40  orders: quiet (25 open)
2026/10/29, 10:32:42  orders: quiet (25 open)
2026/10/29, 10:35:06  orders: 1 new · 0 cancelled · 0 flagged · 26 open
2026/10/29, 10:36:43  orders: quiet (26 open)
2026/10/29, 10:38:55  orders: quiet (26 open)
2026/10/29, 10:40:55  orders: quiet (26 open)
2026/10/29, 10:42:51  orders: quiet (26 open)
2026/10/29, 10:44:50  orders: quiet (26 open)`;

describe("the real 29 Oct outage", () => {
  test("one DOWN and one recovery mail, whatever minute the 10-minute check lands on", () => {
    const all = parseLog(REAL_29_OCT);
    for (let offset = 0; offset < 10; offset++) {
      let state = {};
      const subjects = [];
      for (let t = at("09:47") + offset * 60e3; t <= at("10:50"); t += 10 * 60e3) {
        const r = decide({ lines: all.filter((l) => l.at <= t), now: t, state });
        if (r.mail) subjects.push(r.mail.subject);
        state = r.state;
      }
      expect(subjects, `checks at :${offset}`).toEqual([
        "Website orders poller is DOWN: the last 5 runs all failed",
        "Website orders poller is working again",
      ]);
    }
  });
});

describe("a poller that crashes at start-up every tick", () => {
  test("stamped stack traces are not a sign of life: down after 15 minutes without a run", () => {
    const crash = (ms) => [L(ms, "file:///Users/marathonclub/marathon-store-app/scripts/shopify/orders-poll.mjs:3"), L(ms, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'firebase-admin'")].join("\n");
    const lines = parseLog([quiet(at("11:00")), every2(at("11:02"), at("11:20"), crash)].join("\n"));
    const r = decide({ lines, now: at("11:20"), state: {} });
    expect(r.mail?.subject).toBe("Website orders poller is DOWN: no new poll run in logs/orders-poll.log for 20 minutes");
  });
  test("a broken state (null, an array) is read as none", () => {
    expect(decide({ lines: parseLog(quiet(at("11:00"))), now: at("11:05"), state: null }).mail).toBeNull();
  });
});

describe("recovery counts only runs after the outage began (architect review 2)", () => {
  test("died at 18:30, mailed at 18:45, nothing overnight: no 'working again' at 07:05", () => {
    const lines = parseLog(every2(at("18:00"), at("18:30"), quiet));
    const down = decide({ lines, now: at("18:45"), state: {} });
    expect(down.mail.subject).toMatch(/DOWN: no new poll run/);
    const morning = decide({ lines, now: at("07:05", "2026-10-30"), state: down.state });
    expect(morning.mail).toBeNull();
    expect(morning.state.outage).toBeTruthy();
    // …and once three new runs have come, it is over.
    const back = parseLog([every2(at("18:00"), at("18:30"), quiet), every2(at("07:00", "2026-10-30"), at("07:04", "2026-10-30"), quiet)].join("\n"));
    expect(decide({ lines: back, now: at("07:06", "2026-10-30"), state: down.state }).mail?.subject).toBe("Website orders poller is working again");
  });
});
