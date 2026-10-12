// THE PAUSE SWITCHES (Junid, 8 Oct; scope narrowed 12 Oct): while New Arrivals
// generation is paused the New Arrivals studio calls no model, whoever taps; a
// switch that cannot be read counts as paused. Nothing outside New Arrivals reads it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pause = require("../newArrivals/pause.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

test("the switch gates the New Arrivals studio ONLY — #711 wired it into Marathon Social and the Shopify AI Studio; that is gone (Junid, 12 Oct)", () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  // index.js (generateProductPhotos, generateSocialPosts, socialDailyAutopilot, socialHealthScan) never reads the switch.
  const index = src("index.js");
  for (const needle of ["pause.cjs", "isPaused(", "new_arrivals/pause", "social_autopilot_paused", "generationPaused"]) {
    assert.equal(index.includes(needle), false, `functions/index.js must not contain "${needle}"`);
  }
  // The watchdog's assessor has no paused-day branch.
  assert.equal(src("lib/social-health.cjs").includes("generationPaused"), false);
  // The studio still reads it at BOTH points: the tap, and the model-call boundary.
  const studio = src("newArrivals/studio.js");
  assert.ok((studio.match(/isPaused\(\s*db,\s*["']generation["']\s*\)/g) || []).length >= 2, "studio.js reads the switch at the tap AND at the model call");
});

test("absent = not paused; true = paused; a failed read is PAUSED", async () => {
  const db = makeFakeDb({});
  assert.deepEqual(await pause.readPause(db), { generation: false, posting: false });
  await pause.setPause(db, { which: "generation", paused: true, by: "junid" }, 1000);
  assert.equal(await pause.isPaused(db, "generation"), true);
  assert.equal(await pause.isPaused(db, "posting"), false);
  assert.deepEqual((await db.ref("new_arrivals/pause/generation").once()).val(), { paused: true, at: 1000, by: "junid" });
  assert.deepEqual((await db.ref("new_arrivals/pause/log/1000").once()).val(), { which: "generation", paused: true, at: 1000, by: "junid" });
  await pause.setPause(db, { which: "generation", paused: false, by: "junid" }, 2000);
  assert.equal(await pause.isPaused(db, "generation"), false);
  await assert.rejects(pause.setPause(db, { which: "whatsapp", paused: true }, 3), /no such switch/);
  const broken = { ref: () => ({ once: async () => { throw new Error("offline"); } }) };
  assert.equal(await pause.isPaused(broken, "generation"), true);
  assert.deepEqual(await pause.readPause(broken), { generation: true, posting: true });
});
