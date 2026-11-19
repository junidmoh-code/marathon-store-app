// Black Friday 2026 (Junid, 19 Nov): the card's state — approve (item / group /
// all), untick/tick, undo, the photo choice, the schedule and its plan — against
// the fake RTDB (which deletes empty children like the real one), the card's
// view (stock price only, totals), and bfGenerate through the REAL New Arrivals
// engine with only the image model and Storage faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const core = require("../blackFriday/core.cjs");
const { _internals } = require("../blackFriday/blackFriday.js");
const gen = require("../blackFriday/generate.js")._internals;
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const group = (key, price, pids, division = "clothing") => ({ key, label: key, price, division, part: 1, parts: 1, caption: "x", count: pids.length, builtAt: 1,
  items: Object.fromEntries(pids.map((pid, i) => [pid, { n: i + 1, name: `Item ${pid}`, sizes: i === 0 ? "M-XL" : "one size", qty: 13 + i, photo: `https://x/${pid}.jpg` }])) });
const seed = (extra = {}) => makeFakeDb({ bf_campaign_2026: {
  meta: { keys: ["R300-clothing", "R650-sneakers"], eligible: 5, newArrivals: 2, groupCount: 2, noPhotoCount: 1, noPhoto: [{ pid: "pz", name: "No photo", qty: 20 }] },
  groups: { "R300-clothing": group("R300-clothing", 300, ["a", "b"]), "R650-sneakers": group("R650-sneakers", 650, ["c", "d", "e"], "sneakers") },
  ...extra,
} });
const set = (db, args, nowMs = 1000) => _internals.setOne(db, args, "junid", nowMs);
// The state without its write counter (rev); null when only rev is left.
const state = async (db, key) => {
  const v = (await db.ref(`bf_campaign_2026/state/${key}`).once("value")).val();
  if (!v) return v;
  const { rev, ...rest } = v; // eslint-disable-line no-unused-vars
  return Object.keys(rest).length ? rest : null;
};
const A = "R300-clothing", S = "R650-sneakers";
const withGen = (pid, genId, use = "generated") => ({ [pid]: { use, genId, gens: { [genId]: { url: `https://x/${pid}-${genId}.png`, at: 1 } }, rev: 1 } });

test("only Junid (a super admin) may use the card", () => {
  assert.throws(() => _internals.assertJunid({ auth: { token: { email: "staff@x.com" } } }), /Junid/);
  assert.throws(() => _internals.assertJunid({}), /Junid/);
});

test("group keys: clothing and sneakers at one price are separate groups", () => {
  for (const k of ["R350-clothing", "R350-sneakers", "R350-sneakers-part2", "R349_50-clothing", "R300"]) assert.ok(core.KEY_RE.test(k), k);
  for (const k of ["R350-shoes", "R350-clothing-sneakers", "../x", "R350-part2-clothing"]) assert.ok(!core.KEY_RE.test(k), k);
});

test("the view: one row per group, totals at the top, stock price only", async () => {
  const v = await _internals.list(seed({ photos: withGen("c", "g1790000000000"), stats: { spentZar: 12.345 } }));
  assert.deepEqual(v.groups.map((g) => [g.key, g.status, g.count, g.division]), [[A, "waiting", 2, "clothing"], [S, "waiting", 3, "sneakers"]]);
  assert.equal(v.groups[0].caption, "BLACK FRIDAY 🔥 R300 EACH\n1. Item a — sizes M-XL\n2. Item b — one size\nMessage us to order.");
  assert.deepEqual(v.totals, { products: 5, photos: 5, groups: 2, aiPhotos: 1, approved: 0, waiting: 5, spentZar: 12.35 });
  const c = v.groups[1].items[0];
  assert.equal(c.use, "generated");
  assert.equal(c.shown, "https://x/c-g1790000000000.png");
  assert.equal(v.schedule, null, "no schedule: nothing posts");
  assert.equal(JSON.stringify(v).includes("retail"), false);
});

test("approve one item: covers it with the photo it shows; the group is queued; the other item still waits", async () => {
  const db = seed();
  const r = await set(db, { action: "approveItem", key: A, pid: "a" }, 5000);
  assert.equal(r.group.status, "approved");
  assert.deepEqual(await state(db, A), { approvedAt: 5000, approvedBy: "junid", approvedItems: { a: "current" } });
  assert.deepEqual(r.group.items.map((it) => it.approved), [true, false]);
  assert.equal(r.group.approvedCount, 1);
  assert.equal(r.group.caption, "BLACK FRIDAY 🔥 R300 EACH\n1. Item a — sizes M-XL\nMessage us to order.", "the preview is what would post");
  assert.equal((await set(db, { action: "approveItem", key: A, pid: "a" }, 6000)).noop, true);
  await set(db, { action: "approveItem", key: A, pid: "b" }, 7000);
  assert.deepEqual((await state(db, A)).approvedItems, { a: "current", b: "current" });
  assert.equal((await state(db, A)).approvedAt, 5000, "its place in the queue is kept");
});

test("AN APPROVAL IS OF A PHOTO: generating or switching photo makes the item wait again, and Approve is offered", async () => {
  const db = seed();
  await set(db, { action: "approve", key: S }, 5000);
  // A new generation lands on c (as bfGenerate would write it).
  await db.ref("bf_campaign_2026/photos").set(withGen("c", "g1790000000001"));
  let v = await _internals.list(db);
  const c = v.groups[1].items[0];
  assert.equal(c.approved, false);
  assert.equal(c.changedSinceApproval, true);
  assert.deepEqual(core.postablePids(v.groups[1] && (await db.ref(`bf_campaign_2026/groups/${S}`).once("value")).val(), await state(db, S), (await db.ref("bf_campaign_2026/photos").once("value")).val()), ["d", "e"], "the unseen photo never posts");
  await set(db, { action: "approveItem", key: S, pid: "c" }, 6000);
  assert.equal((await state(db, S)).approvedItems.c, "g1790000000001");
  // Back to the current photo: waiting again until approved again.
  const u = await set(db, { action: "use", key: S, pid: "c", use: "current" });
  assert.equal(u.group.items[0].approved, false);
  assert.equal(u.group.items[0].use, "current");
  const back = await set(db, { action: "use", key: S, pid: "c", use: "generated" });
  assert.equal(back.group.items[0].approved, true, "the generated photo it was approved with");
  assert.match((await set(db, { action: "use", key: S, pid: "d", use: "generated" })).refusal, /tap Generate/);
});

test("an approval from the first version (true) still means the current photo", () => {
  assert.equal(core.itemApproved({ approvedItems: { a: true } }, "a", null), true);
  assert.equal(core.itemApproved({ approvedItems: { a: true } }, "a", withGen("a", "g1790000000000").a), false);
});

test("untick drops the item from a waiting approval; unticking the last withdraws it; ticking back does not approve", async () => {
  const db = seed();
  await set(db, { action: "approve", key: A }, 5000);
  await set(db, { action: "exclude", key: A, pid: "a" });
  assert.deepEqual((await state(db, A)).approvedItems, { b: "current" });
  await set(db, { action: "include", key: A, pid: "a" });
  assert.deepEqual((await state(db, A)).approvedItems, { b: "current" }, "ticked back: waiting for its own Approve");
  await set(db, { action: "exclude", key: A, pid: "a" });
  const last = await set(db, { action: "exclude", key: A, pid: "b" });
  assert.equal(last.unapproved, true);
  assert.deepEqual(await state(db, A), { excluded: { a: true, b: true } });
  assert.match((await set(db, { action: "approve", key: A })).refusal, /every item is unticked/);
  assert.match((await set(db, { action: "approveItem", key: A, pid: "a" })).refusal, /unticked/);
  await set(db, { action: "include", key: A, pid: "a" });
  await set(db, { action: "include", key: A, pid: "b" });
  assert.equal(await state(db, A), null);
  assert.ok((await db.ref(`bf_campaign_2026/state/${A}/rev`).once("value")).val() > 0, "state/{key} is never deleted once written");
});

test("an untick that overlaps an Undo never brings the approval back (cold-null transaction + stale pre-read)", async () => {
  let reads = 0, undone = false, armed = false;
  const db = makeFakeDb({ bf_campaign_2026: { groups: { [A]: group(A, 300, ["a", "b", "c"]) } } }, {
    beforeRead: async (path) => {
      if (path !== `bf_campaign_2026/state/${A}` || undone || !armed) return;
      reads += 1;
      if (reads === 2) { undone = true; await set(db, { action: "unapprove", key: A }); }
    },
  });
  await set(db, { action: "approve", key: A }, 5000);
  armed = true;
  await set(db, { action: "exclude", key: A, pid: "a" });
  assert.equal(undone, true);
  assert.deepEqual(await state(db, A), { excluded: { a: true } });
});

test("posted → status from the poster's record; approving again is a NEW lap; undo refused once posted", async () => {
  const db = seed();
  await set(db, { action: "approve", key: A }, 5000);
  await db.ref(`bf_campaign_2026/posts/${A}`).set({ lap: 5000, status: "posted", at: 6000, posted: { a: "A" }, dropped: { b: { name: "Item b", why: "sold out" } } });
  let v = await _internals.list(db);
  assert.equal(v.groups[0].status, "partly sold out");
  assert.match((await set(db, { action: "unapprove", key: A })).refusal, /already posted/);
  await set(db, { action: "approve", key: A }, 7000);
  v = await _internals.list(db);
  assert.equal(v.groups[0].status, "approved");
  assert.equal(v.groups[0].postedEarlierAt, 6000);
});

test("bad input is refused before anything is written; every tap is logged", async () => {
  const db = seed();
  await assert.rejects(set(db, { action: "approve", key: "../products" }), /Which group/);
  await assert.rejects(set(db, { action: "approve", key: "R999-clothing" }), /not in today's groups/);
  await assert.rejects(set(db, { action: "exclude", key: A, pid: "zz" }), /not in this group/);
  await assert.rejects(set(db, { action: "post", key: A }), /approveItem/);
  await assert.rejects(set(db, { action: "use", key: A, pid: "a", use: "retail" }), /current photo or a generated/);
  await set(db, { action: "approve", key: A });
  const log = (await db.ref("bf_campaign_2026/decisions").once("value")).val();
  assert.deepEqual(Object.values(log).map((r) => [r.action, r.key, r.by]), [["approve", A, "junid"]]);
});

// ── the schedule ─────────────────────────────────────────────────────────────
const T = (s) => Date.parse(`${s}+02:00`);
const fmt = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

test("NOTHING POSTS WITHOUT A SCHEDULE: approvals make no plan until Junid confirms one", async () => {
  const db = seed();
  await set(db, { action: "approve", key: A }, T("2026-11-20T07:00:00"));
  assert.equal((await db.ref("bf_campaign_2026/schedule").once("value")).val(), null);
  const preview = await _internals.schedule(db, { mode: "gap", start: T("2026-11-20T09:00:00"), gapMin: 60 }, { confirm: false }, "junid", T("2026-11-20T07:00:00"));
  assert.equal(preview.preview, true);
  assert.deepEqual(Object.entries(preview.plan).map(([k, t]) => [k, fmt(t)]), [[A, "11-20 09:00"]]);
  assert.equal((await db.ref("bf_campaign_2026/schedule").once("value")).val(), null, "a preview writes nothing");
  await _internals.schedule(db, { mode: "gap", start: T("2026-11-20T09:00:00"), gapMin: 60 }, { confirm: true }, "junid", T("2026-11-20T07:00:00"));
  // A later approval joins the plan.
  await set(db, { action: "approve", key: S }, T("2026-11-20T07:05:00"));
  const plan = (await db.ref("bf_campaign_2026/schedule/plan").once("value")).val();
  assert.deepEqual(Object.entries(plan).map(([k, t]) => [k, fmt(t)]).sort(), [[A, "11-20 09:00"], [S, "11-20 10:00"]]);
  const v = await _internals.list(db);
  assert.equal(v.schedule.mode, "gap");
  assert.equal(fmt(v.groups[1].dueAt), "11-20 10:00");
  await _internals.clearSchedule(db, "junid", 1);
  assert.equal((await db.ref("bf_campaign_2026/schedule").once("value")).val(), null);
});

test("no schedule, or one never confirmed: no plan at all", async () => {
  assert.deepEqual(core.planSchedule([{ key: "a", approvedAt: 1, price: 300 }], null, 0), {});
  const db = seed({ schedule: { mode: "gap", from: "08:00", to: "20:00", start: 1, gapMin: 30 } });
  await set(db, { action: "approve", key: A }, T("2026-11-20T07:00:00"));
  assert.equal((await db.ref("bf_campaign_2026/schedule/plan").once("value")).val(), null, "an unconfirmed schedule never gets a plan");
});

test("NEVER A PARTIAL ALBUM: a group is queued only when every ticked item is approved", async () => {
  const db = seed({ schedule: { mode: "gap", from: "08:00", to: "20:00", start: T("2026-11-20T09:00:00"), gapMin: 60, confirmedAt: 1 } });
  await set(db, { action: "approveItem", key: A, pid: "a" }, T("2026-11-20T07:00:00"));
  let v = await _internals.list(db);
  assert.equal(v.groups[0].complete, false);
  assert.equal((await db.ref("bf_campaign_2026/schedule/plan").once("value")).val(), null, "one of two approved: not queued");
  await set(db, { action: "exclude", key: A, pid: "b" }, T("2026-11-20T07:01:00"));
  v = await _internals.list(db);
  assert.equal(v.groups[0].complete, true, "the rest unticked: complete");
  assert.ok((await db.ref(`bf_campaign_2026/schedule/plan/${A}`).once("value")).val() > 0);
});

test("A TAP NEVER PULLS THE NEXT GROUP FORWARD: planned groups keep their times; new ones go after the last", () => {
  const q = ["a", "b", "c"].map((k, i) => ({ key: k, approvedAt: i, price: 300 }));
  const s = { mode: "gap", from: "08:00", to: "20:00", start: T("2026-11-20T08:00:00"), gapMin: 60 };
  const first = core.planSchedule(q.slice(0, 2), s, T("2026-11-20T07:00:00"));
  assert.deepEqual(Object.values(first).map(fmt), ["11-20 08:00", "11-20 09:00"]);
  // 08:20: a (posted) has left the queue; Junid approves c. b stays at 09:00, c goes an hour after it.
  const again = core.planSchedule(q.slice(1), s, T("2026-11-20T08:20:00"), first);
  assert.deepEqual(Object.entries(again).map(([k, t]) => [k, fmt(t)]), [["b", "11-20 09:00"], ["c", "11-20 10:00"]]);
  // Spread: new groups share the time left after the last kept one.
  const sp = { mode: "spread", from: "08:00", to: "20:00", start: T("2026-11-20T08:00:00"), until: T("2026-11-20T20:00:00") };
  const p1 = core.planSchedule(q.slice(0, 1), sp, T("2026-11-20T07:00:00"));
  assert.deepEqual(Object.values(p1).map(fmt), ["11-20 08:00"]);
  const p2 = core.planSchedule(q, sp, T("2026-11-20T07:30:00"), p1);
  assert.deepEqual(Object.entries(p2).map(([k, t]) => [k, fmt(t)]), [["a", "11-20 08:00"], ["b", "11-20 12:00"], ["c", "11-20 16:00"]], "a kept; b and c share the time left, before the close");
});

test("post all now is capped at the end of the campaign; inWindow", () => {
  const q = ["a", "b"].map((k, i) => ({ key: k, approvedAt: i, price: 300 }));
  const late = core.CAMPAIGN_END_MS - 60_000;
  assert.deepEqual(Object.keys(core.planSchedule(q, { mode: "now", start: late }, late)), ["a"]);
  const s = { mode: "gap", from: "08:00", to: "20:00" };
  assert.equal(core.inWindow(s, T("2026-11-20T03:00:00")), false);
  assert.equal(core.inWindow(s, T("2026-11-20T12:00:00")), true);
  assert.equal(core.inWindow({ mode: "now" }, T("2026-11-20T03:00:00")), true);
});

test("a dead generation claim (older than 10 min) does not grey anything out", () => {
  const g = group(A, 300, ["a"]);
  const now = 1_791_000_000_000;
  const fresh = core.viewGroup(A, g, null, null, { a: { generating: { at: now - 60_000 } } }, null, now);
  const dead = core.viewGroup(A, g, null, null, { a: { generating: { at: now - 11 * 60_000 } } }, null, now);
  assert.equal(fresh.items[0].generating, true);
  assert.equal(dead.items[0].generating, false);
});

test("the card's list never reads the decisions log", async () => {
  const reads = [];
  const db = makeFakeDb({ bf_campaign_2026: { groups: { [A]: group(A, 300, ["a"]) }, decisions: { x: { at: 1 } } } }, { beforeRead: async (p) => { reads.push(p); } });
  await _internals.list(db);
  assert.ok(!reads.some((p) => p === "bf_campaign_2026" || p.includes("decisions")), reads.join());
});

test("plan: a gap walks the daily window (08:00–20:00) and skips nights", () => {
  const q = ["a", "b", "c", "d"].map((k, i) => ({ key: k, approvedAt: i, price: 300 }));
  const plan = core.planSchedule(q, { mode: "gap", from: "08:00", to: "20:00", start: T("2026-11-20T18:30:00"), gapMin: 60 }, T("2026-11-20T07:00:00"));
  assert.deepEqual(Object.values(plan).map(fmt), ["11-20 18:30", "11-20 19:30", "11-21 08:30", "11-21 09:30"]);
});

test("plan: spread evenly until a date shares the window time; a start before the window opens waits for it", () => {
  const q = ["a", "b", "c"].map((k, i) => ({ key: k, approvedAt: i, price: 300 }));
  const plan = core.planSchedule(q, { mode: "spread", from: "08:00", to: "20:00", start: T("2026-11-20T06:00:00"), until: T("2026-11-21T20:00:00") }, T("2026-11-20T05:00:00"));
  assert.deepEqual(Object.values(plan).map(fmt), ["11-20 08:00", "11-20 16:00", "11-21 12:00"]);
});

test("plan: post all now = every approved group, a few minutes apart, from now", () => {
  const q = ["a", "b"].map((k, i) => ({ key: k, approvedAt: i, price: 300 }));
  const now = T("2026-11-20T21:00:00");
  const plan = core.planSchedule(q, core.cleanSchedule({ mode: "now" }, now), now);
  assert.deepEqual(Object.values(plan).map(fmt), ["11-20 21:00", "11-20 21:03"]);
});

test("plan: nothing after the end of the campaign (27 Nov 20:00); bad schedules are refused", () => {
  const q = ["a", "b"].map((k, i) => ({ key: k, approvedAt: i, price: 300 }));
  const plan = core.planSchedule(q, { mode: "gap", from: "08:00", to: "20:00", start: T("2026-11-27T19:00:00"), gapMin: 120 }, T("2026-11-27T07:00:00"));
  assert.deepEqual(Object.keys(plan), ["a"]);
  assert.match(core.cleanSchedule({ mode: "gap", start: 1, gapMin: 1 }, 0).error, /gap/);
  assert.match(core.cleanSchedule({ mode: "gap", start: 1, gapMin: 30, from: "20:00", to: "08:00" }, 0).error, /window/);
  assert.match(core.cleanSchedule({ mode: "spread", start: 10, until: 5 }, 0).error, /after the start/);
  assert.match(core.cleanSchedule({}, 0).error, /Choose/);
});

test("the queue: only approved, unposted groups with something approved to post", async () => {
  const db = seed({ photos: withGen("a", "g1790000000000") });
  await set(db, { action: "approveItem", key: A, pid: "a" }, 5000);
  await db.ref("bf_campaign_2026/photos/a/genId").set("g1790000000009");
  await db.ref("bf_campaign_2026/photos/a/gens/g1790000000009").set({ url: "u", at: 2 });
  const node = (await db.ref("bf_campaign_2026").once("value")).val();
  assert.deepEqual(core.queueOf(node), [], "its only approved photo was replaced: nothing to post");
});

// ── bfGenerate through the real engine ───────────────────────────────────────
const png = (w, h, colour) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();
async function genWorld({ geminiW = 1728, geminiH = 2304 } = {}) {
  const db = seed({ photos: {} });
  await db.ref("products/a").set({ name: "Item a", categoryKey: "hoodies", photoUrl: "https://x/a.jpg", stockPrice: 300 });
  const uploads = [];
  const calls = [];
  let clock = 1_791_200_000_000;
  const plate = { buffer: await png(543, 724, "#888"), width: 543, height: 724, file: "fence-single.png" };
  const deps = {
    now: () => (clock += 1000),
    bucket: { name: "b", file: (p) => ({ save: async (buf, opts) => { uploads.push({ path: p, buf, opts }); } }) },
    fetchBytes: async (url) => { calls.push(["fetch", url]); return { buffer: await png(400, 500, "#a52") }; },
    assets: { loadPlate: async () => plate, loadReference: async () => null, libraryBox: async () => null, loadExamples: async () => [] },
    fx: async () => ({ rate: 18, day: "2026-11-19" }),
    image: async (model, parts, imageConfig) => {
      calls.push(["image", model, imageConfig]);
      return { buffer: await png(geminiW, geminiH, "#777"), mime: "image/png", usage: { promptTokenCount: 9000, candidatesTokenCount: 2000, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 2000 }] }, request: { imageConfig } };
    },
  };
  return { db, deps, uploads, calls };
}

test("Generate: ONE Gemini call at 4K, the photo kept at the model's resolution WITHOUT recompression, under black_friday/", async () => {
  const w = await genWorld();
  const out = await gen.bfGenerate(w.db, { key: A, pid: "a" }, "junid", w.deps);
  assert.equal(out.ok, true);
  const image = w.calls.filter((c) => c[0] === "image");
  assert.equal(image.length, 1);
  assert.equal(image[0][2].imageSize, "4K");
  const final = w.uploads.find((u) => /\/gen_\d+\.(png|jpg)$/.test(u.path));
  assert.match(final.path, /^products\/a\/black_friday\/gen_\d+\.png$/);
  // 1728×2304 is exactly the plate's 3:4 shape: the model's own bytes, untouched.
  const m = await sharp(final.buf).metadata();
  assert.deepEqual([m.width, m.height, m.format], [1728, 2304, "png"]);
  assert.deepEqual(final.buf, await png(1728, 2304, "#777"), "byte for byte what Gemini returned");
  assert.ok(!w.uploads.some((u) => u.path.includes("/new_arrivals/")), "never beside New Arrivals' photos");
  const ph = (await w.db.ref("bf_campaign_2026/photos/a").once("value")).val();
  assert.equal(ph.use, "generated");
  assert.equal(ph.genId, out.genId);
  assert.equal(ph.gens[out.genId].width, 1728);
  assert.equal(ph.generating, undefined, "the claim is released");
  // (The fake keeps the server increment as written, like the New Arrivals studio tests.)
  assert.ok((await w.db.ref("bf_campaign_2026/stats/spentZar").once("value")).val()[".sv"].increment > 0, "the spend is counted in rand");
  // The card: the item now shows the generated photo and waits for Approve.
  const v = await _internals.list(w.db);
  const it = v.groups[0].items[0];
  assert.deepEqual([it.use, it.approved, it.generations], ["generated", false, 1]);
  assert.equal(v.totals.aiPhotos, 1);
});

test("Generate: a shape that needs cropping is cropped at full resolution and stored as PNG (lossless)", async () => {
  const w = await genWorld({ geminiW: 2000, geminiH: 2304 });
  await gen.bfGenerate(w.db, { key: A, pid: "a" }, "junid", w.deps);
  const final = w.uploads.find((u) => /\/gen_\d+\.png$/.test(u.path));
  const m = await sharp(final.buf).metadata();
  assert.deepEqual([m.width, m.height, m.format], [1728, 2304, "png"]);
});

test("Generate: refused for an item not in the group, while one is being made, and while generation is paused", async () => {
  const w = await genWorld();
  await assert.rejects(gen.bfGenerate(w.db, { key: A, pid: "c" }, "junid", w.deps), /not in this group/);
  await w.db.ref("bf_campaign_2026/photos/a").set({ generating: { at: 1_791_200_000_500 }, rev: 1 });
  await assert.rejects(gen.bfGenerate(w.db, { key: A, pid: "a" }, "junid", w.deps), /already being made/);
  await w.db.ref("new_arrivals/pause/generation/paused").set(true);
  await assert.rejects(gen.bfGenerate(w.db, { key: A, pid: "b" }, "junid", w.deps), /Paused/);
  assert.equal(w.calls.filter((c) => c[0] === "image").length, 0, "no model call");
});

test("Generate: a failed model call gives the item back and nothing changes on it", async () => {
  const w = await genWorld();
  w.deps.image = async () => { const e = new Error("busy"); e.status = 503; throw e; };
  await assert.rejects(gen.bfGenerate(w.db, { key: A, pid: "a" }, "junid", w.deps), /busy — tap Generate again/);
  const ph = (await w.db.ref("bf_campaign_2026/photos/a").once("value")).val();
  assert.equal(ph.generating, undefined);
  assert.equal(ph.gens, undefined);
});
