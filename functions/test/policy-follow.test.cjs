// ─── PINE FOLLOWS TROPHY (Junid, 22 Nov 2026) — lib/policy-follow.cjs ─────────
// config/refillEngine/policyFollow = { "marathon-pine": "trophy" }: every
// product Pine already carries keeps what Trophy's policy says for it. A link,
// resolved at each scan — never a copy. HOW MANY, never WHERE.
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, resolveTarget, networkRouting, maskUntrustedStock } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const pf = require("../lib/policy-follow.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");
const { applyCategoryPolicy } = require("../lib/category-policy-write.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");

const ISO = "2026-11-22T09:00:00.000Z";
const NOW = Date.parse(ISO);
const PINE = "marathon-pine";
const LINK = { [PINE]: "trophy" };
const clone = (v) => JSON.parse(JSON.stringify(v));

// Trophy's policy in every shape the engine knows: a one-size category entry
// (bags, sunglasses), a per-size category entry (belts), a size-by-size map
// (jerseys), the clothing size run, a subcategory rule (watches) and rows.
const cfg = (over = {}) => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 5000, maxFootwearIntentsPerRun: 5000, maxDivisionIntentsPerRun: 5000, maxUnitsPerIntent: 20,
  defaultRunByStore: {
    hub2: { S: 2, M: 3, L: 3, XL: 2 }, "marathon-pe": { S: 2, M: 2, L: 2, XL: 1 }, trophy: { S: 2, M: 2, L: 2, XL: 1 },
  },
  subcategoryRunByLocation: { trophy: { Watches: 3 } },
  categoryPolicy: {
    bags: { hub2: { target: 4, minQty: 2, reorderPoint: 0 }, trophy: { target: 2, minQty: 1, reorderPoint: 0 } },
    sunglasses: { hub2: { target: 5, minQty: 1, reorderPoint: 1 }, trophy: { target: 5, minQty: 3, reorderPoint: 3 } },
    belts: { perSize: true, hub2: { target: 5, minQty: 3, reorderPoint: 0 }, trophy: { target: 1, minQty: 1, reorderPoint: 0 } },
    "soccer-jerseys": { perSize: true,
      hub2: { sizes: { S: { target: 4, minQty: 2, reorderPoint: 1 }, M: { target: 4, minQty: 2, reorderPoint: 1 } } },
      trophy: { sizes: { S: { target: 3, minQty: 1, reorderPoint: 1 }, M: { target: 2, minQty: 1, reorderPoint: 0 } } } },
    // Marathon PE only: Trophy has no perfume policy, so Pine keeps its own.
    perfumes: { hub2: { target: 10, minQty: 5, reorderPoint: 5 }, "marathon-pe": { target: 8, minQty: 4, reorderPoint: 3 } },
  },
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(),
    policy: { perSize: true, hub1: { carriedOnly: true, sizes: { 8: { target: 2, minQty: 1, reorderPoint: 1 } } }, hub2: { carriedOnly: true, sizes: { 8: { target: 2, minQty: 1, reorderPoint: 1 } } }, hub3: { carriedOnly: true, sizes: { 8: { target: 2, minQty: 1, reorderPoint: 1 } } } } } },
  ...over,
});
const c = (qty) => ({ qty, v: 1, mv: "m", lastType: "count", trusted: true, trustedVia: "count", trustedAt: ISO });
const shelf = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });

const products = {
  tee: { id: "tee", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M", "L", "XL"] },
  tee2: { id: "tee2", name: "Tee two", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M", "L", "XL"] },
  bag: { id: "bag", name: "Bag", category: "Accessories", categoryKey: "bags", sizes: [] },
  sun: { id: "sun", name: "Ray", category: "Accessories", categoryKey: "sunglasses", sizes: ["_"] },
  belt: { id: "belt", name: "Belt", category: "Accessories", categoryKey: "belts", sizes: ["S", "M"] },
  jersey: { id: "jersey", name: "Jersey", category: "Clothing", categoryKey: "soccer-jerseys", productType: "clothing", sizes: ["S", "M", "L"] },
  watch: { id: "watch", name: "Watch", category: "Accessories", categoryKey: "watches", productType: "clothing", subcategory: "Watches", sizes: ["S"] },
  perf: { id: "perf", name: "Scent", category: "Perfume", categoryKey: "perfumes", sizes: [] },
  trophyOnly: { id: "trophyOnly", name: "Only at Trophy", category: "Accessories", categoryKey: "sunglasses", sizes: ["_"] },
  shoe: { id: "shoe", name: "Shoe", category: "Footwear", categoryKey: "sneakers", productType: "sneaker", sizes: ["8"] },
};
const NONFOOT = ["tee", "tee2", "bag", "sun", "belt", "jersey", "watch", "perf"];
const sizesOf = (pid) => dv.divisionSizes(products[pid]).map((s) => (s === "_" ? "" : s));
const full = (pid, qty, cell = c) => Object.fromEntries(dv.divisionSizes(products[pid]).map((s) => [s, cell(qty)]));

const targets = () => ({
  // Trophy's per-product numbers: a tee kept at 4/3 with an ask-at on M…
  trophy: {
    tee2: { S: { target: 4, minQty: 2 }, M: { target: 3, minQty: 1, reorderPoint: 1 } },
    // …and a jersey Trophy has SWITCHED OFF (the Seating tab's target 0 rows).
    jersey: { S: { target: 0, minQty: 0 }, M: { target: 0, minQty: 0 }, L: { target: 0, minQty: 0 } },
  },
});
const stock = () => ({
  central: { ...Object.fromEntries([...NONFOOT, "trophyOnly"].map((p) => [p, full(p, 40)])), shoe: { 8: c(0) } },
  hub1: {}, hub2: Object.fromEntries(["tee", "tee2", "bag", "sun", "belt", "jersey", "watch", "trophyOnly"].map((p) => [p, full(p, 40)])),
  hub3: { shoe: { 8: c(6) } },
  "marathon-pe": { tee: full("tee", 0), perf: full("perf", 0) },
  trophy: { tee: full("tee", 0), bag: full("bag", 0), sun: full("sun", 0), trophyOnly: full("trophyOnly", 0), watch: full("watch", 0) },
  concrete: { tee: full("tee", 0, shelf), bag: full("bag", 0, shelf), sun: full("sun", 0, shelf) },
  // Pine carries all of these (trophyOnly it does NOT).
  [PINE]: Object.fromEntries(NONFOOT.map((p) => [p, full(p, 0, shelf)])),
});
const seat = { via: "stock", at: ISO };
const seatsOf = (st) => ({
  concrete: Object.fromEntries(Object.keys(st.concrete || {}).map((p) => [p, seat])),
  [PINE]: Object.fromEntries(Object.keys(st[PINE] || {}).map((p) => [p, seat])),
  hub3: Object.fromEntries(Object.keys(st.hub3 || {}).map((p) => [p, seat])),
});
const plan = ({ config = cfg(), t = targets(), st = stock(), seats } = {}) => computeRefillPlan({
  nowMs: NOW, config, targets: t, products, openIndex: {}, refillRequests: {}, heldLines: {}, orders: {}, movements: [],
  stock: st, network: reg.SEED_REGISTRY, seats: seats || seatsOf(st),
});
// What a location's policy answers for one cell, as the scan asks it.
const ask = (config, loc, pid, size, { t = targets(), st = stock() } = {}) => {
  const { stock: view } = maskUntrustedStock(st, reg.SEED_REGISTRY);
  return resolveTarget({ targets: t, config, products, stock: view, network: reg.SEED_REGISTRY, division: dv.divisionContext({ config, seats: seatsOf(st) }) }, loc, pid, size);
};
const three = (x) => (x ? [x.target, x.minQty, x.reorderPoint ?? null] : null);
// Trophy's own answer for a product it carries (a stock cell there).
const atTrophy = (config, pid, size, t = targets()) => {
  const st = stock();
  st.trophy[pid] = st.trophy[pid] || full(pid, 0);
  return ask(config, "trophy", pid, size, { t, st });
};
const linesOf = (p, dest) => p.intents.filter((i) => i.dest === dest).map((i) => `${i.productId}:${i.sizeKey}:${i.qty}<-${i.source}`).sort();

test("the link: only Pine and Concrete may follow, only Trophy may be followed; anything else is off", () => {
  assert.equal(pf.policyFollowOf({ policyFollow: LINK }, PINE), "trophy");
  assert.equal(pf.policyFollowOf({}, PINE), null);
  assert.equal(pf.policyFollowOf({ policyFollow: { [PINE]: "marathon-pe" } }, PINE), null);
  assert.equal(pf.policyFollowOf({ policyFollow: { concrete: "trophy", hub3: "hub2", trophy: PINE } }, "concrete"), "trophy");
  assert.equal(pf.policyFollowOf({ policyFollow: { concrete: "marathon-pe" } }, "concrete"), null);
  assert.equal(pf.policyFollowOf({ policyFollow: { hub3: "hub2" } }, "hub3"), null);
  assert.equal(pf.policyFollowOf({ policyFollow: { trophy: PINE } }, "trophy"), null);
  assert.equal(pf.policyFollowOf({ policyFollow: "trophy" }, PINE), null);
  assert.deepEqual(pf.policyFollowMap({ policyFollow: { ...LINK, concrete: "trophy", hub3: "hub2" } }), { ...LINK, concrete: "trophy" });
  assert.equal(pf.validatePolicyFollow(PINE, "trophy"), null);
  assert.equal(pf.validatePolicyFollow(PINE, null), null);
  assert.equal(pf.validatePolicyFollow("concrete", "trophy"), null);
  assert.match(pf.validatePolicyFollow(PINE, "marathon-pe"), /Trophy only/);
  assert.match(pf.validatePolicyFollow("concrete", "marathon-pe"), /Concrete can follow Trophy only/);
  assert.match(pf.validatePolicyFollow("hub3", "trophy"), /Only Marathon Pine and Concrete/);
  // The chain: Trophy, then Marathon PE.
  assert.deepEqual(pf.policyFollowChain({ policyFollow: LINK }, PINE), ["trophy", "marathon-pe"]);
  assert.deepEqual(pf.policyFollowChain({}, PINE), []);
  // Per category: the fallback first only where the leader has no category policy and it has one.
  assert.deepEqual(pf.followOrder(["trophy", "marathon-pe"], (l) => l === "marathon-pe"), ["marathon-pe", "trophy"]);
  assert.deepEqual(pf.followOrder(["trophy", "marathon-pe"], () => true), ["trophy", "marathon-pe"]);
  assert.deepEqual(pf.followOrder(["trophy", "marathon-pe"], () => false), ["trophy", "marathon-pe"]);
});

test("Pine resolves the same keep, minimum and ask-at as Trophy for every category and size row", () => {
  const config = cfg({ policyFollow: LINK });
  let compared = 0;
  // Everything Trophy has a policy for: the category entries, the size-by-size
  // map, the per-size entry, the size run, the subcategory rule, product rows.
  for (const pid of ["tee", "tee2", "bag", "sun", "belt", "watch"]) {
    for (const size of sizesOf(pid)) {
      const trophy = atTrophy(config, pid, size);
      const pine = ask(config, PINE, pid, size);
      assert.ok(trophy && trophy.target > 0, `Trophy has a policy for ${pid} ${size || "_"}`);
      assert.deepEqual(three(pine), three(trophy), `${pid} ${size || "_"}`);
      assert.equal(pine.source, "follows");
      assert.equal(pine.follows, "trophy");
      compared += 1;
    }
  }
  assert.equal(compared, 13);
  // The numbers themselves, so "equal" cannot be two nulls agreeing.
  assert.deepEqual(three(ask(config, PINE, "sun", "")), [5, 3, 3]);          // was 5 per design, no ask-at
  assert.deepEqual(three(ask(config, PINE, "bag", "")), [2, 1, 0]);          // was 5 per design
  assert.deepEqual(three(ask(config, PINE, "belt", "S")), [1, 1, 0]);        // per-size entry
  assert.deepEqual(three(ask(config, PINE, "tee", "XL")), [1, 1, null]);     // the size run: XL keeps 1, not 2
  assert.deepEqual(three(ask(config, PINE, "watch", "S")), [3, 2, null]);    // the subcategory rule
  assert.deepEqual(three(ask(config, PINE, "tee2", "S")), [4, 2, null]);     // Trophy's product row
  assert.deepEqual(three(ask(config, PINE, "tee2", "M")), [3, 1, 1]);
  assert.deepEqual(three(ask(config, PINE, "tee2", "L")), [2, 1, null]);     // no row for L: the run
});

test("without the link Pine is exactly as it was: 2 per size, 5 per design", () => {
  for (const config of [cfg(), cfg({ policyFollow: null }), cfg({ policyFollow: { [PINE]: "marathon-pe" } })]) {
    assert.deepEqual(three(ask(config, PINE, "sun", "")), [5, 4, null]);
    assert.deepEqual(three(ask(config, PINE, "tee", "XL")), [2, 1, null]);
    assert.equal(ask(config, PINE, "sun", "").source, "concrete_division");
  }
});

test("editing Trophy's policy changes Pine's resolved policy, with no second step", () => {
  const before = cfg({ policyFollow: LINK });
  const after = clone(before);
  after.categoryPolicy.sunglasses.trophy = { target: 9, minQty: 4, reorderPoint: 2 };
  after.categoryPolicy["soccer-jerseys"].trophy.sizes.S.target = 6;
  after.defaultRunByStore.trophy.XL = 3;
  assert.deepEqual(three(ask(before, PINE, "sun", "")), [5, 3, 3]);
  assert.deepEqual(three(ask(after, PINE, "sun", "")), [9, 4, 2]);
  assert.deepEqual(three(ask(after, PINE, "tee", "XL")), [3, 2, null]);
  // A Trophy product row edited on the card: Pine has it at the next question.
  const t = targets();
  t.trophy.tee2.S = { target: 7, minQty: 3, reorderPoint: 2 };
  assert.deepEqual(three(ask(before, PINE, "tee2", "S", { t })), [7, 3, 2]);
  // Removing Trophy's entry hands Pine back to its own numbers for that category.
  delete after.categoryPolicy.sunglasses.trophy;
  assert.deepEqual(three(ask(after, PINE, "sun", "")), [5, 4, null]);
});

test("where Trophy has no policy Marathon PE's applies, then Pine's own; a Trophy switch-off is Trophy's alone", () => {
  const config = cfg({ policyFollow: LINK });
  // Perfume: Marathon PE and Hub 2 only. Pine follows Marathon PE's 8/4/3
  // (policies are universal, Junid 24 Nov 2026).
  assert.equal(atTrophy(config, "perf", ""), null);
  assert.deepEqual(three(ask(config, PINE, "perf", "")), [8, 4, 3]);
  assert.equal(ask(config, PINE, "perf", "").follows, "marathon-pe");
  // With Marathon PE's perfume entry gone too, Pine's own 5 per design stands.
  const noPe = cfg({ policyFollow: LINK });
  delete noPe.categoryPolicy.perfumes["marathon-pe"];
  assert.equal(ask(noPe, PINE, "perf", "").source, "concrete_division");
  // The jersey is switched off AT TROPHY (target 0 rows). Pine carries it and
  // keeps Trophy's size-by-size numbers; the size Trophy's map does not name
  // (L) is Trophy's size run, as it is for a jersey Trophy carries.
  assert.deepEqual(three(ask(config, "trophy", "jersey", "S")), [0, 0, null]);
  assert.deepEqual(three(ask(config, PINE, "jersey", "S")), [3, 1, 1]);
  assert.deepEqual(three(ask(config, PINE, "jersey", "M")), [2, 1, 0]);
  assert.deepEqual(three(ask(config, PINE, "jersey", "L")), [2, 1, null]);
  assert.equal(ask(config, PINE, "jersey", "L").followedSource, "default");
  // With Trophy's size run gone too, Marathon PE's run speaks for L…
  const noRun = cfg({ policyFollow: LINK });
  delete noRun.defaultRunByStore.trophy;
  assert.equal(ask(noRun, PINE, "jersey", "L").follows, "marathon-pe");
  assert.deepEqual(three(ask(noRun, PINE, "tee", "XL")), [1, 1, null]);
  // …and with PE's gone as well, nothing speaks for it: Pine's own.
  delete noRun.defaultRunByStore["marathon-pe"];
  assert.equal(ask(noRun, PINE, "jersey", "L").source, "concrete_division");
  assert.deepEqual(three(ask(noRun, PINE, "tee", "XL")), [2, 1, null]);
});

test("a Pine switch-off row still wins", () => {
  const config = cfg({ policyFollow: LINK });
  const t = targets();
  t[PINE] = { sun: { _: { target: 0, minQty: 0 } }, tee: { M: { target: 0, minQty: 0 } } };
  assert.deepEqual(three(ask(config, PINE, "sun", "", { t })), [0, 0, null]);
  assert.equal(ask(config, PINE, "sun", "", { t }).source, "explicit");
  assert.equal(ask(config, PINE, "tee", "M", { t }).target, 0);
  assert.deepEqual(three(ask(config, PINE, "tee", "S", { t })), [2, 1, null]);   // the other sizes follow
  const p = plan({ config, t });
  assert.equal(p.intents.some((i) => i.dest === PINE && i.productId === "sun"), false);
  assert.equal(p.intents.some((i) => i.dest === PINE && i.productId === "tee" && i.sizeKey === "M"), false);
  assert.equal(p.intents.some((i) => i.dest === PINE && i.productId === "tee" && i.sizeKey === "S"), true);
});

test("a hand-made Pine row above zero still outranks the link (an explicit row is the source of truth; none exist at Pine today)", () => {
  const config = cfg({ policyFollow: LINK });
  const t = targets();
  t[PINE] = { tee: { S: { target: 3, minQty: 2 } } };
  assert.deepEqual(three(ask(config, PINE, "tee", "S", { t })), [3, 2, null]);
  assert.equal(ask(config, PINE, "tee", "S", { t }).source, "explicit");
  assert.equal(ask(config, PINE, "tee", "M", { t }).target, 2);   // the other sizes follow Trophy
});

test("an inherited object key is never an allowed pair", () => {
  for (const loc of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(pf.validatePolicyFollow(loc, "trophy"), "Only Marathon Pine and Concrete can follow another shop's policy.");
    assert.equal(pf.validatePolicyFollow(loc, null), "Only Marathon Pine and Concrete can follow another shop's policy.");
    assert.equal(pf.policyFollowOf({ policyFollow: { [loc]: "trophy" } }, loc), null);
  }
});

test("a product carried at Trophy and not at Pine raises nothing for Pine, and is never seated there", () => {
  const config = cfg({ policyFollow: LINK });
  assert.ok(atTrophy(config, "trophyOnly", "").target > 0);
  assert.equal(ask(config, PINE, "trophyOnly", ""), null);
  const p = plan({ config });
  assert.equal(p.intents.some((i) => i.dest === PINE && i.productId === "trophyOnly"), false);
  // Every Pine request is for a product seated at Pine — no flood.
  const seated = new Set(NONFOOT);
  assert.deepEqual(p.intents.filter((i) => i.dest === PINE && !seated.has(i.productId)), []);
  // A product MOVED OUT of Pine (cells left behind, seat gone) is not carried either.
  const st = stock();
  const seats = seatsOf(st);
  delete seats[PINE].sun;
  assert.equal(plan({ config, st, seats }).intents.some((i) => i.dest === PINE && i.productId === "sun"), false);
});

test("the requests Pine raises carry Trophy's numbers", () => {
  const p = plan({ config: cfg({ policyFollow: LINK }) });
  const pine = linesOf(p, PINE);
  assert.ok(pine.includes("sun:_:5<-central"));
  assert.ok(pine.includes("bag:_:2<-central"));              // 2, not the division's 5
  assert.ok(pine.includes("tee:XL:1<-central"));             // 1, not 2
  assert.ok(pine.includes("tee2:S:4<-central"));             // Trophy's product row
  assert.ok(pine.includes("perf:_:8<-central"));             // no Trophy policy: Marathon PE's
  const off = linesOf(plan({ config: cfg() }), PINE);
  assert.ok(off.includes("bag:_:5<-central") && off.includes("tee:XL:2<-central"));
});

test("Pine's sources do not change: non-footwear from Central, sneakers from Hub 3, never Hub 1 or Hub 2", () => {
  for (const config of [cfg(), cfg({ policyFollow: LINK })]) {
    // A Pine sneaker keep (a product row at Pine; the shelf is counted).
    const t = targets();
    t[PINE] = { shoe: { 8: { target: 1, minQty: 1 } } };
    const st = stock();
    st[PINE].shoe = { 8: c(0) };
    const p = plan({ config, t, st });
    const pine = p.intents.filter((i) => i.dest === PINE);
    assert.ok(pine.length > 5);
    for (const i of pine) {
      assert.equal(i.source, products[i.productId].category === "Footwear" ? "hub3" : "central", `${i.productId} ${i.sizeKey}`);
      assert.notEqual(i.source, "hub1");
      assert.notEqual(i.source, "hub2");
    }
    assert.deepEqual(linesOf(p, PINE).filter((l) => l.startsWith("shoe:")), ["shoe:8:1<-hub3"]);
    // The routing question itself, product by product.
    const routing = networkRouting(config, reg.SEED_REGISTRY, dv.divisionContext({ config, seats: {} }));
    for (const pid of NONFOOT) assert.equal(routing.sourceFor(PINE, products[pid], pid), "central", pid);
    assert.equal(routing.sourceFor(PINE, products.shoe, "shoe"), "hub3");
    assert.deepEqual(routing.sourcesOf(PINE).sort(), ["central", "hub3"]);
  }
});

test("footwear is left out of the link: a Trophy sneaker row gives Pine nothing", () => {
  const config = cfg({ policyFollow: LINK });
  const t = targets();
  t.trophy.shoe = { 8: { target: 3, minQty: 1 } };
  const st = stock();
  st[PINE].shoe = { 8: c(0) };
  assert.equal(ask(config, PINE, "shoe", "8", { t, st }), null);
});

test("Trophy, Marathon PE, Concrete and every hub are identical before and after", () => {
  const slice = (p, loc) => JSON.stringify(["intents", "closes", "resizes", "satisfiedClosures"].map((k) => (p[k] || []).filter((x) => x.dest === loc).map((x) => JSON.stringify(x)).sort()));
  const before = plan({ config: cfg() });
  const after = plan({ config: cfg({ policyFollow: LINK }) });
  for (const loc of ["trophy", "marathon-pe", "concrete", "hub1", "hub2", "hub3"]) {
    assert.equal(slice(after, loc), slice(before, loc), loc);
  }
  assert.ok(before.intents.some((i) => i.dest === "trophy") && before.intents.some((i) => i.dest === "concrete"));
  assert.notEqual(slice(after, PINE), slice(before, PINE));
  // What each of them resolves, cell by cell — Pine is the only one that moved.
  for (const loc of ["trophy", "marathon-pe", "concrete", "hub1", "hub2", "hub3"]) {
    for (const pid of Object.keys(products)) for (const size of sizesOf(pid)) {
      assert.deepEqual(ask(cfg({ policyFollow: LINK }), loc, pid, size), ask(cfg(), loc, pid, size), `${loc} ${pid} ${size}`);
    }
  }
});

test("the division audit calls a followed cell correct, not a wrong number", () => {
  const p = plan({ config: cfg({ policyFollow: LINK }) });
  const audit = p.exceptions.divisionPolicy;
  assert.equal(audit.perLoc[PINE].products, NONFOOT.length);
  assert.equal(audit.perLoc[PINE].mismatched, 0);
  assert.deepEqual(audit.items.filter((m) => m.loc === PINE), []);
  assert.equal(audit.byReason.wrong_number, undefined);
});

// ── THE CARD'S WRITE — history first, one-step revert ───────────────────────
const ADMIN = "gunidmoh@gmail.com";
const world = (engine = {}) => {
  __resetNetworkCacheForTests();
  return makeFakeDb({ config: { refillEngine: { ...cfg(), ...engine } }, settings: { productTaxonomy: { cats: {} } }, locations: { trophy: { name: "Trophy" }, [PINE]: { name: "Marathon Pine" } } });
};
const call = (db, data) => applyCategoryPolicy({ db, callerEmail: ADMIN, adminEmail: ADMIN, callerUid: "u1", data, nowMs: NOW });
const stored = (db) => db.state.root.config.refillEngine.policyFollow;

test("setPolicyFollow: switches the link on with a history entry, and the entry's `before` reverts it in one step", async () => {
  const db = world();
  const dry = await call(db, { action: "setPolicyFollow", location: PINE, follows: "trophy", dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(stored(db), undefined);
  const on = await call(db, { action: "setPolicyFollow", location: PINE, follows: "trophy", expectedBefore: null });
  assert.deepEqual(stored(db), LINK);
  const h = db.state.root.engine_policy_history[on.historyId];
  assert.equal(h.kind, "policyFollow");
  assert.equal(h.location, PINE);
  assert.equal(h.before ?? null, null);
  assert.equal(h.after, "trophy");
  assert.equal(h.status, "applied");
  assert.equal((await call(db, { action: "setPolicyFollow", location: PINE, follows: "trophy" })).noChange, true);
  // The card's Revert: the entry's `before`, expecting what it became.
  const off = await call(db, { action: "setPolicyFollow", location: PINE, follows: h.before ?? null, expectedBefore: h.after });
  assert.equal(off.after, null);
  // Real RTDB deletes a key written null, and the map with it when it empties.
  assert.equal(stored(db) === undefined || stored(db)[PINE] === undefined, true);
  assert.equal(pf.policyFollowOf(db.state.root.config.refillEngine, PINE), null);
});

test("setPolicyFollow: any other pair, a stale screen and a missing field are refused; nothing is written", async () => {
  const db = world();
  await assert.rejects(call(db, { action: "setPolicyFollow", location: "hub3", follows: "trophy" }), /Only Marathon Pine and Concrete/);
  await assert.rejects(call(db, { action: "setPolicyFollow", location: "concrete", follows: "marathon-pe" }), /Trophy only/);
  await assert.rejects(call(db, { action: "setPolicyFollow", location: PINE, follows: "marathon-pe" }), /Trophy only/);
  await assert.rejects(call(db, { action: "setPolicyFollow", location: "trophy", follows: PINE }), /Only Marathon Pine/);
  await assert.rejects(call(db, { action: "setPolicyFollow", location: PINE }), /follows is required/);
  await assert.rejects(call(db, { action: "setPolicyFollow", location: PINE, follows: "trophy", expectedBefore: "trophy" }), /changed while it was open/);
  assert.equal(stored(db), undefined);
  assert.equal(db.state.root.engine_policy_history, undefined);
});

test("setPolicyFollow: a save that lands between the drift read and the write is never overwritten", async () => {
  const { makeFakeDb: mk } = require("./helpers/fake-rtdb.cjs");
  __resetNetworkCacheForTests();
  let armed = false;
  const db = mk({ config: { refillEngine: { ...cfg() } }, settings: { productTaxonomy: { cats: {} } }, locations: { trophy: { name: "Trophy" }, [PINE]: { name: "Marathon Pine" } } }, {
    // Another save switches the link on the instant before this one writes.
    beforeRead: async (path, state) => {
      if (armed && path === `config/refillEngine/policyFollow/${PINE}`) {
        armed = false;
        state.root.config.refillEngine.policyFollow = { [PINE]: "trophy" };
      }
    },
  });
  const realRef = db.ref.bind(db);
  db.ref = (path) => { const r = realRef(path); if (path === `config/refillEngine/policyFollow/${PINE}`) { const t = r.transaction.bind(r); r.transaction = (fn) => { armed = true; return t(fn); }; } return r; };
  // This screen believes the link is OFF and switches it on; the other save
  // got there first. The write must notice, and the history must not say applied.
  await assert.rejects(call(db, { action: "setPolicyFollow", location: PINE, follows: "trophy", expectedBefore: null }), /changed while it was being saved/);
  const hist = Object.values(db.state.root.engine_policy_history || {});
  assert.equal(hist.length, 1);
  assert.equal(hist[0].status, "aborted_on_drift");
});

test("setPolicyFollow: an ignored leftover link is reported off but can be replaced with the stored value as expectedBefore", async () => {
  const db = world({ policyFollow: { [PINE]: "marathon-pe" } });
  const census = await call(db, { action: "census", refresh: true });
  assert.deepEqual(census.policyFollow, {});
  assert.equal(census.policyFollowStored[PINE], "marathon-pe");
  await assert.rejects(call(db, { action: "setPolicyFollow", location: PINE, follows: "trophy", expectedBefore: null }), /changed while it was open/);
  const on = await call(db, { action: "setPolicyFollow", location: PINE, follows: "trophy", expectedBefore: census.policyFollowStored[PINE] });
  assert.equal(on.ok, true);
  assert.equal(stored(db)[PINE], "trophy");
});

test("the census's division keep count for Pine is the linked (resolved) number; every other location's is unchanged", async () => {
  const census = async (engine) => {
    __resetNetworkCacheForTests();
    const db = makeFakeDb({ config: { refillEngine: { ...cfg(), ...engine } }, products, stock: stock(), stock_targets: targets(), refill_engine: { seats: seatsOf(stock()) },
      settings: { productTaxonomy: { cats: {} } }, locations: { trophy: { name: "Trophy" }, [PINE]: { name: "Marathon Pine" } } });
    return (await call(db, { action: "census", refresh: true })).divisionKeeps;
  };
  const off = await census({});
  const on = await census({ policyFollow: LINK });
  assert.ok(off && on, "the census reports division keeps");
  assert.ok(off[PINE].units > 0, "Pine has a division keep to compare against");
  assert.notDeepEqual(on[PINE], off[PINE]);
  for (const loc of Object.keys(off)) if (loc !== PINE) assert.deepEqual(on[loc], off[loc], loc);
});

test("the census says which links are on and which are possible", async () => {
  const db = world({ policyFollow: LINK });
  const r = await call(db, { action: "census", refresh: true });
  assert.deepEqual(r.policyFollow, LINK);
  assert.deepEqual(Object.keys(r.policyFollowAllowed), [PINE, "concrete"]);
  assert.deepEqual((await call(world(), { action: "census", refresh: true })).policyFollow, {});
});

// ── CONCRETE FOLLOWS TROPHY (Junid, 24 Nov 2026: policies are universal) ─────
const BOTH = { [PINE]: "trophy", concrete: "trophy" };

test("Concrete resolves Trophy's numbers for what it carries; Marathon PE's where Trophy has none", () => {
  const config = cfg({ policyFollow: BOTH });
  for (const [pid, size] of [["sun", ""], ["bag", ""], ["tee", "S"], ["tee", "XL"]]) {
    assert.deepEqual(three(ask(config, "concrete", pid, size)), three(atTrophy(config, pid, size)), `${pid} ${size}`);
    assert.equal(ask(config, "concrete", pid, size).follows, "trophy");
  }
  // Without the link: the division's own 2 per size / 5 per design.
  assert.deepEqual(three(ask(cfg({ policyFollow: LINK }), "concrete", "sun", "")), [5, 4, null]);
  assert.deepEqual(three(ask(cfg({ policyFollow: LINK }), "concrete", "bag", "")), [5, 4, null]);
});

test("Concrete never keeps perfume, link or no link", () => {
  const st = stock();
  st.concrete.perf = full("perf", 0, shelf);
  const config = cfg({ policyFollow: BOTH });
  assert.equal(ask(config, "concrete", "perf", "", { st }), null);
  const p = plan({ config, st });
  assert.equal(p.intents.some((i) => i.dest === "concrete" && i.productId === "perf"), false);
});

test("a category only Marathon PE has a policy for is PE's at the follower, not Trophy's size run", () => {
  // Underwear: PE has a size-by-size map; Trophy has only its garment run.
  const config = cfg({ policyFollow: BOTH, categoryPolicy: { ...cfg().categoryPolicy,
    underwear: { perSize: true, "marathon-pe": { sizes: { XL: { target: 3, minQty: 1, reorderPoint: 1 } } } } } });
  const prods = { ...products, pants: { id: "pants", name: "Boxer", category: "Clothing", categoryKey: "underwear", productType: "clothing", sizes: ["S", "XL"] } };
  const st = stock();
  st.central.pants = { S: c(40), XL: c(40) };
  st.concrete.pants = { S: shelf(0), XL: shelf(0) };
  const { stock: view } = maskUntrustedStock(st, reg.SEED_REGISTRY);
  const at = (loc, size) => resolveTarget({ targets: targets(), config, products: prods, stock: view, network: reg.SEED_REGISTRY, division: dv.divisionContext({ config, seats: seatsOf(st) }) }, loc, "pants", size);
  assert.deepEqual(three(at("concrete", "XL")), [3, 1, 1]);
  assert.equal(at("concrete", "XL").follows, "marathon-pe");
  // A size PE's map does not name falls through to PE's run, never skipping to Trophy first.
  assert.equal(at("concrete", "S").follows, "marathon-pe");
});

test("with Concrete linked, Trophy, Marathon PE and every hub resolve exactly as before", () => {
  for (const loc of ["trophy", "marathon-pe", "hub1", "hub2", "hub3"]) {
    for (const pid of Object.keys(products)) for (const size of sizesOf(pid)) {
      assert.deepEqual(ask(cfg({ policyFollow: BOTH }), loc, pid, size), ask(cfg({ policyFollow: LINK }), loc, pid, size), `${loc} ${pid} ${size}`);
    }
  }
});

test("a product carried at Trophy and not at Concrete raises nothing for Concrete", () => {
  const config = cfg({ policyFollow: BOTH });
  assert.equal(ask(config, "concrete", "trophyOnly", ""), null);
  const p = plan({ config });
  const seated = new Set(Object.keys(stock().concrete));
  assert.deepEqual(p.intents.filter((i) => i.dest === "concrete" && !seated.has(i.productId)), []);
});

test("setPolicyFollow: Concrete follows Trophy with a history entry; Revert sends it back", async () => {
  const db = world();
  const r = await call(db, { action: "setPolicyFollow", location: "concrete", follows: "trophy", expectedBefore: null });
  assert.equal(r.after, "trophy");
  assert.equal(stored(db).concrete, "trophy");
  const h = db.state.root.engine_policy_history[r.historyId];
  assert.equal(h.kind, "policyFollow");
  assert.equal(h.before ?? null, null);
  await call(db, { action: "setPolicyFollow", location: "concrete", follows: h.before ?? null, expectedBefore: "trophy" });
  assert.equal(stored(db)?.concrete ?? null, null);
});
