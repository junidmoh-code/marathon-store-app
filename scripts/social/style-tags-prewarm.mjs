// ─── PRE-WARM THE STYLIST'S TAGS FOR EVERY ELIGIBLE PRODUCT ──────────────────
// One vision call per product (functions/lookbook/style-tags-io.cjs
// visionTags, gemini-3.1-flash-lite on a 384 px photo), cached at
// social_lookbook/styleTags/{pid}. A product with a complete record is
// skipped, so a re-run only tags what is new. A v1 record (no gender, cut,
// headwear, knit) is topped up: the same call, its other tags kept
// (writeVisionTags).
//
//   eligible = live and on the storefront, a slot the stylist can use (a
//              lookbook row or a social outfit slot), an approved photo, and
//              network stock: the indexed live query, then reads by pid only
//
// If more than half the products that would be eligible have no photo, the
// run stops before spending anything and says so (the stylist then reads
// those products' names).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/style-tags-prewarm.mjs [--dry-run] [--limit N] [--concurrency 6]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const lookbook = require("./lib/social-lookbook.cjs");
const socialSelect = require("./lib/social-select.cjs");
const { visionTags, hasTagRecord, writeVisionTags } = require("./lookbook/style-tags-io.cjs");
const USD_TO_ZAR = 18.0;

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const DRY = process.argv.includes("--dry-run");
const LIMIT = Number(arg("limit", Infinity));
const CONCURRENCY = Math.max(1, Number(arg("concurrency", 6)));
const secret = (name) => execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, "--project", "marathon-club"], { encoding: "utf8" }).trim();

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const OUT = join(homedir(), "Desktop", "lookbook-samples");
await mkdir(OUT, { recursive: true });

const fetchImage = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "image/jpeg" };
};

const t0 = Date.now();
const live = (await db.ref("shopify_publish").orderByChild("state").equalTo("live").once("value")).val() || {};
const locations = Object.keys((await db.ref("locations").once("value")).val() || {}).filter((id) => !socialSelect.ONLINE_EXCLUDED_LOCATIONS.has(id));
const pids = Object.entries(live).filter(([, n]) => n && n.state === "live" && n.liveState === "on" && n.cleanName).map(([pid]) => pid);
const eligible = [];
let withSlot = 0, noPhoto = 0, noStock = 0;
for (let i = 0; i < pids.length; i += 25) {
  await Promise.all(pids.slice(i, i + 25).map(async (pid) => {
    const v = (await db.ref(`products/${pid}`).once("value")).val();
    if (!v || !(lookbook.lookbookSlot(v) || socialSelect.outfitSlot(v))) return;
    const cells = await Promise.all(locations.map((loc) => db.ref(`stock/${loc}/${pid}`).once("value")));
    const tree = {};
    locations.forEach((loc, j) => { const c = cells[j].val(); if (c) tree[loc] = c; });
    if (socialSelect.availableUnits(tree, v.sizes) <= 0) { noStock++; return; }
    withSlot++;
    const photo = lookbook.approvedPhoto(v, live[pid]);
    if (!photo) { noPhoto++; return; }
    eligible.push({ pid, photoUrl: photo.url, studio: photo.studio, websiteName: live[pid].cleanName, product: { brand: v.brand, name: v.name, categoryKey: v.categoryKey } });
  }));
}
console.log(`live ${pids.length} · in stock with a stylist slot ${withSlot} · no photo ${noPhoto} · eligible ${eligible.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
if (noPhoto > withSlot / 2) {
  console.log(`STOP: ${noPhoto} of ${withSlot} products have no photo — more than half. The stylist will read their names; nothing tagged.`);
  process.exit(3);
}

const todo = [];
let cached = 0;
for (let i = 0; i < eligible.length; i += 25) {
  const slice = eligible.slice(i, i + 25);
  const has = await Promise.all(slice.map((e) => hasTagRecord(db, e.pid)));
  slice.forEach((e, j) => { if (has[j]) cached++; else todo.push(e); });
}
const queue = todo.slice(0, LIMIT);
console.log(`already tagged ${cached} · to tag ${todo.length}${Number.isFinite(LIMIT) ? ` (this run: ${queue.length})` : ""} · estimate ~$${(queue.length * 0.00035).toFixed(3)}`);
if (DRY) process.exit(0);

const geminiApiKey = secret("GEMINI_API_KEY");
const results = [];
let next = 0, spent = 0;
async function worker() {
  while (next < queue.length) {
    const e = queue[next++];
    try {
      // Checked again just before the call: a parallel run may have tagged it.
      if (await hasTagRecord(db, e.pid)) { results.push({ pid: e.pid, source: "cached" }); continue; }
      const img = await fetchImage(e.photoUrl);
      const v = await visionTags(geminiApiKey, img, { brand: e.product.brand, name: e.product.name || e.websiteName, websiteName: e.websiteName, categoryKey: e.product.categoryKey });
      spent += v.costUSD;
      await writeVisionTags(db, e.pid, v, { src: e.photoUrl, nowMs: Date.now() });
      results.push({ pid: e.pid, source: "vision", model: v.model, costUSD: v.costUSD, tags: v.tags });
      if (results.length % 50 === 0) console.log(`${results.length}/${queue.length} · $${spent.toFixed(4)}`);
    } catch (err) {
      spent += (err && err.costUSD) || 0;
      results.push({ pid: e.pid, source: "error", error: String(err && err.message).slice(0, 160) });
      console.log(`${e.pid} → error ${err && err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const tagged = results.filter((r) => r.source === "vision");
const tally = (k) => tagged.reduce((m, r) => ((m[r.tags[k]] = (m[r.tags[k]] || 0) + 1), m), {});
const report = {
  at: new Date().toISOString(), live: pids.length, withSlot, noPhoto, noStock, eligible: eligible.length,
  alreadyTagged: cached, attempted: queue.length, tagged: tagged.length,
  errors: results.filter((r) => r.source === "error").length,
  models: tagged.reduce((m, r) => ((m[r.model] = (m[r.model] || 0) + 1), m), {}),
  costUSD: +spent.toFixed(5), costZAR: +(spent * USD_TO_ZAR).toFixed(3),
  perProductUSD: tagged.length ? +(spent / tagged.length).toFixed(6) : null,
  dominant: tally("dominant"), family: tally("family"), silhouette: tally("silhouette"), pattern: tally("pattern"), season: tally("season"),
  gender: tally("gender"), cut: tally("cut"), headwear: tally("headwear"), knit: tally("knit"),
  results,
};
await writeFile(join(OUT, `style-tags-prewarm-${Date.now()}.json`), JSON.stringify(report, null, 2));
const { results: _r, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
