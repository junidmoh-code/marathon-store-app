// The clothing-photo regeneration queue (Junid, 22 Nov 2026): one request = one product's photo made again by
// the function its own card calls, ALWAYS held until the new photo passes the garment gate.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _internals: regen } = require("../photoRegen/regen.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const read = async (db, p) => (await db.ref(p).once("value")).val();
const PID = "p1795349696496";
const world = () => makeFakeDb({
  bf_campaign_2026: { photos: { [PID]: { use: "generated", genId: "g1", gens: { g1: { url: "https://x/old-bf.jpg", kind: "clothing" } } } } },
  new_arrivals: { items: { [PID]: { status: "ready", currentGen: "g1", generatedUrl: "https://x/old-na.jpg", generations: { g1: { url: "https://x/old-na.jpg" } } } } },
});

test("a Black Friday request calls bfGenerate with hold, and the result row says before / after / passed / cost", async () => {
  const db = world(), seen = [];
  const row = await regen.run(db, "r1", { pid: PID, card: "bf", by: "regen-clothing-2026-11-22" }, {
    bucket: {}, apiKey: "k",
    bfGenerate: async (d, args, uid, deps) => { seen.push({ args, uid, kit: deps.kit, key: deps.apiKey }); return { genId: "g2", url: "https://x/new.jpg", passed: true, costZar: 4.3, wastedZar: 4.31, drift: { first: "drifted", retry: "same", how: "pressed" } }; },
  });
  assert.deepEqual(seen, [{ args: { pid: PID, hold: true }, uid: "photo-regen:regen-clothing-2026-11-22", kit: true, key: "k" }]);
  assert.deepEqual({ ok: row.ok, before: row.before, after: row.after, passed: row.passed, held: row.held, flagged: row.flagged, costZar: row.costZar },
    { ok: true, before: "https://x/old-bf.jpg", after: "https://x/new.jpg", passed: true, held: false, flagged: false, costZar: 8.61 });
  assert.deepEqual(await read(db, "photo_regen/results/r1"), row);
});

test("a New Arrivals request calls studioGenerate with hold; a held photo is reported as held, with the photo that was made", async () => {
  const db = world(), seen = [];
  const row = await regen.run(db, "r2", { pid: PID, card: "na" }, {
    bucket: {}, apiKey: "k",
    studioGenerate: async (d, args) => { seen.push(args); await d.ref(`new_arrivals/items/${PID}/generations/g9`).set({ url: "https://x/held.jpg", flagged: true }); return { genId: "g9", passed: false, flagged: true, held: true, costZar: 8.6, drift: { first: "drifted", retry: "drifted", flagged: true } }; },
  });
  assert.deepEqual(seen, [{ pid: PID, hold: true }]);
  assert.deepEqual({ before: row.before, after: row.after, passed: row.passed, held: row.held, flagged: row.flagged }, { before: "https://x/old-na.jpg", after: "https://x/held.jpg", passed: false, held: true, flagged: true });
});

test("a bad request or a failed generation is a result row, never a throw (the trigger is not retried)", async () => {
  const db = world();
  assert.match((await regen.run(db, "r3", { pid: "../x", card: "bf" }, {})).error, /not a regeneration request/);
  assert.match((await regen.run(db, "r4", { pid: PID, card: "shopify" }, {})).error, /not a regeneration request/);
  const row = await regen.run(db, "r5", { pid: PID, card: "bf" }, { bfGenerate: async () => { throw new Error("No photo — Paused — generation is switched off on the New Arrivals card."); } });
  assert.equal(row.ok, false); assert.match(row.error, /Paused/);
  assert.equal((await read(db, "photo_regen/results/r5")).ok, false);
});

test("the queue is server-only and never starts by itself: no client rule for /photo_regen, no schedule, no retry", () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "database.rules.json"), "utf8")).rules;
  assert.equal(rules.photo_regen, undefined, "no rule = no client can read or write the queue");
  assert.ok(!rules[".write"] && !rules[".read"], "nothing is granted at the root");
  const src = fs.readFileSync(path.join(__dirname, "..", "photoRegen", "regen.js"), "utf8");
  assert.match(src, /retry: false/); assert.doesNotMatch(src, /onSchedule/);
  assert.equal((src.match(/hold: true/g) || []).length >= 2, true, "both cards are always called with hold");
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(idx, /exports\.photoRegenRun = require\("\.\/photoRegen\/regen\.js"\)\.photoRegenRun/);
});
