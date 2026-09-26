// setProductType: manager-only once a product has stock or sales, never strands
// Hub 1 stock, going back to Sneaker restores the hubs it had, and every change
// is logged on the product. Against the in-memory database (null-first, deletes
// empty containers).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planTypeChange } = require("../lib/product-type.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");
const { _handleSetProductType } = require("../productType/setProductType.js");

const NOW = Date.parse("2026-09-26T09:00:00Z");
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const AF1 = { id: "p1", name: "Nike Air Force 1 White", productType: "sneaker", category: "Footwear", hubs: ["hub1"], hub: "hub1", sizes: ["6", "7"], hasShoeBoxOption: true };

test("plan: a product with stock is manager-only; a brand-new one is not", () => {
  const withStock = planTypeChange(AF1, "clothing", { cellsByLoc: { central: { 6: cell(16) } }, isManager: false });
  assert.equal(withStock.ok, false);
  assert.equal(withStock.code, "permission-denied");
  assert.match(withStock.message, /only Junid or MC/);
  const fresh = planTypeChange(AF1, "clothing", { cellsByLoc: {}, isManager: false });
  assert.equal(fresh.ok, true);
  const zeroCell = planTypeChange(AF1, "clothing", { cellsByLoc: { hub2: { 6: cell(0) } }, isManager: false });
  assert.equal(zeroCell.code, "permission-denied", "a qty-0 cell is still history (it was sold down or seated)");
});

test("plan: Clothing is refused while Hub 1 holds units — even for a manager", () => {
  const p = planTypeChange(AF1, "clothing", { cellsByLoc: { hub1: { 6: cell(2), 7: cell(1) } }, isManager: true });
  assert.equal(p.code, "failed-precondition");
  assert.match(p.message, /Hub 1 holds 3 units/);
  const empty = planTypeChange(AF1, "clothing", { cellsByLoc: { hub1: { 6: cell(0) } }, isManager: true });
  assert.deepEqual(empty.patch, { productType: "clothing", hasShoeBoxOption: false, hubs: ["hub2"], hub: "hub2" });
});

test("plan: back to Sneaker restores the hubs it had before the last switch to Clothing", () => {
  const clothed = { ...AF1, productType: "clothing", hubs: ["hub2"], hub: "hub2" };
  const typeLog = { a: { to: "clothing", atMs: 1, hubsBefore: ["hub1", "hub3"] }, b: { to: "sneaker", atMs: 2 } };
  const p = planTypeChange(clothed, "sneaker", { cellsByLoc: {}, isManager: true, typeLog });
  assert.deepEqual(p.patch, { productType: "sneaker", hubs: ["hub1", "hub2", "hub3"], hub: "hub1" });
  const noLog = planTypeChange(clothed, "sneaker", { cellsByLoc: { hub1: { 6: cell(0) } }, isManager: true });
  assert.deepEqual(noLog.after.hubs, ["hub1", "hub2"], "Hub 1 cells bring Hub 1 back");
});

test("plan: same type is a no-op; nonsense is refused", () => {
  assert.equal(planTypeChange(AF1, "sneaker", {}).noop, true);
  assert.equal(planTypeChange(AF1, "boots", {}).code, "invalid-argument");
  assert.equal(planTypeChange(null, "sneaker", {}).code, "not-found");
});

// ── the callable ─────────────────────────────────────────────────────────────
function world(stock = {}) {
  return makeFakeDb({
    locations: { hub1: { id: "hub1" }, hub2: { id: "hub2" }, central: { id: "central" } },
    products: { p1: AF1 },
    users: { mike: { displayName: "Mike", username: "mike" } },
    stock,
  });
}
const deps = (db, manager = null) => ({ db, now: () => NOW, newId: () => "abcdef123456", managerIdentity: async () => manager });
const req = (data, token = { email: "mike@marathon.internal", firebase: { sign_in_provider: "password" } }, uid = "mike") =>
  ({ auth: { uid, token }, data: { productId: "p1", ...data } });

test("callable: Mike (not a manager) cannot retype a product with stock; the product is untouched", async () => {
  const db = world({ central: { p1: { 6: cell(16) } } });
  await assert.rejects(_handleSetProductType(req({ productType: "clothing", deviceId: "aa85821b-5a2d-4a0b" }), deps(db)), /only Junid or MC/);
  assert.equal(readAt(db.state.root, "products/p1/productType"), "sneaker");
  assert.equal(readAt(db.state.root, "product_type_log/p1"), null);
});

test("callable: a manager's change is applied and logged with person, device and server time", async () => {
  const db = world({ central: { p1: { 6: cell(16) } } });
  const out = await _handleSetProductType(req({ productType: "clothing" }), deps(db, { owner: false, by: "MC", deviceId: "38c0b89c-f1cb-4a09" }));
  assert.equal(out.productType, "clothing");
  assert.equal(readAt(db.state.root, "products/p1/productType"), "clothing");
  assert.deepEqual(readAt(db.state.root, "products/p1/hubs"), ["hub2"]);
  assert.equal(readAt(db.state.root, "products/p1/typeChangedAt"), NOW);
  const log = Object.values(readAt(db.state.root, "product_type_log/p1"));
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], {
    from: "sneaker", to: "clothing", atMs: NOW, personName: "MC", deviceId: "38c0b89c-f1cb-4a09", deviceVerified: true,
    uid: "mike", manager: true, hubsBefore: ["hub1"], hubsAfter: ["hub2"], sizesBefore: ["6", "7"],
  });
});

test("callable: a brand-new product may be retyped by anyone who can edit — and it is still logged", async () => {
  const db = world({});
  await _handleSetProductType(req({ productType: "clothing", deviceId: "aa85821b-5a2d-4a0b" }), deps(db));
  const log = Object.values(readAt(db.state.root, "product_type_log/p1"));
  assert.equal(log[0].personName, "Mike");
  assert.equal(log[0].deviceId, "aa85821b-5a2d-4a0b");
  assert.equal(log[0].deviceVerified, false, "a device id the browser sent is recorded as unverified");
  assert.equal(log[0].manager, false);
});

test("callable: unauthenticated, anonymous and bad ids are refused; a no-op writes nothing", async () => {
  const db = world({});
  await assert.rejects(_handleSetProductType({ auth: null, data: { productId: "p1", productType: "clothing" } }, deps(db)), /Sign in first/);
  await assert.rejects(_handleSetProductType(req({ productType: "clothing" }, { firebase: { sign_in_provider: "anonymous" } }), deps(db)), /Sign in first/);
  await assert.rejects(_handleSetProductType(req({ productId: "../x", productType: "clothing" }), deps(db)), /Which product/);
  const same = await _handleSetProductType(req({ productType: "sneaker" }), deps(db));
  assert.equal(same.noop, true);
  assert.equal(readAt(db.state.root, "product_type_log/p1"), null);
});

test("callable: the log lives at product_type_log (no client rule), never on the client-writable product", async () => {
  const db = world({});
  await _handleSetProductType(req({ productType: "clothing" }), deps(db, { owner: true, by: "Junid" }));
  assert.equal(readAt(db.state.root, "products/p1/typeLog"), null);
  assert.equal(Object.keys(readAt(db.state.root, "product_type_log/p1")).length, 1);
});

test("callable: someone else's Type change a moment earlier makes this one refuse, not overwrite", async () => {
  const db = makeFakeDb({
    locations: { hub1: { id: "hub1" } }, products: { p1: AF1 }, stock: {},
  }, { beforeRead: async (path, state) => {
    if (path === "products/p1/productType" && state.root.products.p1.productType === "sneaker") state.root.products.p1.productType = "clothing";
  } });
  await assert.rejects(_handleSetProductType(req({ productType: "clothing" }), deps(db, { owner: true, by: "Junid" })), /Someone else changed/);
  assert.equal(readAt(db.state.root, "product_type_log"), null);
});

test("callable: Hub 1 units that land while it decides are not stranded — the switch is undone", async () => {
  let landed = false;
  const db = makeFakeDb({ locations: { hub1: { id: "hub1" } }, products: { p1: AF1 }, stock: {} }, { beforeRead: async (path, state) => {
    if (path === "stock/hub1/p1" && !landed) {
      // first read (the planner's) sees nothing; the post-write check sees the receive
      landed = true; return;
    }
    if (path === "stock/hub1/p1" && landed) state.root.stock = { hub1: { p1: { 6: cell(2) } } };
  } });
  await assert.rejects(_handleSetProductType(req({ productType: "clothing" }), deps(db, { owner: true, by: "Junid" })), /arrived at Hub 1 just now/);
  assert.equal(readAt(db.state.root, "products/p1/productType"), "sneaker", "rolled back");
  assert.equal(readAt(db.state.root, "product_type_log"), null);
});
