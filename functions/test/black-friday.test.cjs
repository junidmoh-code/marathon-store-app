// Black Friday 2026 (Junid, 19 Nov evening — v3): one row per product, two
// tabs, reject persists, Approve all 30+, grouping only at posting, a house
// look per kind — against the fake RTDB (which deletes empty children like the
// real one), and bfGenerate through the REAL engine with only Gemini and
// Storage faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const core = require("../blackFriday/core.cjs");
const styles = require("../blackFriday/styles.cjs");
const { _internals } = require("../blackFriday/blackFriday.js");
const gen = require("../blackFriday/generate.js")._internals;
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const it_ = (name, price, qty, kind = "clothing", over = {}) => ({ name, price, qty, sizes: "M-XL", photo: `https://x/${name}.jpg`, kind, ...over });
const seed = (extra = {}) => makeFakeDb({ bf_campaign_2026: {
  meta: { builtAt: 1, main: 4, big: 2, under: 2, paperBags: 53 },
  items: {
    main: { a: it_("Tee A", 300, 45), b: it_("Shoe B", 300, 31, "sneakers"), c: it_("Cap C", 150, 20, "headwear"), d: it_("Hoodie D", 450, 13) },
    under: { u: it_("Beanie U", 150, 4, "headwear"), v: it_("Perfume V", 150, 2, "perfume") },
  },
  ...extra,
} });
const tap = (db, args, nowMs = 1000) => _internals.tap(db, args, "junid", nowMs);
const pick = async (db, pid) => (await db.ref(`bf_campaign_2026/picks/${pid}`).once("value")).val();
const T = (s) => Date.parse(`${s}+02:00`);
const fmt = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

test("only Junid (a super admin) may use the card", () => {
  assert.throws(() => _internals.assertJunid({ auth: { token: { email: "staff@x.com" } } }), /Junid/);
  assert.throws(() => _internals.assertJunid({}), /Junid/);
});

test("MAIN: one row per product, every 30+ product first in one block, then 13–29, highest first; no badges, no groups", async () => {
  const v = await _internals.list(seed());
  assert.deepEqual(v.review.map((r) => [r.pid, r.qty, r.big]), [["a", 45, true], ["b", 31, true], ["c", 20, false], ["d", 13, false]]);
  assert.equal(v.approved.length, 0);
  assert.deepEqual(v.totals, { review: 4, underReview: 2, approved: 0, rejected: 0, spentZar: 0, noPriceApproved: 0, newArrivals: 0, approvedNa: 0, approvedNormal: 0 });
  assert.equal(v.meta.paperBags, 53);
  assert.equal(v.schedule, null);
  assert.equal(JSON.stringify(v).includes("retail"), false);
  assert.equal(JSON.stringify(v).includes("50+"), false);
});

test("UNDER 13 is its own section, read only when asked for", async () => {
  const reads = [];
  const db = makeFakeDb({ bf_campaign_2026: { items: { main: { a: it_("A", 1, 20) }, under: { u: it_("U", 1, 3) } }, decisions: { x: 1 } } }, { beforeRead: async (p) => { reads.push(p); } });
  await _internals.list(db);
  assert.ok(!reads.some((p) => p.includes("items/under") || p.includes("decisions") || p === "bf_campaign_2026"), reads.join());
  const u = await _internals.list(db, "under");
  assert.deepEqual(u.review.map((r) => r.pid), ["u"]);
  await assert.rejects(_internals.list(db, "../x"), /main or under/);
});

test("Approve moves a product to Approved; Reject removes it from the list; rejections PERSIST and can be undone from the Rejected list", async () => {
  const db = seed();
  const r = await tap(db, { action: "approve", pid: "c" }, 5000);
  assert.equal(r.row.tab, "approved");
  assert.deepEqual({ ...(await pick(db, "c")), rev: undefined }, { state: "approved", sig: "current", shown: "https://x/Cap C.jpg", at: 5000, by: "junid", section: "main", price: 150, kind: "headwear", name: "Cap C", sizes: "M-XL", photoFrom: "app", rev: undefined });
  await tap(db, { action: "reject", pid: "d" }, 6000);
  // The 05:00 rebuild writes the product again — it stays rejected.
  await db.ref("bf_campaign_2026/items/main/d").set(it_("Hoodie D", 450, 14));
  let v = await _internals.list(db);
  assert.deepEqual(v.review.map((x) => x.pid), ["a", "b"]);
  assert.deepEqual(v.approved.map((x) => x.pid), ["c"]);
  assert.deepEqual(v.rejected.map((x) => [x.pid, x.name]), [["d", "Hoodie D"]]);
  assert.deepEqual(v.totals, { review: 2, underReview: 2, approved: 1, rejected: 1, spentZar: 0, noPriceApproved: 0, newArrivals: 0, approvedNa: 0, approvedNormal: 1 });
  await tap(db, { action: "reset", pid: "d" }, 7000);
  v = await _internals.list(db);
  assert.ok(v.review.some((x) => x.pid === "d"), "undo brings it back to To review");
  assert.ok((await pick(db, "d")).rev > 0, "the node stays (rev)");
  // An under-13 product is approved the same way.
  assert.equal((await tap(db, { action: "approve", pid: "u", section: "under" })).row.tab, "approved");
});

test("Approve all 30+: every untouched 30+ product in MAIN; never a rejected one; still rejectable after", async () => {
  const db = seed();
  await tap(db, { action: "reject", pid: "b" });
  const r = await _internals.approveBig(db, { a: "current", b: "current" }, "junid", 9000);
  assert.equal(r.approved, 1);
  assert.deepEqual(r.pids, ["a"], "the pids, for Undo");
  assert.equal((await pick(db, "a")).state, "approved");
  assert.equal((await pick(db, "b")).state, "rejected", "a rejection is never overridden");
  assert.equal(await pick(db, "c"), null, "20 on hand is not 30+");
  await tap(db, { action: "reject", pid: "a" });
  assert.equal((await pick(db, "a")).state, "rejected");
});

test("the photo approved is PINNED: a photo the 05:00 rebuild brings in is not approved until Junid sees it", async () => {
  const db = seed();
  await tap(db, { action: "approve", pid: "a" });
  await db.ref("bf_campaign_2026/items/main/a/photo").set("https://x/new-photo.jpg");
  const v = await _internals.list(db);
  assert.equal(v.review.find((x) => x.pid === "a").changedSinceApproval, true);
  assert.equal((await tap(db, { action: "approve", pid: "a" }, 2000)).row.tab, "approved");
  assert.equal((await pick(db, "a")).shown, "https://x/new-photo.jpg");
});

test("Approve approves only the photo the card showed (a generation that landed meanwhile is refused)", async () => {
  const db = seed();
  await db.ref("bf_campaign_2026/photos/a").set({ use: "generated", genId: "g1790000000001", gens: { g1790000000001: { url: "u" } }, rev: 1 });
  assert.match((await tap(db, { action: "approve", pid: "a", sig: "current" })).refusal, /photo changed/);
  assert.equal((await tap(db, { action: "approve", pid: "a", sig: "g1790000000001" })).row.tab, "approved");
  await assert.rejects(tap(db, { action: "approve", pid: "b", sig: "../x" }), /Which photo/);
});

test("Approve all 30+ never overwrites a reject made in the same moment, nor a photo the card did not show", async () => {
  const db = seed();
  await db.ref("bf_campaign_2026/photos/b").set({ use: "generated", genId: "g1790000000002", gens: { g1790000000002: { url: "u" } }, rev: 1 });
  // The card showed a and b with their current photos; meanwhile b got a generation and a was rejected.
  await tap(db, { action: "reject", pid: "a" });
  const r = await _internals.approveBig(db, { a: "current", b: "current", c: "current" }, "junid", 9000);
  assert.equal(r.approved, 0);
  assert.equal((await pick(db, "a")).state, "rejected");
  assert.equal(await pick(db, "b"), null);
  assert.equal(await pick(db, "c"), null, "20 on hand is never in Approve all 30+");
});

test("counts include only products in the campaign now (idx); under-13 approvals show on the Approved tab", async () => {
  const db = seed({ idx: { a: "m", b: "m", c: "m", d: "m", u: "u", v: "u" } });
  await tap(db, { action: "reject", pid: "a" });
  await tap(db, { action: "approve", pid: "u", section: "under" });
  // a sells out and leaves the campaign.
  await db.ref("bf_campaign_2026/idx/a").remove();
  await db.ref("bf_campaign_2026/items/main/a").remove();
  await db.ref("bf_campaign_2026/meta/main").set(3);
  const v = await _internals.list(db);
  assert.deepEqual(v.totals, { review: 3, underReview: 1, approved: 1, rejected: 0, spentZar: 0, noPriceApproved: 0, newArrivals: 0, approvedNa: 0, approvedNormal: 1 });
  assert.deepEqual(v.rejected, [], "no ghost in Rejected (n)");
  assert.deepEqual(v.approved.map((x) => x.pid), ["u"], "the under-13 approval is on the Approved tab");
  assert.ok(!v.review.some((x) => x.pid === "u"));
});

test("AN APPROVAL IS OF A PHOTO: a new generation sends the product back to To review", async () => {
  const db = seed();
  await tap(db, { action: "approve", pid: "a" });
  await db.ref("bf_campaign_2026/photos/a").set({ use: "generated", genId: "g1790000000001", gens: { g1790000000001: { url: "u" } }, rev: 1 });
  const v = await _internals.list(db);
  const a = v.review.find((x) => x.pid === "a");
  assert.equal(a.changedSinceApproval, true);
  assert.equal(a.shown, "u");
  assert.equal((await tap(db, { action: "approve", pid: "a" }, 2000)).row.tab, "approved");
  assert.equal((await pick(db, "a")).sig, "g1790000000001");
  assert.match((await tap(db, { action: "use", pid: "b", use: "generated" })).refusal, /tap Generate/);
});

test("multi-select: approve many (each with the photo shown), reject many, and Undo (back to review) — one transaction each", async () => {
  const db = seed();
  await db.ref("bf_campaign_2026/photos/b").set({ use: "generated", genId: "g1790000000002", gens: { g1790000000002: { url: "u" } }, rev: 1 });
  const r = await _internals.many(db, "approve", { a: "current", b: "current", c: "current", zz: "current" }, "junid", 5000);
  assert.deepEqual(r.done.sort(), ["a", "c"]);
  assert.deepEqual(r.refused.map((x) => x.pid).sort(), ["b", "zz"], "b's photo changed; zz is not in the campaign");
  const rj = await _internals.many(db, "reject", ["d", "u"], "junid", 6000);
  assert.deepEqual(rj.done.sort(), ["d", "u"]);
  const undo = await _internals.many(db, "reset", ["a", "c", "d", "u"], "junid", 7000);
  assert.equal(undo.done.length, 4);
  const v = await _internals.list(db);
  assert.equal(v.approved.length, 0);
  assert.equal(v.rejected.length, 0);
  await assert.rejects(_internals.many(db, "approve", { "../x": "current" }, "junid", 1), /Which product/);
  // Any real selection in one call (Junid ticked 574): no 500 cap, chunked inside.
  const big = await _internals.many(db, "reject", Array.from({ length: 600 }, (_, i) => `p${i}`), "junid", 8000);
  assert.equal(big.ok, true);
  assert.equal(big.done.length + big.refused.length, 600, "every one of the 600 answered");
  await assert.rejects(_internals.many(db, "reset", Array.from({ length: 20001 }, (_, i) => `p${i}`), "junid", 1), /Too many/);
});

test("UNDO fully reverses: an approved product rejected then undone is approved again with the SAME photo; a rejected one approved then undone is rejected again", async () => {
  const db = seed();
  await tap(db, { action: "approve", pid: "a" }, 1000);
  const before = await pick(db, "a");
  const rj = await _internals.many(db, "reject", ["a"], "junid", 2000);
  await _internals.restore(db, rj.undo, "junid", 3000);
  const after = await pick(db, "a");
  assert.deepEqual({ ...after, rev: 0 }, { ...before, rev: 0 }, "the original approval (sig, shown, at) is back");
  await tap(db, { action: "reject", pid: "b" }, 4000);
  const ap = await tap(db, { action: "approve", pid: "b" }, 5000);
  await _internals.restore(db, ap.undo, "junid", 6000);
  assert.equal((await pick(db, "b")).state, "rejected");
  const big = await _internals.approveBig(db, { a: "current" }, "junid", 7000);
  assert.deepEqual(big.undo, {}, "a is already approved: nothing to undo");
});

test("UNDO never clobbers a newer change; approveMany needs the photo shown", async () => {
  const db = seed();
  const ap = await tap(db, { action: "approve", pid: "c" }, 1000);
  await tap(db, { action: "reject", pid: "c" }, 2000); // a newer decision within the 6 s
  const u = await _internals.restore(db, ap.undo, "junid", 3000);
  assert.deepEqual(u.refused.map((x) => x.pid), ["c"]);
  assert.equal((await pick(db, "c")).state, "rejected");
  await assert.rejects(_internals.many(db, "approve", ["a"], "junid", 1), /photo the card showed/);
});

test("a failed generation shows on the row (photos/{pid}/failed)", () => {
  const row = core.viewItem("a", it_("A", 1, 20), { photo: { failed: { at: 5, reason: "Gemini returned the original photo" }, rev: 1 } });
  assert.deepEqual(row.failed, { at: 5, reason: "Gemini returned the original photo" });
  assert.equal(core.viewItem("a", it_("A", 1, 20), { photo: { rev: 1 } }).failed, null);
});

test("a category's AI look: established for sneakers and clothing; new kinds need Junid's approval", async () => {
  const db = seed();
  let v = await _internals.list(db);
  assert.equal(v.review.find((x) => x.pid === "a").styleApproved, true);
  assert.equal(v.review.find((x) => x.pid === "c").styleApproved, false, "caps & beanies: Use current photo by default");
  await _internals.approveStyle(db, "headwear", "junid", 1);
  v = await _internals.list(db);
  assert.equal(v.review.find((x) => x.pid === "c").styleApproved, true);
  await assert.rejects(_internals.approveStyle(db, "../x", "junid", 1), /category/);
});

test("bad input is refused before anything is written", async () => {
  const db = seed();
  await assert.rejects(tap(db, { action: "approve", pid: "../products" }), /Which product/);
  await assert.rejects(tap(db, { action: "approve", pid: "zz" }), /not in the campaign/);
  await assert.rejects(tap(db, { action: "post", pid: "a" }), /approve, reject/);
  assert.equal((await db.ref("bf_campaign_2026/picks").once("value")).val(), null);
});

// ── grouping at posting time ──────────────────────────────────────────────────
const P = (name, price, kind, at = 1, sig = "current") => ({ state: "approved", sig, at, price, kind, name, sizes: "M-L" });

test("ALBUMS AT POSTING: one stock price + one kind; clothing and sneakers never together; caps & beanies together, never with sneakers", () => {
  const albums = core.albumsOf({ t: P("Tee", 150, "clothing"), s: P("Shoe", 150, "sneakers"), c: P("Cap", 150, "headwear"), b: P("Beanie", 150, "headwear"), f: P("Perfume", 150, "perfume") });
  assert.deepEqual(albums.map((a) => [a.key, a.pids]), [["R150-clothing-1", ["t"]], ["R150-headwear-1", ["b", "c"]], ["R150-perfume-1", ["f"]], ["R150-sneakers-1", ["s"]]]);
});

test("albums over 30 photos (or a caption past 950 characters) split into parts", () => {
  const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, P(`T${String(i).padStart(2, "0")}`, 300, "clothing")]));
  const a = core.albumsOf(many);
  assert.deepEqual(a.map((x) => [x.key, x.pids.length]), [["R300-clothing-1", 16], ["R300-clothing-2", 15]]);
  const long = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`q${i}`, { ...P(`Nike Air Max Plus TN Triple Black Edition ${i}`, 650, "sneakers"), sizes: "3-4-5-6-7-8-9-10-11-12" }]));
  for (const x of core.albumsOf(long)) assert.ok(core.captionPreview(650, x.pids.map((pid) => long[pid])).length <= 950);
});

test("the album send id changes when a product is re-approved (a re-approval really posts again)", () => {
  const a1 = core.albumsOf({ t: P("Tee", 150, "clothing", 5) })[0];
  const a2 = core.albumsOf({ t: P("Tee", 150, "clothing", 9) })[0];
  assert.notEqual(a1.lap, a2.lap);
  assert.match(styles.promptFor("headwear"), /Do not add a box/);
  assert.doesNotMatch(styles.promptFor("perfume", { hasBox: true }), /Do not add a box/);
});

test("only approved products with the photo they show, and not yet posted for this approval, are posted", () => {
  const picks = { a: P("A", 1, "clothing", 5), b: P("B", 1, "clothing", 5, "g1"), r: { state: "rejected" }, p: P("P", 1, "clothing", 7) };
  const photos = { b: { use: "generated", genId: "g2", gens: { g2: {} } } };
  const posted = { p: { approvedAt: 7, at: 9 } };
  assert.deepEqual(Object.keys(core.toPost(picks, photos, posted)), ["a"]);
  assert.deepEqual(Object.keys(core.toPost({ ...picks, p: P("P", 1, "clothing", 10) }, photos, posted)), ["a", "p"], "re-approved after posting: posts again");
});

test("NOTHING POSTS WITHOUT A SCHEDULE; the plan is shown before confirming; a tap never pulls an album forward", async () => {
  const db = seed();
  await tap(db, { action: "approve", pid: "a" }, T("2026-11-20T07:00:00"));
  assert.equal((await db.ref("bf_campaign_2026/schedule").once("value")).val(), null);
  const s = { mode: "gap", start: T("2026-11-20T09:00:00"), gapMin: 60 };
  const pv = await _internals.schedule(db, s, { confirm: false }, "junid", T("2026-11-20T07:00:00"));
  assert.deepEqual(pv.plan.map((p) => [p.label, fmt(p.due), p.count]), [["R300 Clothing", "11-20 09:00", 1]]);
  assert.equal((await db.ref("bf_campaign_2026/schedule").once("value")).val(), null, "a preview writes nothing");
  await _internals.schedule(db, s, { confirm: true }, "junid", T("2026-11-20T07:00:00"));
  await tap(db, { action: "approve", pid: "b" }, T("2026-11-20T07:10:00"));
  const plan = (await db.ref("bf_campaign_2026/schedule/plan").once("value")).val();
  assert.deepEqual(Object.entries(plan).map(([k, e]) => [k, fmt(e.due), Object.keys(e.pids)]).sort(), [["R300-clothing-1", "11-20 09:00", ["a"]], ["R300-sneakers-1", "11-20 10:00", ["b"]]]);
  assert.ok(Number.isSafeInteger(plan["R300-clothing-1"].lap));
  const v = await _internals.list(db);
  assert.equal(v.plan.length, 2);
  await _internals.clearSchedule(db, "junid", 1);
  assert.equal((await db.ref("bf_campaign_2026/schedule").once("value")).val(), null);
});

test("a schedule never confirmed gets no plan, whatever is approved", async () => {
  const db = seed({ schedule: { mode: "gap", from: "08:00", to: "20:00", start: 1, gapMin: 30 } });
  await tap(db, { action: "approve", pid: "a" }, T("2026-11-20T07:00:00"));
  assert.equal((await db.ref("bf_campaign_2026/schedule/plan").once("value")).val(), null);
});

test("planAlbums: kept while ahead or not posted; a posted album's new members get a fresh slot", () => {
  const s = { mode: "gap", from: "08:00", to: "20:00", start: T("2026-11-20T08:00:00"), gapMin: 60 };
  const a1 = { key: "R1-clothing-1", price: 1, part: 1, pids: ["x"], lap: 1, firstAt: 1 };
  const first = core.planAlbums([a1], s, T("2026-11-20T07:00:00"));
  assert.equal(fmt(first["R1-clothing-1"].due), "11-20 08:00");
  // 08:05: not posted yet (the Mac was asleep) → keeps 08:00.
  assert.equal(fmt(core.planAlbums([a1], s, T("2026-11-20T08:05:00"), first, {})["R1-clothing-1"].due), "11-20 08:00");
  // 08:05: x posted at 08:01 and y joined that key → a fresh slot, never "already sent".
  const a2 = { ...a1, pids: ["y"], lap: 2, firstAt: 2 };
  const next = core.planAlbums([a2], s, T("2026-11-20T08:05:00"), first, { x: { album: "R1-clothing-1", at: T("2026-11-20T08:01:00") } });
  assert.equal(fmt(next["R1-clothing-1"].due), "11-20 08:05");
  assert.equal(next["R1-clothing-1"].lap, 2);
});

test("schedule maths still hold (gap walks the window; spread; post-all-now capped; bad input refused)", () => {
  const q = ["a", "b", "c", "d"].map((k, i) => ({ key: k, approvedAt: i, price: 300 }));
  assert.deepEqual(Object.values(core.planSchedule(q, { mode: "gap", from: "08:00", to: "20:00", start: T("2026-11-20T18:30:00"), gapMin: 60 }, T("2026-11-20T07:00:00"))).map(fmt), ["11-20 18:30", "11-20 19:30", "11-21 08:30", "11-21 09:30"]);
  assert.deepEqual(Object.keys(core.planSchedule(q.slice(0, 2), { mode: "now", start: core.CAMPAIGN_END_MS - 60_000 }, core.CAMPAIGN_END_MS - 60_000)), ["a"]);
  assert.deepEqual(core.planSchedule(q, null, 0), {});
  assert.match(core.cleanSchedule({ mode: "gap", start: 1, gapMin: 1 }, 0).error, /gap/);
  assert.equal(core.inWindow({ mode: "gap", from: "08:00", to: "20:00" }, T("2026-11-20T03:00:00")), false);
});

// ── the house look per kind ───────────────────────────────────────────────────
test("styles: the sneaker formula is never used for anything else; each kind its own staging; the item kept exactly", () => {
  for (const k of ["headwear", "perfume", "bags", "belts", "sunglasses", "watches", "jewellery", "accessories", "something-new"]) {
    const p = styles.promptFor(k, { conditionClause: "COND" });
    assert.match(p, /NEVER turn it into another kind of product, NEVER change its colour/);
    assert.match(p, /COND$/);
    assert.doesNotMatch(p, /side-on|toe to the right|SHOE PHOTO|one direction/i, `${k}: no sneaker formula`);
  }
  assert.match(styles.promptFor("headwear"), /AS HEADWEAR/);
  assert.match(styles.promptFor("bags"), /Never lighten, brighten, fade or shift it/);
  assert.match(styles.promptFor("watches"), /show EVERY piece of the set/);
  assert.match(styles.promptFor("perfume", { hasBox: true }), /BOX \(the third image\)/);
  assert.match(styles.promptFor("perfume", { hasBox: true }), /UPRIGHT/);
  assert.doesNotMatch(styles.promptFor("perfume"), /third image/);
  assert.equal(styles.stagingFor("perfume").plate, "footwear-plate.png");
  assert.equal(styles.stagingFor("headwear").plate, "fence-single.png");
  assert.equal(styles.clothingKeyFor("suits"), "tracksuits", "a set: the wider two-piece fence");
  assert.equal(styles.clothingKeyFor("hoodies"), "hoodies");
  assert.equal(styles.clothingKeyFor("shirts"), "baseball-shirts");
});

// ── bfGenerate through the real engine ───────────────────────────────────────
const NA_GENERATION = require("../newArrivals/studio/config/generation.json");
const png = (w, h, colour) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();
async function genWorld({ geminiW = 1728, geminiH = 2304, pid = "a", product = {} } = {}) {
  const db = seed();
  await db.ref(`products/${pid}`).set({ name: "X", categoryKey: "hoodies", photoUrl: `https://x/${pid}.jpg`, stockPrice: 300, ...product });
  const uploads = [], calls = [];
  let clock = 1_791_200_000_000;
  const plate = { buffer: await png(543, 724, "#888"), width: 543, height: 724, file: "fence-single.png" };
  const deps = {
    now: () => (clock += 1000),
    bucket: { name: "b", file: (p) => ({ save: async (buf) => { uploads.push({ path: p, buf }); } }) },
    fetchBytes: async (url) => { calls.push(["fetch", url]); return { buffer: await png(400, 500, "#a52") }; },
    assets: { loadPlate: async () => plate, loadReference: async () => null, libraryBox: async () => null, loadExamples: async () => [], loadPlateFile: async (f) => { calls.push(["plate", f]); return { ...plate, file: f, forModel: plate.buffer }; } },
    fx: async () => ({ rate: 18 }),
    image: async (model, parts, imageConfig) => {
      calls.push(["image", model, imageConfig, parts.filter((x) => x.text).map((x) => x.text).join("\n")]);
      return { buffer: await png(geminiW, geminiH, "#777"), mime: "image/png", usage: { promptTokenCount: 9000, candidatesTokenCount: 2000, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 2000 }] }, request: { imageConfig } };
    },
  };
  return { db, deps, uploads, calls };
}

test("Generate (clothing): the ONE shared generator, exactly as New Arrivals runs it (4K, the full-resolution JPEG q92 master), under black_friday/", async () => {
  const w = await genWorld();
  const out = await gen.bfGenerate(w.db, { pid: "a" }, "junid", w.deps);
  assert.equal(out.kind, "clothing");
  const image = w.calls.filter((c) => c[0] === "image");
  assert.equal(image.length, 1);
  assert.equal(image[0][2].imageSize, NA_GENERATION.imageSize, "the shared generator's size");
  assert.equal(image[0][2].imageSize, "4K");
  const final = w.uploads.find((u) => /\/gen_\d+\.(png|jpg)$/.test(u.path));
  assert.match(final.path, /^products\/a\/black_friday\//);
  const fm = await sharp(final.buf).metadata();
  assert.deepEqual([fm.format, fm.width, fm.height], ["jpeg", 1728, 2304], "the master at the model's full resolution, JPEG — never shrunk to the plate, never PNG");
  assert.ok(!w.uploads.some((u) => u.path.includes("/new_arrivals/")));
  const v = await _internals.list(w.db);
  assert.deepEqual([v.review.find((x) => x.pid === "a").use, v.review.find((x) => x.pid === "a").generations], ["generated", 1]);
});

test("Generate (footwear): the last-good request — 4K, Gemini composes the whole photo (the plate-lock paste is never run)", async () => {
  const w = await genWorld({ product: { categoryKey: "sneakers" } });
  await w.db.ref(`${core.ROOT}/items/main/a/kind`).set("sneakers");
  const seen = [];
  w.deps.correct = async (args) => { seen.push(args); return { problem: "test: not placed" }; };
  await gen.bfGenerate(w.db, { pid: "a" }, "junid", w.deps).catch(() => {});
  const image = w.calls.filter((c) => c[0] === "image");
  assert.equal(image[0][2].imageSize, "4K");
  assert.equal(seen.length, 0, "no cut-out-and-paste onto the plate: that made the shoe small and the box float");
  assert.match(image[0][3], /the shoe's heel at x=17\.8%, its toe tip at x=83\.8% \(shoe 66% of the frame width\)/, "the 2 Oct (last-good) placement");
});

test("Generate: a result that is really the original photo is never shown — 'Failed, tap to retry', nothing charged to the item", async () => {
  const w = await genWorld();
  const same = await png(400, 500, "#a52");
  w.deps.image = async (model, parts, imageConfig) => ({ buffer: same, mime: "image/png", usage: { promptTokenCount: 9000, candidatesTokenCount: 2000 }, request: { imageConfig } });
  await assert.rejects(() => gen.bfGenerate(w.db, { pid: "a" }, "junid", w.deps), /Failed, tap to retry/);
  const ph = (await w.db.ref(`${core.ROOT}/photos/a`).once("value")).val() || {};
  assert.ok(ph.failed && /Failed, tap to retry/.test(ph.failed.reason), "the card's failed mark");
  assert.notEqual(ph.use, "generated");
  const st = (await w.db.ref(`${core.ROOT}/stats`).once("value")).val() || {};
  assert.ok(!st.spentZar, "the card's AI spend is not charged");
  // The next real photo clears the mark.
  const w2image = w.deps.image;
  w.deps.image = async (model, parts, imageConfig) => ({ buffer: await png(1728, 2304, "#777"), mime: "image/png", usage: { promptTokenCount: 9000, candidatesTokenCount: 2000 }, request: { imageConfig } });
  await gen.bfGenerate(w.db, { pid: "a" }, "junid", w.deps);
  assert.equal(((await w.db.ref(`${core.ROOT}/photos/a`).once("value")).val() || {}).failed, undefined);
  void w2image;
});

test("Generate: a photo that CARRIES JUNID'S PLATE is never refused as 'the original', even when the staff photo was taken on the shop's fence and looks alike", async () => {
  const w = await genWorld();
  // The staff photo IS (near enough) the plate: the old rule (difference < 12 → refused) failed a real photo here.
  const plateLike = await png(400, 500, "#888");
  w.deps.fetchBytes = async (url) => { w.calls.push(["fetch", url]); return { buffer: plateLike }; };
  w.deps.image = async (model, parts, imageConfig) => ({ buffer: await png(1728, 2304, "#888"), mime: "image/png", usage: { promptTokenCount: 9000, candidatesTokenCount: 2000 }, request: { imageConfig } });
  const out = await gen.bfGenerate(w.db, { pid: "a" }, "junid", w.deps);
  assert.equal(out.ok, true);
  const ph = (await w.db.ref(`${core.ROOT}/photos/a`).once("value")).val();
  assert.equal(ph.failed, undefined);
  assert.equal(ph.use, "generated");
});

test("Generate (caps & beanies): its OWN staging on the fence plate, New Arrivals' model at 4K, saved as JPEG q92 — never the sneaker or hanger formula", async () => {
  const w = await genWorld({ pid: "c", product: { categoryKey: "caps-beanies", category: "Clothing" } });
  const out = await gen.bfGenerate(w.db, { pid: "c" }, "junid", w.deps);
  assert.equal(out.kind, "headwear");
  const image = w.calls.find((c) => c[0] === "image");
  assert.equal(image[1], NA_GENERATION.imageModel, "New Arrivals' image model");
  assert.equal(image[2].imageSize, "4K");
  assert.match(image[3], /AS HEADWEAR/);
  assert.doesNotMatch(image[3], /pedestal|hanger|side-on/i);
  assert.deepEqual(w.calls.find((c) => c[0] === "plate"), ["plate", "fence-single.png"]);
  const final = w.uploads.find((u) => /\/gen_\d+\.jpg$/.test(u.path));
  assert.match(final.path, /^products\/c\/black_friday\//);
  const m = await sharp(final.buf).metadata();
  assert.deepEqual([m.width, m.height, m.format], [1728, 2304, "jpeg"], "the model's full resolution, JPEG not PNG");
  const ph = (await w.db.ref(`${core.ROOT}/photos/c`).once("value")).val();
  assert.equal(ph.gens[ph.genId].imageSize, "4K");
});

test("ONE BRAIN: footwear and clothing call New Arrivals' generator with its own model and size; a known clothing category is passed unchanged", async () => {
  const w = await genWorld({ product: { categoryKey: "t-shirts" } });
  await gen.bfGenerate(w.db, { pid: "a" }, "junid", w.deps);
  const image = w.calls.filter((c) => c[0] === "image");
  assert.equal(image[0][1], NA_GENERATION.imageModel);
  assert.equal(image[0][2].imageSize, NA_GENERATION.imageSize);
  assert.doesNotMatch(image[0][3], /Black Friday/, "New Arrivals' own prompt, not a Black Friday one");
  const ph = (await w.db.ref(`${core.ROOT}/photos/a`).once("value")).val();
  assert.equal(ph.gens[ph.genId].pipeline, "shared");
  assert.equal(ph.gens[ph.genId].finish, "master-jpeg-q92");
  assert.equal(ph.gens[ph.genId].model, NA_GENERATION.imageModel);
});

test("Generate (perfume): upright on the pedestal plate, with its box when it has one", async () => {
  const w = await genWorld({ pid: "v", product: { categoryKey: "perfumes", category: "Perfume", photoBoxUrl: "https://x/box.jpg" } });
  const out = await gen.bfGenerate(w.db, { pid: "v", section: "under" }, "junid", w.deps);
  assert.equal(out.kind, "perfume");
  assert.deepEqual(w.calls.find((c) => c[0] === "plate"), ["plate", "footwear-plate.png"]);
  assert.ok(w.calls.some((c) => c[0] === "fetch" && c[1] === "https://x/box.jpg"));
  assert.match(w.calls.find((c) => c[0] === "image")[3], /UPRIGHT/);
});

test("Generate: refused for a product not in the campaign, while one is being made, and while generation is paused", async () => {
  const w = await genWorld();
  await assert.rejects(gen.bfGenerate(w.db, { pid: "zz" }, "junid", w.deps), /not in the campaign/);
  await w.db.ref("bf_campaign_2026/photos/a").set({ generating: { at: 1_791_200_000_500 }, rev: 1 });
  await assert.rejects(gen.bfGenerate(w.db, { pid: "a" }, "junid", w.deps), /already being made/);
  await w.db.ref("new_arrivals/pause/generation/paused").set(true);
  await assert.rejects(gen.bfGenerate(w.db, { pid: "b" }, "junid", w.deps), /Paused/);
  assert.equal(w.calls.filter((c) => c[0] === "image").length, 0);
});

test("Generate: a failed model call gives the product back unchanged", async () => {
  const w = await genWorld({ pid: "c", product: { categoryKey: "caps-beanies" } });
  w.deps.image = async () => { const e = new Error("busy"); e.status = 503; throw e; };
  await assert.rejects(gen.bfGenerate(w.db, { pid: "c" }, "junid", w.deps), /busy — tap Generate again/);
  const ph = (await w.db.ref("bf_campaign_2026/photos/c").once("value")).val();
  assert.equal(ph.generating, undefined);
  assert.equal(ph.gens, undefined);
});

test("SELECTION is kept on the server as Junid ticks: saved, read back, replaced, cleared; bad input refused", async () => {
  const db = seed();
  const sigs = Object.fromEntries(Array.from({ length: 574 }, (_, i) => [`p${i}`, "current"]));
  assert.deepEqual(await _internals.saveSelection(db, "junid", sigs, 100), { ok: true, saved: 574 });
  const back = await _internals.loadSelection(db, "junid");
  assert.equal(Object.keys(back.sigs).length, 574);
  assert.equal(back.at, 100);
  await _internals.saveSelection(db, "junid", { a: "current" }, 200);
  assert.deepEqual((await _internals.loadSelection(db, "junid")).sigs, { a: "current" }, "replaced, never merged");
  assert.equal(await _internals.loadSelection(db, "someone-else"), null, "per admin");
  await _internals.saveSelection(db, "junid", {}, 300);
  assert.equal(await _internals.loadSelection(db, "junid"), null, "empty clears it");
  await assert.rejects(_internals.saveSelection(db, "junid", { "../x": "current" }, 1), /Which product/);
  await assert.rejects(_internals.saveSelection(db, "junid", { a: "<script>" }, 1), /Which photo/);
  await assert.rejects(_internals.saveSelection(db, null, { a: "current" }, 1), /Sign in/);
});

test("POSTING BRAIN: the card reads brain/view and writes only brain/control (Pause, a slot time inside 07:00–21:30)", async () => {
  const db = seed();
  await db.ref(`${core.ROOT}/brain/view`).set({ posted: 3, days: {} });
  assert.equal((await _internals.brainView(db)).posted, 3);
  await _internals.brainPause(db, true, "junid", 1);
  assert.equal((await _internals.brainView(db)).paused, true);
  await _internals.brainSlot(db, { day: "2026-11-21", i: 1, at: "14:15" }, "junid", 2);
  assert.equal((await _internals.brainView(db)).overrides["2026-11-21"][1], "14:15");
  await assert.rejects(_internals.brainSlot(db, { day: "2026-11-21", i: 1, at: "23:00" }, "junid", 3), /never 22:00/);
  await assert.rejects(_internals.brainSlot(db, { day: "2026-12-01", i: 1, at: "10:00" }, "junid", 3), /day of the campaign/);
});

test("CAPTION (Junid 20 Nov): two lines, every in-stock size, never a range", () => {
  const cap = require("../blackFriday/caption.cjs");
  assert.equal(core.captionPreview(750, [{ sizes: "6-11" }]), "R750\nAvailable sizes: 6, 7, 8, 9, 10, 11");
  assert.equal(cap.sizesLine(["6", "7", "9", "10"]), "6, 7, 9, 10");
  assert.equal(cap.sizesLine(["6", "6.5", "7"]), "6, 6.5, 7");
  assert.equal(cap.sizesLine(["XXL", "S", "L", "M", "XL"]), "S, M, L, XL, XXL");
  assert.equal(core.captionPreview(300, [{ sizes: "one size" }]), "R300\nAvailable sizes: one size");
  assert.doesNotMatch(core.captionPreview(650, [{ sizes: "M-XL" }, { sizes: "S" }]), /BLACK FRIDAY|🔥|EACH|Message us/);
});
