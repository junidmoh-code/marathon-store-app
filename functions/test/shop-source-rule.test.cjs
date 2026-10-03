// ─── A SHOP NEVER REFILLS FROM CENTRAL ONCE ITS HUB HAS HELD THE PRODUCT ─────
// Owner rule 2026-09-17 (SHOP-CENTRAL-ROUTE-INVESTIGATION.md). Driven through
// the REAL computeRefillPlan for every shop × every non-sneaker category:
//   • never held at the shop's hub → a first-batch shop ← Central request
//     stands (it is the one legitimate Central → shop leg);
//   • held by ANY means — units now, a sold-out cell, an older seed, a prior
//     lock, a prior open hub request, units held in transit — → the request
//     is withdrawn (untouched only) and the shop's need re-raised from the hub;
//   • the engine itself never plans shop ← Central, whatever routes[] says.
// Plus the list-change regressions: a shop or a hub added to the network must
// not break the mapping, and a shop is never judged by "any hub".
// Run: cd functions && node --test test/shop-source-rule.test.cjs
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const rule = require("../lib/shop-source-rule.cjs");
const { hub2PresenceSignals } = require("../lib/first-batch.cjs");
const { closeRequestTxn } = { closeRequestTxn: require("../refill-scan.cjs")._closeRequestTxn };

const NOW = Date.parse("2026-10-03T10:00:00.000Z");
const C0 = "2026-09-25T14:25:29.087Z";            // the request's createdAt
const BEFORE = "2026-09-20T08:00:00.000Z";
const AFTER = "2026-09-26T08:00:00.000Z";
const SHOPS = ["marathon-pe", "trophy"];
const LOCATIONS = {
  central: { kind: "warehouse" }, hub1: { kind: "warehouse" }, hub2: { kind: "warehouse" }, hub3: { kind: "warehouse" },
  in_transit: { kind: "transit" }, "marathon-pe": { kind: "store" }, trophy: { kind: "store" }, "marathon-pine": { kind: "store" },
};
// Every mapped category live on 2026-10-03 (config/refillEngine.categoryPolicy),
// one-size or per-size exactly as live, given BOTH shops so every shop is tested.
const MAPPED = {
  bags: false, belts: true, "caps-beanies": false, "fitted-caps": true, gloves: false,
  perfumes: false, "soccer-jerseys": true, sunglasses: false, underwear: true,
};
// Clothing keys (defaultRunByStore) — the ones the 25 Sep first batches used.
const CLOTHING = ["t-shirts", "hoodies", "pants", "jackets", "golf-t-shirts", "suits"];
const categoryPolicy = Object.fromEntries(Object.entries(MAPPED).map(([k, perSize]) => [k, {
  ...(perSize ? { perSize: true } : {}),
  hub2: { target: 4, minQty: 2 }, "marathon-pe": { target: 2, minQty: 1 }, trophy: { target: 2, minQty: 1 },
}]));
const CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", trophy: "live", "marathon-pe": "live" },
  routes: { hub1: "central", hub2: "central", trophy: "hub2", "marathon-pe": "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 500, staleIntentHours: 999,
  defaultRunByStore: { hub2: { M: 3 }, trophy: { M: 2 }, "marathon-pe": { M: 2 } },
  categoryPolicy,
};
const CATEGORIES = [
  ...Object.entries(MAPPED).map(([key, perSize]) => ({ key, size: perSize ? "M" : "_", product: { productType: "clothing", categoryKey: key, sizes: [perSize ? "M" : "_"] } })),
  ...CLOTHING.map((key) => ({ key, size: "M", product: { productType: "clothing", categoryKey: key, sizes: ["M"] } })),
];

const cell = (qty, updatedAt = BEFORE) => ({ qty, v: 1, mv: "m", lastType: "received", updatedAt });
const seed = (updatedAt) => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt });
const fbRow = (pid, size, store, over = {}) => ({
  productId: pid, size, qty: 2, requestingLocation: store, status: "open", createdAt: C0,
  createdFrom: { firstBatch: true, solveId: `fb_${pid}_1`, source: "central", store, hub: "hub2" }, ...over,
});
const fbLock = (refillId) => ({ qty: 2, source: "central", createdAt: C0, runId: "first_batch:fb_1", refillId, orderId: null, orderCreatedAt: null });

// One shop, one category, one way of "held" (or none): the engine snapshot.
function scenario({ shop, cat, held = null, row = {} }) {
  const pid = `${cat.key}-${shop}`;
  const sk = cat.size;
  const stock = { central: { [pid]: { [sk]: cell(9) } }, [shop]: { [pid]: { [sk]: seed(C0) } } };
  const openIndex = { [shop]: { [pid]: { [sk]: fbLock("r1") } } };
  const refillRequests = { r1: fbRow(pid, sk === "_" ? "" : sk, shop, row) };
  const heldLines = {};
  if (held === "units") stock.hub2 = { [pid]: { [sk]: cell(3) } };
  if (held === "sold_out") stock.hub2 = { [pid]: { [sk]: cell(0) } };
  if (held === "other_size") stock.hub2 = { [pid]: { XL: cell(0) } };
  if (held === "older_seed") stock.hub2 = { [pid]: { [sk]: seed(BEFORE) } };
  if (held === "unstamped_seed") stock.hub2 = { [pid]: { [sk]: seed(undefined) } };
  if (held === "later_seed") stock.hub2 = { [pid]: { [sk]: seed(AFTER) } };            // NOT presence: the Solve's / trigger's own carriage
  if (held === "prior_lock") openIndex.hub2 = { [pid]: { [sk]: { qty: 3, source: "central", createdAt: BEFORE, runId: "scan", refillId: "h1" } } };
  if (held === "later_lock") openIndex.hub2 = { [pid]: { [sk]: { qty: 3, source: "central", createdAt: AFTER, runId: "scan", refillId: "h1" } } };
  if (held === "prior_lock" || held === "later_lock") refillRequests.h1 = { productId: pid, size: sk, qty: 3, requestingLocation: "hub2", status: "open", createdAt: held === "prior_lock" ? BEFORE : AFTER, createdFrom: { engine: true, source: "central" } };
  // A lock alone (its request already resolved, the lock not yet closed by a scan).
  if (held === "prior_lock_only") openIndex.hub2 = { [pid]: { [sk]: { qty: 3, source: "central", createdAt: BEFORE, runId: "scan", refillId: "gone" } } };
  if (held === "prior_open_request") refillRequests.h2 = { productId: pid, size: sk, qty: 1, requestingLocation: "hub2", status: "open", createdAt: BEFORE, createdFrom: { manual: true, source: "central", via: "on_hold" } };
  if (held === "held_inbound") heldLines.hub2 = { line1: { productId: pid, size: sk, sizeKey: sk, qty: 2 } };
  return {
    pid, sk,
    snap: { nowMs: NOW, config: CONFIG, products: { [pid]: { id: pid, name: pid, ...cat.product } }, targets: {}, stock, openIndex, refillRequests, orders: {}, movements: [], heldLines, locations: LOCATIONS },
  };
}
const shopCentralIntents = (plan) => plan.intents.filter((i) => i.source === "central" && rule.isShopLoc(i.dest, { routes: CONFIG.routes, locations: LOCATIONS }));
const withdrawalOf = (plan) => plan.closes.find((c) => c.refillId === "r1" && c.reason === "shop_hub_present");

const HELD = ["units", "sold_out", "other_size", "older_seed", "unstamped_seed", "prior_lock", "prior_lock_only", "prior_open_request", "held_inbound"];
const NOT_HELD = [null, "later_seed", "later_lock"];

for (const shop of SHOPS) {
  for (const cat of CATEGORIES) {
    test(`${shop} × ${cat.key}: never held at Hub 2 → the first batch from Central stands, and the engine plans no shop ← Central`, () => {
      for (const held of NOT_HELD) {
        const { snap } = scenario({ shop, cat, held });
        const plan = computeRefillPlan(snap);
        assert.equal(withdrawalOf(plan), undefined, `${held || "nothing"} at Hub 2 is not prior presence`);
        assert.deepEqual(shopCentralIntents(plan), []);
      }
    });
    test(`${shop} × ${cat.key}: held at Hub 2 by any means → the untouched Central request is withdrawn; never a shop ← Central intent`, () => {
      for (const held of HELD) {
        const { snap, pid } = scenario({ shop, cat, held });
        const plan = computeRefillPlan(snap);
        const w = withdrawalOf(plan);
        assert.ok(w, `held by ${held} must withdraw`);
        assert.equal(w.cancelReason, "first_batch_hub2_present");
        assert.equal(w.rrStatus, "cancelled");
        assert.equal(w.requireUntouched, true);
        assert.equal(w.hub, "hub2");
        assert.deepEqual(shopCentralIntents(plan), [], `held by ${held}: no shop ← Central intent`);
        if (held === "units") {
          const fromHub = plan.intents.filter((i) => i.dest === shop && i.productId === pid);
          assert.equal(fromHub.length, 1, "the need is re-raised from Hub 2 in the same plan");
          assert.equal(fromHub[0].source, "hub2");
        }
      }
    });
    test(`${shop} × ${cat.key}: a request Central has started (sentQty) or one whose sentQty is not a plain number is never withdrawn`, () => {
      for (const row of [{ sentQty: 1, qty: 1 }, { sentQty: "1" }, { sentQty: "?" }, { sentQty: {} }, { sentQty: null }]) {
        const { snap } = scenario({ shop, cat, held: "units", row });
        const plan = computeRefillPlan(snap);
        if (row.sentQty === null) assert.ok(withdrawalOf(plan), "an absent sentQty is untouched");
        else assert.equal(withdrawalOf(plan), undefined, `sentQty ${JSON.stringify(row.sentQty)} is in flight`);
        assert.deepEqual(shopCentralIntents(plan), []);
      }
    });
  }
}

test("sneakers and slides are untouched by the rule's reconcile (shops hold none; no first batch is ever made for them)", () => {
  for (const key of ["sneakers", "slides"]) {
    const cat = { key, size: "8", product: { productType: "footwear", category: "Footwear", categoryKey: key, sizes: ["8"] } };
    const { snap } = scenario({ shop: "trophy", cat, held: null });
    const plan = computeRefillPlan(snap);
    assert.deepEqual(shopCentralIntents(plan), []);
  }
});

test("a mid-pick store leg (plan-gen locked on its order) is never withdrawn even when Hub 2 holds the product", () => {
  const cat = CATEGORIES[0];
  const { snap, pid, sk } = scenario({ shop: "trophy", cat, held: "units" });
  const oca = "2026-09-25T14:25:30.000Z";
  snap.openIndex.trophy[pid][sk] = { ...fbLock("r1"), orderId: "R001-1", orderCreatedAt: oca };
  snap.orders = { "R001-1": { productId: pid, size: sk, createdAt: oca, clothingPlanGen: 3, autoRefill: true } };
  assert.equal(withdrawalOf(computeRefillPlan(snap)), undefined);
});

// ── the engine never PLANS shop ← Central, whatever routes[] says ─────────────
test("routes.trophy = 'central' (one console edit) is a refused route: no Trophy ← Central intent, a named error, other shops unaffected", () => {
  const cat = CATEGORIES.find((c) => c.key === "t-shirts");
  const { snap, pid } = scenario({ shop: "trophy", cat });
  snap.stock.trophy[pid].M = cell(0);
  snap.openIndex = {}; snap.refillRequests = {};
  snap.config = { ...CONFIG, routes: { ...CONFIG.routes, trophy: "central" } };
  const plan = computeRefillPlan(snap);
  assert.deepEqual(plan.intents.filter((i) => i.dest === "trophy"), []);
  assert.ok(plan.errors.some((e) => e.startsWith("route refused: trophy")), plan.errors.join("\n"));
});

test("the backstop: a pass-through raised for a shop's 'hub' that is itself a shop routed to Central is refused at the intent exit", () => {
  // trophy → marathon-pe → central: PE is a SHOP (registry) misrouted to
  // Central, and Trophy's leg upstream would be PE ← Central.
  const pid = "tee-x";
  const snap = {
    nowMs: NOW, products: { [pid]: { id: pid, name: pid, productType: "clothing", categoryKey: "t-shirts", sizes: ["M"] } },
    config: { ...CONFIG, routes: { hub1: "central", hub2: "central", "marathon-pe": "central", trophy: "marathon-pe" }, mode: { ...CONFIG.mode } },
    targets: {}, stock: { central: { [pid]: { M: cell(9) } }, trophy: { [pid]: { M: cell(0) } } },
    openIndex: {}, refillRequests: {}, orders: {}, movements: [], heldLines: {}, locations: LOCATIONS,
  };
  const plan = computeRefillPlan(snap);
  assert.deepEqual(shopCentralIntents(plan), []);
  assert.ok(!plan.intents.some((i) => i.dest === "marathon-pe" && i.source === "central"));
});

test("the reconcile asks the REGISTRY: a shop whose hub has no upstream route (shape says 'not a shop') is still held to the rule", () => {
  const cat = CATEGORIES.find((c) => c.key === "t-shirts");
  const { snap } = scenario({ shop: "trophy", cat, held: "units" });
  const routes = { hub1: "central", trophy: "hub2", "marathon-pe": "hub2" };   // hub2's own route missing
  snap.config = { ...CONFIG, routes };
  assert.equal(rule.isShopLoc("trophy", { routes, locations: null }), false, "the shape alone cannot see it");
  const w = withdrawalOf(computeRefillPlan(snap));
  assert.ok(w, "the registry says Trophy is a store, so Hub 2 holding the product withdraws its Central request");
  assert.equal(w.hub, "hub2");
});

// ── list changes must not break the mapping ──────────────────────────────────
test("ADDING A SHOP: a Section 1 shop routed via Hub 3 gets the same rule, judged at ITS hub (never 'any hub')", () => {
  const routes = { ...CONFIG.routes, hub3: "central", "marathon-pine": "hub3", concrete: "hub3" };
  const locations = { ...LOCATIONS, concrete: { kind: "store" } };
  for (const shop of ["marathon-pine", "concrete"]) {
    assert.equal(rule.shopHubFor(shop, { routes, locations }), "hub3");
    assert.equal(rule.forbiddenShopSource({ dest: shop, source: "central", routes, locations }), true);
    const rr = fbRow("p1", "M", shop);
    const entry = fbLock("r1");
    const heldAtHub2Only = rule.shopCentralWithdrawal({ dest: shop, pid: "p1", entry, rr, inFlight: false, routes, locations,
      snapshot: { stock: { hub2: { p1: { M: cell(5) } } } } });
    assert.equal(heldAtHub2Only, null, "Hub 2 holding it says nothing about the Section 1 shop's hub");
    const heldAtHub3 = rule.shopCentralWithdrawal({ dest: shop, pid: "p1", entry, rr, inFlight: false, routes, locations,
      snapshot: { stock: { hub3: { p1: { M: cell(0) } } } } });
    assert.deepEqual(heldAtHub3, { hub: "hub3", signals: ["stock_cell"] });
  }
});

test("ADDING A HUB: a new hub routed to Central is a hub, not a shop — its own Central refills are allowed", () => {
  const routes = { ...CONFIG.routes, hub4: "central" };
  for (const locations of [{ ...LOCATIONS, hub4: { kind: "warehouse" } }, null]) {
    assert.equal(rule.isShopLoc("hub4", { routes, locations }), false);
    assert.equal(rule.forbiddenShopSource({ dest: "hub4", source: "central", routes, locations }), false);
    for (const hub of ["hub1", "hub2"]) assert.equal(rule.forbiddenShopSource({ dest: hub, source: "central", routes, locations }), false);
  }
});

test("ANY shop the registry names is covered — generated shop names, both sections, with and without the registry", () => {
  for (let i = 0; i < 25; i++) {
    const shop = `shop-${i.toString(36)}`;
    const hub = i % 2 ? "hub2" : "hub3";
    const routes = { ...CONFIG.routes, hub3: "central", [shop]: hub };
    const locations = { ...LOCATIONS, [shop]: { kind: "store" } };
    for (const loc of [locations, null]) {
      assert.equal(rule.isShopLoc(shop, { routes, locations: loc }), true, `${shop} (${loc ? "registry" : "route shape"})`);
      assert.equal(rule.shopHubFor(shop, { routes, locations: loc }), hub);
      assert.equal(rule.forbiddenShopSource({ dest: shop, source: "central", routes, locations: loc }), true);
      assert.equal(rule.forbiddenShopSource({ dest: shop, source: hub, routes, locations: loc }), false, "its own hub is always allowed");
    }
  }
});

test("the registry wins over a broken route: Trophy misrouted to Central is still a shop", () => {
  const routes = { ...CONFIG.routes, trophy: "central" };
  assert.equal(rule.isShopLoc("trophy", { routes, locations: LOCATIONS }), true);
  assert.equal(rule.forbiddenShopSource({ dest: "trophy", source: "central", routes, locations: LOCATIONS }), true);
  assert.equal(rule.isShopLoc("central", { routes, locations: LOCATIONS }), false);
  assert.equal(rule.isShopLoc("in_transit", { routes, locations: LOCATIONS }), false);
});

// ── the presence function is ONE function ───────────────────────────────────
test("first-batch.cjs hub2PresenceSignals is the shared rule with Hub 2's inputs (same answer on every shape)", () => {
  const shapes = [
    { hub2Node: null }, { hub2Node: { M: cell(0) } }, { hub2Node: { M: seed(AFTER) } }, { hub2Node: { M: seed(BEFORE) } },
    { hub2Node: [null, null, cell(1)] }, { hub2Locks: { M: { createdAt: BEFORE } } }, { hub2Locks: { M: { createdAt: AFTER } } },
    { hub2OpenRequestIds: ["x"] }, { hub2OpenRequestIds: [] }, { heldLines: { a: { productId: "p1" } }, pid: "p1" }, { heldLines: { a: { productId: "p2" } }, pid: "p1" },
  ];
  for (const s of shapes) {
    const a = hub2PresenceSignals({ sinceIso: C0, ...s });
    const b = rule.hubPresenceSignals({ hubNode: s.hub2Node, hubLocks: s.hub2Locks, hubOpenRequests: s.hub2OpenRequestIds, heldLines: s.heldLines, pid: s.pid, sinceIso: C0 });
    assert.deepEqual(a, b, JSON.stringify(s));
  }
});

// ── the apply side: a pick that won the race keeps its request ──────────────
test("closeRequestTxn: a requireUntouched close never cancels a request a pick touched in the gap", () => {
  const c = { rrStatus: "cancelled", cancelReason: "first_batch_hub2_present", requireUntouched: true };
  assert.equal(closeRequestTxn({ status: "open", sentQty: 1 }, c, NOW), undefined);
  assert.equal(closeRequestTxn({ status: "open", sentQty: "1" }, c, NOW), undefined);
  assert.equal(closeRequestTxn({ status: "fulfilled" }, c, NOW), undefined);
  assert.equal(closeRequestTxn({ status: "open" }, c, NOW).status, "cancelled");
  assert.equal(closeRequestTxn({ status: "open", sentQty: 2 }, { ...c, requireUntouched: false }, NOW).status, "cancelled", "other closes keep their old semantics");
});

// ── the entrance exists: the scan hands the registry to the engine ──────────
test("refill-scan reads /locations (failures not swallowed) and passes it to computeRefillPlan; a requireUntouched close that did not commit keeps its lock", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "refill-scan.cjs"), "utf8");
  assert.match(src, /db\.ref\("locations"\)\.once\("value"\)/);
  assert.doesNotMatch(src, /db\.ref\("locations"\)[^\n]*\.catch\(/, "a swallowed registry read would run the scan with the rule weakened");
  assert.match(src, /computeRefillPlan\(\{[^}]*\blocations\b[^}]*\}\)/s);
  assert.match(src, /if \(c\.requireUntouched && !\(res && res\.committed\)\) \{ refusedHubPresent\.push\(c\); continue; \}/);
  assert.match(src, /plan\.intents = dropIntentsForRefused\(plan\.intents, refusedHubPresent\)/);
});

// ── Fable review, PR #673 ───────────────────────────────────────────────────
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const scan = require("../refill-scan.cjs");

test("a mis-typed registry kind never switches the rule off: registry OR route shape", () => {
  const routes = CONFIG.routes;
  for (const kind of ["shop", "Store ", "STORE"]) assert.equal(rule.isShopLoc("trophy", { routes, locations: { trophy: { kind } } }), true, kind);
  assert.equal(rule.isShopLoc("trophy", { routes, locations: { trophy: { kind: "warehouse" } } }), true, "the route shape still says shop");
  assert.equal(rule.isShopLoc("trophy", { routes: { ...routes, trophy: "central" }, locations: { trophy: { kind: "warehouse" } } }), false);
});

test("a request with no createdAt cannot be judged 'prior' and is left alone", () => {
  const cat = CATEGORIES[0];
  const { snap } = scenario({ shop: "trophy", cat, held: "units" });
  delete snap.refillRequests.r1.createdAt;
  assert.equal(withdrawalOf(computeRefillPlan(snap)), undefined);
});

test("a stock movement already linked to the request (pick written, sentQty not yet) is in flight: never withdrawn", () => {
  const cat = CATEGORIES[0];
  const { snap, pid, sk } = scenario({ shop: "trophy", cat, held: "units" });
  snap.movements = [{ type: "transfer_out", from: "central", to: "trophy", productId: pid, size: sk, qty: 1, ts: AFTER, link: { refillId: "r1" } }];
  assert.equal(withdrawalOf(computeRefillPlan(snap)), undefined);
});

test("a LOCK-LESS shop ← Central row: withdrawn (status only) when the hub held it; otherwise kept AND counted inbound, so nothing asks beside it", () => {
  const cat = CATEGORIES.find((c) => c.key === "t-shirts");
  for (const held of ["units", null]) {
    const { snap, pid } = scenario({ shop: "trophy", cat, held });
    snap.openIndex = {};                                          // the shop-lock claim was lost / never ran
    const plan = computeRefillPlan(snap);
    const s = plan.satisfiedClosures.find((c) => c.refillId === "r1");
    if (held) {
      assert.ok(s, "withdrawn");
      assert.equal(s.cancelReason, "first_batch_hub2_present");
      assert.equal(s.hubPresent, true);
      assert.equal(s.requireUntouched, true);
    } else {
      assert.equal(s, undefined, "a legitimate first batch stands");
      assert.deepEqual(plan.intents.filter((i) => i.productId === pid), [], "no shop ← hub2 and no pass-through beside the open Central request");
    }
  }
});

test("applySatisfied: a hub-present withdrawal needs no destination stock, and a pick that landed in the gap wins", async () => {
  const closure = { refillId: "r1", dest: "trophy", pid: "p1", sizeKey: "M", size: "M", qty: 0, have: 0, rrStatus: "cancelled", cancelReason: "first_batch_hub2_present", hubPresent: true, requireUntouched: true };
  const db = makeFakeDb({ refill_requests: { r1: fbRow("p1", "M", "trophy") } });
  const r = await scan._applySatisfied({ db, closures: [closure], startedAt: "2026-10-03T10:00:00.000Z" });
  assert.equal(r.satisfied, 1);
  assert.equal(db.state.root.refill_requests.r1.status, "cancelled");
  const db2 = makeFakeDb({ refill_requests: { r1: fbRow("p1", "M", "trophy", { sentQty: 1 }) } });
  await scan._applySatisfied({ db: db2, closures: [closure], startedAt: "2026-10-03T10:00:00.000Z" });
  assert.equal(db2.state.root.refill_requests.r1.status, "open");
});

test("a refused withdrawal drops the same pass's asks for that shop cell — its own and any leg raised FOR it", () => {
  const intents = [
    { dest: "trophy", productId: "p1", sizeKey: "M", source: "hub2" },
    { dest: "hub2", productId: "p1", sizeKey: "M", source: "central", forDests: ["trophy"] },
    { dest: "hub2", productId: "p1", sizeKey: "L", source: "central", forDests: ["trophy"] },
    { dest: "marathon-pe", productId: "p1", sizeKey: "M", source: "hub2" },
  ];
  const kept = scan._dropIntentsForRefused(intents, [{ dest: "trophy", pid: "p1", sizeKey: "M" }]);
  assert.deepEqual(kept.map((i) => `${i.dest}|${i.sizeKey}`), ["hub2|L", "marathon-pe|M"]);
});
