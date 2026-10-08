// THE PAUSE SWITCHES (Junid, 8 Oct): while photo generation is paused no image
// model is called, whoever taps; a switch that cannot be read counts as paused.
const test = require("node:test");
const assert = require("node:assert/strict");
const pause = require("../newArrivals/pause.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

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
