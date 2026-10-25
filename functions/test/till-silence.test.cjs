// ─── A TILL THAT TOOK CARD MONEY WITH NO BATCH — the morning alarm's decision ─
// lib/till-silence.cjs. The estate below is the live one on 25 Oct 2026: the
// two speedpoints swapped on 5 Oct, so the machine on Trophy Till 1 (67325636)
// is FILED under pe and the one on Marathon Till 1 (67377843) under trophy.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assessTillSilence, alarmLine, covers, judgedDays, MARKER } = require("../lib/till-silence.cjs");

const SWAP = Date.parse("2026-10-05T12:46:00+02:00");
const TERMINALS = {
  "67325636": { label: "Trophy Till 1", storeId: "pe", tillId: "till-1", placements: {
    "at-1": { effectiveFrom: 1, label: "Marathon Till 1", storeId: "pe", tillId: "till-1" },
    [`at-${SWAP}`]: { effectiveFrom: SWAP, label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
  } },
  "67377843": { label: "Marathon Till 1", storeId: "trophy", tillId: "till-1", placements: {
    "at-0": { effectiveFrom: 0, label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
    [`at-${SWAP}`]: { effectiveFrom: SWAP, label: "Marathon Till 1", storeId: "pe", tillId: "till-1" },
  } },
};

const at = (ymd, hhmm) => Date.parse(`${ymd}T${hhmm}:00+02:00`);
const MORNING = at("2026-10-26", "07:30");          // judges 19 → 25 Oct
let k = 0;
const leg = (storeId, tillId, ymd, hhmm, amount) => ({ [`e${++k}`]: { method: "card", storeId, tillId, at: at(ymd, hhmm), amount } });
const legs = (...xs) => Object.assign({}, ...xs);
const rec = (openYmd, openHm, closeYmd, closeHm) => ({ slip: { openedAt: at(openYmd, openHm), closedAt: at(closeYmd, closeHm) } });

test("judgedDays: yesterday back seven SAST days — today is never judged", () => {
  const days = judgedDays(MORNING);
  assert.equal(days.length, 7);
  assert.equal(days[0].ymd, "2026-10-25");
  assert.equal(days.at(-1).ymd, "2026-10-19");
  assert.equal(days[0].startMs, at("2026-10-25", "00:00"));
  // 00:30 SAST is still the previous UTC date — the SAST day decides.
  assert.equal(judgedDays(at("2026-10-26", "00:30"))[0].ymd, "2026-10-25");
});

test("a till with card money and its batch recorded is not silent", () => {
  const v = assessTillSilence({
    nowMs: MORNING, terminals: TERMINALS,
    events: legs(leg("trophy", "till-1", "2026-10-25", "11:00", 687000)),
    recordsByTid: { "67325636": { 71: rec("2026-10-25", "09:40", "2026-10-25", "14:05") } },
  });
  assert.deepEqual(v.silent, []);
});

test("25 Oct: Trophy's machine sent its 17 Sep batch 57 — the till is silent, and named by the machine on it", () => {
  const v = assessTillSilence({
    nowMs: MORNING, terminals: TERMINALS,
    events: legs(leg("trophy", "till-1", "2026-10-25", "11:00", 400000), leg("trophy", "till-1", "2026-10-25", "12:30", 287000),
      leg("trophy", "till-1", "2026-10-24", "12:00", 2785800)),
    recordsByTid: { "67325636": {
      70: rec("2026-10-24", "09:46", "2026-10-24", "16:47"),
      57: rec("2026-09-17", "16:56", "2026-09-17", "21:16"),   // re-printed on 25 Oct: covers nothing
    } },
  });
  assert.equal(v.silent.length, 1);
  const s = v.silent[0];
  assert.deepEqual([s.storeId, s.tillId, s.label, s.tids, s.days, s.cents, s.missing],
    ["trophy", "till-1", "Trophy Till 1", ["67325636"], 1, 687000, ["2026-10-25"]]);
  const line = alarmLine(v.silent);
  assert.ok(line.startsWith(`${MARKER} Trophy Till 1 (trophy/till-1, terminal 67325636): 1 day with card money and NO batch recorded — 25 Oct (R6,870.00 on card)`), line);
});

test("two silent trading days in a row say 2 days, oldest first", () => {
  const v = assessTillSilence({
    nowMs: MORNING, terminals: TERMINALS,
    events: legs(leg("trophy", "till-1", "2026-10-24", "10:00", 1000), leg("trophy", "till-1", "2026-10-25", "10:00", 2000),
      leg("trophy", "till-1", "2026-10-23", "10:00", 5000)),
    recordsByTid: { "67325636": { 69: rec("2026-10-05", "10:01", "2026-10-23", "16:43") } },
  });
  assert.equal(v.silent[0].days, 2);
  assert.equal(v.silent[0].cents, 3000);
  assert.match(alarmLine(v.silent), /2 days with card money and NO batch recorded — 24 Oct, 25 Oct \(R30\.00 on card\)/);
});

test("a day with no card money neither counts nor breaks the run", () => {
  const v = assessTillSilence({
    nowMs: MORNING, terminals: TERMINALS,
    // Saturday traded, nothing recorded; Sunday shut.
    events: legs(leg("trophy", "till-1", "2026-10-24", "10:00", 1000), leg("trophy", "till-1", "2026-10-23", "10:00", 1000)),
    recordsByTid: { "67325636": { 69: rec("2026-10-23", "09:00", "2026-10-23", "16:43") } },
  });
  assert.deepEqual(v.silent[0].missing, ["2026-10-24"]);
});

test("a batch left open and reported the next day covers both days (23–24 Oct, batch 51)", () => {
  const r = rec("2026-10-23", "09:47", "2026-10-24", "16:29");
  assert.equal(covers(r, at("2026-10-23", "00:00"), at("2026-10-24", "00:00")), true);
  assert.equal(covers(r, at("2026-10-24", "00:00"), at("2026-10-25", "00:00")), true);
  assert.equal(covers(r, at("2026-10-25", "00:00"), at("2026-10-26", "00:00")), false);
  assert.equal(covers(rec("2026-10-24", "09:00", "2026-10-24", "16:00"), at("2026-10-23", "00:00"), at("2026-10-24", "00:00")), false, "opened after the day: not its money");
  assert.equal(covers({}, 0, 1), false);
});

test("a machine moved to another shop is judged on the till it stood on, not its filing key", () => {
  const v = assessTillSilence({
    nowMs: MORNING, terminals: TERMINALS,
    events: legs(leg("pe", "till-1", "2026-10-25", "10:00", 749500), leg("trophy", "till-1", "2026-10-25", "10:00", 100)),
    recordsByTid: {
      "67377843": { 52: rec("2026-10-25", "09:00", "2026-10-25", "14:56") },   // filed trophy, stands on pe/till-1
      "67325636": { 72: rec("2026-10-25", "09:00", "2026-10-25", "14:00") },   // filed pe, stands on trophy/till-1
    },
  });
  assert.deepEqual(v.silent, []);
  // Without Trophy's own report, Marathon Till 1's machine does NOT cover Trophy.
  const v2 = assessTillSilence({
    nowMs: MORNING, terminals: TERMINALS,
    events: legs(leg("trophy", "till-1", "2026-10-25", "10:00", 100)),
    recordsByTid: { "67377843": { 52: rec("2026-10-25", "09:00", "2026-10-25", "14:56") } },
  });
  assert.equal(v2.silent.length, 1);
  assert.deepEqual(v2.silent[0].tids, ["67325636"]);
});

test("refunds only, a retired machine, and a machine not yet in the estate are never silent", () => {
  const v = assessTillSilence({
    nowMs: MORNING,
    terminals: {
      OLD1: { label: "Old", storeId: "pine", tillId: "till-1", retiredAt: 5 },
      NEW1: { label: "New", storeId: "concrete", tillId: "till-1", activeFrom: at("2026-10-26", "06:00") },
      "67325636": TERMINALS["67325636"],
    },
    events: legs(leg("pine", "till-1", "2026-10-25", "10:00", 5000), leg("concrete", "till-1", "2026-10-25", "10:00", 5000),
      leg("trophy", "till-1", "2026-10-25", "10:00", -5000)),
    recordsByTid: {},
  });
  assert.deepEqual(v.silent, []);
});

test("a till silent for the whole lookback says 7+ days; several tills share ONE line", () => {
  const ev = {};
  for (const d of judgedDays(MORNING)) Object.assign(ev, leg("trophy", "till-1", d.ymd, "10:00", 100), leg("pe", "till-1", d.ymd, "10:00", 100));
  const v = assessTillSilence({ nowMs: MORNING, terminals: TERMINALS, events: ev,
    recordsByTid: { "67377843": { 50: rec("2026-10-23", "09:00", "2026-10-23", "16:00") } } });
  assert.equal(v.silent.length, 2);
  const trophy = v.silent.find((s) => s.storeId === "trophy");
  assert.equal(trophy.days, 7);
  assert.equal(trophy.capped, true);
  const pe = v.silent.find((s) => s.storeId === "pe");
  assert.equal(pe.days, 2, "Marathon Till 1 stops at its 23 Oct batch");
  assert.equal(pe.capped, false);
  const line = alarmLine(v.silent);
  assert.equal(line.split(MARKER).length, 2, "the marker once — one line");
  assert.match(line, /Trophy Till 1 \(trophy\/till-1, terminal 67325636\): 7\+ days/);
  assert.match(line, / · Marathon Till 1 \(pe\/till-1, terminal 67377843\): 2 days/);
  assert.equal(v.silent[0].storeId, "trophy", "longest silence first");
});
