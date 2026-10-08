// ─── THE LOCATION LISTS THAT USED TO BE LITERALS ─────────────────────────────
// Stock audit, refusal write-off, display rows and display checks each named
// their locations in code, and each left Pine / Hub 3 out by a recorded owner
// decision. They now read the network registry's `live` flag, which only the
// owner flips: TODAY'S MEMBERSHIP IS EXACTLY WHAT THE LITERALS HELD, and a
// Section 1 location joins by the same rule the day it is marked live.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const reg = require("../lib/network-registry.cjs");
const audit = require("../lib/stock-audit.cjs");
const writeoff = require("../lib/refusal-writeoff.cjs");
const rows = require("../displayRows/lib.cjs");
const checks = require("../displayChecks/lib.cjs");

const S1 = ["hub3", "marathon-pine", "concrete"];
const SEED = reg.SEED_REGISTRY;
const live = (...ids) => reg.normalizeNetwork({ locations: Object.fromEntries(ids.map((id) => [id, { live: true }])) });
const allLive = live(...S1);
const NO_REGISTRY = [undefined, null];

// ── today's membership, exactly ─────────────────────────────────────────────

test("TODAY: every list holds exactly what its literal held — with no registry, and on the seed", () => {
  assert.deepEqual(audit.AUDIT_STORES, ["marathon-pe", "trophy"]);
  assert.deepEqual(audit.AUDIT_HUBS, ["hub1", "hub2"]);
  assert.deepEqual([...writeoff.WRITEOFF_LOCATIONS], ["hub1", "hub2", "central"]);
  assert.deepEqual(rows.DISPLAY_STORES, ["marathon-pe", "trophy"]);
  assert.deepEqual(rows.DISPLAY_HUBS, ["hub1", "hub2"]);
  for (const network of [...NO_REGISTRY, SEED]) {
    assert.deepEqual(audit.auditStores(network), ["marathon-pe", "trophy"]);
    assert.deepEqual(audit.auditHubs(network), ["hub1", "hub2"]);
    assert.deepEqual(writeoff.writeoffLocations(network), ["hub1", "hub2", "central"]);
    assert.deepEqual(rows.displayStores(network), ["marathon-pe", "trophy"]);
    assert.deepEqual(rows.displayHubs(network), ["hub1", "hub2"]);
    assert.deepEqual(rows.displayStoresForHub(network, "hub1"), ["marathon-pe", "trophy"]);
    assert.deepEqual(rows.displayStoresForHub(network, "hub2"), ["marathon-pe", "trophy"]);
    assert.deepEqual(checks.triggerStores(network), ["marathon-pe", "trophy"]);
    assert.equal(checks.isTriggerStoreEnabled("marathon-pe", network), true);
    assert.equal(checks.isTriggerStoreEnabled("trophy", network), true);
    for (const off of ["marathon-pine", "concrete", "hub1", "hub2", "hub3", "central", "", undefined, null, "toString", "__proto__"]) {
      assert.equal(checks.isTriggerStoreEnabled(off, network), false, String(off));
    }
    // Pine's refusals never count — and Concrete, the other store not live
    assert.ok(writeoff.excludedRequesters(network).includes("marathon-pine"));
    for (const counted of ["marathon-pe", "trophy", "hub1", "hub2", "hub3"]) {
      assert.ok(!writeoff.excludedRequesters(network).includes(counted), `${counted}'s refusals count, as they always have`);
    }
  }
  assert.equal(checks.TRIGGER_STORE_FLAGS["marathon-pe"], true);
  assert.equal(checks.TRIGGER_STORE_FLAGS.trophy, true);
  assert.equal(checks.TRIGGER_STORE_FLAGS["marathon-pine"], false);
});

// ── going live ──────────────────────────────────────────────────────────────

test("LIVE: each list takes a Section 1 location in by the rule Section 2 is in by", () => {
  assert.deepEqual(audit.auditStores(allLive), ["marathon-pine", "concrete", "marathon-pe", "trophy"]);
  assert.deepEqual(audit.auditHubs(allLive), ["hub3", "hub1", "hub2"]);
  assert.deepEqual(writeoff.writeoffLocations(allLive), ["hub3", "hub1", "hub2", "central"]);
  assert.deepEqual(writeoff.excludedRequesters(allLive), []);
  assert.deepEqual(rows.displayStores(allLive), ["marathon-pine", "concrete", "marathon-pe", "trophy"]);
  assert.deepEqual(rows.displayHubs(allLive), ["hub3", "hub1", "hub2"]);
  assert.deepEqual(checks.triggerStores(allLive), ["marathon-pine", "concrete", "marathon-pe", "trophy"]);
  assert.equal(checks.isTriggerStoreEnabled("marathon-pine", allLive), true);
  assert.equal(checks.isTriggerStoreEnabled("hub3", allLive), false, "a hub is never a trigger store");
});

test("LIVE: one location at a time — only the one marked live joins", () => {
  const pine = live("marathon-pine");
  assert.deepEqual(audit.auditStores(pine), ["marathon-pine", "marathon-pe", "trophy"]);
  assert.deepEqual(audit.auditHubs(pine), ["hub1", "hub2"]);
  assert.deepEqual(writeoff.excludedRequesters(pine), ["concrete"]);
  assert.deepEqual(writeoff.writeoffLocations(pine), ["hub1", "hub2", "central"]);
  assert.equal(checks.isTriggerStoreEnabled("concrete", pine), false);
});

test("NOT LIVE: a Section 2 location the owner switches off drops out of every list", () => {
  const off = reg.normalizeNetwork({ locations: { trophy: { live: false }, hub1: { live: false } } });
  assert.deepEqual(audit.auditStores(off), ["marathon-pe"]);
  assert.deepEqual(audit.auditHubs(off), ["hub2"]);
  assert.deepEqual(writeoff.writeoffLocations(off), ["hub2", "central"]);
  assert.deepEqual(rows.displayStores(off), ["marathon-pe"]);
  assert.deepEqual(rows.displayHubs(off), ["hub2"]);
  assert.deepEqual(checks.triggerStores(off), ["marathon-pe"]);
  assert.ok(writeoff.excludedRequesters(off).includes("trophy"));
});

// ── display rows: the section wall on a hub sale ────────────────────────────

test("DISPLAY ROWS: a hub sale is only ever attributed to a wall on the hub's own side", () => {
  assert.deepEqual(rows.displayStoresForHub(allLive, "hub2"), ["marathon-pe", "trophy"]);
  assert.deepEqual(rows.displayStoresForHub(allLive, "hub1"), ["marathon-pe", "trophy"]);
  assert.deepEqual(rows.displayStoresForHub(allLive, "hub3"), ["marathon-pine", "concrete"]);
  assert.deepEqual(rows.displayStoresForHub(allLive, "concrete-stockroom"), [], "the Concrete Stockroom does not exist (8 Oct 2026)");
  assert.deepEqual(rows.displayStoresForHub(live("hub3", "concrete"), "hub3"), ["concrete"], "Pine is not live");
  assert.deepEqual(rows.displayStoresForHub(allLive, "nowhere"), []);
});

test("DISPLAY ROWS: classifyMovement follows the registry, and is unchanged without one", () => {
  const sold = (from) => ({ type: "sold", from, productId: "p1", size: "9", qty: 1 });
  for (const network of [...NO_REGISTRY, SEED]) {
    assert.equal(rows.classifyMovement(sold("marathon-pe"), network).kind, "sold");
    assert.equal(rows.classifyMovement(sold("hub2"), network).kind, "sold_hub");
    for (const from of S1) assert.equal(rows.classifyMovement(sold(from), network), null, from);
  }
  assert.deepEqual(rows.classifyMovement(sold("marathon-pine"), allLive), { kind: "sold", store: "marathon-pine", productId: "p1", sizeKey: "9", qty: 1 });
  assert.deepEqual(rows.classifyMovement(sold("hub3"), allLive), { kind: "sold_hub", hub: "hub3", store: null, productId: "p1", sizeKey: "9", qty: 1 });
  assert.equal(rows.classifyMovement(sold("central"), allLive), null);
});

// ── refusal write-off through the planner ───────────────────────────────────

const PID = "p1";
function refusals(requestingLocation, source, n = 4) {
  const out = {};
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.parse("2026-09-20T09:00:00.000Z") + i * 864e5).toISOString();
    out[`r${requestingLocation}${i}`] = {
      productId: PID, size: "M", qty: 1, requestingLocation, status: "cancelled",
      createdAt: at, resolvedAt: at, createdFrom: { engine: true, source },
    };
  }
  return out;
}
const snapshotFor = (refillRequests, stock, network) => ({
  nowMs: Date.parse("2026-09-25T09:00:00.000Z"), config: { routes: { hub2: "central", "marathon-pe": "hub2", trophy: "hub2" } },
  stock, products: { [PID]: { name: "P", sizes: ["M"] } }, refillRequests, movements: [], cursors: {}, windowStartMs: 0,
  ...(network !== undefined ? { network } : {}),
});

test("WRITE-OFF: four refused days at Hub 2 still write the cell off; the same at Hub 3 does nothing until Hub 3 is live", () => {
  const stock = { hub2: { [PID]: { M: { qty: 3 } } }, hub3: { [PID]: { M: { qty: 3 } } } };
  const hub2 = writeoff.planRefusalWriteoffs(snapshotFor(refusals("marathon-pe", "hub2"), stock));
  assert.equal(hub2.writeoffs.length, 1);
  assert.equal(hub2.writeoffs[0].loc, "hub2");
  assert.deepEqual(writeoff.planRefusalWriteoffs(snapshotFor(refusals("marathon-pe", "hub2"), stock, SEED)), hub2, "the seed = no registry");

  // Hub 3 refusing Concrete four days running: not a write-off location while not live…
  const s1 = refusals("concrete", "hub3");
  assert.equal(writeoff.planRefusalWriteoffs(snapshotFor(s1, stock, SEED)).writeoffs.length, 0);
  // …nor once Hub 3 alone is live (Concrete is still a store that is not live — its refusals do not count)…
  assert.equal(writeoff.planRefusalWriteoffs(snapshotFor(s1, stock, live("hub3"))).writeoffs.length, 0);
  // …and with both live, by the rule Hub 2 and Marathon PE are under.
  const both = writeoff.planRefusalWriteoffs(snapshotFor(s1, stock, live("hub3", "concrete")));
  assert.equal(both.writeoffs.length, 1);
  assert.equal(both.writeoffs[0].loc, "hub3");
});

test("WRITE-OFF: Pine's refusals never count while Pine is not live — exactly as before", () => {
  const stock = { hub2: { [PID]: { M: { qty: 3 } } } };
  const fromPine = refusals("marathon-pine", "hub2");
  for (const network of [undefined, SEED]) {
    assert.equal(writeoff.planRefusalWriteoffs(snapshotFor(fromPine, stock, network)).writeoffs.length, 0);
  }
});
