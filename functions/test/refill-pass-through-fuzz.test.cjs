// ─── PASS-THROUGH — PROPERTY FUZZ over generated networks ────────────────────
// Run: cd functions && node --test test/refill-pass-through-fuzz.test.cjs
//
// The hand-written tests pin the cases somebody thought of. These generate
// shops × hub × Central worlds with explicit rows (including hub 0s), rule
// targets, empty and negative cells, open locks, reject streaks and Central
// refusals, and hold the real computeRefillPlan to properties that must be
// true of EVERY world — then apply the plan to the lock table and run the
// next scan, because the failure modes that matter here are multi-scan:
// a leg withdrawn an hour after it was raised, or raised again every hour.
//
//   P1  one intent per (dest, product, size) — a lock path is claimed once
//   P2  no source is promised more than it counts, net of open locks
//   P3  a pass-through leg: from the hub's own source, ≤ the shops' combined
//       shortfall, ≤ maxUnitsPerIntent, and no shop it carries gets its own
//       leg this scan
//   P4  a pass-through leg is only raised where the hub resolves NO target
//       (no_target) or the shop is streak-parked against that hub (disputed)
//   P5  STABILITY: applied as locks, the next scan on the same stock neither
//       withdraws nor resizes any leg it just raised, nor raises a second one
//   P6  shortNotRequested never lists a cell with something on its way, and
//       never lists an "unclassified" reason

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget, encodeSizeKey } = require("../lib/refill-engine.cjs");

const NOW = Date.parse("2026-09-23T10:00:00.000Z");
const iso = (hAgo) => new Date(NOW - hAgo * 3600e3).toISOString();

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const SIZES = ["S", "M", "L", "XL"];
const SHOPS = ["marathon-pe", "trophy"];

function world(seed) {
  const r = rng(seed);
  const int = (n) => Math.floor(r() * (n + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const products = {};
  const nP = 1 + int(3);
  for (let i = 0; i < nP; i++) products[`p${i}`] = { name: `P${i}`, productType: "clothing", sizes: SIZES.slice(0, 1 + int(3)) };
  const stock = { central: {}, hub2: {}, "marathon-pe": {}, trophy: {} };
  const targets = {};
  const rejectStreak = {};
  const refillRequests = {};
  const openIndex = {};
  for (const pid of Object.keys(products)) {
    for (const loc of Object.keys(stock)) {
      if (r() < 0.3) continue;
      const cells = {};
      for (const sz of products[pid].sizes) if (r() < 0.8) cells[sz] = { qty: r() < 0.1 ? -int(2) : int(loc === "central" ? 8 : 4) };
      if (Object.keys(cells).length) stock[loc][pid] = cells;
    }
    for (const loc of [...SHOPS, "hub2"]) {
      if (r() < 0.4) continue;
      for (const sz of products[pid].sizes) {
        if (r() < 0.5) continue;
        const t = loc === "hub2" && r() < 0.25 ? 0 : 1 + int(3);
        ((targets[loc] ||= {})[pid] ||= {})[sz] = { target: t, minQty: Math.ceil(t / 2), ...(r() < 0.2 ? { reorderPoint: int(1) } : {}) };
      }
    }
    // Reject streaks at the shops (the disputed trigger), by hub2.
    for (const shop of SHOPS) {
      if (r() < 0.7) continue;
      const sz = pick(products[pid].sizes);
      ((rejectStreak[shop] ||= {})[pid] ||= {})[sz] = { count: 3 + int(2), by: "hub2", lastTs: iso(1 + int(40)) };
    }
    // Central refusals of a hub2 leg.
    if (r() < 0.2) {
      refillRequests[`rc${pid}`] = { productId: pid, size: pick(products[pid].sizes), qty: 1, requestingLocation: "hub2",
        status: "cancelled", createdAt: iso(10), resolvedAt: iso(1 + int(30)), createdFrom: { engine: true, source: "central" } };
    }
    // An open hub2 leg (ordinary or pass-through).
    if (r() < 0.2) {
      const sz = pick(products[pid].sizes);
      const pt = r() < 0.5 ? pick(["no_target", "disputed"]) : null;
      const id = `ro${pid}`;
      ((openIndex.hub2 ||= {})[pid] ||= {})[sz] = { qty: 1 + int(2), source: "central", createdAt: iso(2), runId: "r0", refillId: id,
        ...(pt ? { passThrough: pt, forDests: ["marathon-pe"] } : {}) };
      refillRequests[id] = { productId: pid, size: sz, qty: 1, requestingLocation: "hub2", status: "open", createdAt: iso(2) };
    }
  }
  const config = {
    enabled: true,
    mode: { hub2: "live", "marathon-pe": "live", trophy: "live" },
    routes: { hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    defaultRunByStore: { hub2: { S: 2, M: 3, L: 3, XL: 2 }, "marathon-pe": { S: 2, M: 2, L: 2, XL: 1 }, trophy: { S: 2, M: 2, L: 2, XL: 1 } },
    ruleBasedTargets: r() < 0.5,
    maxUnitsPerIntent: 1 + int(5),
    maxIntentsPerRun: 500,
    rejectStreakLimit: 4,
    recheckCooldownMinutes: 1440,
  };
  return { nowMs: NOW, config, products, stock, targets, openIndex, refillRequests, orders: {}, movements: [], rejectStreak, retryState: {} };
}

const avail = (stock, loc, pid, size) => Math.max(Number(stock?.[loc]?.[pid]?.[encodeSizeKey(size)]?.qty) || 0, 0);
const key = (d, p, s) => `${d}|${p}|${s}`;

// Apply a plan to the lock table + requests exactly as the scan would (closes
// remove locks and resolve requests; intents claim a lock and open a request).
function applyPlan(snap, plan) {
  const openIndex = JSON.parse(JSON.stringify(snap.openIndex));
  const refillRequests = { ...snap.refillRequests };
  for (const c of plan.closes) {
    if (openIndex[c.dest]?.[c.pid]) delete openIndex[c.dest][c.pid][c.sizeKey];
    if (c.refillId && refillRequests[c.refillId]) refillRequests[c.refillId] = { ...refillRequests[c.refillId], status: c.rrStatus || "cancelled", cancelReason: c.cancelReason || "x" };
  }
  let n = 0;
  for (const i of plan.intents) {
    const id = `new${n++}`;
    ((openIndex[i.dest] ||= {})[i.productId] ||= {})[i.sizeKey] = { qty: i.qty, source: i.source, createdAt: iso(0), runId: "r1", refillId: id,
      orderId: null, orderCreatedAt: null, ...(i.passThrough ? { passThrough: i.passThrough, forDests: i.forDests } : {}) };
    refillRequests[id] = { productId: i.productId, size: i.size, qty: i.qty, requestingLocation: i.dest, status: "open", createdAt: iso(0) };
  }
  return { ...snap, openIndex, refillRequests };
}

test("pass-through properties hold over 1,500 generated networks, across two scans", () => {
  let worldsWithPT = 0, ptLegs = 0, disputedLegs = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const snap = world(seed);
    const plan = computeRefillPlan(snap);
    const ctx = { targets: snap.targets, config: snap.config, products: snap.products, stock: snap.stock };
    const where = `seed ${seed}`;

    // P1
    const seen = new Set();
    for (const i of plan.intents) {
      const k = key(i.dest, i.productId, i.sizeKey);
      assert.ok(!seen.has(k), `${where}: two intents for ${k}`);
      seen.add(k);
    }
    // P2 — per source cell: new intents + open locks drawing on it ≤ its count.
    const draw = new Map();
    const add = (src, pid, sk, q) => draw.set(key(src, pid, sk), (draw.get(key(src, pid, sk)) || 0) + q);
    const closedLocks = new Set(plan.closes.map((c) => key(c.dest, c.pid, c.sizeKey)));
    for (const [dest, byPid] of Object.entries(snap.openIndex)) for (const [pid, bySize] of Object.entries(byPid)) for (const [sk, e] of Object.entries(bySize)) {
      if (!closedLocks.has(key(dest, pid, sk))) add(e.source || snap.config.routes[dest], pid, sk, e.qty || 1);
    }
    for (const rz of plan.resizes) {
      const e = snap.openIndex[rz.dest][rz.pid][rz.sizeKey];
      add(e.source || snap.config.routes[rz.dest], rz.pid, rz.sizeKey, rz.to - rz.from);
    }
    const newDraw = new Map();
    for (const i of plan.intents) {
      add(i.source, i.productId, i.sizeKey, i.qty);
      newDraw.set(key(i.source, i.productId, i.sizeKey), (newDraw.get(key(i.source, i.productId, i.sizeKey)) || 0) + i.qty);
    }
    for (const [k, q] of newDraw) {
      const [src, pid, sk] = k.split("|");
      // Only NEW promises are the plan's responsibility; a pre-existing
      // overcommit (open locks already over the count) is not re-litigated.
      const before = (draw.get(k) || 0) - q;
      const have = avail(snap.stock, src, pid, sk);
      assert.ok(q <= Math.max(have - before, 0), `${where}: ${k} promised ${q} new on top of ${before} against ${have}`);
    }
    // P3 / P4
    const pts = plan.intents.filter((i) => i.passThrough);
    if (pts.length) worldsWithPT++;
    for (const i of pts) {
      ptLegs++;
      if (i.passThrough === "disputed") disputedLegs++;
      assert.equal(i.dest, "hub2", where);
      assert.equal(i.source, "central", where);
      assert.ok(i.qty >= 1 && i.qty <= (snap.config.maxUnitsPerIntent || 20), `${where}: qty ${i.qty}`);
      let need = 0;
      for (const shop of i.forDests) {
        assert.ok(!plan.intents.some((x) => x.dest === shop && x.productId === i.productId && x.sizeKey === i.sizeKey), `${where}: ${shop} also got its own leg`);
        const t = resolveTarget(ctx, shop, i.productId, i.size);
        need += Math.max(t.target - avail(snap.stock, shop, i.productId, i.size), 0);
      }
      assert.ok(i.qty <= need, `${where}: leg ${i.qty} > shops' shortfall ${need}`);
      if (i.passThrough === "no_target") {
        assert.equal(resolveTarget(ctx, "hub2", i.productId, i.size), null, `${where}: no_target leg past a resolving hub target`);
      } else {
        assert.ok(i.forDests.some((s) => snap.rejectStreak?.[s]?.[i.productId]?.[i.sizeKey]), `${where}: disputed leg without a streak`);
      }
    }
    // P6
    const planned = new Set();
    for (const i of plan.intents) { planned.add(key(i.dest, i.productId, i.sizeKey)); for (const d of i.forDests || []) planned.add(key(d, i.productId, i.sizeKey)); }
    for (const row of plan.exceptions.shortNotRequested.items) {
      const sk = encodeSizeKey(row.size);
      assert.ok(!planned.has(key(row.loc, row.pid, sk)), `${where}: listed but raised now`);
      assert.ok(row.hubHas + row.upHas > 0, where);
      assert.notEqual(row.reason, "unclassified", `${where}: unclassified ${JSON.stringify(row)}`);
    }

    // P5 — next scan, same stock, the plan applied.
    const next = computeRefillPlan(applyPlan(snap, plan));
    const justRaised = new Set(plan.intents.map((i) => key(i.dest, i.productId, i.sizeKey)));
    for (const c of next.closes) assert.ok(!justRaised.has(key(c.dest, c.pid, c.sizeKey)), `${where}: ${key(c.dest, c.pid, c.sizeKey)} withdrawn (${c.reason}) the scan after it was raised`);
    for (const rz of next.resizes) assert.ok(!justRaised.has(key(rz.dest, rz.pid, rz.sizeKey)), `${where}: ${key(rz.dest, rz.pid, rz.sizeKey)} resized ${rz.from}→${rz.to} the scan after it was raised`);
    for (const i of next.intents) assert.ok(!justRaised.has(key(i.dest, i.productId, i.sizeKey)), `${where}: second leg for ${key(i.dest, i.productId, i.sizeKey)}`);
  }
  // The generator must actually exercise the feature, or every assertion above is vacuous.
  assert.ok(worldsWithPT > 150, `only ${worldsWithPT} worlds raised a pass-through leg`);
  assert.ok(disputedLegs > 30, `only ${disputedLegs} disputed legs of ${ptLegs}`);
});
