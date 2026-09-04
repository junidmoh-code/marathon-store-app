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

const BUCKET = "marathon-club.firebasestorage.app";
const N = Number((process.argv.find((a) => a.startsWith("--n=")) || "--n=12").slice(4));
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

const scratch = mkdtempSync(join(tmpdir(), "thumb-measure-"));
const server = createServer((req, res) => {
  // Serves the repo (for the real ES module) and the scratch dir (for the
  // downloaded photos) so the module's own relative imports resolve.
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.startsWith("/sample/") ? join(scratch, path.slice("/sample/".length)) : join(ROOT, path);
  try {
    const body = readFileSync(file);
    const type = extname(file) === ".js" ? "text/javascript" : "image/jpeg";
    res.writeHead(200, { "Content-Type": type }).end(body);
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const originals = await sampleOriginals(N);
console.log(`sampling ${originals.length} product photos from ${BUCKET}\n`);

const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" }).catch(() => {});

const rows = [];
try {
  for (const name of originals) {
    const id = /^products\/([^/]+)\/photo\.jpg$/.exec(name)[1];
    const jpg = join(scratch, `${id}.jpg`);
    const dl = await authed(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`);
    if (!dl.ok) { console.log(`  skip ${id}: HTTP ${dl.status}`); continue; }
    const srcBytes = Buffer.from(await dl.arrayBuffer());
    writeFileSync(jpg, srcBytes);

    // Leg A — the bulk generator's encoder, verbatim.
    const webp = join(scratch, `${id}.cwebp.webp`);
    execFileSync("cwebp", ["-quiet", "-q", "80", "-resize", "300", "0", jpg, "-o", webp]);
    const cwebpBytes = readFileSync(webp).length;

    // Leg B — THE MODULE THE APP SHIPS, in a real browser.
    const browserResult = await page.evaluate(async (base, productId) => {
      const { encodeThumbnail } = await import(`${base}/src/utils/productThumb.js`);
      const res = await fetch(`${base}/sample/${productId}.jpg`);
      const blob = await res.blob();
      const thumb = await encodeThumbnail(blob);
      const bmp = await createImageBitmap(thumb);
      return { bytes: thumb.size, type: thumb.type, width: bmp.width, height: bmp.height };
    }, origin, id);

    const dims = execFileSync("cwebp", ["-quiet", "-print_psnr", "-q", "80", "-resize", "300", "0", jpg, "-o", "/dev/null"], { encoding: "utf8" }).trim();
    rows.push({ id, srcKB: +(srcBytes.length / 1024).toFixed(1), cwebpKB: +(cwebpBytes / 1024).toFixed(1),
      browserKB: +(browserResult.bytes / 1024).toFixed(1), type: browserResult.type,
      px: `${browserResult.width}x${browserResult.height}`, psnr: dims });
    const r = rows[rows.length - 1];
    console.log(`  ${id}  src ${r.srcKB}KB  cwebp ${r.cwebpKB}KB  browser ${r.browserKB}KB (${r.px}, ${r.type})`);
  }
} finally {
  await browser.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}

const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
const ratio = sum((r) => r.browserKB) / sum((r) => r.cwebpKB);
console.log(`\n${rows.length} photos`);
console.log(`  cwebp   total ${sum((r) => r.cwebpKB).toFixed(1)} KB  mean ${(sum((r) => r.cwebpKB) / rows.length).toFixed(1)} KB`);
console.log(`  browser total ${sum((r) => r.browserKB).toFixed(1)} KB  mean ${(sum((r) => r.browserKB) / rows.length).toFixed(1)} KB`);
console.log(`  browser / cwebp = ${ratio.toFixed(2)}x`);
console.log(`  every browser encode is image/webp: ${rows.every((r) => r.type === "image/webp")}`);
console.log(`  every browser encode is 300px wide: ${rows.every((r) => r.px.startsWith("300x"))}`);
console.log(`\n  full-catalogue projection at 5,039 photos: ${(sum((r) => r.browserKB) / rows.length * 5039 / 1024).toFixed(1)} MB`);
