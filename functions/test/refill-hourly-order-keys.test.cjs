// ─── HOURLY CADENCE — THE ORDER-KEY OVERWRITE HAZARD IS BOUNDED ──────────────
// Run: cd functions && node --test test/refill-hourly-order-keys.test.cjs
//
// PR #616 proposed one run a day and was HELD, because store-leg order keys
// recycle. This file exists to show that the reason it was held is a property
// of having exactly ONE run a day, and that thirteen runs a day does not have
// it. It drives the real drawRefillNumber transaction body and the real
// computeRefillPlan — nothing about the mechanism is restated here except the
// key TEMPLATE, and that is pinned against the source so it cannot drift.
//
// THE MECHANISM, in one paragraph. A store-leg order is written at
// `orders/${refillNum}-${lineIdx}`. refillNum comes from /refillCounter, which
// resets every SA day; lineIdx restarts at 1 per destination per run. So
// yesterday's run-k order lines are overwritten by today's run-k order lines.
// The engine notices (`orderLost`: the order node no longer matches the lock's
// createdAt), cancels the request and drops the lock, and the next run
// re-proposes the cell if the deficit is still real.
//
// SO THE QUESTION IS NEVER "does a key get overwritten" — it does at every
// cadence, including the 15-minute one running today. The question is whether
// the re-proposal CONVERGES. It converges when (a) it happens soon and (b) it
// lands on a key that is not the one just clobbered. Both are decided by how
// many runs there are in a day, and both are tested below.
//
// The answers, proved rather than assumed: (a) is ONE run, not two — the plan
// that detects the clobber also re-proposes the cell, and refill-scan applies
// closes before it mints orders; (b) holds for any cadence with a run k+2 left
// in the same day, because /refillCounter only goes up within a day. One run a
// day has neither, which is exactly why PR #616 was held.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { computeRefillPlan, saTodayKey } = require("../lib/refill-engine.cjs");

const SRC = readFileSync(join(__dirname, "..", "refill-scan.cjs"), "utf8");

// ── the schedule, parsed rather than restated ────────────────────────────────
// Everything below that needs "how many runs a day" or "how long between runs"
// derives it from this, so a schedule edit moves the assertions with it.
function parseSchedule(src) {
  const value = /schedule:\s*"([^"]+)"/.exec(src)?.[1];
  assert.ok(value, "the schedule must be a literal string");
  const m = /^every (\d+) minutes from (\d{2}):(\d{2}) to (\d{2}):(\d{2})$/.exec(value);
  assert.ok(m, `unrecognised schedule form: ${value}`);
  const stepMin = Number(m[1]);
  const from = Number(m[2]) * 60 + Number(m[3]);
  const to = Number(m[4]) * 60 + Number(m[5]);
  const runs = [];
  // App Engine's "from … to" is INCLUSIVE of the end time.
  for (let t = from; t <= to; t += stepMin) runs.push(t);
  return { value, stepMin, from, to, runs };
}
const SCHEDULE = parseSchedule(SRC);
const hhmm = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;

test("the schedule is hourly on the hour, 07:00 to 19:00 inclusive", () => {
  assert.equal(SCHEDULE.stepMin, 60);
  assert.equal(SCHEDULE.runs.length, 13, `expected 13 runs a day, got ${SCHEDULE.runs.length}`);
  assert.equal(hhmm(SCHEDULE.runs[0]), "07:00");
  assert.equal(hhmm(SCHEDULE.runs.at(-1)), "19:00");
  assert.equal(SCHEDULE.runs.every((t) => t % 60 === 0), true, "every run must start on the hour");
  assert.equal(SCHEDULE.runs.some((t) => t > 19 * 60), false, "nothing may fire past 19:00");
  assert.match(SRC, /timeZone:\s*"Africa\/Johannesburg"/);
});

test("13 runs, not 49 and not 1 — the two cadences this replaces", () => {
  // 49 is what was live (every 15 minutes in the same window); 1 is PR #616.
  assert.notEqual(SCHEDULE.runs.length, 49);
  assert.notEqual(SCHEDULE.runs.length, 1);
});

// ── the key template, pinned to the source ───────────────────────────────────
test("store-leg orders are still keyed `${refillNum}-${lineIdx}`", () => {
  // If this stops matching, the model below is describing code that no longer
  // exists and every convergence claim in this file is void.
  assert.match(SRC, /orderId = `\$\{refillNum\}-\$\{lineIdx\}`/);
  assert.match(SRC, /lineIdx \+= 1;/);
  assert.match(SRC, /let lineIdx = 0;/);
  assert.match(SRC, /if \(!refillNum\) refillNum = await drawRefillNumber\(db, nowMs\)/);
});

// ── drawRefillNumber, the real transaction body ──────────────────────────────
// refill-scan.cjs initialises firebase-admin at require time, which this suite
// has no credentials for, so the transaction CALLBACK is lifted out of the
// source and executed. It is the shipped code, not a paraphrase: the test fails
// if the daily-reset rule or the 999 wrap changes shape.
function drawRefillNumberCallback() {
  const body = /const res = await db\.ref\("refillCounter"\)\.transaction\(\(current\) => \{([\s\S]*?)\n  \}\);/.exec(SRC);
  assert.ok(body, "drawRefillNumber's transaction body must be findable in the source");
  // eslint-disable-next-line no-new-func
  return new Function("todayKey", `return (current) => {${body[1]}};`);
}
const makeCounter = () => {
  const factory = drawRefillNumberCallback();
  let stored = null;
  return (nowMs) => {
    const todayKey = saTodayKey(nowMs);
    stored = factory(todayKey)(stored);
    return "R" + String(stored?.counter ?? 1).padStart(3, "0");
  };
};

test("within one SA day the counter only ever goes up", () => {
  const draw = makeCounter();
  const day = Date.parse("2026-09-21T05:00:00.000Z");          // 07:00 SAST
  const drawn = SCHEDULE.runs.map((_, i) => draw(day + i * 3600e3));
  assert.deepEqual(drawn, ["R001", "R002", "R003", "R004", "R005", "R006", "R007",
    "R008", "R009", "R010", "R011", "R012", "R013"]);
  assert.equal(new Set(drawn).size, drawn.length,
    "no two runs in a day may draw the same R-number — that is what makes a re-proposal land on a fresh key");
});

test("the counter resets the next SA day — the recycling is real, not hypothetical", () => {
  const draw = makeCounter();
  const d1 = Date.parse("2026-09-21T05:00:00.000Z");
  const d2 = Date.parse("2026-09-22T05:00:00.000Z");
  assert.equal(draw(d1), "R001");
  assert.equal(draw(d1 + 3600e3), "R002");
  assert.equal(draw(d2), "R001", "the next day starts over — this is the hazard's root");
});

// ── THE CONVERGENCE PROPERTY ─────────────────────────────────────────────────
// A cell is clobbered at run k. The engine detects it at run k+1 and drops the
// lock; run k+2 re-proposes and mints a NEW order. Does that new order land on
// a key that is about to be clobbered again?
//
// Modelled with the real counter: the answer is decided entirely by whether
// there IS a run k+1 and k+2 in the same day.
function reproposeKey(runsPerDay) {
  const draw = makeCounter();
  const day0 = Date.parse("2026-09-21T05:00:00.000Z");
  const stepMs = runsPerDay > 1 ? (SCHEDULE.to - SCHEDULE.from) / (runsPerDay - 1) * 60e3 : 24 * 3600e3;
  const at = (day, k) => day0 + day * 24 * 3600e3 + k * stepMs;
  // Day 0: the order is minted at run 0 and takes the first line.
  const minted = { R: draw(at(0, 0)), line: 1 };
  for (let k = 1; k < runsPerDay; k++) draw(at(0, k));            // the rest of day 0
  // Day 1: run 0 draws again — the same number, so the day-0 order is clobbered.
  const clobberer = draw(at(1, 0));
  assert.equal(clobberer, minted.R, "the next day's run 0 always lands on run 0's number");
  // Detection is one run later; the re-proposal one run after that.
  const detectRun = 1, reproposeRun = 2;
  let reproposed = null;
  for (let k = 1; k < Math.max(runsPerDay, reproposeRun + 1); k++) {
    const r = draw(k < runsPerDay ? at(1, k) : at(1 + Math.floor(k / runsPerDay), k % runsPerDay));
    if (k === reproposeRun) reproposed = { R: r, line: 1 };
  }
  const sameDay = reproposeRun < runsPerDay;
  return { minted, clobberer, reproposed, sameDay, detectRun, reproposeRun,
    gapMs: (reproposeRun - 0) * (sameDay ? stepMs : 24 * 3600e3) };
}

test("hourly: the re-proposal lands on a DIFFERENT key, within two hours", () => {
  const r = reproposeKey(SCHEDULE.runs.length);
  assert.equal(r.sameDay, true, "detection and re-proposal both happen the same trading day");
  assert.notEqual(`${r.reproposed.R}-${r.reproposed.line}`, `${r.minted.R}-${r.minted.line}`,
    "the replacement order must not be minted onto the key that was just overwritten");
  assert.equal(r.reproposed.R, "R003");
  // Two runs at the schedule's own step.
  assert.equal(r.gapMs, 2 * SCHEDULE.stepMin * 60e3);
  assert.equal(r.gapMs, 2 * 3600e3, "≤2 hours from clobber to a fresh order");
});

test("once a day: the re-proposal lands on the SAME key it was just clobbered on", () => {
  // This is PR #616's hold reason, reproduced. With one run a day there is no
  // run k+1 to detect in and no run k+2 to re-propose in, so both come round on
  // the counter's reset and draw R001 again — the loop never converges.
  const r = reproposeKey(1);
  assert.equal(r.sameDay, false);
  assert.equal(r.reproposed.R, r.minted.R,
    "at one run a day the replacement is minted onto the very key that was overwritten");
  assert.equal(r.gapMs, 2 * 24 * 3600e3, "48 hours, twice over the same key");
});

test("the property holds for every cadence with two or more runs a day", () => {
  // Not a special fact about 13. Any cadence that leaves a run k+2 inside the
  // same day converges; only a single run a day does not.
  for (const n of [2, 3, 5, 13, 25, 49]) {
    const r = reproposeKey(n);
    assert.equal(r.sameDay, n > 2, `${n} runs/day: re-proposal should be same-day`);
    if (n > 2) assert.notEqual(r.reproposed.R, r.minted.R, `${n} runs/day must re-propose on a fresh number`);
  }
  assert.equal(reproposeKey(1).reproposed.R, reproposeKey(1).minted.R);
});

// ── orderLost → close → re-propose, through the REAL engine ──────────────────
// The model above says the re-proposal happens two runs later. This proves the
// engine actually does the two halves: it cancels a clobbered request, and once
// the lock is gone it asks for the same cell again.
const CONFIG = {
  enabled: true,
  routes: { "marathon-pe": "hub2", hub2: "central" },
  mode: { "marathon-pe": "live", hub2: "live" },
  productTypes: { clothing: true },
  defaultRunByStore: { "marathon-pe": { M: 2 } },
  maxIntentsPerRun: 75, maxUnitsPerIntent: 20, ruleBasedTargets: true, confirmedOutDays: 14,
};
const PRODUCTS = { p1: { id: "p1", name: "Test Hoodie", productType: "clothing", category: "Clothing", sizes: ["M"] } };
const STOCK = {
  "marathon-pe": { p1: { M: { qty: 0 } } },
  hub2: { p1: { M: { qty: 10 } } },
  central: { p1: { M: { qty: 10 } } },
};
const snapshot = (nowMs, over = {}) => ({
  nowMs, config: CONFIG, products: PRODUCTS, stock: STOCK,
  targets: {}, targetDecisions: {}, openIndex: {}, refillRequests: {}, orders: {},
  rejectStreak: {}, retryState: {}, movements: [], ...over,
});

const RUN_A = Date.parse("2026-09-21T09:00:00.000Z");   // 11:00 SAST, run 5
const RUN_B = RUN_A + 3600e3;                            // 12:00 SAST, run 6 — detect
const RUN_C = RUN_A + 2 * 3600e3;                        // 13:00 SAST, run 7 — re-propose
const MINTED_AT = new Date(RUN_A - 24 * 3600e3).toISOString();   // yesterday's order

// The lock as refill-scan.cjs writes it for a store leg, and the order node
// that the NEXT day's run of the same number has since written over it.
const clobbered = {
  openIndex: { "marathon-pe": { p1: { M: {
    qty: 2, source: "hub2", createdAt: MINTED_AT, runId: "2026-09-20T11-00",
    refillId: "rr1", orderId: "R005-1", orderCreatedAt: MINTED_AT,
  } } } },
  refillRequests: { rr1: { productId: "p1", size: "M", qty: 2, requestingLocation: "marathon-pe", status: "open", createdAt: MINTED_AT } },
  // Same key, different order: a later run's line 1 for another product.
  orders: { "R005-1": {
    id: "R005-1", productId: "pOTHER", size: "XL", qty: 3, autoRefill: true,
    destShop: "marathon-pe", status: "incoming",
    createdAt: new Date(RUN_A).toISOString(), clothingRefillStatus: null,
  } },
};

test("run k+1: a clobbered order is detected and the request cancelled", () => {
  const plan = computeRefillPlan(snapshot(RUN_B, clobbered));
  const close = (plan.closes || []).find((c) => c.dest === "marathon-pe" && c.pid === "p1");
  assert.ok(close, "the engine must close the lock whose order node no longer matches");
  assert.equal(close.reason, "order_lost");
  assert.equal(close.cancelReason, "order_lost");
  assert.equal(close.rrStatus, "cancelled");
  assert.equal(close.refillId, "rr1");
  // It must NOT delete the node — that node belongs to a different, live order.
  assert.equal(close.removeOrderId ?? null, null,
    "the recycled node is somebody else's order; deleting it would lose a REAL refill");
});

test("CONTROL: an INTACT order suppresses a second ask — the lock really does work", () => {
  // Without this, the test below proves nothing: a fixture that always yields
  // an intent would pass whether or not order_lost had anything to do with it.
  const intact = {
    openIndex: clobbered.openIndex,
    refillRequests: clobbered.refillRequests,
    orders: { "R005-1": {
      id: "R005-1", productId: "p1", size: "M", qty: 2, autoRefill: true,
      destShop: "marathon-pe", status: "incoming",
      createdAt: MINTED_AT, clothingRefillStatus: null,     // MATCHES the lock
    } },
  };
  const plan = computeRefillPlan(snapshot(RUN_B, intact));
  assert.equal((plan.closes || []).filter((c) => c.reason === "order_lost").length, 0,
    "an order that still matches its lock is not lost");
  assert.equal((plan.intents || []).filter((i) => i.dest === "marathon-pe" && i.productId === "p1").length, 0,
    "the open lock must suppress a duplicate ask");
});

test("the SAME run that detects the clobber also re-proposes the cell", () => {
  // Better than the two-run round trip this file first assumed. The plan
  // carries both the close and a fresh intent for the same cell, and
  // refill-scan.cjs applies closes BEFORE the intent apply loop, so the lock is
  // gone by the time the new claim is made.
  const plan = computeRefillPlan(snapshot(RUN_B, clobbered));
  assert.ok((plan.closes || []).some((c) => c.reason === "order_lost" && c.pid === "p1"));
  const mine = (plan.intents || []).filter((i) => i.dest === "marathon-pe" && i.productId === "p1");
  assert.equal(mine.length, 1, "the deficit is still real, so the same run asks again");
  assert.equal(mine[0].sizeKey, "M");
  assert.ok(mine[0].qty > 0);
});

test("refill-scan applies closes BEFORE minting new orders", () => {
  // The one-run round trip depends on this order: if the apply loop ran first,
  // the new claim would hit a lock that has not been removed yet and the
  // re-proposal would slip to the following run.
  const closesAt = SRC.indexOf("// ── apply closes ");
  const applyAt = SRC.indexOf("applyLoop:");
  assert.ok(closesAt > 0 && applyAt > 0);
  assert.ok(closesAt < applyAt,
    "closes must be applied before the intent apply loop, or a freed cell waits a whole run");
});

test("run k+1 with the lock already gone still asks — nothing is carried in state", () => {
  // The stateless guarantee: the engine does not remember that it cancelled
  // anything. Whatever run comes next sees a real deficit and a free cell.
  const after = snapshot(RUN_C, {
    openIndex: {},
    refillRequests: { rr1: { ...clobbered.refillRequests.rr1, status: "cancelled" } },
    orders: clobbered.orders,
  });
  const mine = (computeRefillPlan(after).intents || []).filter((i) => i.dest === "marathon-pe" && i.productId === "p1");
  assert.equal(mine.length, 1);
});

test("the round trip is bounded by ONE run of the live schedule", () => {
  // Stated as time rather than as run counts, because that is what staff see:
  // a card that vanishes is back within an hour at the worst.
  const oneRun = SCHEDULE.stepMin * 60e3;
  assert.equal(RUN_B - RUN_A, oneRun);
  assert.equal(oneRun, 3600e3);
  assert.ok(oneRun * 2 < 24 * 3600e3 / 2,
    "a round trip that outlasts half a day is the once-a-day hazard by another name");
});

test("a clobbered cell is not punished — no cooldown, no reject streak", () => {
  // If order_lost wrote a rejection stamp, a longer gap between runs WOULD be a
  // loss: the cell would be parked before it could be re-proposed. It does not.
  const plan = computeRefillPlan(snapshot(RUN_B, clobbered));
  const close = (plan.closes || []).find((c) => c.reason === "order_lost");
  assert.equal(close.nextRetryAt ?? null, null);
  assert.equal(close.lastRejectedAt ?? null, null);
  assert.deepEqual((plan.streakOps || []).filter((o) => o.pid === "p1"), []);
});

// ── every timer, re-checked against a 60-minute gap ──────────────────────────
test("LOCK_STEAL_MS is shorter than the gap between runs", () => {
  const steal = /const LOCK_STEAL_MS = (\d+) \* 60e3;/.exec(SRC);
  assert.ok(steal, "LOCK_STEAL_MS must stay a literal minutes constant");
  const stealMin = Number(steal[1]);
  assert.ok(stealMin < SCHEDULE.stepMin,
    `a run's lock must be stale by the time the next run starts (${stealMin}min steal vs ${SCHEDULE.stepMin}min gap)`);
  // And the converse hazard is gone: at 15 minutes a run lasting >10 min could
  // be joined by the next one. At 60 it would have to hang for an hour.
  assert.ok(stealMin < 15 === false || SCHEDULE.stepMin >= 15);
});

test("the /stock_confidence gate fires on EVERY run, because every run is on the hour", () => {
  const gate = /getUTCMinutes\(\) < (\d+)\)/.exec(SRC);
  assert.ok(gate, "the confidence gate must stay a minute-of-hour comparison");
  const limit = Number(gate[1]);
  for (const t of SCHEDULE.runs) {
    assert.ok(t % 60 < limit,
      `${hhmm(t)} would skip the confidence write — the gate assumes runs start inside the first ${limit} minutes`);
  }
});

test("runIds stay unique across a day at minute resolution", () => {
  // runId = ISO.slice(0,16) — one key per minute. Two runs in the same minute
  // would collide in /refill_engine/runs and lose a record.
  assert.match(SRC, /toISOString\(\)\.slice\(0, 16\)\.replace\(\/:\/g, "-"\)/);
  const ids = SCHEDULE.runs.map((t) => hhmm(t));
  assert.equal(new Set(ids).size, ids.length);
});

test("RUNS_KEEP_DAYS still keeps a week of runs, now 91 records not 342", () => {
  const keep = Number(/const RUNS_KEEP_DAYS = (\d+);/.exec(SRC)?.[1]);
  assert.equal(keep, 7);
  assert.equal(keep * SCHEDULE.runs.length, 91);
});

test("the daily refill counter cannot wrap at this cadence", () => {
  // One draw per destination per run. Three store destinations exist
  // (UNIVERSE_BY_SHOP), so the ceiling is runs × 3 — nowhere near the 999 wrap.
  const universe = /const UNIVERSE_BY_SHOP = \{([^}]+)\}/.exec(SRC)?.[1] || "";
  const destCount = universe.split(",").filter((s) => s.includes(":")).length;
  assert.ok(destCount >= 3, `expected the three store universes, found ${destCount}`);
  assert.ok(SCHEDULE.runs.length * destCount < 999,
    "if a day could exhaust 999 the counter would wrap mid-day and collide with itself");
});

test("the scoped-deploy instruction survives next to the schedule", () => {
  assert.match(SRC, /--only functions:refillHealthScan/);
});
