// ─── REFUSAL WRITE-OFF — PROPERTY FUZZ (the generated stress test) ───────────
// Run: cd functions && node --test test/refusal-writeoff-fuzz.test.cjs
//
// 1,000 seeded worlds, each a small network (hub1, hub2, central, two shops,
// Pine) with random refusal / fulfilment / withdrawal / open-request histories
// over ~60 days, and a ledger that is CONSISTENT with each cell's timeline
// (arrivals, sales, before/after). Two scans run back to back through the real
// planner and the real server writer on the fake RTDB. Whatever the history,
// these must hold:
//
//   I1  only written-off cells change — every other cell is byte-identical
//   I2  a written-off cell keeps at least what arrived after the first counted
//       refusal (as far as today's count still holds it): after ≥ min(today, arrivals)
//   I3  never more than was on paper when the first counted refusal came
//   I4  every write-off stands on ≥ 4 different SAST days of refusals by that
//       location, none of them followed by a fulfilment of the size
//   I5  only hub1 / hub2 / central; never a Pine request; never negative
//   I6  the second scan debits nothing (one run, one write-off)
//   I7  nothing thrown; every patch passes the RTDB sanitizer untouched

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { planRefusalWriteoffs, applyRefusalWriteoffs, sastDay } = require("../lib/refusal-writeoff.cjs");
const { sanitizeUpdate } = require("../lib/refill-engine.cjs");

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const NOW = Date.parse("2026-09-23T12:45:00.000Z");
const DAY = 864e5;
const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
const CONFIG = { routes: ROUTES };
const SOURCES = ["hub1", "hub2", "central"];
const REQUESTERS = { hub2: ["marathon-pe", "trophy", "marathon-pine"], central: ["hub1", "hub2"], hub1: ["marathon-pe"] };
const SIZES = ["M", "L", "5.5", "Free Size"];
const cellKey = (s) => (s === "Free Size" ? "_" : String(s).replace(/[.#$/\[\]\s]/g, "_"));

function world(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const stock = { hub1: {}, hub2: {}, central: {}, "marathon-pe": {}, trophy: {} };
  const rr = {}, movements = {}, products = {};
  const truth = [];   // per generated cell: timeline facts for the invariants
  let n = 0;
  const cells = 1 + Math.floor(r() * 4);
  for (let c = 0; c < cells; c++) {
    const pid = `p${seed}_${c}`;
    products[pid] = { name: pid, productType: "clothing", sizes: SIZES };
    const loc = pick(SOURCES);
    const size = pick(SIZES);
    const ck = cellKey(size);
    let qty = Math.floor(r() * 6);
    // An unrelated neighbour cell of the same product and the same size elsewhere.
    stock[loc][pid] = { Z: { qty: 4, v: 1, mv: "n", lastType: "received", updatedAt: "2026-07-01T00:00:00.000Z" } };
    stock["marathon-pe"][pid] = { [ck]: { qty: 1, v: 1, mv: "n", lastType: "sold", updatedAt: "2026-07-01T00:00:00.000Z" } };
    const events = [];
    const start = NOW - (r() < 0.15 ? 70 : 40) * DAY;
    let t = start;
    const k = 3 + Math.floor(r() * 9);
    for (let i = 0; i < k; i++) {
      t += Math.floor(r() * 3.2 * DAY) + 3600e3;
      if (t >= NOW - 3600e3) break;
      const roll = r();
      const kind = roll < 0.55 ? "refuse" : roll < 0.62 ? "fulfil" : roll < 0.67 ? "partial" : roll < 0.72 ? "withdrawn"
        : roll < 0.84 ? "arrive" : roll < 0.95 ? "sell" : "open";
      events.push({ t, kind, dest: pick(REQUESTERS[loc]), q: 1 + Math.floor(r() * 3) });
    }
    let updatedAt = "2026-06-01T00:00:00.000Z";
    for (const e of events) {
      const at = new Date(e.t).toISOString();
      const base = { productId: pid, size, qty: e.q, requestingLocation: e.dest, createdAt: new Date(e.t - 3600e3).toISOString(), createdFrom: { engine: true, source: loc } };
      if (e.kind === "refuse") rr[`r${n++}`] = { ...base, status: "cancelled", resolvedAt: at };
      else if (e.kind === "fulfil") rr[`r${n++}`] = { ...base, status: "fulfilled", resolvedAt: at };
      else if (e.kind === "partial") rr[`r${n++}`] = { ...base, status: "cancelled", resolvedAt: at, sentQty: 1 };
      else if (e.kind === "withdrawn") rr[`r${n++}`] = { ...base, status: "cancelled", resolvedAt: at, cancelReason: "no_longer_needed" };
      else if (e.kind === "open") rr[`r${n++}`] = { ...base, status: "open" };
      else if (e.kind === "arrive") {
        movements[`m${n++}`] = { type: pick(["received", "transfer_in", "return"]), productId: pid, size, qty: e.q, from: "central", to: loc, ts: at, before: { [loc]: qty }, after: { [loc]: qty + e.q } };
        qty += e.q; updatedAt = at;
      } else if (e.kind === "sell" && qty > 0) {
        const s = Math.min(qty, e.q);
        movements[`m${n++}`] = { type: "sold", productId: pid, size, qty: s, from: loc, ts: at, before: { [loc]: qty }, after: { [loc]: qty - s } };
        qty -= s; updatedAt = at;
      }
    }
    stock[loc][pid][ck] = { qty, v: 3, mv: "x", lastType: "transfer_out", updatedAt };
    truth.push({ pid, loc, ck, size, events, final: qty });
  }
  return { stock, rr, movements, products, truth };
}

async function runScan(db, products, now) {
  const root = db.state.root;
  const snapshot = {
    nowMs: now, config: CONFIG, products,
    stock: structuredClone(root.stock || {}), refillRequests: structuredClone(root.refill_requests || {}),
    movements: Object.values(structuredClone(root.stock_movements || {})), rejectStreak: {},
    cursors: structuredClone(root.refill_engine?.refusalWriteoffCursor || {}), windowStartMs: now - 45 * DAY,
  };
  const plan = planRefusalWriteoffs(snapshot);
  const problems = [];
  const update = async (patch) => {
    const { safe, problems: p } = sanitizeUpdate(patch);
    problems.push(...p);
    await db.ref().update(safe);
    return true;
  };
  const res = await applyRefusalWriteoffs({ db, writeoffs: plan.writeoffs, snapshot, update, nowMs: now });
  return { plan, res, problems };
}

test("1,000 generated worlds: the write-off keeps every hard constraint", async () => {
  let wrote = 0, protectedHits = 0, deferred = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const w = world(seed);
    const db = makeFakeDb({ stock: w.stock, refill_requests: w.rr, stock_movements: w.movements });
    const before = structuredClone(db.state.root.stock);
    const ctx = `seed ${seed}`;
    const s1 = await runScan(db, w.products, NOW);
    assert.deepEqual(s1.problems, [], `${ctx} I7 sanitizer`);
    deferred += s1.plan.deferred.length;
    const after = db.state.root.stock;
    const touched = new Set(s1.res.applied.map((a) => `${a.loc}|${a.pid}|${a.cellKey}`));
    // I1
    for (const [loc, byP] of Object.entries(before)) for (const [pid, byS] of Object.entries(byP)) for (const [sk, c] of Object.entries(byS)) {
      if (touched.has(`${loc}|${pid}|${sk}`)) continue;
      assert.deepEqual(after[loc]?.[pid]?.[sk], c, `${ctx} I1 ${loc}/${pid}/${sk} changed`);
    }
    for (const a of s1.res.applied) {
      wrote++;
      const tr = w.truth.find((x) => x.pid === a.pid && x.loc === a.loc);
      assert.ok(tr, `${ctx} write-off on a cell that was never generated`);
      // I5
      assert.ok(SOURCES.includes(a.loc), `${ctx} I5 loc`);
      assert.ok(a.refusals.every((x) => x.dest !== "marathon-pine"), `${ctx} I5 Pine`);
      const now = after[a.loc][a.pid][a.cellKey].qty;
      assert.ok(now >= 0, `${ctx} I5 negative`);
      // I4: ≥ 4 different days among the COUNTED refusals, no fulfilment after the first refusal of the run.
      const counted = a.refusals.filter((x) => x.counted !== false);
      assert.ok(new Set(counted.map((x) => x.day)).size >= 4, `${ctx} I4 days`);
      const firstMs = Math.min(...a.refusals.map((x) => Date.parse(x.at)));
      const lastMs = Math.max(...a.refusals.map((x) => Date.parse(x.at)));
      const fulfilledBetween = tr.events.some((e) => (e.kind === "fulfil" || e.kind === "partial") && e.t > firstMs && e.t < lastMs);
      assert.ok(!fulfilledBetween, `${ctx} I4 a fulfilment inside the run ${JSON.stringify({ refusals: a.refusals.map((x) => x.at), events: tr.events.map((e) => [new Date(e.t).toISOString(), e.kind]) })}`);
      assert.ok(a.refusals.every((x) => sastDay(Date.parse(x.at)) === x.day), `${ctx} day label`);
      // I2 / I3 against the generated timeline.
      const countedFirst = Math.min(...counted.map((x) => Date.parse(x.at)));
      const arrivals = tr.events.filter((e) => e.kind === "arrive" && e.t > countedFirst).reduce((t, e) => t + e.q, 0);
      assert.ok(now >= Math.min(tr.final, arrivals), `${ctx} I2 erased arrivals: after ${now}, arrivals ${arrivals}, today ${tr.final}`);
      if (arrivals > 0) protectedHits++;
      let atFirst = null;
      for (const m of Object.values(w.movements)) {
        if (m.productId !== a.pid) continue;
        const ts = Date.parse(m.ts);
        if (ts > countedFirst && (atFirst === null || ts < atFirst.ts)) atFirst = { ts, before: m.before?.[a.loc] };
      }
      const paperAtFirst = atFirst ? atFirst.before : tr.final;
      assert.ok(a.qty <= Math.max(paperAtFirst, 0), `${ctx} I3 erased ${a.qty} > ${paperAtFirst} on paper at the first refusal`);
    }
    // I6
    const snapAfter1 = structuredClone(db.state.root.stock);
    const s2 = await runScan(db, w.products, NOW + 3600e3);
    assert.deepEqual(s2.problems, [], `${ctx} I7 sanitizer (2nd)`);
    assert.equal(s2.res.units, 0, `${ctx} I6 second scan debited`);
    assert.deepEqual(db.state.root.stock, snapAfter1, `${ctx} I6 stock moved on the second scan`);
    const rows = Object.values(db.state.root.stock_movements || {}).filter((m) => m.type === "refusal_writeoff");
    assert.equal(rows.length, touched.size, `${ctx} I6 ledger rows`);
  }
  console.log(`refusal write-off fuzz: 1000 worlds, ${wrote} write-offs, ${protectedHits} with arrivals protected, ${deferred} deferred`);
  // The fuzz must actually exercise the interesting paths.
  assert.ok(wrote > 100, `only ${wrote} write-offs generated`);
  assert.ok(protectedHits > 10, `only ${protectedHits} write-offs had arrivals to protect`);
  assert.ok(deferred > 10, `only ${deferred} deferrals`);
});
