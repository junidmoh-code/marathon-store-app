// Black Friday card × New Arrivals (Junid, 20 Nov 2026): the New Arrivals tab is the
// New Arrivals queue itself, and approving in either place is ONE approval.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { _internals: bf } = require("../blackFriday/blackFriday.js");
const naLib = require("../blackFriday/na.cjs");
const core = require("../blackFriday/core.cjs");
const { _internals: na } = require("../newArrivals/newArrivals.js");

const DAY = 86_400_000;
const NOW = 1_795_150_000_000; // 20 Nov 2026
const pidAt = (daysAgo, n = 0) => `p${NOW - Math.round(daysAgo * DAY) + n}`;
const photo = (p) => `https://firebasestorage.googleapis.com/v0/b/b/o/products%2F${p}%2Fphoto.jpg?alt=media`;
const read = async (db, p) => (await db.ref(p).once("value")).val();

const NEW1 = pidAt(1), NEW2 = pidAt(3), NEWMAIN = pidAt(5), BAG = pidAt(2), OLD = pidAt(40), GEN = pidAt(4);
function world() {
  const tree = {
    locations: { central: { name: "Central" } }, products: {}, stock: { central: {} }, new_arrivals: { items: {}, by_status: {} },
    bf_campaign_2026: {
      meta: { builtAt: 1, main: 2, under: 0 },
      items: { main: { [NEWMAIN]: { name: "New Tee", price: 300, qty: 40, sizes: "S-XL", photo: photo(NEWMAIN), kind: "clothing", na: true }, a: { name: "Old Tee", price: 300, qty: 50, sizes: "M", photo: "https://x/a.jpg", kind: "clothing" } } },
      idx: { [NEWMAIN]: "m", a: "m" },
    },
  };
  const add = (pid, { status = "new", product = {}, units = 3, item = {} } = {}) => {
    tree.products[pid] = { name: `Item ${pid.slice(-4)}`, categoryKey: "sneakers", category: "Footwear", stockPrice: 650, sizes: ["7", "8"], photoUrl: photo(pid), ...product };
    if (units > 0) tree.stock.central[pid] = { 7: { qty: units } };
    tree.new_arrivals.items[pid] = { pid, status, enqueuedAt: 1, statusAt: 1, ...item };
    (tree.new_arrivals.by_status[status] ||= {})[pid] = 1;
  };
  add(NEW1); add(NEW2, { product: { categoryKey: "caps-beanies", category: "Clothing", name: "Lacoste cap" } });
  add(NEWMAIN, { product: { categoryKey: "t-shirts", category: "Clothing" } });
  add(BAG, { product: { categoryKey: "packaging", name: "Paper bag large" } });
  add(GEN, { status: "ready", item: { currentGen: "g1795100000000", generatedUrl: "https://x/gen.jpg", generations: { g1795100000000: { url: "https://x/gen.jpg" } } } });
  add(OLD, { status: "done", item: { approvedAt: 1_700_000_000_000, generatedUrl: "https://x/old.jpg" } });
  return makeFakeDb(tree);
}
const list = (db) => bf.list(db, "main", NOW);
const tap = (db, args) => bf.tap(db, args, "junid", NOW);

test("New Arrivals tab: the past 20 days, in stock, newest first, upload date on each row; no paper bags; a new 13+ product only here", async () => {
  const db = world();
  const v = await list(db);
  assert.deepEqual(v.newArrivals.map((r) => r.pid), [NEW1, NEW2, GEN, NEWMAIN]);
  assert.equal(v.newArrivals[0].uploadedAt, Number(NEW1.slice(1)));
  assert.equal(v.newArrivals.find((r) => r.pid === NEW2).kind, "headwear", "the build's kind rule");
  assert.equal(v.newArrivals.find((r) => r.pid === NEW2).canGenerate, false, "New Arrivals' generator frames footwear and clothing only");
  assert.equal(v.newArrivals.find((r) => r.pid === GEN).shown, "https://x/gen.jpg", "its New Arrivals AI photo");
  assert.ok(!v.review.some((r) => r.pid === NEWMAIN), "new and 13+: only under New Arrivals");
  assert.deepEqual(v.review.map((r) => r.pid), ["a"]);
  assert.equal(v.totals.review, 1);
  assert.equal(v.totals.newArrivals, 4);
});

test("Approve (current photo) on the New Arrivals tab IS the New Arrivals approval; the pick mirrors it; the approval is kept for ever", async () => {
  const db = world();
  const r = await tap(db, { action: "approve", pid: NEW1, sig: "current" });
  assert.equal(r.ok, true);
  assert.equal(await read(db, `new_arrivals/items/${NEW1}/status`), "approved");
  assert.equal(await read(db, `new_arrivals/items/${NEW1}/useCurrentPhoto`), true);
  const p = await read(db, `bf_campaign_2026/picks/${NEW1}`);
  assert.deepEqual([p.state, p.src, p.section, p.shown, p.price, p.kind], ["approved", "na", "newArrivals", photo(NEW1), 650, "sneakers"]);
  const led = await read(db, `bf_campaign_2026/approvals/${NEW1}`);
  assert.equal(Object.values(led)[0].photo, photo(NEW1));
  const v = await list(db);
  assert.ok(!v.newArrivals.some((x) => x.pid === NEW1));
  const row = v.approved.find((x) => x.pid === NEW1);
  assert.ok(row && row.na, "Approved, in the New Arrivals section");
  assert.equal(v.totals.approvedNa, 1);
  assert.equal(r.undo[NEW1].expectAt, p.at);
});

test("Approve a New Arrival with its AI photo: that exact photo is approved and pinned", async () => {
  const db = world();
  const r = await tap(db, { action: "approve", pid: GEN, sig: "g1795100000000" });
  assert.equal(r.ok, true);
  assert.equal(await read(db, `new_arrivals/items/${GEN}/status`), "approved");
  assert.equal((await read(db, `bf_campaign_2026/picks/${GEN}`)).shown, "https://x/gen.jpg");
  assert.ok(core.isApproved(await read(db, `bf_campaign_2026/picks/${GEN}`), null));
});

test("Approve with no AI photo and no 'current' asks for Use current photo or Generate", async () => {
  const db = world();
  const r = await tap(db, { action: "approve", pid: NEW1 });
  assert.equal(r.ok, false);
  assert.match(r.refusal, /Use current photo, or Generate/);
});

test("Reject = New Arrivals skip; Back to review = restore; Undo of an approval = un-approve — the pick follows each time", async () => {
  const db = world();
  await tap(db, { action: "reject", pid: NEW2 });
  assert.equal(await read(db, `new_arrivals/items/${NEW2}/status`), "skipped");
  assert.equal((await read(db, `bf_campaign_2026/picks/${NEW2}`)).state, "rejected");
  let v = await list(db);
  assert.ok(v.rejected.some((x) => x.pid === NEW2));
  await tap(db, { action: "reset", pid: NEW2 });
  assert.equal(await read(db, `new_arrivals/items/${NEW2}/status`), "new");
  assert.equal((await read(db, `bf_campaign_2026/picks/${NEW2}`)).state, undefined);
  const a = await tap(db, { action: "approve", pid: NEW1, sig: "current" });
  const u = await bf.restore(db, a.undo, "junid", NOW + 1);
  assert.deepEqual(u.done, [NEW1]);
  assert.equal(await read(db, `new_arrivals/items/${NEW1}/status`), "new");
  v = await list(db);
  assert.ok(v.newArrivals.some((x) => x.pid === NEW1), "back on the New Arrivals tab");
});

test("A tap on the NEW ARRIVALS card mirrors into Black Friday (bfNaMirror's work); an old pre-campaign approval does not", async () => {
  const db = world();
  await na.useCurrent(db, { pid: NEW2 }, "junid", NOW);
  await naLib.mirror(db, NEW2, NOW);
  assert.equal((await read(db, `bf_campaign_2026/picks/${NEW2}`)).state, "approved");
  await na.unapprove(db, { pid: NEW2 }, "junid", NOW + 5);
  await naLib.mirror(db, NEW2, NOW + 5);
  assert.equal((await read(db, `bf_campaign_2026/picks/${NEW2}`)).state, undefined);
  await naLib.mirror(db, OLD, NOW);
  assert.equal(await read(db, `bf_campaign_2026/picks/${OLD}`), null, "done long before the campaign: not a Black Friday approval");
});

test("Multi-select Approve routes New Arrivals through New Arrivals and the rest as before", async () => {
  const db = world();
  const r = await bf.many(db, "approve", { [NEW1]: "current", a: "current" }, "junid", NOW);
  assert.deepEqual(r.done.sort(), [NEW1, "a"].sort());
  assert.equal(await read(db, `new_arrivals/items/${NEW1}/status`), "approved");
  assert.equal((await read(db, "bf_campaign_2026/picks/a")).src, undefined);
  assert.ok(await read(db, "bf_campaign_2026/approvals/a"), "every approval is recorded");
});

test("Posted products stay in Approved as 'Posted n× · last'; Repost queues them for the next slot (nothing reposts by itself)", async () => {
  const db = world();
  await tap(db, { action: "approve", pid: "a", sig: "current" });
  await db.ref("bf_campaign_2026/brain/sent/a").set({ n: 2, last: NOW - 1000 });
  let row = (await list(db)).approved.find((x) => x.pid === "a");
  assert.deepEqual([row.postedN, row.postedLast, row.repostQueued], [2, NOW - 1000, false]);
  const r = await bf.repost(db, ["a", NEW1], "junid", NOW);
  assert.deepEqual(r.done, ["a"]);
  assert.deepEqual(r.refused.map((x) => x.pid), [NEW1], "only approved products");
  row = (await list(db)).approved.find((x) => x.pid === "a");
  assert.equal(row.repostQueued, true);
});

test("mirrorPick is pure: approved / skipped / back to new, and a Black Friday approval of its own is never taken back", () => {
  const facts = { price: 500, kind: "sneakers", name: "X" };
  const appr = naLib.mirrorPick("p1", { status: "approved", approvedAt: NOW, generatedUrl: "https://g" }, facts, null, { inWindow: true });
  assert.deepEqual([appr.state, appr.src, appr.shown], ["approved", "na", "https://g"]);
  assert.equal(naLib.mirrorPick("p1", { status: "approved", approvedAt: NOW, generatedUrl: "https://g" }, facts, appr, { inWindow: true }), undefined, "already mirrored");
  assert.equal(naLib.mirrorPick("p1", { status: "new" }, facts, { state: "approved", sig: "current" }, { inWindow: true }), undefined);
  assert.deepEqual(naLib.mirrorPick("p1", { status: "new" }, facts, appr, { inWindow: true }), { name: "X" });
  assert.equal(naLib.kindOf({ categoryKey: "chains-bracelets", name: "Beanie black" }), "headwear");
});

test("architect review: an approval from before the campaign is never mirrored, even for a product in the 20-day window", () => {
  const p = naLib.mirrorPick("p1", { status: "done", approvedAt: naLib.CAMPAIGN_START_MS - 1, generatedUrl: "https://g" }, { price: 1 }, null, { inWindow: true });
  assert.equal(p, undefined);
});
test("architect review: a Black Friday approval made before (not mirrored) is taken back the old way", async () => {
  const db = world();
  await db.ref(`bf_campaign_2026/picks/${NEWMAIN}`).set({ state: "approved", sig: "current", shown: photo(NEWMAIN), at: 5, section: "main", price: 300, kind: "clothing", name: "New Tee" });
  const r = await tap(db, { action: "reset", pid: NEWMAIN });
  assert.equal(r.ok, true);
  assert.equal(r.noop, false);
  assert.equal((await read(db, `bf_campaign_2026/picks/${NEWMAIN}`)).state, undefined);
  assert.equal(await read(db, `new_arrivals/items/${NEWMAIN}/status`), "new", "the New Arrivals item is untouched");
});
test("architect review: an AI photo with no generation id approves that photo (sig 'na'), never the app photo", async () => {
  const db = world();
  await db.ref(`new_arrivals/items/${GEN}/currentGen`).set(null);
  const row = (await list(db)).newArrivals.find((x) => x.pid === GEN);
  assert.equal(row.sig, "na");
  await bf.many(db, "approve", { [GEN]: "na" }, "junid", NOW);
  assert.equal((await read(db, `bf_campaign_2026/picks/${GEN}`)).shown, "https://x/gen.jpg");
  assert.notEqual(await read(db, `new_arrivals/items/${GEN}/useCurrentPhoto`), true);
});
