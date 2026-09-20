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
  pushKeyForMs, DAYS_PATH, LATE_PATH, CURSOR_PATH, BUILT_PATH, INDEX_PATH, CATCHUP_PAGE,
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
  return {
    commits,
    reads,
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
    async commit({ updates }) { commits.push(updates); },
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

test("the cursor and the day nodes land in ONE update", async () => {
  const rows = makeLog([sale(Date.parse("2026-09-19T08:00:00.000Z"))]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  await runSweep({ io, nowMs: NOW });

  assert.strictEqual(io.commits.length, 1, "one atomic update, not several");
  const upd = io.commits[0];
  assert.ok(Object.prototype.hasOwnProperty.call(upd, CURSOR_PATH));
  assert.strictEqual(upd[CURSOR_PATH], rows[rows.length - 1].key);
  assert.ok(Object.keys(upd).some((k) => k.startsWith(`${DAYS_PATH}/`)));
});

test("the cursor advances to the last key SEEN, so the next run reads only what is new", async () => {
  const rows = makeLog([
    sale(Date.parse("2026-09-19T08:00:00.000Z")),
    sale(Date.parse("2026-09-19T09:00:00.000Z")),
  ]);
  const io = makeIo(rows, { dayKeys: allBackstopDays(TODAY) });
  await runSweep({ io, nowMs: NOW });
  const cursor = io.commits[0][CURSOR_PATH];

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
