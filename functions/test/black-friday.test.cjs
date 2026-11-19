// Black Friday 2026 (Junid, 19 Nov): the card's state — approve, Approve All,
// untick/tick, undo — against the fake RTDB (which deletes empty children like
// the real one), and the card's view: stock price only, statuses, caption.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../blackFriday/core.cjs");
const { _internals } = require("../blackFriday/blackFriday.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const group = (key, price, pids) => ({ key, label: key, price, part: 1, parts: 1, caption: "x", count: pids.length, builtAt: 1,
  items: Object.fromEntries(pids.map((pid, i) => [pid, { n: i + 1, name: `Item ${pid}`, sizes: i === 0 ? "M-XL" : "one size", qty: 13 + i, photo: `https://x/${pid}.jpg` }])) });
const seed = () => makeFakeDb({ bf_campaign_2026: {
  meta: { keys: ["R300", "R650-part1"], eligible: 5, groupCount: 2, noPhotoCount: 1, noPhoto: [{ pid: "pz", name: "No photo", qty: 20 }] },
  groups: { R300: group("R300", 300, ["a", "b"]), "R650-part1": group("R650-part1", 650, ["c", "d", "e"]) },
} });
const set = (db, args, nowMs = 1000) => _internals.setOne(db, args, "junid", nowMs);
// The state without its write counter (rev); null when only rev is left.
const state = async (db, key) => {
  const v = (await db.ref(`bf_campaign_2026/state/${key}`).once("value")).val();
  if (!v) return v;
  const { rev, ...rest } = v; // eslint-disable-line no-unused-vars
  return Object.keys(rest).length ? rest : null;
};

test("only Junid (a super admin) may use the card", () => {
  assert.throws(() => _internals.assertJunid({ auth: { token: { email: "staff@x.com" } } }), /Junid/);
  assert.throws(() => _internals.assertJunid({}), /Junid/);
});

test("the view: one row per group, waiting, caption numbered like the photos, stock price only", async () => {
  const v = await _internals.list(seed());
  assert.deepEqual(v.groups.map((g) => [g.key, g.status, g.count]), [["R300", "waiting", 2], ["R650-part1", "waiting", 3]]);
  assert.equal(v.groups[0].caption, "BLACK FRIDAY 🔥 R300 EACH\n1. Item a — sizes M-XL\n2. Item b — one size\nMessage us to order.");
  assert.equal(v.meta.noPhotoCount, 1);
  assert.equal(JSON.stringify(v).includes("retail"), false);
});

test("approve covers every ticked item; approving again while it waits keeps its place; undo puts it back to waiting", async () => {
  const db = seed();
  await set(db, { action: "exclude", key: "R650-part1", pid: "d" });
  const r = await set(db, { action: "approve", key: "R650-part1" }, 5000);
  assert.equal(r.group.status, "approved");
  assert.deepEqual(await state(db, "R650-part1"), { approvedAt: 5000, approvedBy: "junid", approvedItems: { c: true, e: true }, excluded: { d: true } });
  assert.equal(r.group.caption, "BLACK FRIDAY 🔥 R650 EACH\n1. Item c — sizes M-XL\n2. Item e — one size\nMessage us to order.", "the preview drops the unticked item and renumbers");
  assert.equal((await set(db, { action: "approve", key: "R650-part1" }, 9000)).noop, true);
  assert.equal((await state(db, "R650-part1")).approvedAt, 5000);
  await set(db, { action: "unapprove", key: "R650-part1" });
  assert.deepEqual(await state(db, "R650-part1"), { excluded: { d: true } });
});

test("untick after approval removes it from the approval; unticking the last one withdraws the approval; tick adds it back", async () => {
  const db = seed();
  await set(db, { action: "approve", key: "R300" }, 5000);
  await set(db, { action: "exclude", key: "R300", pid: "a" });
  assert.deepEqual((await state(db, "R300")).approvedItems, { b: true });
  await set(db, { action: "include", key: "R300", pid: "a" });
  assert.deepEqual((await state(db, "R300")).approvedItems, { a: true, b: true });
  await set(db, { action: "exclude", key: "R300", pid: "a" });
  const last = await set(db, { action: "exclude", key: "R300", pid: "b" });
  assert.equal(last.unapproved, true);
  assert.deepEqual(await state(db, "R300"), { excluded: { a: true, b: true } }, "no empty approvedItems left behind");
  const refused = await set(db, { action: "approve", key: "R300" });
  assert.match(refused.refusal, /every item is unticked/);
  await set(db, { action: "include", key: "R300", pid: "a" });
  await set(db, { action: "include", key: "R300", pid: "b" });
  assert.equal(await state(db, "R300"), null, "a fully ticked, unapproved group leaves nothing but its write counter");
  assert.ok((await db.ref("bf_campaign_2026/state/R300/rev").once("value")).val() > 0, "state/{key} is never deleted once written");
});

test("an untick that overlaps an Undo never brings the approval back (cold-null transaction + stale pre-read)", async () => {
  // The untick reads state (approved), then Junid's Undo commits, then the
  // untick's transaction runs: its cold first callback works from the stale
  // read. Because Undo leaves state/{key} in place (rev), the server's CAS
  // mismatches and the untick re-runs on the real, unapproved state.
  let reads = 0, undone = false, armed = false;
  const db = makeFakeDb({ bf_campaign_2026: { groups: { R300: group("R300", 300, ["a", "b", "c"]) } } }, {
    beforeRead: async (path) => {
      if (path !== "bf_campaign_2026/state/R300" || undone || !armed) return;
      reads += 1;
      if (reads === 2) { undone = true; await set(db, { action: "unapprove", key: "R300" }); }
    },
  });
  await set(db, { action: "approve", key: "R300" }, 5000);
  armed = true;
  await set(db, { action: "exclude", key: "R300", pid: "a" });
  assert.equal(undone, true, "the Undo landed between the untick's read and its transaction");
  assert.deepEqual(await state(db, "R300"), { excluded: { a: true } }, "still unapproved: the stale approval was not restored");
  // An ordinary untick of an approved group keeps the approval.
  await set(db, { action: "approve", key: "R300" }, 7000);
  await set(db, { action: "exclude", key: "R300", pid: "b" });
  assert.deepEqual(await state(db, "R300"), { approvedAt: 7000, approvedBy: "junid", approvedItems: { c: true }, excluded: { a: true, b: true } });
});

test("posted → status from the poster's record; approving again is a NEW lap (posts once more); undo refused once posted", async () => {
  const db = seed();
  await set(db, { action: "approve", key: "R300" }, 5000);
  await db.ref("bf_campaign_2026/posts/R300").set({ lap: 5000, status: "posted", at: 6000, posted: { a: "A" }, dropped: { b: { name: "Item b", why: "sold out" } } });
  let v = await _internals.list(db);
  assert.equal(v.groups[0].status, "partly sold out");
  assert.deepEqual(v.groups[0].post.dropped, [{ pid: "b", name: "Item b", why: "sold out" }]);
  assert.match((await set(db, { action: "unapprove", key: "R300" })).refusal, /already posted/);
  await set(db, { action: "approve", key: "R300" }, 7000);
  v = await _internals.list(db);
  assert.equal(v.groups[0].status, "approved");
  assert.equal(v.groups[0].postedEarlierAt, 6000, "the card says it already went out once");
  assert.equal(v.groups[0].approvedAt, 7000);
});

test("a rebuild that adds an item to an approved group: shown as new, covered only after Approve again (same queue place)", async () => {
  const db = seed();
  await set(db, { action: "approve", key: "R300" }, 5000);
  await db.ref("bf_campaign_2026/groups/R300/items/f").set({ n: 3, name: "Item f", sizes: "7-9", qty: 14, photo: "https://x/f.jpg" });
  let v = await _internals.list(db);
  assert.equal(v.groups[0].newSinceApproval, 1);
  await set(db, { action: "approve", key: "R300" }, 8000);
  assert.deepEqual(await state(db, "R300"), { approvedAt: 5000, approvedBy: "junid", approvedItems: { a: true, b: true, f: true } });
  v = await _internals.list(db);
  assert.equal(v.groups[0].newSinceApproval, 0);
});

test("bad input is refused before anything is written; every tap is logged", async () => {
  const db = seed();
  await assert.rejects(set(db, { action: "approve", key: "../products" }), /Which group/);
  await assert.rejects(set(db, { action: "approve", key: "R999" }), /not in today's groups/);
  await assert.rejects(set(db, { action: "exclude", key: "R300", pid: "zz" }), /not in this group/);
  await assert.rejects(set(db, { action: "post", key: "R300" }), /approve, unapprove/);
  await set(db, { action: "approve", key: "R300" });
  const log = (await db.ref("bf_campaign_2026/decisions").once("value")).val();
  assert.deepEqual(Object.values(log).map((r) => [r.action, r.key, r.by]), [["approve", "R300", "junid"]]);
});

test("the caption keeps cents: R300.50 is never shown as R301", () => {
  assert.equal(core.captionPreview(300.5, [{ name: "Tee", sizes: "M" }]), "BLACK FRIDAY 🔥 R300.50 EACH\n1. Tee — sizes M\nMessage us to order.");
  assert.match(core.captionPreview(300, []), /R300 EACH/);
});

test("status words", () => {
  assert.equal(core.groupStatus(null, null), "waiting");
  assert.equal(core.groupStatus({ approvedAt: 1 }, { lap: 1, status: "sold out" }), "sold out");
  assert.equal(core.groupStatus({ approvedAt: 1 }, { lap: 1, status: "posted" }), "posted");
});
