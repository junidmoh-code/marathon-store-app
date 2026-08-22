// ─── THE SELL-THROUGH SIGNAL ─────────────────────────────────────────────────
// Three things can quietly go wrong here and none of them raises an error:
// downloading the wrong time window, stopping the pager a page early, and
// counting a sale twice. All three are tested against the property, not against
// a happy path.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  PUSH_CHARS, PAD_MS, WINDOW_DAYS, PAGE, MAX_PAGES,
  pushKeyForMs, recentDaysStartKey, pageBackwards, compositeKey, returnKey, tallyUnits,
} = require("../lib/social-signal.cjs");
const { saDateStringFromMs } = require("../lib/sa-time.cjs");

// ─── THE DRIFT PIN ───────────────────────────────────────────────────────────
// pushKeyForMs here is a twin of the one in src/insights/insightsLogRange.js.
// If they diverge this side downloads the wrong window — and reports a
// perfectly confident ranking computed over it.
describe("pushKeyForMs matches the browser twin", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const SRC = join(__dirname, "../../src/insights/insightsLogRange.js");

  // Rebuild the ESM twin's implementation from its own source, so the
  // comparison is against the real code rather than a copy of a copy.
  const src = readFileSync(SRC, "utf8");
  const chars = src.match(/const PUSH_CHARS = "(.+?)";/)[1];

  test("the alphabet is identical", () => {
    assert.equal(chars, PUSH_CHARS);
    assert.equal(PUSH_CHARS.length, 64);
  });

  test("the browser twin still has the shape this pins", () => {
    assert.match(src, /export function pushKeyForMs/);
    assert.match(src, /export function recentDaysStartKey/);
    assert.match(src, /export const PAD_MS = 48 \* 60 \* 60 \* 1000;/);
    assert.equal(PAD_MS, 48 * 60 * 60 * 1000);
  });

  test("produces an 8-character key that sorts with time", () => {
    const instants = [0, 1, 1000, 1785000000000, 1787000000000, Date.UTC(2026, 7, 22)];
    const keys = instants.map(pushKeyForMs);
    for (const k of keys) assert.equal(k.length, 8);
    for (let i = 1; i < keys.length; i++) {
      assert.ok(keys[i] > keys[i - 1], `${instants[i]} did not sort after ${instants[i - 1]}`);
    }
  });

  test("the documented worked example still holds", () => {
    // From the ESM twin's own doc comment.
    assert.equal(pushKeyForMs(1785000000000), "-OyPHbc-");
  });

  test("negative and nonsense instants clamp to the epoch rather than throwing", () => {
    assert.equal(pushKeyForMs(-1), pushKeyForMs(0));
    assert.equal(pushKeyForMs(NaN), pushKeyForMs(0));
    assert.equal(pushKeyForMs("x"), pushKeyForMs(0));
  });
});

describe("recentDaysStartKey", () => {
  const NOW = Date.UTC(2026, 7, 22, 12, 0);

  test("the padded start is earlier than the window it protects", () => {
    const { startMs } = recentDaysStartKey(WINDOW_DAYS, NOW);
    const naive = NOW - WINDOW_DAYS * 86400000;
    assert.ok(startMs < naive, "the download bound is not wider than the window");
    // The pad is what protects against key/timestamp skew — an entry whose
    // timestamp is inside the window but whose key sorts before its start.
    assert.ok(naive - startMs >= PAD_MS);
  });

  test("more days means an earlier start", () => {
    const a = recentDaysStartKey(7, NOW).startMs;
    const b = recentDaysStartKey(56, NOW).startMs;
    assert.ok(b < a);
    assert.equal(a - b, 49 * 86400000);
  });

  test("the key and the ms agree", () => {
    const { startKey, startMs } = recentDaysStartKey(WINDOW_DAYS, NOW);
    assert.equal(startKey, pushKeyForMs(startMs));
  });

  test("anchors on the SA calendar day, not the UTC instant", () => {
    // 22:30 UTC is already the 23rd in SA. Two instants inside the same SA day
    // must produce the same start.
    const a = recentDaysStartKey(7, Date.UTC(2026, 7, 22, 23, 0));
    const b = recentDaysStartKey(7, Date.UTC(2026, 7, 22, 22, 30));
    assert.equal(a.startMs, b.startMs);
  });
});

// ── THE PAGER ────────────────────────────────────────────────────────────────
// A fake ref, so the paging logic is tested without Firebase. It stores keys in
// sorted order and answers endAt/limitToLast the way RTDB does — endAt is
// INCLUSIVE, which is exactly the detail that makes the cursor row need
// removing.
function fakeDb(nodes) {
  return (path) => {
    const data = nodes[path] || {};
    const state = { end: null, limit: null };
    const api = {
      orderByKey: () => api,
      endAt: (k) => { state.end = k; return api; },
      limitToLast: (n) => { state.limit = n; return api; },
      once: async () => {
        let keys = Object.keys(data).sort();
        if (state.end !== null) keys = keys.filter((k) => k <= state.end);   // inclusive
        if (state.limit !== null) keys = keys.slice(-state.limit);
        const out = {};
        for (const k of keys) out[k] = data[k];
        return { val: () => out };
      },
    };
    return api;
  };
}

const key = (i) => pushKeyForMs(1780000000000 + i * 60000);

describe("pageBackwards", () => {
  test("reads a node smaller than one page in a single pass", () => {
    const rows = {};
    for (let i = 0; i < 10; i++) rows[key(i)] = { action: "ready", qty: 1 };
    return pageBackwards(fakeDb({ insights_log: rows }), "insights_log", key(0), "ready").then((r) => {
      assert.equal(r.rows.length, 10);
      assert.equal(r.pages, 1);
      assert.equal(r.truncated, false);
    });
  });

  test("filters on action when asked, and not when not", async () => {
    const rows = {};
    for (let i = 0; i < 10; i++) rows[key(i)] = { action: i % 2 ? "ready" : "oos" };
    const db = fakeDb({ insights_log: rows });
    assert.equal((await pageBackwards(db, "insights_log", key(0), "ready")).rows.length, 5);
    assert.equal((await pageBackwards(db, "insights_log", key(0), null)).rows.length, 10);
  });

  test("walks BACKWARDS across many pages and reads every row exactly once", async () => {
    // The bug this guards: the cursor row is re-read (endAt is inclusive) or a
    // page is skipped. Both are silent — the count is just wrong.
    const total = PAGE * 2 + 137;
    const rows = {};
    for (let i = 0; i < total; i++) rows[key(i)] = { action: "ready", n: i };
    const r = await pageBackwards(fakeDb({ insights_log: rows }), "insights_log", key(0), "ready");
    assert.equal(r.rows.length, total, "did not read every row exactly once");
    const seen = new Set(r.rows.map((x) => x.n));
    assert.equal(seen.size, total, "a row was read twice");
    assert.ok(r.pages >= 3);
  });

  test("stops as soon as the oldest key on a page predates the window", async () => {
    // Only the newest 50 are inside the window; the pager must not walk the
    // other 9,950.
    const rows = {};
    for (let i = 0; i < 10000; i++) rows[key(i)] = { action: "ready" };
    const from = key(9950);
    const r = await pageBackwards(fakeDb({ insights_log: rows }), "insights_log", from, "ready");
    assert.equal(r.pages, 1, "walked further back than the window needed");
  });

  test("an empty node is one page and no rows", async () => {
    const r = await pageBackwards(fakeDb({}), "insights_log", key(0), "ready");
    assert.equal(r.rows.length, 0);
    assert.equal(r.truncated, false);
  });

  test("reports truncation rather than pretending the window is complete", async () => {
    const rows = {};
    for (let i = 0; i < PAGE * (MAX_PAGES + 3); i++) rows[key(i)] = { action: "ready" };
    const r = await pageBackwards(fakeDb({ insights_log: rows }), "insights_log", key(0), "ready");
    assert.equal(r.truncated, true);
    assert.equal(r.pages, MAX_PAGES);
  });

  test("skips rows that are not objects instead of throwing", async () => {
    const rows = { [key(0)]: null, [key(1)]: "nonsense", [key(2)]: { action: "ready" } };
    const r = await pageBackwards(fakeDb({ insights_log: rows }), "insights_log", key(0), "ready");
    assert.equal(r.rows.length, 1);
  });
});

describe("compositeKey / returnKey", () => {
  test("scopes the daily-reset order number by SA date", () => {
    assert.equal(compositeKey({ timestamp: "2026-08-22T10:00:00.000Z", orderNumber: 7 }), "2026-08-22::7");
  });

  // ── THE BUG A TEST CAUGHT ────────────────────────────────────────────────
  // SA is UTC+2, so a sale rung up at 23:30 UTC belongs to the NEXT SA day.
  // An ISO slice keys it to the wrong day — for every sale after 22:00 local,
  // every day — and then no return ever matches it.
  test("uses the SA calendar day, not a UTC slice of the timestamp", () => {
    assert.equal(compositeKey({ timestamp: "2026-08-22T23:30:00.000Z", orderNumber: 7 }), "2026-08-23::7");
    assert.equal(compositeKey({ timestamp: "2026-08-22T21:59:00.000Z", orderNumber: 7 }), "2026-08-22::7");
    assert.equal(compositeKey({ timestamp: "2026-08-22T22:00:00.000Z", orderNumber: 7 }), "2026-08-23::7");
  });

  test("agrees with sa-time for a spread of instants across the day boundary", () => {
    for (let h = 0; h < 24; h++) {
      const iso = `2026-08-22T${String(h).padStart(2, "0")}:30:00.000Z`;
      const expected = saDateStringFromMs(Date.parse(iso));
      assert.equal(compositeKey({ timestamp: iso, orderNumber: 1 }), `${expected}::1`, iso);
    }
  });

  test("the SAME order number on two days is two different keys", () => {
    const a = compositeKey({ timestamp: "2026-08-22T10:00:00Z", orderNumber: 1 });
    const b = compositeKey({ timestamp: "2026-08-23T10:00:00Z", orderNumber: 1 });
    assert.notEqual(a, b);
  });

  test("accepts the snake_case spelling too", () => {
    assert.equal(compositeKey({ timestamp: "2026-08-22T10:00:00Z", order_number: 3 }), "2026-08-22::3");
  });

  test("returns null when there is no order number to key on", () => {
    for (const e of [{}, { orderNumber: null }, { orderNumber: "" }, null, undefined]) {
      assert.equal(compositeKey(e), null);
      assert.equal(returnKey(e), null);
    }
  });

  test("order number 0 is a real number, not a missing one", () => {
    assert.equal(compositeKey({ timestamp: "2026-08-22T00:00:00Z", orderNumber: 0 }), "2026-08-22::0");
  });

  test("a string order number keys the same as a numeric one — the till writes both", () => {
    // insights_log carries numbers; returns_log carries strings ("252").
    const a = compositeKey({ timestamp: "2026-08-22T10:00:00Z", orderNumber: 252 });
    const b = returnKey({ timestamp: "2026-08-22T10:00:00Z", orderNumber: "252" });
    assert.equal(a, b);
  });

  // ── THE SECOND BUG A TEST CAUGHT ─────────────────────────────────────────
  // `date` on a return is the ORDER's date; `timestamp` is when the return was
  // logged. A return processed the morning after must still cancel yesterday's
  // sale.
  test("a return prefers its own `date` field over its timestamp", () => {
    assert.equal(
      returnKey({ date: "2026-08-22", timestamp: "2026-08-23T08:00:00.000Z", orderNumber: 5 }),
      "2026-08-22::5"
    );
  });

  test("a return with no `date` falls back to the SA date of its timestamp", () => {
    assert.equal(returnKey({ timestamp: "2026-08-22T10:00:00.000Z", orderNumber: 5 }), "2026-08-22::5");
  });

  // ── DIFFERENTIAL AGAINST THE PRODUCTION HELPERS ──────────────────────────
  // functions/index.js holds eventCompositeKey / returnCompositeKey and cannot
  // be required here (it boots firebase-functions). Their bodies are lifted
  // from the source text and run against the same inputs, so a change to
  // either side that is not mirrored fails.
  test("matches eventCompositeKey / returnCompositeKey in functions/index.js", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(__dirname, "../index.js"), "utf8");
    assert.match(src, /function eventCompositeKey\(e\) \{\s*return `\$\{saDateStringFromMs\(isoToMs\(e\.timestamp\)\)\}::\$\{e\.orderNumber\}`;/,
      "eventCompositeKey in functions/index.js no longer has the shape this mirrors");
    assert.match(src, /function returnCompositeKey\(r\) \{\s*const date = r\.date \|\| saDateStringFromMs\(isoToMs\(r\.timestamp\)\);/,
      "returnCompositeKey in functions/index.js no longer has the shape this mirrors");

    const prodEvent = (e) => `${saDateStringFromMs(Date.parse(e.timestamp))}::${e.orderNumber}`;
    const prodReturn = (r) => `${r.date || saDateStringFromMs(Date.parse(r.timestamp))}::${r.orderNumber}`;
    const samples = [
      { timestamp: "2026-08-22T10:00:00.000Z", orderNumber: 1 },
      { timestamp: "2026-08-22T23:30:00.000Z", orderNumber: 42 },
      { timestamp: "2026-01-01T00:00:00.000Z", orderNumber: "007" },
      { timestamp: "2026-12-31T22:30:00.000Z", orderNumber: 999 },
    ];
    for (const e of samples) {
      assert.equal(compositeKey(e), prodEvent(e), JSON.stringify(e));
      assert.equal(returnKey(e), prodReturn(e), JSON.stringify(e));
      assert.equal(returnKey({ ...e, date: "2026-05-05" }), prodReturn({ ...e, date: "2026-05-05" }));
    }
  });
});

describe("tallyUnits", () => {
  const FROM = "2026-07-01T00:00:00.000Z";
  const TO = "2026-08-23T00:00:00.000Z";
  const ev = (over) => ({ timestamp: "2026-08-01T10:00:00.000Z", action: "ready", ...over });

  test("counts qty, defaulting a missing qty to one", () => {
    const r = tallyUnits([ev({ orderNumber: 1, productId: "pA", qty: 3 }), ev({ orderNumber: 2, productId: "pA" })], [], FROM, TO);
    assert.equal(r.unitsByPid.pA, 4);
    assert.equal(r.totalUnits, 4);
  });

  test("de-duplicates an undo/redo pair", () => {
    const dupe = ev({ orderNumber: 9, productId: "pA", qty: 2 });
    const r = tallyUnits([dupe, { ...dupe }], [], FROM, TO);
    assert.equal(r.unitsByPid.pA, 2, "the same sale was counted twice");
  });

  test("drops a sale that was returned", () => {
    const sale = ev({ orderNumber: 5, productId: "pA", qty: 4 });
    // Same SA day as the sale — which is what a real reversal looks like.
    const ret = { timestamp: "2026-08-01T13:00:00.000Z", orderNumber: 5 };
    const r = tallyUnits([sale], [ret], FROM, TO);
    assert.equal(r.unitsByPid.pA, undefined);
    assert.equal(r.totalUnits, 0);
  });

  test("a return for a DIFFERENT day's order does not cancel this day's sale", () => {
    // The composite key is what makes this correct: the numbers collide, the
    // dates do not.
    const sale = ev({ timestamp: "2026-08-02T10:00:00.000Z", orderNumber: 5, productId: "pA", qty: 4 });
    const ret = { date: "2026-08-03", timestamp: "2026-08-03T10:00:00.000Z", orderNumber: 5 };
    const r = tallyUnits([sale], [ret], FROM, TO);
    assert.equal(r.unitsByPid.pA, 4);
  });

  test("a return logged the MORNING AFTER still cancels its order", () => {
    // This is the case the `date` preference exists for, and the case the
    // first draft of this module got wrong.
    const sale = ev({ timestamp: "2026-08-02T15:00:00.000Z", orderNumber: 5, productId: "pA", qty: 4 });
    const ret = { date: "2026-08-02", timestamp: "2026-08-03T08:00:00.000Z", orderNumber: 5 };
    const r = tallyUnits([sale], [ret], FROM, TO);
    assert.equal(r.unitsByPid.pA, undefined, "a next-morning return failed to cancel its sale");
  });

  test("returns are applied BEFORE de-duplication, so an undo pair cannot survive one", () => {
    const sale = ev({ orderNumber: 7, productId: "pA", qty: 1 });
    const r = tallyUnits([sale, { ...sale }], [{ date: "2026-08-01", orderNumber: 7, timestamp: sale.timestamp }], FROM, TO);
    assert.equal(r.totalUnits, 0);
  });

  test("respects the window on both ends", () => {
    const rows = [
      ev({ timestamp: "2026-06-01T00:00:00.000Z", orderNumber: 1, productId: "old", qty: 5 }),
      ev({ timestamp: "2026-09-01T00:00:00.000Z", orderNumber: 2, productId: "future", qty: 5 }),
      ev({ timestamp: "2026-08-01T00:00:00.000Z", orderNumber: 3, productId: "in", qty: 5 }),
    ];
    const r = tallyUnits(rows, [], FROM, TO);
    assert.deepEqual(Object.keys(r.unitsByPid), ["in"]);
  });

  test("an event with no order number is counted ONCE, not dropped and not multiplied", () => {
    // It cannot be de-duplicated or matched against a return. Dropping it would
    // understate the tills; counting it repeatedly would be worse.
    const rows = [ev({ productId: "pA", qty: 2 }), ev({ productId: "pA", qty: 3 })];
    const r = tallyUnits(rows, [], FROM, TO);
    assert.equal(r.unitsByPid.pA, 5);
  });

  test("reports attribution coverage honestly", () => {
    const rows = [
      ev({ orderNumber: 1, productId: "pA", qty: 3 }),
      ev({ orderNumber: 2, qty: 7 }),   // no productId
    ];
    const r = tallyUnits(rows, [], FROM, TO);
    assert.equal(r.totalUnits, 10);
    assert.equal(r.attributedUnits, 3);
    assert.equal(r.coverage, 0.3);
  });

  test("coverage is 0, not NaN, when there is nothing at all", () => {
    const r = tallyUnits([], [], FROM, TO);
    assert.equal(r.coverage, 0);
    assert.deepEqual(r.unitsByPid, {});
  });

  test("trims whitespace off a productId rather than making two products of it", () => {
    const r = tallyUnits([
      ev({ orderNumber: 1, productId: "pA" }),
      ev({ orderNumber: 2, productId: " pA " }),
    ], [], FROM, TO);
    assert.equal(r.unitsByPid.pA, 2);
  });

  test("a return with neither date nor timestamp cancels nothing, deliberately", () => {
    const sale = ev({ orderNumber: 5, productId: "pA", qty: 4 });
    const r = tallyUnits([sale], [{ orderNumber: 5 }], FROM, TO);
    // No date and no timestamp ⇒ key "::5", which matches no sale. Documented
    // rather than asserted away: the alternative — matching on the number
    // alone — would cancel a sale on every other day that reused it.
    assert.equal(r.unitsByPid.pA, 4);
  });
});
