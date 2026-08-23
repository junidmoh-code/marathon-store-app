// ─── productIdentity — WHO may read the identity map ─────────────────────────
// The callable hands back the fold of two Admin-SDK-only nodes. It must be
// gated like every other style-code callable (assertStyleCodeAccess): a
// signed-in account with no /users record and no style-code permission gets
// permission-denied, not the catalogue's every code and alias.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const admin = require("firebase-admin");

// A tiny RTDB fake: ref(path).get() → { val() }.
function fakeDb(data) {
  const at = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n && typeof n === "object" ? n[k] : undefined), data);
  return { ref: (path) => ({ get: async () => ({ val: () => { const v = at(path); return v === undefined ? null : v; } }) }) };
}

const DATA = {
  users: {
    uStaff: { permissions: ["stock_management"] },
    uNobody: { permissions: [] },
  },
  label_aliases: { a1: { productId: "p1", c: { ABC123: true }, t: {} } },
  style_code_index: { XYZ789: { productId: "p2" } },
};

// Patch admin.database BEFORE the module is loaded; the handler calls it per request.
// `admin.database` is a getter on the namespace, so it is shadowed with an own
// property rather than assigned.
Object.defineProperty(admin, "database", { value: () => fakeDb(DATA), configurable: true });
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://example.firebaseio.com" });
const { productIdentity } = require("../productIdentity/productIdentity.js");
test.after(() => { delete admin.database; });

const req = (uid, provider = "password") => ({
  auth: uid ? { uid, token: { firebase: { sign_in_provider: provider } } } : null,
  data: {},
  rawRequest: {},
});

test("no auth → unauthenticated", async () => {
  await assert.rejects(() => productIdentity.run(req(null)), (e) => e.code === "unauthenticated");
});

test("anonymous → unauthenticated", async () => {
  await assert.rejects(() => productIdentity.run(req("uAnon", "anonymous")), (e) => e.code === "unauthenticated");
});

test("a signed-in account with NO /users record gets nothing", async () => {
  await assert.rejects(() => productIdentity.run(req("uGhost")), (e) => e.code === "permission-denied");
});

test("a /users record WITHOUT a style-code permission gets nothing", async () => {
  await assert.rejects(() => productIdentity.run(req("uNobody")), (e) => e.code === "permission-denied");
});

test("a staff member with a style-code permission gets the folded map", async () => {
  const res = await productIdentity.run(req("uStaff"));
  assert.deepEqual(res.map.p1.c, ["ABC123"]);
  assert.deepEqual(res.map.p2.c, ["XYZ789"]);
});
