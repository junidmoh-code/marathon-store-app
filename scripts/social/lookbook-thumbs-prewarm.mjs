// ─── PRE-WARM THE LOOKBOOK'S CLEAN-SHOT CACHE FOR EVERY ELIGIBLE PRODUCT ─────
// Makes the panel's clean product shot (functions/lookbook/thumbs.cjs) for
// every product the lookbook could draw today, so no poster waits on one:
//
//   eligible  = what the lookbook loader would accept with no per-slot limit:
//               live, a lookbook slot, a retail price, an approved photo, in
//               stock (the same indexed live query and pid reads, nothing whole)
//   skipped   = a New Arrivals studio photo (used as it is), or already cached
//   generated = everything else, ONCE: the same resolveThumb, the same engines
//               and the same cache the Cloud Function uses
//
// The daily thumbnail ceiling is not applied here: this run is the one-off the
// owner asked for (2026-10-18). Every shot is still cached, so a re-run only
// makes what is missing. Cut-outs run one at a time (an ONNX session each).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/lookbook-thumbs-prewarm.mjs [--dry-run] [--limit N] [--from N] [--concurrency 3]
//
//   --probe N   make N shots on BOTH Flash-Lite and Flash, cache nothing, and
//               write a side-by-side sheet: the model choice, measured.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const sharp = require("sharp");
const gemini = require("./lib/gemini-image.cjs");
const lookbook = require("./lib/social-lookbook.cjs");
const { engines } = require("./lookbook/engines.cjs");
const { resolveThumb } = require("./lookbook/thumbs.cjs");
const { loadLookbookCandidates } = require("./lookbook/load.cjs");
const { cutout } = require("./lib/lookbook-render.cjs");
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");
const USD_TO_ZAR = 18.0;

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const DRY = process.argv.includes("--dry-run");
const LIMIT = Number(arg("limit", Infinity));
const CONCURRENCY = Math.max(1, Number(arg("concurrency", 3)));
const PROBE = Number(arg("probe", 0));

const secret = (name) => execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, "--project", "marathon-club"], { encoding: "utf8" }).trim();
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const bucket = admin.storage().bucket(STORAGE_BUCKET);
const saDate = saDateStringFromMs(Date.now());
const OUT = join(homedir(), "Desktop", "lookbook-samples", "thumbs");
await mkdir(OUT, { recursive: true });

const fetchImage = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "image/jpeg" };
};

// One cut-out at a time, whatever the generation concurrency.
let gate = Promise.resolve();
const serialCutout = (buf) => { const run = gate.then(() => cutout(buf)); gate = run.catch(() => {}); return run; };

const t0 = Date.now();
const { candidates, reads, liveCount } = await loadLookbookCandidates(db, { readsPerSlot: 100000 });
const rows = [];
for (const c of candidates) { const r = lookbook.resolveRow(c); if (r.row) rows.push(r.row); }
const studio = rows.filter((r) => r.studio);
const need = rows.filter((r) => !r.studio);
console.log(`live ${liveCount} · eligible ${rows.length} (reads: ${reads.products} products, ${reads.stock} stock cells, ${((Date.now() - t0) / 1000).toFixed(0)} s) · studio photo ${studio.length} · to check ${need.length}`);
const bySlot = {};
for (const r of rows) bySlot[r.slot] = (bySlot[r.slot] || 0) + 1;
console.log(`by slot: ${JSON.stringify(bySlot)}`);

const geminiApiKey = secret("GEMINI_API_KEY");
const deps = engines({ db, bucket, saDate, geminiApiKey, fetchImage });

if (PROBE) {
  // One per slot in turn (hat, jacket, tee, bottoms, bag, sneakers), so the
  // sheet shows every kind of product, not six pairs of sneakers.
  const pick = [];
  for (let i = 0; pick.length < PROBE && i < need.length; i++) {
    for (const slot of lookbook.SLOT_KEYS) {
      const r = need.filter((x) => x.slot === slot)[i];
      if (r && pick.length < PROBE) pick.push(r);
    }
  }
  const tiles = [];
  let lite = 0, flash = 0;
  for (const r of pick) {
    const photo = await fetchImage(r.photoUrl);
    const parts = [
      { text: lookbook.buildThumbPrompt(r) },
      { text: `REFERENCE — ${r.displayName}. Reproduce exactly this product:` },
      gemini.inlineImagePart(photo.buffer, photo.contentType),
    ];
    const a = await gemini.geminiGenerateImage(geminiApiKey, gemini.FLASH_LITE_MODEL, parts, { outPerMtok: gemini.FLASH_LITE_OUT_PER_MTOK, flatUsd: gemini.FLASH_LITE_FLAT_IMAGE_USD, imageConfig: { aspectRatio: "1:1" } });
    const b = await gemini.geminiGenerateImage(geminiApiKey, gemini.GEMINI_MODEL, parts, { outPerMtok: gemini.GEMINI_OUT_PER_MTOK, flatUsd: gemini.GEMINI_FLAT_IMAGE_USD, imageConfig: { aspectRatio: "1:1", imageSize: "1K" } });
    lite += a.costUSD; flash += b.costUSD;
    const sq = (buf) => sharp(buf).rotate().resize(400, 400, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).jpeg().toBuffer();
    const ca = await serialCutout(a.buffer), cb = await serialCutout(b.buffer);
    const onPaper = async (c) => (c && c.png ? sharp({ create: { width: 400, height: 400, channels: 3, background: "#E9E6DF" } }).composite([{ input: await sharp(c.png).resize(360, 360, { fit: "inside" }).toBuffer(), gravity: "center" }]).jpeg().toBuffer() : sq(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>`)));
    tiles.push([await sq(photo.buffer), await sq(a.buffer), await onPaper(ca), await sq(b.buffer), await onPaper(cb)]);
    console.log(`${r.pid} ${r.slot} ${r.displayName}: lite $${a.costUSD} (${(await sharp(a.buffer).metadata()).width}px, cut ${ca && ca.method}) · flash $${b.costUSD} (${(await sharp(b.buffer).metadata()).width}px, cut ${cb && cb.method})`);
  }
  const comp = [];
  tiles.forEach((row, y) => row.forEach((t, x) => comp.push({ input: t, left: x * 410, top: y * 410 })));
  await sharp({ create: { width: 5 * 410, height: tiles.length * 410, channels: 3, background: "#ffffff" } }).composite(comp).jpeg({ quality: 85 }).toFile(join(OUT, "probe.jpg"));
  console.log(JSON.stringify({ probe: pick.length, liteUSD: +lite.toFixed(4), flashUSD: +flash.toFixed(4), litePer: +(lite / pick.length).toFixed(4), flashPer: +(flash / pick.length).toFixed(4), sheet: join(OUT, "probe.jpg"), columns: "shop photo | lite | lite cut-out | flash | flash cut-out" }, null, 2));
  process.exit(0);
}

// What is already cached: one pointer read per product, never the whole node.
const todo = [];
let cached = 0;
for (const r of need) {
  const ptr = (await db.ref(`social_lookbook/thumbs/${r.pid}`).once("value")).val();
  if (ptr) cached++; else todo.push(r);
}
// --from N: start at the Nth missing product, so a second run can take the
// back half while the first works forward. Each product is checked against
// the cache again just before it is made (resolveThumb), so a product the
// other run already made is read, not bought.
const FROM = Math.max(0, Number(arg("from", 0)) || 0);
const queue = todo.slice(FROM, FROM + LIMIT);
console.log(`already cached ${cached} · to generate ${todo.length}${Number.isFinite(LIMIT) ? ` (this run: ${queue.length})` : ""} · estimate $${(queue.length * gemini.FLASH_LITE_FLAT_IMAGE_USD).toFixed(2)} at Flash-Lite's 1K rate`);
if (DRY) process.exit(0);

const results = [];
const tdeps = {
  ...deps,
  cutout: serialCutout,
  claimThumbUnit: async () => ({ ok: true }),
  log: (m) => console.log(m),
};
let next = 0;
async function worker() {
  while (next < queue.length) {
    const r = queue[next++];
    try {
      const photo = await fetchImage(r.photoUrl);
      const t = await resolveThumb(r, photo, tdeps);
      results.push({ pid: r.pid, slot: r.slot, name: r.displayName, source: t.source, costUSD: t.costUSD, method: t.cutout && t.cutout.method });
      if (t.source === "generated") await writeFile(join(OUT, `${r.pid}.png`), t.cutout.png);
      console.log(`${results.length}/${queue.length} ${r.pid} ${r.slot} → ${t.source} $${t.costUSD}`);
    } catch (e) {
      results.push({ pid: r.pid, slot: r.slot, name: r.displayName, source: "error", costUSD: 0, error: String(e && e.message).slice(0, 120) });
      console.log(`${results.length}/${queue.length} ${r.pid} → error ${e && e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const generated = results.filter((x) => x.source === "generated");
const spent = results.reduce((s, x) => s + (x.costUSD || 0), 0);
const engineCounts = {};
for (const g of generated) {
  const p = (await db.ref(`social_lookbook/thumbs/${g.pid}`).once("value")).val();
  engineCounts[(p && p.engine) || "?"] = (engineCounts[(p && p.engine) || "?"] || 0) + 1;
}
const report = {
  at: new Date().toISOString(), live: liveCount, eligible: rows.length, studio: studio.length,
  alreadyCached: cached, attempted: queue.length, generated: generated.length,
  fellBackToPhoto: results.filter((x) => x.source === "photo").length,
  errors: results.filter((x) => x.source === "error").length,
  engines: engineCounts,
  costUSD: +spent.toFixed(4), costZAR: +(spent * USD_TO_ZAR).toFixed(2),
  perThumbUSD: generated.length ? +(spent / generated.length).toFixed(4) : null,
  perThumbZAR: generated.length ? +((spent / generated.length) * USD_TO_ZAR).toFixed(3) : null,
  cacheSize: cached + generated.length,
  results,
};
await writeFile(join(OUT, `prewarm-${Date.now()}.json`), JSON.stringify(report, null, 2));
const { results: _r, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
