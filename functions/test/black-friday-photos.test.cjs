// Black Friday card — Junid's own photo, Find online, Generate on every row and
// the R0 guard (Junid, 20 Nov 2026), against the fake RTDB, real sharp, and
// bfGenerate through the REAL shared engine with only Gemini and Storage faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const core = require("../blackFriday/core.cjs");
const naLib = require("../blackFriday/na.cjs");
const web = require("../blackFriday/websearch.cjs");
const { _internals: bf } = require("../blackFriday/blackFriday.js");
const gen = require("../blackFriday/generate.js")._internals;
const src = require("../blackFriday/sources.js")._internals;
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const R = core.ROOT;
const read = async (db, p) => (await db.ref(p).once("value")).val();
const jpeg = (w, h, colour = "#a52") => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).jpeg().toBuffer();
const png = (w, h, colour) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();
const it_ = (name, price, qty, kind = "clothing") => ({ name, price, qty, sizes: "M-XL", photo: `https://x/${name}.jpg`, kind });
const seed = () => makeFakeDb({
  [R]: {
    meta: { builtAt: 1, main: 3, under: 0 },
    items: { main: { a: it_("Tee A", 300, 45), c: it_("Cap C", 150, 20, "headwear"), z: it_("Zero Z", 0, 20) } },
    idx: { a: "m", c: "m", z: "m" },
  },
  products: { a: { name: "Tee A", brand: "Nike", photoUrl: "https://x/a.jpg", categoryKey: "hoodies" }, c: { name: "Cap C", brand: "New Era", colour: "Black", photoUrl: "https://x/c.jpg", categoryKey: "caps-beanies" } },
});
let clock = 1_795_200_000_000;
const uploads = [];
const deps = (over = {}) => ({
  now: () => (clock += 1000),
  upload: async (p, buf, mime) => { uploads.push({ p, buf, mime }); return { path: p, url: `https://firebasestorage.googleapis.com/v0/b/b/o/${encodeURIComponent(p)}?alt=media&token=t` }; },
  ...over,
});
const NOW = 1_795_150_000_000;

// ── R0 guard ─────────────────────────────────────────────────────────────────
test("R0: a product with no stock price can't be approved (one tap, bulk, 30+) — 'No price, set price first' on its row", async () => {
  const db = seed();
  const r = await bf.tap(db, { action: "approve", pid: "z", sig: "current" }, "junid", 5000);
  assert.deepEqual([r.ok, r.refusal], [false, "No price, set price first"]);
  assert.equal(await read(db, `${R}/picks/z`), null);
  const m = await bf.many(db, "approve", { z: "current", a: "current" }, "junid", 6000);
  assert.deepEqual(m.done, ["a"]);
  assert.deepEqual(m.refused, [{ pid: "z", refusal: "No price, set price first" }]);
  const v = await bf.list(db);
  assert.equal(v.review.find((x) => x.pid === "z").noPrice, true);
  assert.equal(v.approved.find((x) => x.pid === "a").noPrice, false);
  for (const missing of [null, undefined, "", 0, "0", -5, "abc"]) assert.equal(core.hasPrice(missing), false, String(missing));
  assert.equal(core.hasPrice(150), true);
});

test("R0: an approval made before the guard with no price is held back from posting and listed (noPriceApproved)", async () => {
  const db = seed();
  await db.ref(`${R}/picks/z`).set({ state: "approved", sig: "current", shown: "https://x/Zero Z.jpg", at: 10, price: 0, kind: "clothing", name: "Zero Z", section: "main" });
  await db.ref(`${R}/picks/a`).set({ state: "approved", sig: "current", shown: "https://x/Tee A.jpg", at: 11, price: 300, kind: "clothing", name: "Tee A", section: "main" });
  const v = await bf.list(db);
  assert.equal(v.totals.noPriceApproved, 1);
  assert.equal(v.approved.find((x) => x.pid === "z").noPrice, true);
  const picks = await read(db, `${R}/picks`);
  assert.deepEqual(Object.keys(core.toPost(picks, {}, {})), ["a"], "never planned for posting");
});

// ── Replace photo ────────────────────────────────────────────────────────────
test("Replace photo: stored at FULL resolution exactly as given, becomes the source and the photo shown; the app photo stays in the viewer", async () => {
  const db = seed();
  const big = await jpeg(3024, 4032);
  const out = await src.upload(db, { pid: "c", imageBase64: big.toString("base64") }, "junid", deps());
  assert.equal(out.ok, true);
  const up = uploads[uploads.length - 1];
  assert.match(up.p, /^products\/c\/black_friday\/src_\d+\.jpg$/);
  assert.ok(up.buf.equals(big), "the bytes he picked, untouched");
  const ph = await read(db, `${R}/photos/c`);
  assert.equal(ph.srcId, out.id);
  assert.deepEqual([ph.use, ph.genId], ["generated", out.id]);
  assert.deepEqual([ph.gens[out.id].src, ph.gens[out.id].width, ph.gens[out.id].height], ["upload", 3024, 4032]);
  const row = (await bf.list(db)).review.find((x) => x.pid === "c");
  assert.deepEqual([row.srcId, row.shown, row.shownFrom, row.generations], [out.id, out.url, "upload", 0]);
  assert.deepEqual(row.gallery.map((g) => g.label), ["App photo", "Your photo"]);
  assert.equal(await read(db, "products/c/photoUrl"), "https://x/c.jpg", "the app's own photo is never touched");
});

test("Replace photo: a photo turned by its EXIF orientation is stored the right way up at the same size; a non-image is refused", async () => {
  const turned = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#123" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const s = await src.storable(turned, sharp);
  assert.deepEqual([s.mime, s.width, s.height], ["image/jpeg", 300, 400]);
  await assert.rejects(() => src.storable(Buffer.from("not a photo"), sharp), /not a photo/);
  await assert.rejects(() => src.upload(seed(), { pid: "nope", imageBase64: "AA" }, "junid", deps()), /not on the Black Friday card/);
});

test("his photo is approved, pinned and posted exactly like a generated one (Approve / Undo; the poster's own sig rule accepts it)", async () => {
  const db = seed();
  const { id, url } = await src.upload(db, { pid: "c", imageBase64: (await jpeg(800, 800)).toString("base64") }, "junid", deps());
  const r = await bf.tap(db, { action: "approve", pid: "c", sig: id }, "junid", 7000);
  assert.equal(r.ok, true);
  const p = await read(db, `${R}/picks/c`);
  assert.deepEqual([p.sig, p.shown, p.photoFrom], [id, url, "upload"]);
  const photo = await read(db, `${R}/photos/c`);
  assert.equal(core.isApproved(p, photo), true);
  // The poster (marathon-group-poster src/bf/core.mjs): sigOf / generatedFor read photos.gens[genId].url.
  const posterSig = photo.use === "generated" && photo.genId && photo.gens && photo.gens[photo.genId] ? photo.genId : "current";
  assert.equal(posterSig, p.sig);
  assert.equal(photo.gens[posterSig].url, url, "the photo that posts is the one approved");
  const ledger = await read(db, `${R}/approvals/c`);
  assert.equal(Object.values(ledger)[0].photo, url);
  await bf.restore(db, r.undo, "junid", 8000);
  assert.equal((await read(db, `${R}/picks/c`)).state, undefined, "Undo: back to review");
});

test("an APPROVED product keeps posting its approved photo when he adds one: the new photo waits, and 'Use this photo' (Approved tab) approves it in the same tap", async () => {
  const db = seed();
  await bf.tap(db, { action: "approve", pid: "a", sig: "current" }, "junid", 5000);
  const { id, kept } = await src.upload(db, { pid: "a", imageBase64: (await jpeg(800, 800)).toString("base64") }, "junid", deps());
  assert.equal(kept, true);
  const ph = await read(db, `${R}/photos/a`);
  assert.equal(ph.srcId, id);
  assert.notEqual(ph.use, "generated", "still the approved app photo");
  assert.equal(core.isApproved(await read(db, `${R}/picks/a`), ph), true);
  const r = await bf.tap(db, { action: "use", pid: "a", use: "generated", genId: id, approve: true }, "junid", 9000);
  assert.equal(r.ok, true);
  assert.ok(r.undo && r.undo.a, "with Undo");
  const p = await read(db, `${R}/picks/a`);
  assert.deepEqual([p.state, p.sig, p.at], ["approved", id, 9000]);
  assert.equal(r.row.tab, "approved");
});

test("'Use app photo' brings the app's photo back and Generate starts from it again; his photo is kept (never deleted)", async () => {
  const db = seed();
  const { id } = await src.upload(db, { pid: "c", imageBase64: (await jpeg(800, 800)).toString("base64") }, "junid", deps());
  const r = await bf.tap(db, { action: "use", pid: "c", use: "current", app: true }, "junid", 9000);
  assert.equal(r.ok, true);
  const ph = await read(db, `${R}/photos/c`);
  assert.deepEqual([ph.use, ph.srcId, !!ph.gens[id]], ["current", undefined, true]);
  // Picking his photo again from the viewer makes it the source again.
  await bf.tap(db, { action: "use", pid: "c", use: "generated", genId: id }, "junid", 9500);
  assert.equal((await read(db, `${R}/photos/c`)).srcId, id);
});

// ── Generate from his photo ──────────────────────────────────────────────────
async function genDeps(db, calls) {
  const plate = { buffer: await png(543, 724, "#888"), width: 543, height: 724, file: "fence-single.png" };
  return {
    now: () => (clock += 1000),
    bucket: { name: "b", file: (p) => ({ save: async (buf) => { uploads.push({ p, buf }); } }) },
    fetchBytes: async (url) => { calls.push(["fetch", url]); return { buffer: await png(400, 500, "#a52") }; },
    assets: { loadPlate: async () => plate, loadReference: async () => null, libraryBox: async () => null, loadExamples: async () => [], loadPlateFile: async (f) => ({ ...plate, file: f, forModel: plate.buffer }) },
    fx: async () => ({ rate: 18 }),
    image: async (model, parts, imageConfig) => {
      calls.push(["image", model, imageConfig, parts.filter((x) => x.text).map((x) => x.text).join("\n")]);
      return { buffer: await png(1728, 2304, "#777"), mime: "image/png", usage: { promptTokenCount: 9000, candidatesTokenCount: 2000 }, request: { imageConfig } };
    },
    naRow: async () => null,
  };
}

test("Generate from his photo: the shared generator is handed HIS photo as the product photo; same model, size and prompt as from the app photo", async () => {
  const db = seed();
  const callsApp = [], callsSrc = [];
  await gen.bfGenerate(db, { pid: "c" }, "junid", await genDeps(db, callsApp));
  const { id, url } = await src.upload(db, { pid: "c", imageBase64: (await jpeg(800, 800)).toString("base64") }, "junid", deps());
  const out = await gen.bfGenerate(db, { pid: "c" }, "junid", await genDeps(db, callsSrc));
  assert.equal(out.fromSrc, id);
  assert.deepEqual(callsApp.filter((c) => c[0] === "fetch").map((c) => c[1]), ["https://x/c.jpg"]);
  assert.deepEqual(callsSrc.filter((c) => c[0] === "fetch").map((c) => c[1]), [url], "his photo, not the app's");
  const a = callsApp.find((c) => c[0] === "image"), b = callsSrc.find((c) => c[0] === "image");
  assert.deepEqual([b[1], b[2]], [a[1], a[2]], "same model and image size");
  assert.equal(b[3], a[3], "the same prompt word for word (it already keeps the product exactly as the photo shows it)");
  const ph = await read(db, `${R}/photos/c`);
  assert.deepEqual([ph.genId, ph.use, ph.srcId, ph.gens[out.genId].fromSrc], [out.genId, "generated", id, id]);
  const row = (await bf.list(db)).review.find((x) => x.pid === "c");
  assert.deepEqual([row.shownFrom, row.generations, row.aiGenId, row.srcId], ["ai", 2, out.genId, id]);
  assert.deepEqual(row.gallery.map((g) => g.label), ["App photo", "AI", "Your photo", "AI (from your photo)"]);
});

test("Generate on an APPROVED product: the new photo is added beside it; the approved photo keeps posting", async () => {
  const db = seed();
  await bf.tap(db, { action: "approve", pid: "a", sig: "current" }, "junid", 5000);
  const out = await gen.bfGenerate(db, { pid: "a" }, "junid", await genDeps(db, []));
  assert.equal(out.keptApproved, true);
  const ph = await read(db, `${R}/photos/a`);
  assert.ok(ph.gens[out.genId]);
  assert.notEqual(ph.use, "generated");
  assert.equal(core.isApproved(await read(db, `${R}/picks/a`), ph), true);
});

// ── New Arrivals rows ────────────────────────────────────────────────────────
const DAY = 86_400_000;
const NA1 = `p${NOW - DAY}`;
function naWorld() {
  const photo = `https://firebasestorage.googleapis.com/v0/b/b/o/products%2F${NA1}%2Fphoto.jpg?alt=media`;
  return makeFakeDb({
    locations: { central: { name: "Central" } },
    products: { [NA1]: { name: "Lacoste cap", categoryKey: "caps-beanies", category: "Clothing", stockPrice: 450, sizes: ["7", "8"], photoUrl: photo } },
    stock: { central: { [NA1]: { 7: { qty: 3 } } } },
    new_arrivals: { items: { [NA1]: { pid: NA1, status: "new", enqueuedAt: 1, statusAt: 1 } }, by_status: { new: { [NA1]: 1 } } },
    [R]: { meta: { builtAt: 1, main: 0, under: 0 }, items: {}, idx: {} },
  });
}

test("New Arrivals: a cap (not in the build) gets Generate, Replace photo; his photo shows on its New Arrivals row and Approve makes it a Black Friday approval — the New Arrivals item is left alone", async () => {
  const db = naWorld();
  let v = await bf.list(db, "main", NOW);
  let row = v.newArrivals.find((x) => x.pid === NA1);
  assert.deepEqual([row.canGenerate, row.naStudio, row.noPrice], [true, false, false]);
  const naRow = (pid) => naLib.campaignRowOfNa(db, pid, NOW, require("../newArrivals/newArrivals.js"));
  const { id, url } = await src.upload(db, { pid: NA1, imageBase64: (await jpeg(900, 900)).toString("base64") }, "junid", deps({ naRow }));
  v = await bf.list(db, "main", NOW);
  row = v.newArrivals.find((x) => x.pid === NA1);
  assert.deepEqual([row.bfPhoto, row.shown, row.sig, row.srcId, row.shownFrom], [true, url, id, id, "upload"]);
  const r = await bf.tap(db, { action: "approve", pid: NA1, sig: id }, "junid", NOW);
  assert.equal(r.ok, true, r.refusal);
  const p = await read(db, `${R}/picks/${NA1}`);
  assert.deepEqual([p.state, p.sig, p.shown, p.section, p.src, p.price], ["approved", id, url, "newArrivals", undefined, 450]);
  assert.equal(await read(db, `new_arrivals/items/${NA1}/status`), "new", "New Arrivals' own queue is untouched");
  v = await bf.list(db, "main", NOW);
  assert.ok(!v.newArrivals.some((x) => x.pid === NA1));
  const ap = v.approved.find((x) => x.pid === NA1);
  assert.deepEqual([ap.na, ap.shown], [true, url], "listed with the New Arrivals on the Approved tab");
  await bf.restore(db, r.undo, "junid", NOW + 1);
  v = await bf.list(db, "main", NOW);
  assert.ok(v.newArrivals.some((x) => x.pid === NA1), "Undo: back on the New Arrivals tab");
});

test("New Arrivals: Black Friday's Generate makes a photo for a New Arrival that is not in the build", async () => {
  const db = naWorld();
  const calls = [];
  const d = await genDeps(db, calls);
  d.naRow = (pid) => naLib.campaignRowOfNa(db, pid, NOW, require("../newArrivals/newArrivals.js"));
  const out = await gen.bfGenerate(db, { pid: NA1 }, "junid", d);
  assert.equal(out.kind, "headwear");
  const row = (await bf.list(db, "main", NOW)).newArrivals.find((x) => x.pid === NA1);
  assert.deepEqual([row.bfPhoto, row.sig, row.shownFrom, row.generations], [true, out.genId, "ai", 1]);
});

// ── Find online ──────────────────────────────────────────────────────────────
test("Find online: the search words are brand + name + colour + style code, each once", () => {
  assert.equal(web.queryOf({ name: "Air Force 1 '07", brand: "Nike", labelColorway: "WHITE/WHITE", styleCode: "CW2288-111" }), "Nike Air Force 1 '07 WHITE/WHITE CW2288-111");
  assert.equal(web.queryOf({ name: "Nike Dunk Low Panda", brand: "Nike" }), "Nike Dunk Low Panda");
  assert.equal(web.queryOf({ name: "Cap C", brand: "New Era", colour: "Black" }), "New Era Cap C Black");
});

test("Find online: only public https addresses are ever fetched (private, loopback, metadata, other ports and http refused; redirects checked)", async () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(web.isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "151.101.1.1", "2606:4700::1111"]) assert.equal(web.isPrivateIp(ip), false, ip);
  for (const u of ["http://shop.example/x.jpg", "https://169.254.169.254/x", "https://metadata.google.internal/x", "https://localhost/x", "https://shop.example:8443/x", "https://u:p@shop.example/x", "file:///etc/passwd"]) assert.throws(() => web.checkUrl(u), u);
  const lookup = async (h) => (h === "evil.example" ? [{ address: "10.1.2.3", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(() => web.safeFetch("https://evil.example/x.jpg", { maxBytes: 100, lookup, fetchImpl: async () => { throw new Error("must not fetch"); } }), /not public/);
  const redirecting = async () => ({ status: 302, ok: false, headers: new Map([["location", "https://169.254.169.254/latest"]]) });
  await assert.rejects(() => web.safeFetch("https://shop.example/x.jpg", { maxBytes: 100, lookup, fetchImpl: redirecting }), /not public/);
  const huge = async () => ({ status: 200, ok: true, headers: new Map([["content-length", "999999"]]), body: [] });
  await assert.rejects(() => web.safeFetch("https://shop.example/x.jpg", { maxBytes: 100, lookup, fetchImpl: huge }), /too large/);
});

test("Find online: a page's own product photos (og:image, twitter:image, JSON-LD Product image), absolute and https", () => {
  const html = `<html><head>
    <meta property="og:image" content="//cdn.shop.example/a.jpg?w=1200&amp;q=90">
    <meta name="twitter:image" content="https://cdn.shop.example/b.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Cap","image":["/img/c.jpg",{"url":"https://cdn.shop.example/d.jpg"}]}]}</script>
    <meta property="og:image" content="javascript:alert(1)">
  </head></html>`;
  assert.deepEqual(web.imagesFromHtml(html, "https://www.shop.example/p/cap"), [
    "https://cdn.shop.example/a.jpg?w=1200&q=90", "https://cdn.shop.example/b.jpg", "https://www.shop.example/img/c.jpg", "https://cdn.shop.example/d.jpg",
  ]);
  assert.equal(web.siteOf("https://www.shop.example/p"), "shop.example");
});

test("Find online: candidates come from the grounded pages' own photos, one site after another, small images and repeats dropped; nothing is stored", async () => {
  const bigA = await jpeg(1200, 1200, "#d00"), bigA2 = await jpeg(800, 800, "#d00"), bigB = await jpeg(900, 1100, "#00d"), tiny = await jpeg(120, 120, "#0d0");
  const files = {
    "https://a.example/p": `<meta property="og:image" content="https://a.example/1.jpg"><meta name="twitter:image" content="https://a.example/small.jpg">`,
    "https://b.example/p": `<meta property="og:image" content="https://b.example/1.jpg"><meta name="twitter:image" content="https://b.example/same-as-a.jpg">`,
  };
  const imgs = { "https://a.example/1.jpg": bigA, "https://a.example/small.jpg": tiny, "https://b.example/1.jpg": bigB, "https://b.example/same-as-a.jpg": bigA2 };
  const fetchImpl = async (u, opts = {}) => {
    const url = String(u);
    if (url.startsWith("https://generativelanguage")) {
      assert.match(JSON.parse(opts.body).contents[0].parts[0].text, /New Era Cap C Black/);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/A", title: "a.example" } }, { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/B", title: "b.example" } }], searchEntryPoint: { renderedContent: "<div>chips</div>" }, webSearchQueries: ["q"] } }] }) };
    }
    if (url.includes("grounding-api-redirect/A")) return { status: 302, headers: new Map([["location", "https://a.example/p"]]) };
    if (url.includes("grounding-api-redirect/B")) return { status: 302, headers: new Map([["location", "https://b.example/p"]]) };
    const body = files[url] ? Buffer.from(files[url]) : imgs[url];
    if (!body) return { status: 404, ok: false, headers: new Map() };
    return { status: 200, ok: true, headers: new Map([["content-type", files[url] ? "text/html" : "image/jpeg"]]), body: [body] };
  };
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const db = seed();
  const before = JSON.stringify(await read(db, R));
  const r = await src.search(db, { pid: "c" }, { apiKey: "k", fetchImpl, lookup, sharp });
  assert.equal(r.query, "New Era Cap C Black");
  assert.deepEqual(r.candidates.map((c) => [c.site, c.imageUrl, c.width]), [["a.example", "https://a.example/1.jpg", 1200], ["b.example", "https://b.example/1.jpg", 900]]);
  assert.match(r.candidates[0].thumb, /^data:image\/jpeg;base64,/);
  assert.equal(r.entryPoint, "<div>chips</div>");
  assert.equal(JSON.stringify(await read(db, R)), before, "a search writes nothing");
  // He taps the second one: fetched again, stored full size, becomes the source.
  const p = await src.pick(db, { pid: "c", imageUrl: "https://b.example/1.jpg", pageUrl: "https://b.example/p", site: "b.example" }, "junid", deps({ fetchImpl, lookup }));
  const ph = await read(db, `${R}/photos/c`);
  assert.deepEqual([ph.srcId, ph.gens[p.id].src, ph.gens[p.id].site, ph.gens[p.id].pageUrl, ph.gens[p.id].width], [p.id, "web", "b.example", "https://b.example/p", 900]);
  assert.ok(uploads[uploads.length - 1].buf.equals(bigB), "the photo exactly as the site serves it");
  const row = (await bf.list(db)).review.find((x) => x.pid === "c");
  assert.deepEqual([row.shownFrom, row.gallery[1].label, row.gallery[1].pageUrl], ["web", "From b.example", "https://b.example/p"]);
});
