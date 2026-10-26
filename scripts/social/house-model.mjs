// ─── THE HOUSE MODEL: FOUR CANDIDATE FACES, JUNID PICKS ONE ─────────────────
// Junid, 26 Oct 2026: one consistent house model for every outfit post, an
// INVENTED young South African Black man (lookbook/house-model.cjs has the
// brief and the lifecycle). This script:
//
//   --candidates   makes four candidate faces on Nano Banana Pro from the
//                  text brief alone (no photo of anyone is ever sent), has
//                  claude-opus-5-5 score each against the brief, uploads them
//                  and writes social_lookbook/houseModel with decideBy = now +
//                  24 h. Refuses if candidates already exist (--replace).
//   --pick N       makes candidate N the house model (Junid's choice).
//   --status       prints the candidates, scores, deadline and pick.
//
// Until a pick, the best-scoring candidate stands in; 24 hours after
// --candidates with no pick, the best-scoring one is picked automatically the
// next time a hero is made. Each generation is counted on
// social_generation_budget/{today}, like any other.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/house-model.mjs --candidates | --pick 2 | --status
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
const houseModel = require("./lookbook/house-model.cjs");
const fitRules = require("./lib/fit-rules.cjs");
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const has = (name) => process.argv.includes(`--${name}`);
const secret = (name) => execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, "--project", "marathon-club"], { encoding: "utf8" }).trim();
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const bucket = admin.storage().bucket(STORAGE_BUCKET);
const OUT = join(homedir(), "Desktop", "house-model");

const hmNow = (await db.ref(houseModel.HOUSE_PATH).once("value")).val();

if (has("status")) {
  console.log(JSON.stringify({ ...hmNow, decideByIso: hmNow && new Date(hmNow.decideBy).toISOString(), ranked: houseModel.rankCandidates(hmNow).map((c) => `${c.n}: ${c.score}`) }, null, 2));
  process.exit(0);
}

if (arg("pick")) {
  if (!hmNow) throw new Error("no candidates yet: run --candidates first");
  const u = houseModel.pickUpdates(hmNow, arg("pick"), { by: has("auto") ? "auto" : "junid", nowMs: Date.now() });
  await db.ref().update(u);
  console.log(`house model is candidate ${arg("pick")} (${u[houseModel.MODEL_PATH].path})`);
  process.exit(0);
}

if (!has("candidates")) { console.error("usage: --candidates [--replace] | --pick N | --status"); process.exit(1); }
if (hmNow && !has("replace")) { console.error(`candidates already exist (${new Date(hmNow.generatedAt).toISOString()}) — pass --replace for four new faces`); process.exit(1); }

const geminiApiKey = secret("GEMINI_API_KEY");
const anthropic = new (Anthropic.default || Anthropic)({ apiKey: secret("anthropic-api-key") });
await mkdir(OUT, { recursive: true });
const saDate = saDateStringFromMs(Date.now());

// The critic model scores each face against the brief, from the photo alone.
const SCORE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["score", "age", "build", "skin", "hair", "face", "expression", "light", "realism", "reasons"],
  properties: {
    score: { type: "integer", description: "1 to 10: how well the photo matches the whole brief" },
    ...Object.fromEntries(["age", "build", "skin", "hair", "face", "expression", "light", "realism"].map((k) => [k, { type: "integer", description: "1 to 10" }])),
    reasons: { type: "string" },
  },
};
async function scoreFace(jpg) {
  const small = await sharp(jpg).resize(768, 768, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  const msg = await anthropic.messages.create({
    model: fitRules.FIT_MODEL, max_tokens: 1500,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCORE_SCHEMA } },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: small.toString("base64") } },
      { type: "text", text: [
        "This is a candidate face for a clothing brand's house model. Score it strictly against the brief, 1 to 10 each:",
        `Brief: ${lookbook.MODEL_DESCRIPTION}. Photographed in natural light in a real South African outdoor or urban setting, not a studio.`,
        "age (early 20s), build (slim athletic), skin (dark brown), hair (clean low fade, short, neat, sharp hairline), face (clean-shaven or very light stubble), expression (calm, confident), light (natural, real location, not studio), realism (a real photograph, no AI artefacts in eyes, teeth, hands, ears or skin), and score: the whole brief, and how well this face would carry a brand as its recurring model.",
      ].join("\n") },
    ] }],
  });
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { ...JSON.parse(text), costUSD: fitRules.costOf(msg.usage) };
}

const at = Date.now();
const candidates = {};
let totalUSD = 0;
for (let n = 1; n <= 4; n++) {
  await db.ref(`social_generation_budget/${saDate}/count`).transaction((cur) => (Number(cur) || 0) + 1);
  const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.NBPRO_MODEL, [{ text: lookbook.buildModelRefPrompt() }], {
    outPerMtok: gemini.NBPRO_OUT_PER_MTOK, flatUsd: gemini.NBPRO_FLAT_IMAGE_USD,
    imageConfig: { aspectRatio: "4:5", imageSize: "2K" },
  });
  const jpg = await sharp(gen.buffer).jpeg({ quality: 92 }).toBuffer();
  const s = await scoreFace(jpg);
  const path = `${houseModel.REF_PREFIX}house-${at}-${n}.jpg`;
  const token = randomUUID();
  await bucket.file(path).save(jpg, { resumable: false, contentType: "image/jpeg", metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } } });
  const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  const costUSD = +(gen.costUSD + s.costUSD).toFixed(5);
  totalUSD += costUSD;
  const { reasons, score, costUSD: _c, ...parts } = s;
  candidates[n] = { path, url, contentType: "image/jpeg", engine: gemini.NBPRO_MODEL, score, parts, reasons: String(reasons).slice(0, 600), costUSD };
  await writeFile(join(OUT, `candidate-${n}.jpg`), jpg);
  console.log(`candidate ${n}: ${score}/10 — ${reasons} ($${costUSD})`);
}
await db.ref(houseModel.HOUSE_PATH).set({
  generatedAt: at, decideBy: at + houseModel.DECIDE_MS, candidates, picked: null, prompt: lookbook.buildModelRefPrompt(),
  replaced: hmNow ? hmNow.generatedAt : null,
});
const ranked = houseModel.rankCandidates({ candidates });
await writeFile(join(OUT, "candidates.json"), JSON.stringify({ generatedAt: new Date(at).toISOString(), decideBy: new Date(at + houseModel.DECIDE_MS).toISOString(), candidates }, null, 2));
console.log(JSON.stringify({ best: ranked[0].n, decideBy: new Date(at + houseModel.DECIDE_MS).toISOString(), totalUSD: +totalUSD.toFixed(4), out: OUT }, null, 2));
process.exit(0);
