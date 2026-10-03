// GENERATION ONLY ON JUNID'S TAP (3 Oct). Pins the switches in the source so
// an automatic path cannot come back unnoticed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../newArrivals/core.cjs");

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("the daily social autopilot is OFF unless explicitly switched on", () => {
  assert.match(src, /const SOCIAL_AUTOPILOT_ENABLED = process\.env\.SOCIAL_AUTOPILOT_ENABLED === "true";/);
  // The scheduled callback returns on the flag BEFORE any database or generation work.
  const i = src.indexOf("exports.socialDailyAutopilot = onSchedule(");
  assert.ok(i > 0);
  const body = src.slice(src.indexOf("async () => {", i));
  const guard = body.indexOf("if (!SOCIAL_AUTOPILOT_ENABLED) {");
  assert.ok(guard > 0 && guard < 40, "the flag is the callback's first statement");
  const ret = body.indexOf("return;", guard);
  for (const work of ["admin.database()", "generateOnePost(", "generateSocialScene("]) {
    const at = body.indexOf(work);
    assert.ok(at === -1 || ret < at, `returns before ${work}`);
  }
});

test("generateProductPhotos refuses a call that names no products (no unattended sweep), before any catalogue read", () => {
  const i = src.indexOf("const namedIds = resolveNamedIds(data, PHOTO_MAX_BATCH);");
  assert.ok(i > 0);
  const after = src.slice(i, i + 900);
  const refuse = after.indexOf('throw new HttpsError("invalid-argument", "Pick the products to generate');
  const scan = after.indexOf('db.ref("products").once("value")');
  assert.ok(refuse > 0, "the refusal is there");
  assert.ok(scan === -1 || refuse < scan, "refused BEFORE the whole-catalogue read");
});

test("the studio's Generate button only generates PICKED products", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "src", "App.jsx"), "utf8");
  assert.doesNotMatch(app, /selectedIds\.size \? generateSelected : runAI/);
  assert.doesNotMatch(app, /Generate next clothing/);
});

test("a pick on an item approved before clears that approval — the new photo needs its own Approve", () => {
  const gen = { url: "https://x/g2.jpg", path: "g2", verdict: { pass: true, label: "ok" } };
  const f = core.selectFields(gen, "g2", 5, { status: "rejected", approvedAt: 3, approvedBy: "junid" });
  assert.equal(f.approvedAt, null);
  assert.equal(f.approvedBy, null);
  const g = core.selectFields(gen, "g2", 5, { status: "ready" });
  assert.equal("approvedAt" in g, false, "nothing to clear on a never-approved item");
});
