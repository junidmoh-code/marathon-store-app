// setProductName: same permission rule as Type, refuses a twin name (on the
// page — see sameName), keeps the style code, keeps refill requests attached
// WITHOUT writing them, closes a pending AI proposal, and logs every rename.
// Against the in-memory database (null-first, deletes empty containers).
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planRename, twinsOf, sameName } = require("../lib/product-rename.cjs");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");
const { _handleSetProductName } = require("../productType/setProductName.js");

const NOW = Date.parse("2026-11-27T15:00:00Z");
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "received" });
const AM96 = {
  id: "p1", name: "Nike Air Max 96 DT blue Whitet", styleCode: "724274-002", styleCodeNormalised: "724274002",
  productType: "sneaker", sizes: ["7", "8"], brand: "Nike",
};

test("plan: trims, refuses blank, no-op when unchanged", () => {
  assert.equal(planRename(AM96, "  Nike Air Max 96 DT Blue White  ", { from: AM96.name }).to, "Nike Air Max 96 DT Blue White");
  assert.equal(planRename(AM96, "   ", {}).code, "invalid-argument");
  assert.equal(planRename(AM96, AM96.name, {}).noop, true);
  assert.equal(planRename(null, "x", {}).code, "not-found");
});

test("plan: stock or sales makes a rename manager-only; a brand-new product is not", () => {
  assert.equal(planRename(AM96, "New", { cellsByLoc: { central: { 7: cell(0) } } }).code, "permission-denied");
  assert.equal(planRename(AM96, "New", { cellsByLoc: { central: { 7: cell(3) } }, isManager: true }).ok, true);
  assert.equal(planRename(AM96, "New", { cellsByLoc: {} }).ok, true);
});

test("plan: a rename that raced another is refused, not overwritten", () => {
  assert.equal(planRename(AM96, "New", { from: "Something older" }).code, "aborted");
});

test("plan: only brand/category ride along — never styleCode", () => {
  const p = planRename(AM96, "New", { extras: { brand: "Nike", styleCode: "X", styleCodeNormalised: "X", categoryKey: "caps-beanies" } });
  assert.deepEqual(p.extras, { brand: "Nike", categoryKey: "caps-beanies" });
});

test("twins: same name ignoring case, outer and doubled spaces; never the product itself", () => {
  const products = { p1: AM96, p2: { name: "Gucci slide brown " }, p3: { name: "gucci  SLIDE brown" } };
  assert.deepEqual(twinsOf(products, "p2", "Gucci slide brown").map((t) => t.id), ["p3"]);
  assert.deepEqual(twinsOf(products, "p1", AM96.name), []);
  assert.equal(sameName("", ""), false);
});

// ── the callable ─────────────────────────────────────────────────────────────
function world({ stock = {}, extra = {} } = {}) {
  return makeFakeDb({
    locations: { hub1: { id: "hub1" }, central: { id: "central" } },
    products: { p1: AM96, p2: { id: "p2", name: "Other" } },
    users: { mike: { displayName: "Mike", username: "mike" } },
    stock,
    ...extra,
  });
}
const deps = (db, manager = null) => ({ db, now: () => NOW, newId: () => "abcdef123456", managerIdentity: async () => manager });
const req = (data, uid = "mike") =>
  ({ auth: { uid, token: { email: "mike@marathon.internal", firebase: { sign_in_provider: "password" } } }, data: { productId: "p1", ...data } });

test("callable: a rename with open refill requests keeps them attached and never writes them", async () => {
  const requests = {
    r1: { productId: "p1", productName: AM96.name, size: "7", status: "open", requestingLocation: "marathon-pe" },
    r2: { productId: "p1", productName: AM96.name, size: "8", status: "fulfilled", resolvedAt: "2026-11-20" },
    r3: { productId: "p2", productName: "Other", size: "7", status: "open" },
  };
  const writes = [];
  const db = makeFakeDb({
    locations: { central: { id: "central" } }, products: { p1: AM96 }, users: { mike: { username: "mike" } },
    stock: { central: { p1: { 7: cell(4) } } }, refill_requests: requests,
  }, { afterWrite: async (path) => { writes.push(path); } });
  const out = await _handleSetProductName(req({ name: " Nike Air Max 96 DT Blue White ", from: AM96.name, deviceId: "38c0b89c-f1cb-4a09" }),
    deps(db, { owner: true, by: "Junid" }));
  assert.equal(out.name, "Nike Air Max 96 DT Blue White");
  assert.equal(out.openRefillRequests, 1);
  assert.equal(readAt(db.state.root, "products/p1/name"), "Nike Air Max 96 DT Blue White");
  // Attached by productId, untouched byte for byte (any write would wake firstBatchLeg).
  assert.deepEqual(readAt(db.state.root, "refill_requests"), requests);
  assert.equal(writes.some((p) => p.startsWith("refill_requests")), false);
  // The style code is immutable and untouched.
  assert.equal(readAt(db.state.root, "products/p1/styleCode"), "724274-002");
  assert.equal(readAt(db.state.root, "products/p1/styleCodeNormalised"), "724274002");
  // Old name kept for history joins.
  assert.deepEqual(readAt(db.state.root, "products/p1/previousNames"), [AM96.name]);
  assert.equal(readAt(db.state.root, "products/p1/nameChangedAt"), NOW);
});

test("callable: every rename is logged — old name, new name, who, when — at product_name_log", async () => {
  const db = world();
  await _handleSetProductName(req({ name: "Renamed", from: AM96.name, deviceId: "aa85821b-5a2d-4a0b" }), deps(db));
  const log = Object.values(readAt(db.state.root, "product_name_log/p1"));
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], {
    from: AM96.name, to: "Renamed", atMs: NOW, personName: "Mike", deviceId: "aa85821b-5a2d-4a0b",
    deviceVerified: false, uid: "mike", manager: false, openRefillRequests: 0,
  });
  assert.equal(readAt(db.state.root, "products/p1/nameLog"), null, "never on the client-writable product");
});

test("callable: a non-manager cannot rename a product with stock; nothing changes", async () => {
  const db = world({ stock: { central: { p1: { 7: cell(2) } } } });
  await assert.rejects(_handleSetProductName(req({ name: "Renamed", from: AM96.name }), deps(db)), /only Junid, Jafer or MC/);
  assert.equal(readAt(db.state.root, "products/p1/name"), AM96.name);
  assert.equal(readAt(db.state.root, "product_name_log"), null);
});

test("callable: a pending AI name proposal is closed so approving it later cannot undo the rename", async () => {
  const db = world({ extra: { aiAssistant: { nameProposals: { p1: { current: AM96.name, suggested: "AI name", status: "pending" } } } } });
  await _handleSetProductName(req({ name: "Renamed", from: AM96.name }), deps(db, { owner: true, by: "Junid" }));
  assert.equal(readAt(db.state.root, "aiAssistant/nameProposals/p1/status"), "rejected");
  assert.equal(readAt(db.state.root, "aiAssistant/nameProposals/p1/rejectReason"), "renamed by hand");
});

test("callable: unauthenticated, bad ids and blank names are refused; a no-op writes nothing", async () => {
  const db = world();
  await assert.rejects(_handleSetProductName({ auth: null, data: { productId: "p1", name: "x" } }, deps(db)), /Sign in first/);
  await assert.rejects(_handleSetProductName(req({ productId: "../x", name: "x" }), deps(db)), /Which product/);
  await assert.rejects(_handleSetProductName(req({ name: "   " }), deps(db)), /1–200 characters/);
  const same = await _handleSetProductName(req({ name: AM96.name }), deps(db));
  assert.equal(same.noop, true);
  assert.equal(readAt(db.state.root, "product_name_log"), null);
});

test("callable: a second rename keeps every earlier name, newest last", async () => {
  const db = world();
  await _handleSetProductName(req({ name: "Second", from: AM96.name }), deps(db));
  await _handleSetProductName(req({ name: "Third", from: "Second" }), deps(db));
  assert.deepEqual(readAt(db.state.root, "products/p1/previousNames"), [AM96.name, "Second"]);
});

test("plan: the extras allow-list is exactly what brandOnRename/headwearRenamePatch return", () => {
  const p = planRename(AM96, "New Era Beanie", { extras: {
    brand: "New Era", brandFlag: false, brandSource: "list", category: "Headwear", categoryKey: "caps-beanies", subcategory: "Beanies",
    name: "sneaky", productType: "clothing",
  } });
  assert.deepEqual(Object.keys(p.extras).sort(), ["brand", "brandFlag", "brandSource", "category", "categoryKey", "subcategory"]);
});
