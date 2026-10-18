// ─── THE LOOKBOOK'S CHARACTER REFERENCE: ONE MAN ON EVERY POSTER ─────────────
// Owner review of sample 01 (2026-10-18): the model is a Black man, dark skin,
// athletic, 20s–30s, and the same face on every poster. Nano Banana Pro takes
// a person as a reference image, so ONE neutral casting portrait is made here,
// checked by the same vision model the lookbook uses (model_black must be an
// explicit true, and no text), and stored:
//
//   Storage  aiStudio/social/lookbook/model/ref-{ms}.jpg
//   RTDB     social_lookbook/model { path, url, at, costUSD, engine, check }
//
// lookbook/engines.cjs readModelRef() attaches it to every hero from then on.
// It refuses to replace an existing reference without --replace (a new face
// is a new man on the feed). The generation is counted on
// social_generation_budget/{today}, like any other, but not refused by the cap
// (Junid's brief asked for it).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/lookbook-model-ref.mjs [--replace]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const sharp = require("sharp");
const gemini = require("./lib/gemini-image.cjs");
const lookbook = require("./lib/social-lookbook.cjs");
const { engines } = require("./lookbook/engines.cjs");
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");

const secret = (name) => execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, "--project", "marathon-club"], { encoding: "utf8" }).trim();
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const bucket = admin.storage().bucket(STORAGE_BUCKET);
const saDate = saDateStringFromMs(Date.now());

const existing = (await db.ref("social_lookbook/model").once("value")).val();
if (existing && !process.argv.includes("--replace")) {
  console.log(`a character reference already exists (${existing.path}, ${new Date(existing.at).toISOString()}) — pass --replace to make a new man`);
  process.exit(0);
}

const geminiApiKey = secret("GEMINI_API_KEY");
const deps = engines({ db, bucket, saDate, geminiApiKey, anthropicApiKey: secret("anthropic-api-key"), visionModel: "claude-sonnet-4-6", Anthropic });
const OUT = join(homedir(), "Desktop", "lookbook-samples");
await mkdir(OUT, { recursive: true });

let made = null, costUSD = 0;
for (let attempt = 1; attempt <= 2 && !made; attempt++) {
  await db.ref(`social_generation_budget/${saDate}/count`).transaction((cur) => (Number(cur) || 0) + 1);
  const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.NBPRO_MODEL, [{ text: lookbook.buildModelRefPrompt() }], {
    outPerMtok: gemini.NBPRO_OUT_PER_MTOK, flatUsd: gemini.NBPRO_FLAT_IMAGE_USD,
    imageConfig: { aspectRatio: "4:5", imageSize: "2K" },
  });
  costUSD += gen.costUSD;
  const answer = await deps.checkHero(gen.buffer, gen.mime, lookbook.buildHeroCheckPrompt());
  const text = lookbook.readHeroCheck(answer), model = lookbook.readModelCheck(answer);
  console.log(`attempt ${attempt}: $${gen.costUSD} text ${text.ok ? "clean" : text.reason} · model ${model.ok ? `ok (${model.seen})` : model.reason}`);
  await writeFile(join(OUT, `model-ref-attempt${attempt}.jpg`), await sharp(gen.buffer).jpeg({ quality: 92 }).toBuffer());
  if (text.ok && model.ok) made = { gen, model };
}
if (!made) { console.error(`no usable reference after two attempts ($${costUSD.toFixed(4)})`); process.exit(2); }

const jpg = await sharp(made.gen.buffer).jpeg({ quality: 92 }).toBuffer();
const at = Date.now();
const path = `aiStudio/social/lookbook/model/ref-${at}.jpg`;
const token = randomUUID();
await bucket.file(path).save(jpg, { resumable: false, contentType: "image/jpeg", metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } } });
const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
await db.ref("social_lookbook/model").set({
  path, url, at, contentType: "image/jpeg", engine: gemini.NBPRO_MODEL, costUSD: +costUSD.toFixed(6),
  check: made.model.seen || null, replaced: existing ? existing.path : null,
});
await writeFile(join(OUT, "model-ref.jpg"), jpg);
console.log(JSON.stringify({ path, url, costUSD: +costUSD.toFixed(4), costZAR: +(costUSD * 18).toFixed(2) }, null, 2));
process.exit(0);
