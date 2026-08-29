// THE CARD-RECON NODES MUST NEVER POINT BACK UNDER /pos.
//
// They were moved to the top level so that no parent grant reaches them. The
// old /pos/card_* paths still exist in the live rules carrying `".write":
// "false"`, which stops every CLIENT from writing there — but the Admin SDK
// bypasses rules entirely, so a path constant pointed back under /pos would
// silently start writing investigation material into a node that ANY signed-in
// staff member can read.
//
// And that read cannot be closed from there. RTDB read grants cascade downward
// and cannot be revoked by a deeper rule: /pos grants `.read` to every
// signed-in non-anonymous staff member, so adding `".read": "false"` to
// /pos/card_batches does nothing at all (verified against the real rules engine
// with those rules applied — staff read straight through it). The `.write`
// denial works only because /pos has no `.write` of its own to override.
//
// So the ONLY thing keeping those dead paths harmless is that nothing writes
// them. That is not a property to leave to memory.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");

const {
  CARD_BATCHES_PATH, CARD_BATCH_DRAFTS_PATH, CARD_TERMINALS_PATH,
} = require("../lib/card-recon.cjs");

test("the record and draft paths are TOP-LEVEL, not under /pos", () => {
  assert.equal(CARD_BATCHES_PATH, "card_batches");
  assert.equal(CARD_BATCH_DRAFTS_PATH, "card_batch_drafts");
  for (const [name, path] of Object.entries({ CARD_BATCHES_PATH, CARD_BATCH_DRAFTS_PATH })) {
    assert.ok(!path.startsWith("pos/"),
      `${name} points under /pos — every signed-in staff member can read that, and no rule under /pos can stop them`);
  }
  // The terminal registry is a different thing and legitimately lives under
  // /config: it holds a TID→till map, no takings and no card data, and the
  // phone's till picker reads it.
  assert.equal(CARD_TERMINALS_PATH, "config/cardTerminals");
});

test("no function names a pos/card_* path directly, bypassing the constants", () => {
  // A constant is only a control if nothing goes around it. The Admin SDK
  // ignores rules, so a literal here is all it would take.
  //
  // WHAT THIS CATCHES, honestly: a path written as a string literal, and the
  // `.child("card_batch…")` chained form. What it does NOT catch is a path
  // ASSEMBLED at runtime — `"pos/" + name`, or a segment held in a variable.
  // No amount of grepping catches that, and pretending otherwise is worse than
  // saying so: the real defence against a computed path is that the two
  // exported constants are the only way anything here addresses these nodes,
  // which the test above pins, and that a reviewer reads the diff.
  const root = resolve(__dirname, "..");
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "test") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(js|cjs|mjs)$/.test(entry)) files.push(full);
    }
  })(root);

  const offenders = [];
  for (const file of files) {
    // Comments may explain the old path; code may not name it.
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const literal = /["'`]pos\/card_batch/.test(code);              // "pos/card_batches/…"
    const chained = /\.child\(\s*["'`]card_batch/.test(code);        // .ref("pos").child("card_batches")
    if (literal || chained) offenders.push(file.slice(root.length + 1));
  }
  assert.deepEqual(offenders, [],
    `these name a /pos card path directly: ${offenders.join(", ")}`);
});
