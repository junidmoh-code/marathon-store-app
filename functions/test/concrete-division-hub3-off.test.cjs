// ─── NO DEADLOCK WHILE HUB 3 CLOTHING IS OFF (Junid, 10 Nov 2026) ────────────
// While the Hub 3 non-sneaker keep is OFF, the exists-at-Hub-3 rule applies only
// to a size Hub 3 actually holds (qty > 0) — or has on its way in. Every other
// size the owning shop asks Central for, under its own keep. ON: Hub 3 only.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, networkRouting } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const { shopCentralWithdrawal, forbiddenShopSource } = require("../lib/shop-source-rule.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");

const ISO = "2026-11-10T09:00:00.000Z";
const NOW = Date.parse(ISO);
const cfg = (on) => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 500, maxFootwearIntentsPerRun: 500, maxUnitsPerIntent: 20,
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on, perSize: 2, oneSize: 10 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true } } },
});
const c = (qty) => ({ qty, v: 1, mv: "m", lastType: "count", trusted: true, trustedVia: "count", trustedAt: ISO });
const shelf = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });
const TEE = { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M", "L"] };
const BAG = { id: "b1", name: "Bag", category: "Accessories", categoryKey: "bags", sizes: [] };
const products = { t1: TEE, b1: BAG };
const central = { t1: { S: c(9), M: c(9), L: c(9) }, b1: { _: c(20) } };
const seat = { via: "stock", at: ISO };
const run = (on, { hub3, concrete, seats = {}, openIndex = {}, refillRequests = {} }) => computeRefillPlan({
  nowMs: NOW, config: cfg(on), targets: {}, products, openIndex, refillRequests, orders: {}, movements: [],
  stock: { central, hub3, concrete, "marathon-pine": {} }, network: reg.SEED_REGISTRY,
  seats: { concrete: Object.fromEntries(Object.keys(concrete).map((p) => [p, seat])), hub3: Object.fromEntries(Object.keys(hub3).map((p) => [p, seat])), ...seats },
});
const lines = (p) => p.intents.filter((i) => i.dest === "concrete").map((i) => `${i.source}:${i.sizeKey}:${i.qty}`).sort();

test("OFF: Hub 3 holds S only → S from Hub 3 at its keep of 1; M and L from Central at the shop's keep of 2", () => {
  const p = run(false, { hub3: { t1: { S: c(3), M: c(0) } }, concrete: { t1: { S: shelf(0), M: shelf(0), L: shelf(0) } } });
  assert.deepEqual(lines(p), ["central:L:2", "central:M:2", "hub3:S:1"]);
});

test("ON: the same shelf asks Hub 3 for every size, and Central for none (no deadlock route needed)", () => {
  const p = run(true, { hub3: { t1: { S: c(3), M: c(0) } }, concrete: { t1: { S: shelf(0), M: shelf(0), L: shelf(0) } } });
  assert.ok(!p.intents.some((i) => i.dest === "concrete" && i.source === "central"), JSON.stringify(lines(p)));
  assert.deepEqual(lines(p), ["hub3:S:1"]);
});

test("OFF: a sold-out Hub 3 (cells at zero everywhere) never strands the shop", () => {
  const p = run(false, { hub3: { t1: { S: c(0), M: c(0), L: c(0) }, b1: { _: c(0) } }, concrete: { t1: { S: shelf(0) }, b1: { _: shelf(1) } } });
  assert.deepEqual(lines(p), ["central:L:2", "central:M:2", "central:S:2", "central:_:4"]);
});

test("OFF: a size whose box is already on its way into Hub 3 waits for it (held box)", () => {
  const heldLines = { hub3: { h1: { productId: "t1", size: "M", qty: 2 } } };
  const p = computeRefillPlan({
    nowMs: NOW, config: cfg(false), targets: {}, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [], heldLines,
    stock: { central, hub3: { t1: { S: c(0) } }, concrete: { t1: { S: shelf(0), M: shelf(0), L: shelf(2) } }, "marathon-pine": {} }, network: reg.SEED_REGISTRY,
    seats: { concrete: { t1: seat }, hub3: { t1: seat } },
  });
  assert.deepEqual(lines(p), ["central:S:2"]);
});

test("OFF: the owner rule still holds — the other shop asks nothing for a Hub 3-owned product", () => {
  const p = run(false, { hub3: { t1: { S: c(0) } }, concrete: { t1: { S: shelf(0) } }, seats: { hub3: { t1: { via: "solve", at: ISO, owner: "marathon-pine" } } } });
  assert.deepEqual(lines(p), []);
});

test("OFF: a Central request for a size Hub 3 does not hold is not withdrawn as 'Hub 3 serves this'", () => {
  const config = cfg(false);
  const division = dv.divisionContext({ config, rawStock: { hub3: { t1: { S: c(3) } } }, seats: {}, openIndex: {}, heldLines: {}, refillRequests: {} });
  const routing = networkRouting(config, reg.SEED_REGISTRY, division);
  const rr = { status: "open", productId: "t1", size: "M", requestingLocation: "concrete", createdAt: "2026-11-10T08:00:00.000Z" };
  const args = { dest: "concrete", pid: "t1", entry: { source: "central" }, rr, inFlight: false, routes: config.routes, locations: null, routing, product: TEE, snapshot: { stock: { hub3: { t1: { S: c(3) } } } }, nowMs: NOW };
  assert.equal(shopCentralWithdrawal({ ...args, size: "M" }), null, "M: Hub 3 holds none — Central's line stands");
  assert.ok(shopCentralWithdrawal({ ...args, size: "S", rr: { ...rr, size: "S" } }), "S: Hub 3 holds it — withdrawn to Hub 3");
  assert.equal(forbiddenShopSource({ dest: "concrete", source: "central", routes: config.routes, routing, product: TEE, pid: "t1", size: "M" }), false);
  assert.equal(forbiddenShopSource({ dest: "concrete", source: "central", routes: config.routes, routing, product: TEE, pid: "t1", size: "S" }), true);
});

test("the predicate itself: qty > 0, raw or encoded key, inbound counts, keep ON serves every size", () => {
  const division = { hub3Present: new Set(["t1", "s"]), policy: { hub3Keep: { on: false } }, hub3Stock: { t1: { S: { qty: 1 }, M: { qty: 0 } }, s: { "9_5": { qty: 2 } } }, hub3Inbound: new Set(["t1|L"]) };
  assert.equal(dv.hub3ServesSize(division, "t1", "S"), true);
  assert.equal(dv.hub3ServesSize(division, "t1", "M"), false);
  assert.equal(dv.hub3ServesSize(division, "t1", "L"), true, "on its way in");
  assert.equal(dv.hub3ServesSize(division, "s", "9.5"), true);
  assert.equal(dv.hub3ServesSize(division, "x", "S"), false, "never at Hub 3");
  assert.equal(dv.hub3ServesSize({ ...division, policy: { hub3Keep: { on: true } } }, "t1", "M"), true);
  assert.equal(dv.hub3ServesSize({ ...division, hub3Stock: undefined, hub3Inbound: undefined }, "t1", "M"), true, "no stock handed in: the older rule");
});

// ── Review fixes (Sonnet architect + Fable, PR #884) ─────────────────────────
test("OFF: an UNCOUNTED Hub 3 cell is no source — the shop asks Central for that size (no park on 'count that cell')", () => {
  const uncounted = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });
  const p = run(false, { hub3: { t1: { S: uncounted(3), M: c(2) } }, concrete: { t1: { S: shelf(0), M: shelf(0), L: shelf(1) } } });
  assert.deepEqual(lines(p), ["central:L:1", "central:S:2", "hub3:M:1"]);
});

test("OFF: a box into Hub 3 older than the stale window no longer holds the shop's size", () => {
  const old = "2026-11-01T08:00:00.000Z";
  const openIndex = { hub3: { t1: { M: { qty: 2, source: "central", refillId: "x", createdAt: old } } } };
  const refillRequests = { x: { status: "open", productId: "t1", size: "M", qty: 2, requestingLocation: "hub3", createdAt: old } };
  const p = run(false, { hub3: { t1: { S: c(0) } }, concrete: { t1: { S: shelf(2), M: shelf(0), L: shelf(2) } }, openIndex, refillRequests });
  assert.deepEqual(lines(p), ["central:M:2"]);
  const fresh = new Date(NOW - 3600e3).toISOString();
  const q = run(false, { hub3: { t1: { S: c(0) } }, concrete: { t1: { S: shelf(2), M: shelf(0), L: shelf(2) } },
    openIndex: { hub3: { t1: { M: { ...openIndex.hub3.t1.M, createdAt: fresh } } } }, refillRequests: { x: { ...refillRequests.x, createdAt: fresh } } });
  assert.deepEqual(lines(q), [], "a fresh box: the shop waits for it");
});

test("OFF: with Hub 3 not auto-routable to the shops, a size it does not hold still goes to Central (no product-level drop)", () => {
  const net = JSON.parse(JSON.stringify(reg.SEED_REGISTRY));
  net.locations.hub3.autoRefill = "off";
  const p = computeRefillPlan({
    nowMs: NOW, config: cfg(false), targets: {}, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    stock: { central, hub3: { t1: { S: c(0) } }, concrete: { t1: { S: shelf(0), M: shelf(0), L: shelf(0) } }, "marathon-pine": {} },
    network: net, seats: { concrete: { t1: seat } },
  });
  assert.deepEqual(lines(p), ["central:L:2", "central:M:2", "central:S:2"]);
});
