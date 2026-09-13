// ── PROOF: THE WORDMARK IS WHOLE ON THE FEED, AND NO NAME IS CUT ─────────────
// Renders real catalogue products through EXACTLY the code the generator runs
// (functions/lib/social-render.cjs: normalise → composite, story + feed) and
// checks the output pixels, not the layout's opinion of itself.
//
//   node scripts/social/proof-safe-zone.mjs --out <dir> [pid ...]
//
// Reads each /products/{pid} with point reads (no whole-node read) using
// application-default credentials. The model's photograph is not regenerated —
// that would spend money to prove a property of the TYPE — so the product's
// own catalogue photograph stands in for it, placed on a dark ground.
//
// For each product it writes:
//   <pid>-story-1080x1920.png         the story file
//   <pid>-feed-1080x1350.png          the feed file
//   <pid>-story-cropped-4x5.png       the story file cut exactly as the feed
//                                     would cut it (y 285..1635) — belt and braces
// and verifies, exiting non-zero on any failure:
//   1. story: no pixel of any text or wordmark element is outside y 285..1635
//      (and, stricter, outside the 345..1575 band)
//   2. feed: the wordmark, the product name and the price are each entirely
//      inside the 1080x1350 frame, clear of every edge
//   3. the name drawn equals the catalogue name in full, with no ellipsis
//
// "Pixels of a text element" are found two independent ways: (a) the type layer
// rasterised on its own, per role, and (b) the finished image differenced
// against the same photograph with only the scrims composited.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const sharp = require("sharp");
const admin = require("firebase-admin");
const D = require("./lib/social-design.cjs");
const R = require("./lib/social-render.cjs");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = resolve(outIdx >= 0 ? args[outIdx + 1] : "proof-safe-zone");
const pids = args.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1);
if (!pids.length) {
  console.error("usage: node scripts/social/proof-safe-zone.mjs --out <dir> <pid> [pid ...]");
  process.exit(2);
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Bounding box of pixels where `hit(i)` is true; null when there are none. */
function bbox(data, info, channels, hit) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (hit((y * info.width + x) * channels)) {
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return n ? { x0, y0, x1, y1, n } : null;
}

/** Keep only the text elements of one role in a rendered overlay. */
function onlyRoles(svg, roles) {
  const head = svg.slice(0, svg.indexOf("<g "));
  const group = svg.match(/<g [^>]*>/)[0];
  const texts = (svg.match(/<text [\s\S]*?<\/text>/g) || []).filter((t) => roles.some((r) => t.includes(`data-role="${r}"`)));
  return { svg: `${head}${group}${texts.join("\n")}</g></svg>`, texts };
}

async function alphaBox(svg) {
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { box: bbox(data, info, 4, (i) => data[i + 3] > 0), info };
}

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
await mkdir(OUT, { recursive: true });

let failures = 0;
const report = [];
const check = (ok, what) => {
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
  return ok;
};

for (const pid of pids) {
  const p = (await db.ref(`products/${pid}`).once("value")).val();
  if (!p) { check(false, `${pid}: no such product`); continue; }
  const name = p.displayName || p.name;
  const photoUrl = (Array.isArray(p.photos) && p.photos[0]) || p.photoUrl;
  console.log(`\n${pid}  ${name}  R${p.retailPrice}`);
  if (!check(Boolean(photoUrl), "the product has a photograph")) continue;

  const res = await fetch(photoUrl);
  const src = Buffer.from(await res.arrayBuffer());
  // A stand-in for the model's scene: the catalogue shot centred on a dark
  // ground, a little taller than 9:16 so normalise has real work to do.
  const shot = await sharp(src).resize(1300, 1300, { fit: "inside" }).toBuffer();
  const scene = await sharp({ create: { width: 1536, height: 2752, channels: 3, background: { r: 58, g: 56, b: 54 } } })
    .composite([{ input: shot, gravity: "centre" }]).png().toBuffer();

  const products = [{ displayName: name, retailPrice: p.retailPrice }];
  const { buffer: norm } = await R.normalizeSocialImage(scene, "image/png", "story");
  const out = await R.compositeSocialDesign(norm, { products, kind: "single", format: "story", alsoFeed: true });
  check(out.designed === true, "the design was composited");
  check(out.width === 1080 && out.height === 1920, `story file is ${out.width}x${out.height}`);
  check(Boolean(out.feed) && out.feed.width === 1080 && out.feed.height === 1350, `feed file is ${out.feed?.width}x${out.feed?.height}`);
  if (!out.feed) continue;

  const storyPng = join(OUT, `${pid}-story-1080x1920.png`);
  const feedPng = join(OUT, `${pid}-feed-1080x1350.png`);
  const cropPng = join(OUT, `${pid}-story-cropped-4x5.png`);
  await sharp(out.buffer).png().toFile(storyPng);
  await sharp(out.feed.buffer).png().toFile(feedPng);
  await sharp(out.buffer).extract({ left: 0, top: 285, width: 1080, height: 1350 }).png().toFile(cropPng);

  // The overlay the generator composited, rebuilt with the same inputs.
  const edges = await R.measureEdges(norm);
  const storySvg = D.buildOverlay({ products, edges, kind: "single", format: "story", width: 1080, height: 1920 });
  const feedSvg = D.buildOverlay({ products, edges, kind: "single", format: "story", surface: "feed", width: 1080, height: 1350 });

  // 1a. Every text element, rasterised alone, on the story.
  const ROLES = ["wordmark", "brand", "name", "price", "total", "cta", "url"];
  const allText = await alphaBox(onlyRoles(storySvg, ROLES).svg);
  check(allText.box.y0 >= 285 && allText.box.y1 < 1635,
    `story: all type rasterised spans y ${allText.box.y0}..${allText.box.y1} — inside 285..1635`);
  check(allText.box.y0 >= 345 && allText.box.y1 <= 1575,
    `story: and inside the stricter band 345..1575`);

  // 1b. The finished story file against the same photograph with scrims only.
  const scrimOnly = D.buildOverlay({ products, edges, kind: "single", format: "story", width: 1080, height: 1920, layers: "scrim" });
  // Encoded exactly as the generator encodes, then both decoded to RGB: raw()
  // after jpeg() would skip the encode and keep an alpha channel.
  const baseJpeg = await sharp(norm).composite([{ input: Buffer.from(scrimOnly) }]).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  const base = await sharp(baseJpeg).removeAlpha().raw().toBuffer();
  const fin = await sharp(out.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const THRESH = 60;   // JPEG ringing stays well under this; glyph edges do not
  let outside = 0;
  const diffBox = bbox(fin.data, fin.info, 3, (i) => {
    const d = Math.max(Math.abs(fin.data[i] - base[i]), Math.abs(fin.data[i + 1] - base[i + 1]), Math.abs(fin.data[i + 2] - base[i + 2]));
    if (d > THRESH) {
      const y = Math.floor(i / 3 / fin.info.width);
      if (y < 285 || y >= 1635) outside++;
      return true;
    }
    return false;
  });
  check(outside === 0, `story: output differs from the scrim-only image by >${THRESH} at ${diffBox?.n ?? 0} px, spanning y ${diffBox?.y0}..${diffBox?.y1}; ${outside} of them outside 285..1635`);

  // 2. The feed file: wordmark, name, price each whole and inside the frame.
  for (const [label, roles] of [["wordmark", ["wordmark"]], ["product name", ["brand", "name"]], ["price", ["price"]]]) {
    const { box, info } = await alphaBox(onlyRoles(feedSvg, roles).svg);
    const inside = box && box.x0 > 0 && box.y0 > 0 && box.x1 < info.width - 1 && box.y1 < info.height - 1;
    check(inside, `feed: ${label} at x ${box?.x0}..${box?.x1}, y ${box?.y0}..${box?.y1} — entirely inside 1080x1350`);
  }

  // 3. The name, in full.
  const drawn = onlyRoles(feedSvg, ["brand", "name"]).texts.map((t) => unesc(t.replace(/<[^>]+>/g, ""))).join(" ");
  const want = name.trim().replace(/\s+/g, " ").toUpperCase();
  check(!/…|\.\.\./.test(storySvg + feedSvg), "no ellipsis anywhere on either file");
  check(drawn.replace(/\s+/g, " ") === want, `the name drawn is "${drawn}" — catalogue "${want}"`);

  report.push({ pid, name, price: p.retailPrice, story: storyPng, feed: feedPng, storyCropped4x5: cropPng, typeSpanStory: [allText.box.y0, allText.box.y1] });
}

await writeFile(join(OUT, "report.json"), JSON.stringify({ failures, products: report }, null, 2));
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"} — files in ${OUT}`);
process.exit(failures ? 1 : 0);
