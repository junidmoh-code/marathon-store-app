// ─── EVERY DECLARED DEPENDENCY MUST BE IN THE LOCKFILE ───────────────────────
// Firebase installs Cloud Functions from package-lock.json, NOT package.json.
// A dependency declared in package.json but absent from the lockfile root
// therefore fails at DEPLOY time — the one moment the failure is most expensive
// and least expected, because everything passes locally where node_modules is
// already populated.
//
// That is exactly what happened: `google-auth-library` was added to
// package.json for the Cloud Vision auth in readStyleCodeLabel.js and the
// lockfile was never regenerated. Local tests passed the whole time.
// (CodeRabbit, PR #312.)

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

test("every package.json dependency is recorded in the lockfile root", () => {
  const declared = Object.keys(pkg.dependencies || {});
  const locked = (lock.packages && lock.packages[""] && lock.packages[""].dependencies) || {};
  const missing = declared.filter((d) => !(d in locked));
  assert.deepStrictEqual(missing, [],
    `declared in package.json but missing from package-lock.json root: ${missing.join(", ")} — ` +
    "this deploys fine locally and FAILS on `firebase deploy`. Run `npm install --package-lock-only`.");
});

test("every dependency resolves to an installed package entry in the lockfile", () => {
  const declared = Object.keys(pkg.dependencies || {});
  const missing = declared.filter((d) => !(`node_modules/${d}` in (lock.packages || {})));
  assert.deepStrictEqual(missing, [], `no lockfile package entry for: ${missing.join(", ")}`);
});

test("the declared range and the lockfile range agree", () => {
  const declared = pkg.dependencies || {};
  const locked = (lock.packages && lock.packages[""] && lock.packages[""].dependencies) || {};
  for (const [name, range] of Object.entries(declared)) {
    if (!(name in locked)) continue; // covered by the test above
    assert.strictEqual(locked[name], range, `${name}: package.json says ${range}, lockfile says ${locked[name]}`);
  }
});

test("google-auth-library specifically — the Cloud Vision auth dependency", () => {
  // Named explicitly because it is required directly by readStyleCodeLabel.js
  // and was previously only present transitively, which is fragile: a
  // transitive dependency can vanish on any unrelated upgrade.
  assert.ok(pkg.dependencies["google-auth-library"], "must be a DIRECT dependency, not transitive");
  assert.ok("node_modules/google-auth-library" in lock.packages);
});
