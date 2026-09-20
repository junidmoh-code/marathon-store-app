// ─── THE ROLLUP SWEEP ────────────────────────────────────────────────────────
//
// Against a fake database that actually honours key ranges and page limits. A
// fake that returned everything regardless of the constraints would make the
// bounded reads vacuous — the cursor could be wrong, or missing, and every
// test here would still pass.
//
// What is asserted is the set of properties the design rests on:
//   · a day node is a pure function of that day's events, so a rebuild writes
//     the same bytes and a crash costs a repeat rather than a double count;
//   · today is never built;
//   · a row written far later than its own timestamp — outside the padded key
//     range its day is rebuilt from — is put where readers can still find it,
//     instead of vanishing into a plausible-looking quiet day;
//   · a day with no node inside the backstop window heals itself;
//   · the cursor and the day nodes land in ONE update, so the cursor can never
//     be ahead of the aggregates it justified.

const test = require("node:test");
const assert = require("node:assert");
const {
  runSweep, buildDay, datesToBuild, keyRangeForDate, saDateOf, shiftSaDate,
  pushKeyForMs, DAYS_PATH, LATE_PATH, CURSOR_PATH, BUILT_PATH, INDEX_PATH, LOG_TOTALS_PATH, CATCHUP_PAGE,
} = require("../insightsRollup/builder.cjs");
const { expandDay, keptFieldsOf } = require("../insightsRollup/rollupCodec.cjs");

const SA = 2 * 3600 * 1000;
const NOW = Date.parse("2026-09-20T09:00:00.000Z");   // 11:00 SA on the 20th
const TODAY = "2026-09-20";

/** Every date the backstop would otherwise report as missing. */
function allBackstopDays(today) {
  const out = [];
  for (let i = 1; i <= 14; i++) out.push(shiftSaDate(today, -i));
  return out;
}

/** A log whose keys really are ordered by the ms they encode. */
function makeLog(entries) {
  // entries: [{ atMs, keyMs?, value }]
  const rows = entries.map((e, i) => ({
    key: `${pushKeyForMs(e.keyMs ?? e.atMs)}${String(i).padStart(12, "0")}`,
    value: { timestamp: new Date(e.atMs).toISOString(), ...e.value },
  }));
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

function makeIo(rows, { dayKeys = [], cursor = null } = {}) {
  const commits = [];
  const reads = [];
  const advances = [];
  const meta = { cursor, logTotals: null };
  return {
    commits,
    reads,
    advances,
    meta,
    async readCursor() { return cursor; },
    async readKeyRange(startKey, endKey) {
      reads.push({ kind: "range", startKey, endKey });
      return rows.filter((r) => r.key >= startKey && r.key <= endKey);
    },
    async readPageAfter(after, limit) {
      reads.push({ kind: "page", after, limit });
      assert.ok(limit > 0, "a page read must carry a limit");
      const from = after === null || after === undefined ? rows : rows.filter((r) => r.key > after);
      return from.slice(0, limit);
    },
    async listDayKeys() { return dayKeys; },
    async readLogTotals() { return null; },
    async commit({ updates }) { commits.push(updates); },
    // The compare-and-set the real io does with a transaction.
    async advanceCursor({ expect, cursor, seen, at }) {
      advances.push({ expect, cursor, seen, at });
      if ((meta.cursor ?? null) !== (expect ?? null)) return false;
      meta.cursor = cursor ?? null;
      const b = meta.logTotals || { n: 0, pe: 0, trophy: 0, pine: 0, other: 0 };
      meta.logTotals = {
        n: b.n + seen.n, pe: b.pe + seen.pe, trophy: b.trophy + seen.trophy,
        pine: b.pine + seen.pine, other: b.other + seen.other, cursor, at,
      };
      return true;
    },
  };
}

const sale = (atMs, extra = {}) => ({ atMs, value: { action: "ready", productName: "Boot", size: "8", ...extra } });

test("builds yesterday and the day before, never today", async () => {
  const rows = makeLog([
    sale(Date.parse("2026-09-20T08:00:00.000Z")),   // today, SA
    sale(Date.parse("2026-09-19T08:00:00.000Z")),
    sale(Date.parse("2026-09-18T08:00:00.000Z")),
  ]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  const r = await runSweep({ io, nowMs: NOW });

  assert.deepStrictEqual(r.dates, ["2026-09-18", "2026-09-19"]);
  assert.ok(!r.dates.includes(TODAY), "today must never be built");
});

test("a day node holds exactly that day's rows, in key order", async () => {
  const rows = makeLog([
    sale(Date.parse("2026-09-18T05:00:00.000Z"), { productName: "A" }),
    sale(Date.parse("2026-09-18T21:59:00.000Z"), { productName: "B" }),   // 23:59 SA — in
    sale(Date.parse("2026-09-18T22:01:00.000Z"), { productName: "C" }),   // 00:01 SA next day — out
    sale(Date.parse("2026-09-17T22:30:00.000Z"), { productName: "D" }),   // 00:30 SA on the 18th — in
  ]);
  const io = makeIo(rows);
  const built = await buildDay(io, "2026-09-18");
  const back = expandDay(built.node);

  assert.deepStrictEqual(back.map((e) => e.productName), ["D", "A", "B"]);
  assert.strictEqual(built.rows, 3);
});

test("the key range is padded, and the TIMESTAMP decides the day", async () => {
  // A row whose key was written 20 hours before its own timestamp — the skew
  // this node is measured to have. A range without padding would miss it.
  const atMs = Date.parse("2026-09-18T10:00:00.000Z");
  const rows = makeLog([{ atMs, keyMs: atMs - 20 * 3600 * 1000, value: { action: "ready", productName: "Late" } }]);
  const io = makeIo(rows);
  const built = await buildDay(io, "2026-09-18");

  const { startKey, endKey } = keyRangeForDate("2026-09-18");
  assert.ok(rows[0].key >= startKey && rows[0].key <= endKey, "the padded range must contain it");
  assert.strictEqual(expandDay(built.node).map((e) => e.productName).join(), "Late");
});

test("rebuilding a day writes the same bytes — idempotent by construction", async () => {
  const rows = makeLog([
    sale(Date.parse("2026-09-18T05:00:00.000Z"), { productName: "A" }),
    sale(Date.parse("2026-09-18T06:00:00.000Z"), { productName: "B" }),
  ]);
  const io = makeIo(rows);
  const a = await buildDay(io, "2026-09-18");
  const b = await buildDay(io, "2026-09-18");
  assert.strictEqual(JSON.stringify(a.node), JSON.stringify(b.node));
});

test("a row written far later than its own timestamp goes to the LATE bucket", async () => {
  // A POS till that was offline for six days replays a `collected` for the
  // 14th: the key is from today, the timestamp from the 14th. Rebuilding the
  // 14th from its padded key range would never look where this row is — so
  // the sweep puts it where a reader can still find it.
  const row = { atMs: Date.parse("2026-09-14T10:00:00.000Z"), keyMs: NOW, value: { action: "collected", productName: "Replay" } };
  const rows = makeLog([row]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  const r = await runSweep({ io, nowMs: NOW });

  assert.strictEqual(r.late, 1);
  const latePath = `${LATE_PATH}/2026-09-14/${rows[0].key}`;
  assert.ok(io.commits[0][latePath], "the row must be written under its own day");
  assert.strictEqual(io.commits[0][latePath].productName, "Replay");
  // The day node itself is still a pure function of the key range, and empty.
  assert.deepStrictEqual(expandDay(io.commits[0][`${DAYS_PATH}/2026-09-14`]), []);
  // …and nothing landed under today.
  assert.strictEqual(io.commits[0][`${DAYS_PATH}/${TODAY}`], undefined);
});

test("an ordinary out-of-order row needs NO late bucket — the pad covers it", async () => {
  const atMs = Date.parse("2026-09-19T10:00:00.000Z");
  const rows = makeLog([{ atMs, keyMs: atMs - 20 * 3600 * 1000, value: { action: "ready", productName: "Skewed" } }]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  const r = await runSweep({ io, nowMs: NOW });
  assert.strictEqual(r.late, 0);
  assert.strictEqual(expandDay(io.commits[0][`${DAYS_PATH}/2026-09-19`]).length, 1);
});

test("a day inside the backstop window with no node heals itself", async () => {
  const io = makeIo([], { dayKeys: ["2026-09-19"] });          // everything else is missing
  const r = await runSweep({ io, nowMs: NOW });
  assert.ok(r.dates.includes("2026-09-18"));
  assert.ok(r.dates.includes(shiftSaDate(TODAY, -14)), "the backstop reaches 14 days");
  assert.ok(!r.dates.includes(shiftSaDate(TODAY, -15)), "…and no further");
});

test("the day nodes land in ONE update, and the cursor follows them", async () => {
  const rows = makeLog([sale(Date.parse("2026-09-19T08:00:00.000Z"))]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  await runSweep({ io, nowMs: NOW });

  assert.strictEqual(io.commits.length, 1, "one atomic update, not several");
  const upd = io.commits[0];
  assert.ok(Object.keys(upd).some((k) => k.startsWith(`${DAYS_PATH}/`)));
  // The cursor is NOT in the multi-path update. It moves with the running
  // counter, which is a fold and has to be applied exactly once — so it goes
  // through a compare-and-set instead, AFTER the aggregates it justifies.
  assert.strictEqual(upd[CURSOR_PATH], undefined);
  assert.strictEqual(io.advances.length, 1);
  assert.strictEqual(io.advances[0].cursor, rows[rows.length - 1].key);
  assert.strictEqual(io.meta.cursor, rows[rows.length - 1].key);
});

test("a run whose cursor moved under it does NOT advance the counter", async () => {
  // Two overlapping runs that both read the same cursor: the second must be
  // refused, or the overlap is counted twice for ever.
  const rows = makeLog([sale(Date.parse("2026-09-19T08:00:00.000Z"))]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  io.meta.cursor = "somebody-else-moved-it";
  const r = await runSweep({ io, nowMs: NOW });
  assert.strictEqual(r.advanced, false);
  assert.strictEqual(io.meta.logTotals, null, "nothing was folded in");
  // …and the day nodes still landed, because they are recomputations.
  assert.ok(Object.keys(io.commits[0]).some((k) => k.startsWith(`${DAYS_PATH}/`)));
});

test("the cursor advances to the last key SEEN, so the next run reads only what is new", async () => {
  const rows = makeLog([
    sale(Date.parse("2026-09-19T08:00:00.000Z")),
    sale(Date.parse("2026-09-19T09:00:00.000Z")),
  ]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  await runSweep({ io, nowMs: NOW });
  const cursor = io.advances[0].cursor;

  const io2 = makeIo(rows, { dayKeys: allBackstopDays(TODAY), cursor });
  await runSweep({ io: io2, nowMs: NOW });
  const pageReads = io2.reads.filter((r) => r.kind === "page");
  assert.strictEqual(pageReads[0].after, cursor);
});

test("a catch-up longer than the page budget is REPORTED, never silently short", async () => {
  const many = [];
  for (let i = 0; i < 5; i++) many.push(sale(Date.parse("2026-09-19T08:00:00.000Z") + i * 1000));
  const rows = makeLog(many);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  // Squeeze the budget: every page comes back FULL and advances the cursor, so
  // the walk can only ever stop by running out of budget.
  let n = 0;
  io.readPageAfter = async (_after, limit) => {
    n += 1;
    assert.ok(limit > 0);
    return new Array(CATCHUP_PAGE).fill(null).map((_, i) => ({
      key: `${pushKeyForMs(NOW - 3600_000 + n * 1000)}${String(i).padStart(12, "0")}`,
      value: { action: "ready", productName: "P", timestamp: new Date(NOW - 3600_000).toISOString() },
    }));
  };
  const r = await runSweep({ io, nowMs: NOW });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(io.commits[0][BUILT_PATH].truncated, true);
  assert.ok(n > 1);
});

test("every page read carries a limit and every day read a range", async () => {
  const io = makeIo(makeLog([sale(Date.parse("2026-09-19T08:00:00.000Z"))]), { dayKeys: allBackstopDays(TODAY) });
  await runSweep({ io, nowMs: NOW });
  for (const r of io.reads) {
    if (r.kind === "page") assert.ok(r.limit > 0);
    if (r.kind === "range") { assert.ok(r.startKey); assert.ok(r.endKey); }
  }
});

test("datesToBuild refuses a date from the future and a blank one", () => {
  const out = datesToBuild({ touched: ["", "2026-12-01", "2026-09-19"], missing: [], todaySA: TODAY });
  assert.ok(!out.includes(""));
  assert.ok(!out.includes("2026-12-01"));
  assert.ok(out.includes("2026-09-19"));
});

test("saDateOf buckets on SOUTH AFRICAN midnight, not UTC", () => {
  assert.strictEqual(saDateOf("2026-09-18T21:59:59.000Z"), "2026-09-18");
  assert.strictEqual(saDateOf("2026-09-18T22:00:00.000Z"), "2026-09-19");
  assert.strictEqual(saDateOf(undefined), "");
  assert.strictEqual(saDateOf("not a date"), "");
  void SA;
});

test("the rows a day node returns are the events, field for field", async () => {
  const rows = makeLog([
    sale(Date.parse("2026-09-18T05:00:00.000Z"), { customerName: "X", customerPhone: "+27810000000", qty: 2 }),
    sale(Date.parse("2026-09-18T06:00:00.000Z"), { action: "placed", size: undefined }),
  ]);
  const io = makeIo(rows);
  const built = await buildDay(io, "2026-09-18");
  assert.deepStrictEqual(expandDay(built.node), rows.map((r) => keptFieldsOf(r.value)));
});

test("a row with NO usable timestamp is kept, in the undated bucket", async () => {
  // It belongs to no day, and it is still on two screens today: the Insights
  // sidebar counts every event, and the Customers list walks every `placed`
  // without a window. Dropping it would change a number.
  const rows = [
    { key: `${pushKeyForMs(NOW)}000000000001`, value: { action: "placed", productName: "Ghost" } },
    { key: `${pushKeyForMs(NOW)}000000000002`, value: { action: "placed", productName: "Bad", timestamp: "not a date" } },
  ];
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  const r = await runSweep({ io, nowMs: NOW });

  assert.strictEqual(r.late, 2);
  assert.strictEqual(io.commits[0][`${LATE_PATH}/undated/${rows[0].key}`].productName, "Ghost");
  assert.strictEqual(io.commits[0][`${LATE_PATH}/undated/${rows[1].key}`].productName, "Bad");
  // …and no day node was invented for it.
  assert.strictEqual(io.commits[0][`${DAYS_PATH}/`], undefined);
});

test("the index carries per-store counts, because the sidebar total is not the window's", async () => {
  // "N events in view" is every event the store has ever logged. A screen that
  // loaded one day could not produce it from the day it loaded, and loading all
  // of history to render one number is the cost this change exists to remove.
  const rows = makeLog([
    sale(Date.parse("2026-09-19T08:00:00.000Z"), { destShop: "marathon-pe" }),
    sale(Date.parse("2026-09-19T08:01:00.000Z"), { destShop: "trophy" }),
    sale(Date.parse("2026-09-19T08:02:00.000Z"), { placedAtHub: "hub3" }),
    sale(Date.parse("2026-09-19T08:03:00.000Z"), { destShop: "somewhere-new" }),
  ]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  await runSweep({ io, nowMs: NOW });

  const idx = io.commits[0][`${INDEX_PATH}/2026-09-19`];
  assert.deepStrictEqual(idx, { n: 4, pe: 1, trophy: 1, pine: 1, other: 1 });
  // The three store filters plus the unfiltered remainder add up to the day.
  assert.strictEqual(idx.pe + idx.trophy + idx.pine + idx.other, idx.n);
});

// ─── THE RUNNING COUNTER ─────────────────────────────────────────────────────
//
// The Insights sidebar shows every event the store has ever logged. Summing the
// day index would silently omit any day the backfill has not reached and every
// late or undated row. The counter is kept over the WALK, which sees each row
// exactly once, and is stamped with the cursor it is exact as far as.
test("the walk keeps a running per-store count of the whole log", async () => {
  const rows = makeLog([
    sale(Date.parse("2026-09-19T08:00:00.000Z"), { destShop: "marathon-pe" }),
    sale(Date.parse("2026-09-19T08:01:00.000Z"), { destShop: "trophy" }),
    sale(Date.parse("2026-09-20T08:02:00.000Z"), { placedAtHub: "hub3" }),   // today counts too
  ]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  await runSweep({ io, nowMs: NOW });

  const t = io.meta.logTotals;
  assert.strictEqual(t.n, 3);
  assert.strictEqual(t.pe, 1);
  assert.strictEqual(t.trophy, 1);
  assert.strictEqual(t.pine, 1);
  // It is only meaningful as "exact up to here", so it carries the cursor.
  assert.strictEqual(t.cursor, io.meta.cursor);
});

test("a later run ADDS to the counter rather than replacing it", async () => {
  const rows = makeLog([sale(Date.parse("2026-09-19T08:00:00.000Z"), { destShop: "trophy" })]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  io.meta.logTotals = { n: 100, pe: 60, trophy: 30, pine: 10, other: 0, cursor: null };
  await runSweep({ io, nowMs: NOW });

  const t = io.meta.logTotals;
  assert.strictEqual(t.n, 101);
  assert.strictEqual(t.trophy, 31);
  assert.strictEqual(t.pe, 60);
});

test("a run that saw nothing new adds nothing to the counter", async () => {
  const io = makeIo([], { dayKeys: allBackstopDays(TODAY) });
  io.meta.logTotals = { n: 100, pe: 100, trophy: 0, pine: 0, other: 0, cursor: null };
  await runSweep({ io, nowMs: NOW });
  assert.strictEqual(io.meta.logTotals.n, 100);
});

// ─── THE WALK MUST NOT END ON ITS SECOND REQUEST ─────────────────────────────
//
// `startAfter(cursor) + limitToFirst(n)` returns n-1 children — the server
// applies the limit counting the cursor's own row, the SDK then drops it. A
// walk that ends on "the page came back short" therefore ends immediately.
// This backfill's first real run did exactly that: 9,999 rows of 112,968,
// reported as success.
test("catches up across many pages when the bound re-sends the cursor's row", async () => {
  // A fake that behaves the way the real one does: an INCLUSIVE bound, so the
  // caller sees pageSize-1 NEW rows and a `sent` of pageSize.
  const total = CATCHUP_PAGE * 3 + 17;
  const all = [];
  for (let i = 0; i < total; i++) {
    all.push({
      key: `${pushKeyForMs(NOW - 86400000 + i)}${String(i).padStart(12, "0")}`,
      value: { action: "ready", productName: "P", timestamp: new Date(NOW - 86400000).toISOString() },
    });
  }
  const io = makeIo([], { dayKeys: allBackstopDays(TODAY) });
  io.readPageAfter = async (after, limit) => {
    const from = after === null || after === undefined ? 0 : all.findIndex((r) => r.key === after);
    const slice = all.slice(from < 0 ? 0 : from, (from < 0 ? 0 : from) + limit);
    const out = slice.filter((r) => r.key !== after);
    out.sent = slice.length;
    return out;
  };
  const r = await runSweep({ io, nowMs: NOW });
  assert.strictEqual(r.truncated, false, "the walk must reach the end of the node");
  assert.strictEqual(r.cursor, all[all.length - 1].key);
});
