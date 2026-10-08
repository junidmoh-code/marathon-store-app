// ─── THE SHOP-SOURCE RULE, FOR A SHOP THE REGISTRY ROUTES ────────────────────
// "A shop never refills from Central once its hub has held the product" used
// to find a shop's hub in config.routes only, so it did not cover Pine or
// Concrete (routed by the network registry, per product). The rule now takes
// the engine's own routing (networkRouting) and judges such a shop against the
// hub the engine refills THAT product from.
//
//   1. Section 1, through the REAL computeRefillPlan on a production-shaped
//      config (no Section 1 entry in routes / mode / runs).
//   2. Section 2 DIFFERENTIAL: the rule as it stood before this change, copied
//      below as a frozen reference, against the rule as it is now with the
//      routing handed in — over generated routes, /locations and registries.
// Run: cd functions && node --test test/shop-source-rule-sections.test.cjs
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, networkRouting } = require("../lib/refill-engine.cjs");
const rule = require("../lib/shop-source-rule.cjs");
const { normalizeNetwork } = require("../lib/network-registry.cjs");

const NOW = Date.parse("2026-10-03T10:00:00.000Z");
const C0 = "2026-09-25T14:25:29.087Z";
const BEFORE = "2026-09-20T08:00:00.000Z";
const AFTER = "2026-09-26T08:00:00.000Z";
const S1 = ["marathon-pine", "concrete", "hub3"];
// Section 1 with BOTH switches off — what the seed shipped as before 7 Oct 2026
// (the seed itself now holds Section 1 Solve on + Auto-refill "solved").
const DARK = normalizeNetwork({ locations: Object.fromEntries(["marathon-pine", "concrete", "hub3"].map((id) => [id, { solve: false, autoRefill: "off" }])) });

const live = (ids = S1, extra = {}) => normalizeNetwork({ locations: Object.fromEntries(S1.map((id) => [id, ids.includes(id) ? { live: true } : { solve: false, autoRefill: "off" }])), ...extra });
// Production-shaped: only Section 2 is named.
const CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", trophy: "live", "marathon-pe": "live" },
  routes: { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 500, staleIntentHours: 999,
  defaultRunByStore: { hub2: { M: 3 }, trophy: { M: 2 }, "marathon-pe": { M: 2 } },
};
const TEE = { id: "tee", name: "Tee", productType: "clothing", categoryKey: "t-shirts", sizes: ["M"] };
const cell = (qty, updatedAt = BEFORE) => ({ qty, v: 1, mv: "m", lastType: "received", updatedAt });
const seed = (updatedAt) => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt });
const fbRow = (store, over = {}) => ({
  productId: "tee", size: "M", qty: 2, requestingLocation: store, status: "open", createdAt: C0,
  createdFrom: { firstBatch: true, solveId: "fb_tee_1", source: "central", store }, ...over,
});
const fbLock = () => ({ qty: 2, source: "central", createdAt: C0, runId: "first_batch:fb_tee_1", refillId: "r1", orderId: null, orderCreatedAt: null });

// One Section 1 shop with an open first-batch request from Central.
// `at` = { loc: cellOrSeed } — what other locations hold of the product.
function snap({ shop = "marathon-pine", network = live(), at = {}, locked = true, row = {}, heldLines = {}, extraLocks = {}, extraRequests = {} } = {}) {
  const stock = { central: { tee: { M: cell(9) } }, [shop]: { tee: { M: seed(C0) } } };
  for (const [loc, c] of Object.entries(at)) stock[loc] = { tee: { M: c } };
  return {
    nowMs: NOW, config: CONFIG, products: { tee: TEE }, targets: {}, stock,
    openIndex: { ...(locked ? { [shop]: { tee: { M: fbLock() } } } : {}), ...extraLocks },
    refillRequests: { r1: fbRow(shop, row), ...extraRequests }, orders: {}, movements: [], heldLines, network,
  };
}
const withdrawal = (plan) => plan.closes.find((c) => c.refillId === "r1" && c.reason === "shop_hub_present")
  || (plan.satisfiedClosures || []).find((c) => c.refillId === "r1" && c.hubPresent);
const shopCentral = (plan) => plan.intents.filter((i) => i.source === "central" && S1.slice(0, 2).includes(i.dest));

test("SECTION 1, LIVE: Pine's first batch from Central stands while Hub 3 has never held the product", () => {
  for (const at of [{}, { hub3: seed(AFTER) }, { hub2: cell(5) }, { hub1: cell(5) }, { "concrete-stockroom": cell(5) }]) {
    const plan = computeRefillPlan(snap({ at }));
    assert.equal(withdrawal(plan), undefined, JSON.stringify(Object.keys(at)));
    assert.deepEqual(shopCentral(plan), []);
  }
});

test("SECTION 1, LIVE: Hub 3 holds the product by any means → Pine's untouched Central request is withdrawn, naming Hub 3", () => {
  const cases = [
    { at: { hub3: cell(4) } }, { at: { hub3: cell(0) } }, { at: { hub3: seed(BEFORE) } },
    { extraLocks: { hub3: { tee: { M: { qty: 3, source: "central", createdAt: BEFORE, runId: "scan", refillId: "gone" } } } } },
    { extraRequests: { h1: { productId: "tee", size: "M", qty: 1, requestingLocation: "hub3", status: "open", createdAt: BEFORE, createdFrom: { manual: true, source: "central" } } } },
    { heldLines: { hub3: { l1: { productId: "tee", size: "M", sizeKey: "M", qty: 2 } } } },
  ];
  for (const c of cases) {
    const plan = computeRefillPlan(snap(c));
    const w = withdrawal(plan);
    assert.ok(w, JSON.stringify(c));
    assert.deepEqual({ hub: w.hub, cancelReason: w.cancelReason, rrStatus: w.rrStatus, requireUntouched: w.requireUntouched },
      { hub: "hub3", cancelReason: "first_batch_hub2_present", rrStatus: "cancelled", requireUntouched: true });
    assert.deepEqual(shopCentral(plan), []);
  }
  // With units at Hub 3 the shop's need is re-raised from Hub 3 in the same plan.
  const plan = computeRefillPlan(snap({ at: { hub3: cell(4) } }));
  const again = plan.intents.filter((i) => i.dest === "marathon-pine" && i.productId === "tee");
  assert.deepEqual(again.map((i) => i.source), ["hub3"]);
});

test("SECTION 1, LIVE: a LOCK-LESS Pine ← Central row is judged the same way, and counts as inbound until then", () => {
  const held = computeRefillPlan(snap({ locked: false, at: { hub3: cell(4) } }));
  assert.equal(withdrawal(held).hub, "hub3");
  // never held: it stands, and the shop's need is not raised a second time
  const stands = computeRefillPlan(snap({ locked: false }));
  assert.equal(withdrawal(stands), undefined);
  assert.deepEqual(stands.intents.filter((i) => i.dest === "marathon-pine"), []);
});

test("SECTION 1, LIVE: a request Central has started, or one a picker has claimed, is never withdrawn", () => {
  for (const row of [{ sentQty: 1, qty: 1 }, { sentQty: "1" }, { picking: { atMs: NOW - 60e3, movementId: "m1", by: "u" } }]) {
    assert.equal(withdrawal(computeRefillPlan(snap({ at: { hub3: cell(4) }, row }))), undefined, JSON.stringify(row));
  }
});

test("CONCRETE: its back stock is Hub 3 — a stored mapping to the (removed) Concrete Stockroom is ignored, by category and by product override", () => {
  for (const extra of [{}, { backStock: { concrete: { "t-shirts": "concrete-stockroom" } } }, { productOverrides: { concrete: { tee: "concrete-stockroom" } } }]) {
    const network = live(S1, extra);
    // Hub 3 holding it IS presence for Concrete, whatever a stored record says
    assert.equal(withdrawal(computeRefillPlan(snap({ shop: "concrete", network, at: { hub3: cell(4) } }))).hub, "hub3", JSON.stringify(extra));
    // and units at the old Stockroom id are no presence anywhere (it is not a location)
    assert.equal(withdrawal(computeRefillPlan(snap({ shop: "concrete", network, at: { "concrete-stockroom": cell(4) } }))), undefined);
  }
  assert.equal(withdrawal(computeRefillPlan(snap({ shop: "concrete", at: { hub3: cell(4) } }))).hub, "hub3");
});

test("NOT LIVE: nothing automatic touches a request at a shop that is not live, or whose hub is not", () => {
  for (const network of [DARK, live(["marathon-pine"]), live(["hub3"]), null]) {
    const s = snap({ network: network || DARK, at: { hub3: cell(4) } });
    if (!network) delete s.network;                 // no registry handed in at all
    const plan = computeRefillPlan(s);
    assert.equal(withdrawal(plan), undefined);
    assert.deepEqual(plan.intents.filter((i) => S1.includes(i.dest)), []);
  }
});

test("the functions: a registry-routed shop is a shop, its hub is per product, and Central is a forbidden source for it", () => {
  const network = live(S1, { backStock: { concrete: { hoodies: "concrete-stockroom" } } });   // a stored mapping to the removed Stockroom: ignored
  const routing = networkRouting(CONFIG, network);
  const ctx = { routes: routing.routes, locations: null, routing };
  for (const shop of ["marathon-pine", "concrete"]) {
    assert.equal(rule.isShopLoc(shop, ctx), true);
    assert.equal(rule.forbiddenShopSource({ dest: shop, source: "central", ...ctx }), true);
    assert.equal(rule.forbiddenShopSource({ dest: shop, source: "hub3", ...ctx }), false);
  }
  assert.equal(rule.shopHubFor("marathon-pine", { ...ctx, product: TEE, pid: "tee" }), "hub3");
  assert.equal(rule.shopHubFor("concrete", { ...ctx, product: TEE, pid: "tee" }), "hub3");
  assert.equal(rule.shopHubFor("concrete", { ...ctx, product: { categoryKey: "hoodies" }, pid: "h" }), "hub3");
  // hubs are never shops, with or without the routing
  for (const hub of ["hub3", "hub1", "hub2"]) assert.equal(rule.isShopLoc(hub, ctx), false);
  assert.equal(rule.isShopLoc("concrete-stockroom", ctx), false);
  // without the routing the rule is exactly the config.routes rule
  assert.equal(rule.isShopLoc("marathon-pine", { routes: routing.routes }), false);
  assert.equal(rule.shopHubFor("marathon-pine", { routes: routing.routes, product: TEE, pid: "tee" }), null);
  // not live → not in the engine's routing → not covered
  const cold = networkRouting(CONFIG, DARK);
  assert.equal(rule.isShopLoc("marathon-pine", { routes: cold.routes, routing: cold }), false);
});

// ═══ SECTION 2 DIFFERENTIAL ═══════════════════════════════════════════════════
// THE RULE AS IT STOOD BEFORE THIS CHANGE (shop-source-rule.cjs at cd6f5b35),
// frozen here. Do not "fix" it: it is the reference.
const OLD = (() => {
  const CENTRAL = "central";
  const SHOP_KINDS = new Set(["store", "shop"]);
  function isShopLoc(loc, { routes = {}, locations = null } = {}) {
    if (!loc || loc === CENTRAL) return false;
    if (Object.values(routes || {}).includes(loc)) return false;
    const reg = locations && typeof locations === "object" ? locations[loc] : null;
    if (reg && typeof reg === "object" && typeof reg.kind === "string" && SHOP_KINDS.has(reg.kind.trim().toLowerCase())) return true;
    const hub = routes[loc];
    return !!hub && hub !== CENTRAL && routes[hub] != null;
  }
  function shopHubFor(loc, ctx = {}) {
    if (!isShopLoc(loc, ctx)) return null;
    const hub = (ctx.routes || {})[loc];
    return hub && hub !== CENTRAL ? hub : null;
  }
  function forbiddenShopSource({ dest, source, routes, locations } = {}) {
    return source === CENTRAL && isShopLoc(dest, { routes, locations });
  }
  function shopCentralWithdrawal({ dest, pid, entry, rr, inFlight, routes, locations, snapshot = {}, nowMs = Date.now() } = {}) {
    if (!entry || !rr) return null;
    if (!rr.createdAt || !Number.isFinite(Date.parse(rr.createdAt))) return null;
    const source = entry.source || (routes || {})[dest];
    if (!forbiddenShopSource({ dest, source, routes, locations })) return null;
    if (rr.status !== "open" || !rule.requestUntouched(rr, nowMs) || inFlight) return null;
    const hub = shopHubFor(dest, { routes, locations });
    if (!hub) return null;
    const { stock = {}, openIndex = {}, heldLines = {}, refillRequests = {} } = snapshot;
    const hubOpenRequests = [];
    for (const r of Object.values(refillRequests || {})) {
      if (r && r.status === "open" && r.productId === pid && r.requestingLocation === hub && !r.shadow) hubOpenRequests.push({ createdAt: r.createdAt });
    }
    const signals = rule.hubPresenceSignals({
      hubNode: stock[hub] ? stock[hub][pid] : null,
      hubLocks: openIndex[hub] ? openIndex[hub][pid] : null,
      hubOpenRequests, heldLines: heldLines[hub] || null, sinceIso: rr.createdAt, pid,
    });
    return signals.length ? { hub, signals } : null;
  }
  return { isShopLoc, shopHubFor, forbiddenShopSource, shopCentralWithdrawal };
})();

// Deterministic generator (mulberry32).
function rng(seedN) { let a = seedN >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const S2 = ["marathon-pe", "trophy", "hub1", "hub2"];
const IDS = ["central", ...S2, ...S1, "ghost"];
const KINDS = ["store", "shop", " Store ", "warehouse", "transit", "", 7, undefined];
function genCase(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  // routes: mostly the live shape, mutated — entries dropped, re-pointed, added
  const routes = { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" };
  const muts = Math.floor(r() * 4);
  for (let i = 0; i < muts; i++) {
    const k = pick(IDS.slice(1));
    const how = r();
    if (how < 0.3) delete routes[k]; else routes[k] = pick(IDS);
  }
  const locations = r() < 0.3 ? null : Object.fromEntries(IDS.filter(() => r() < 0.7).map((id) => [id, r() < 0.1 ? "junk" : { kind: pick(KINDS) }]));
  const liveIds = S1.filter(() => r() < 0.6);
  const network = pick([undefined, DARK, live(liveIds), live(liveIds, { backStock: { concrete: { "t-shirts": "concrete-stockroom" } } }),
    normalizeNetwork({ locations: { ...Object.fromEntries(liveIds.map((id) => [id, { live: true }])), [pick(S2)]: { live: r() < 0.5 } } })]);
  const hubHas = pick([null, "units", "later_seed", "lock", "held"]);
  const hubLoc = pick(["hub1", "hub2", "hub3"]);
  const stock = { central: { tee: { M: cell(9) } } };
  const openIndex = {}; const heldLines = {};
  if (hubHas === "units") stock[hubLoc] = { tee: { M: cell(2) } };
  if (hubHas === "later_seed") stock[hubLoc] = { tee: { M: seed(AFTER) } };
  if (hubHas === "lock") openIndex[hubLoc] = { tee: { M: { qty: 1, createdAt: pick([BEFORE, AFTER]) } } };
  if (hubHas === "held") heldLines[hubLoc] = { l: { productId: "tee" } };
  const rr = pick([
    fbRow("x"), fbRow("x", { sentQty: 1 }), fbRow("x", { sentQty: "1" }), fbRow("x", { status: "fulfilled" }), fbRow("x", { createdAt: null }),
    fbRow("x", { picking: { atMs: NOW } }), null,
  ]);
  const entry = pick([{ source: "central" }, { source: "hub2" }, {}, null]);
  return { routes, locations, network, snapshot: { stock, openIndex, heldLines, refillRequests: {} }, rr, entry, inFlight: r() < 0.15, source: pick(["central", "hub1", "hub2", "hub3", undefined]) };
}

test("SECTION 2 DIFFERENTIAL: for Marathon PE, Trophy, Hub 1 and Hub 2 the rule answers exactly as the frozen reference, whatever routing is handed in", () => {
  const r = rng(20261006);
  let n = 0; let named = 0; let withdrawals = 0; let shops = 0;
  const skippedUnnamedShops = [];
  for (let i = 0; i < 6000; i++) {
    const c = genCase(r);
    // The engine hands the rule routing.routes (see computeRefillPlan), so
    // that is the map both sides are given here.
    const routing = networkRouting({ routes: c.routes }, c.network);
    for (const dest of S2) {
      // The reference is "today" for a location config.routes NAMES — every
      // Section 2 location in production. A Section 2 shop that config.routes
      // does not name at all is routed by the registry in the engine since
      // sections shipped, and the rule now follows the engine there: that
      // input class is pinned separately below and excluded here.
      const inConfig = Object.prototype.hasOwnProperty.call(c.routes, dest);
      if (!inConfig && routing.stores.has(dest)) { skippedUnnamedShops.push(dest); continue; }
      for (const routes of [c.routes, routing.routes]) {
        const oldCtx = { routes, locations: c.locations };
        const newCtx = { ...oldCtx, routing, product: TEE, pid: "tee" };
        const label = JSON.stringify({ dest, routes, locations: c.locations });
        assert.equal(rule.isShopLoc(dest, newCtx), OLD.isShopLoc(dest, oldCtx), label);
        assert.equal(rule.shopHubFor(dest, newCtx), OLD.shopHubFor(dest, oldCtx), label);
        assert.equal(rule.forbiddenShopSource({ dest, source: c.source, ...newCtx }), OLD.forbiddenShopSource({ dest, source: c.source, ...oldCtx }), label);
        const args = { dest, pid: "tee", entry: c.entry, rr: c.rr && { ...c.rr, requestingLocation: dest }, inFlight: c.inFlight, snapshot: c.snapshot, nowMs: NOW };
        const was = OLD.shopCentralWithdrawal({ ...args, ...oldCtx });
        assert.deepEqual(rule.shopCentralWithdrawal({ ...args, ...newCtx }), was, label);
        n++; if (inConfig) named++; if (was) withdrawals++; if (OLD.isShopLoc(dest, oldCtx)) shops++;
      }
    }
  }
  // the generator really exercised both answers
  assert.ok(n > 40000 && named > 30000 && shops > 5000 && withdrawals > 50, JSON.stringify({ n, named, shops, withdrawals }));
  assert.ok(skippedUnnamedShops.length > 0);
});

test("SECTION 2, the one input class the reference does not cover: a shop config.routes does not name at all is the engine's registry-routed shop, and the rule follows the engine", () => {
  const routes = { hub1: "central", hub2: "central", "marathon-pe": "hub2" };          // trophy's entry deleted
  const routing = networkRouting({ routes }, DARK);
  assert.equal(routing.stores.has("trophy"), true);                                    // the engine routes it by the registry
  assert.equal(routing.sourceFor("trophy", TEE, "tee"), "hub2");
  assert.equal(OLD.isShopLoc("trophy", { routes: routing.routes }), false);            // before: not covered
  assert.equal(rule.isShopLoc("trophy", { routes: routing.routes, routing }), true);   // now: covered, as the engine plans it
  assert.equal(rule.shopHubFor("trophy", { routes: routing.routes, routing, product: TEE, pid: "tee" }), "hub2");
  // Marathon PE, named, is untouched by any of it
  assert.equal(rule.shopHubFor("marathon-pe", { routes: routing.routes, routing, product: TEE, pid: "tee" }), OLD.shopHubFor("marathon-pe", { routes: routing.routes }));
});
