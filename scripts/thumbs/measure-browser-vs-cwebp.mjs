// ─── DIFFERENTIAL MEASUREMENT: the browser writer vs the bulk generator ──────
//
// There are now TWO writers of products/{id}/thumb_300.webp:
//   • marathon-pos-app/scripts/thumbs/generate.mjs — cwebp -q 80 -resize 300 0
//   • src/utils/productThumb.js — canvas.toBlob("image/webp", 0.8), in the
//     browser, at upload time (this repo)
//
// They pass the same NUMBER for quality, but canvas WebP is the browser's own
// encoder on its own scale, not libwebp's. Claiming "same object, same cost"
// from that alone would be an assumption, and it is a load-bearing one: the
// mirror enforces its cache in BYTES (a measured 106.6 MB for the full
// catalogue), so a systematically fatter browser encode would eat that budget
// silently — no error anywhere, just fewer products cached per till.
//
// So both encoders are RUN OVER THE SAME REAL INPUTS and compared: the actual
// module the app ships, loaded as an ES module into headless Chromium, against
// cwebp on the same downloaded photo.jpg. Same inputs, two implementations,
// compare the outputs — the same way this repo differential-tests a mirror
// rather than trusting one side's copy.
//
// READ-ONLY against production: it downloads a sample of product photos and
// writes nothing to the bucket. Auth is the Firebase CLI's own refresh token,
// the established pattern in this repo's scripts.
//
//   node scripts/thumbs/measure-browser-vs-cwebp.mjs            # 12 photos
//   node scripts/thumbs/measure-browser-vs-cwebp.mjs --n=40
//
// Requires `cwebp` on PATH (brew install webp) and the repo's dev deps
// (puppeteer). Not part of `npm test` — it needs a network and a browser.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, extname } from "node:path";
import puppeteer from "puppeteer";

import { PHOTO_THUMB_MAX_EDGE } from "../../src/utils/productPhotoPaths.js";

const BUCKET = "marathon-club.firebasestorage.app";
const N = (() => {
  const n = Number((process.argv.find((a) => a.startsWith("--n=")) || "--n=12").slice(4));
  // `--n=abc` used to become NaN and silently measure nothing, printing a
  // confident summary over zero rows.
  if (!Number.isInteger(n) || n < 1) throw new Error("--n= must be a positive integer");
  return n;
})();
const ROOT = new URL("../..", import.meta.url).pathname;

function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const refresh = cfg?.tokens?.refresh_token;
  if (!refresh) throw new Error("No firebase-tools refresh token — run `firebase login` first.");
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: refresh,
    grant_type: "refresh_token",
  }).toString();
  const out = execFileSync("curl", ["-sS", "-X", "POST", "https://oauth2.googleapis.com/token", "-d", "@-"],
    { input: body, encoding: "utf8" });
  const res = JSON.parse(out);
  if (!res.access_token) throw new Error("token refresh failed");
  return res.access_token;
}

const token = accessToken();
const authed = (url) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });

// A spread across the catalogue, not the first N of one listing page — the
// oldest products are not representative of what gets photographed today.
async function sampleOriginals(want) {
  const names = [];
  let pageToken;
  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`);
    url.searchParams.set("prefix", "products/");
    url.searchParams.set("maxResults", "1000");
    url.searchParams.set("fields", "items(name),nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await authed(url);
    if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`);
    const j = await res.json();
    for (const it of j.items ?? []) if (/^products\/[^/]+\/photo\.jpg$/.test(it.name)) names.push(it.name);
    pageToken = j.nextPageToken;
  } while (pageToken);
  const step = Math.max(1, Math.floor(names.length / want));
  return names.filter((_, i) => i % step === 0).slice(0, want);
}

// EVERYTHING that must be cleaned up is created inside the try below, so a
// failure in the listing, the auth or the browser launch cannot leave a temp
// directory of downloaded photos behind on the machine.
let scratch = null;
let server = null;
let browser = null;

const makeServer = (scratchDir) => createServer((req, res) => {
  // Serves the repo (for the real ES module) and the scratch dir (for the
  // downloaded photos) so the module's own relative imports resolve.
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.startsWith("/sample/") ? join(scratchDir, path.slice("/sample/".length)) : join(ROOT, path);
  try {
    const body = readFileSync(file);
    const ext = extname(file);
    // An ES module served as image/jpeg is refused by the browser outright, so
    // the type is not a detail here — it is what makes the import work.
    const type = ext === ".js" ? "text/javascript"
      : ext === ".html" ? "text/html"
      : ext === ".webp" ? "image/webp"
      : "image/jpeg";
    res.writeHead(200, { "Content-Type": type }).end(body);
  } catch {
    res.writeHead(404).end("no");
  }
});

const rows = [];
try {
  scratch = mkdtempSync(join(tmpdir(), "thumb-measure-"));
  server = makeServer(scratch);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const originals = await sampleOriginals(N);
  console.log(`sampling ${originals.length} product photos from ${BUCKET}\n`);

  browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  // Any same-origin document will do — the module is imported by URL, and the
  // page itself runs nothing. It must load, though: from about:blank the
  // dynamic import would be refused cross-origin.
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });

  for (const name of originals) {
    const id = /^products\/([^/]+)\/photo\.jpg$/.exec(name)[1];
    const jpg = join(scratch, `${id}.jpg`);
    const dl = await authed(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`);
    if (!dl.ok) { console.log(`  skip ${id}: HTTP ${dl.status}`); continue; }
    const srcBytes = Buffer.from(await dl.arrayBuffer());
    writeFileSync(jpg, srcBytes);

    // Leg A — THE MODULE THE APP SHIPS, in a real browser. It runs first
    // because it also reports the SOURCE dimensions, which leg B needs.
    const browserResult = await page.evaluate(async (base, productId) => {
      const { encodeThumbnail } = await import(`${base}/src/utils/productThumb.js`);
      const res = await fetch(`${base}/sample/${productId}.jpg`);
      const blob = await res.blob();
      // Both bitmaps are closed as soon as their dimensions are read: --n takes
      // any positive integer, and a long run that leaves decoded frames to the
      // garbage collector is how a measurement starts measuring memory
      // pressure instead of bytes. (CodeRabbit, PR #553.)
      let source = null;
      let bmp = null;
      try {
        source = await createImageBitmap(blob);
        const thumb = await encodeThumbnail(blob);
        bmp = await createImageBitmap(thumb);
        return { bytes: thumb.size, type: thumb.type, width: bmp.width, height: bmp.height,
          srcWidth: source.width, srcHeight: source.height };
      } finally {
        source?.close();
        bmp?.close();
      }
    }, origin, id);

    // Leg B — the bulk generator's encoder, at the SAME target width.
    // generate.mjs passes `-resize 300 0`, and cwebp's default resize_mode is
    // "always": it UPSCALES a source narrower than 300. encodeThumbnail
    // deliberately does not (an upscaled thumbnail is only bigger, never
    // better). That divergence is real and documented — but comparing an
    // upscaled 300px cwebp object against a 180px browser object would not be
    // measuring the ENCODERS, it would be measuring the resize policy, and it
    // would report the browser as dramatically cheaper for exactly the photos
    // where it is not. So both legs are given the same target width, and the
    // script asserts they agreed. (CodeRabbit, PR #553.)
    const targetWidth = Math.min(PHOTO_THUMB_MAX_EDGE, browserResult.srcWidth);
    const webp = join(scratch, `${id}.cwebp.webp`);
    execFileSync("cwebp", ["-quiet", "-q", "80", "-resize", String(targetWidth), "0", jpg, "-o", webp]);
    const cwebpBytes = readFileSync(webp).length;

    // ── VERIFY BOTH LEGS, NOT JUST OURS ─────────────────────────────────────
    // Asserting the BROWSER's width against the target says nothing about what
    // cwebp actually produced — the flag was passed, not the output inspected.
    // A different cwebp version, a changed default resize mode, or a typo'd
    // flag would leave the two legs encoding different geometries again, and
    // the script would print a confident byte ratio for the comparison it was
    // built to prevent. So the cwebp object is DECODED and its real dimensions
    // are checked against the browser's. (CodeRabbit, PR #553.)
    const cwebpDims = await page.evaluate(async (base, productId) => {
      const res = await fetch(`${base}/sample/${productId}.cwebp.webp`);
      const bmp = await createImageBitmap(await res.blob());
      try { return { width: bmp.width, height: bmp.height }; } finally { bmp.close(); }
    }, origin, id);
    // Width must be EXACT. Height is allowed to differ by one pixel, and does:
    // the first run of this check found browser 300x405 against cwebp 300x406
    // on a 599x809 source — the two encoders round the derived height
    // differently (this module uses Math.round; cwebp's scaler does its own).
    // One row of pixels cannot move a byte ratio and nothing downstream depends
    // on an exact height, so it is recorded rather than treated as an error.
    // Anything larger means the legs are resizing differently, which is what
    // this check exists to catch.
    const heightDrift = Math.abs(cwebpDims.height - browserResult.height);
    if (browserResult.width !== targetWidth) {
      throw new Error(`${id}: browser encoded ${browserResult.width}px, target was ${targetWidth}px`);
    }
    if (cwebpDims.width !== browserResult.width || heightDrift > 1) {
      throw new Error(`${id}: legs disagree on geometry — browser ${browserResult.width}x${browserResult.height}, `
        + `cwebp ${cwebpDims.width}x${cwebpDims.height}. The byte ratio would be meaningless.`);
    }

    // (There was a second cwebp run here with -print_psnr. It measured
    // cwebp against the SOURCE, not the browser against cwebp, and its output
    // was stored and never printed — a whole extra encode per photo for a
    // number that answered no question this script asks.)
    rows.push({ id, srcKB: +(srcBytes.length / 1024).toFixed(1), cwebpKB: +(cwebpBytes / 1024).toFixed(1),
      browserKB: +(browserResult.bytes / 1024).toFixed(1), type: browserResult.type,
      px: `${browserResult.width}x${browserResult.height}`, targetWidth, heightDrift,
      cwebpPx: `${cwebpDims.width}x${cwebpDims.height}`,
      srcPx: `${browserResult.srcWidth}x${browserResult.srcHeight}` });
    const r = rows[rows.length - 1];
    console.log(`  ${id}  src ${r.srcKB}KB  cwebp ${r.cwebpKB}KB  browser ${r.browserKB}KB (${r.px}, ${r.type})`);
  }
} finally {
  if (browser) await browser.close();
  if (server) server.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

// An empty run must not print a summary. With no rows the totals are NaN while
// both `rows.every(...)` checks return TRUE — a measurement that measured
// nothing, reporting that everything it did not measure was correct.
// (CodeRabbit, PR #553.)
if (rows.length === 0) throw new Error("measured nothing — every sample was skipped or failed");

const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
const ratio = sum((r) => r.browserKB) / sum((r) => r.cwebpKB);
console.log(`\n${rows.length} photos`);
console.log(`  cwebp   total ${sum((r) => r.cwebpKB).toFixed(1)} KB  mean ${(sum((r) => r.cwebpKB) / rows.length).toFixed(1)} KB`);
console.log(`  browser total ${sum((r) => r.browserKB).toFixed(1)} KB  mean ${(sum((r) => r.browserKB) / rows.length).toFixed(1)} KB`);
console.log(`  browser / cwebp = ${ratio.toFixed(2)}x`);
console.log(`  every browser encode is image/webp: ${rows.every((r) => r.type === "image/webp")}`);
// NOT "is 300 wide": a source narrower than 300 is correctly left at its own
// width. The property that matters is that both legs encoded the same pixels.
// Every row that got this far had BOTH legs decoded and their real dimensions
// compared — the run throws otherwise, so this line reports a checked fact.
// Every row that got this far had BOTH objects decoded and their real
// dimensions compared — the run throws otherwise — so these report checked
// facts rather than a flag that was passed.
console.log(`  both legs decoded to the same width, every row: ${rows.every((r) => r.px.startsWith(`${r.targetWidth}x`))}`);
console.log(`  rows where the two encoders' heights differ by 1px: ${rows.filter((r) => r.heightDrift > 0).length}`);
console.log(`  sources narrower than ${PHOTO_THUMB_MAX_EDGE}px in this sample: ${rows.filter((r) => r.targetWidth < PHOTO_THUMB_MAX_EDGE).length}`);
// The RATIO is the finding. This sample's own mean is not a catalogue mean —
// the whole existing set is already measured on the other side (5,016 objects,
// 106.6 MB, POS src/offline/photoCache.js), so the honest projection applies
// the ratio to THAT, and compares it with the mirror's actual ceiling.
const MEASURED_SET_MB = 106.6;          // POS photoCache.js, 5,016 objects, 2026-09-03
const MIRROR_BUDGET_MB = 160;           // PHOTO_CACHE_BYTE_BUDGET
console.log(`\n  projection = ratio x the measured set, NOT this sample's mean:`);
console.log(`    ${ratio.toFixed(2)}x * ${MEASURED_SET_MB} MB = ${(ratio * MEASURED_SET_MB).toFixed(1)} MB`);
console.log(`    mirror budget ${MIRROR_BUDGET_MB} MB -> ${ratio * MEASURED_SET_MB < MIRROR_BUDGET_MB ? "INSIDE" : "OVER"}`);
console.log(`  (measured in Chromium. The uploading fleet is iPad Safari: unmeasured.)`);
