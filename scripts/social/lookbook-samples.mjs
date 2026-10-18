
// ─── LOOKBOOK SAMPLES FOR JUNID, MADE BY THE PRODUCTION CODE, POSTED NOWHERE ──
// Runs functions/lookbook/lookbook.cjs end to end, like lookbook-real.mjs, and
// writes the 2:3 master to ~/Desktop/lookbook-samples/NN.jpg with a
// compare-NN.jpg beside docs/lookbook-reference.jpg (or, while that file is
// missing, beside docs/lookbook-real.jpg, the first real Nano Banana Pro poster).
//
// Each sample SPENDS ONE GENERATION, claimed on social_generation_budget/{today}
// against the same cap as the autopilot. It writes NO post, NO lookbook history
// and does not touch the rotation. Products already in a sample in that folder
// (samples.json) or in docs/lookbook-real.json are excluded, so every sample is a
// different outfit.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/lookbook-samples.mjs --n 03 --engine flash
//
// --engine nbpro (default) is the production hero engine; --engine flash sends
// the same parts to gemini-3.1-flash-image, the pipeline's own fallback model.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const sharp = require("sharp");
const { makeLookbook } = require("./lookbook/lookbook.cjs");
const { engines } = require("./lookbook/engines.cjs");
const gemini = require("./lib/gemini-image.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");
const USD_TO_ZAR = 18.0;

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const N = String(arg("n", "01")).padStart(2, "0");
const ENGINE = arg("engine", "nbpro");
if (!["nbpro", "flash"].includes(ENGINE)) throw new Error(`--engine must be nbpro or flash, not ${ENGINE}`);

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const OUT = join(homedir(), "Desktop", "lookbook-samples");
const secret = (name) => execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, "--project", "marathon-club"], { encoding: "utf8" }).trim();

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const nowMs = Date.now();
const saDate = saDateStringFromMs(nowMs);

const fetchImage = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "image/jpeg" };
};

const geminiApiKey = secret("GEMINI_API_KEY");
const deps = engines({
  db, saDate, geminiApiKey,
  anthropicApiKey: secret("anthropic-api-key"),
  visionModel: "claude-sonnet-4-6",
  fetchImage, Anthropic,
  log: (m) => console.log(m),
});
// Run after the day's still has posted, so no current-style fallback needs a
// unit held back (the same allowance lookbook-real.mjs makes).
const realLeft = deps.unitsLeft;
deps.unitsLeft = async () => { const l = await realLeft(); return l === null ? null : l + 1; };
if (ENGINE === "flash") {
  deps.generateHero = async (parts) => {
    const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.GEMINI_MODEL, parts, {
      outPerMtok: gemini.GEMINI_OUT_PER_MTOK, flatUsd: gemini.GEMINI_FLAT_IMAGE_USD,
      // The request the production fallback sends (engines.cjs): no imageSize.
      imageConfig: { aspectRatio: "9:16" },
    });
    return { ...gen, engine: "nb2" };
  };
}

await mkdir(OUT, { recursive: true });
const logPath = join(OUT, "samples.json");
const log = existsSync(logPath) ? JSON.parse(await readFile(logPath, "utf8")) : {};
const used = new Set();
for (const s of Object.values(log)) for (const r of s.rows || []) used.add(r.pid);
const real = JSON.parse(await readFile(join(ROOT, "docs/lookbook-real.json"), "utf8"));
for (const r of (real.generation || real).rows || []) used.add(r.pid);

const before = (await db.ref(`social_generation_budget/${saDate}/count`).once("value")).val();
const r = await makeLookbook(db, deps, { nowMs, used });
const after = (await db.ref(`social_generation_budget/${saDate}/count`).once("value")).val();

const model = ENGINE === "flash" ? gemini.GEMINI_MODEL : gemini.NBPRO_MODEL;
const entry = {
  at: new Date().toISOString(), saDate, ok: r.ok, gate: r.gate || null, reason: r.reason || null,
  model, engineUsed: r.engine || null, budget: { before, after, cap: 4 },
  costUSD: r.costUSD, costZAR: +((r.costUSD || 0) * USD_TO_ZAR).toFixed(2), attempts: r.attempts,
  rows: (r.rows || []).map((x) => ({ slot: x.slot, pid: x.pid, name: x.displayName, price: x.priceText })),
  total: r.total ? r.total.text : null,
};
if (r.ok) {
  await writeFile(join(OUT, `${N}.jpg`), r.poster.master.buffer);
  await writeFile(join(OUT, `${N}-hero.jpg`), r.hero.buffer);
  const refPath = existsSync(join(ROOT, "docs/lookbook-reference.jpg")) ? "docs/lookbook-reference.jpg" : "docs/lookbook-real.jpg";
  const H = 1800, W = 1200, GAP = 40, BAR = 90;
  const label = (t) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BAR}"><text x="0" y="60" font-family="Helvetica" font-size="40" font-weight="bold" fill="#111">${t}</text></svg>`);
  const ref = await sharp(join(ROOT, refPath)).resize(W, H, { fit: "contain", background: "#E9E6DF" }).toBuffer();
  const leftT = refPath.endsWith("reference.jpg") ? "REFERENCE" : "FIRST REAL POSTER · gemini-3-pro-image (17 Oct)";
  await sharp({ create: { width: W * 2 + GAP * 3, height: H + BAR + GAP, channels: 3, background: "#ffffff" } })
    .composite([
      { input: label(leftT), left: GAP, top: 0 },
      { input: label(`SAMPLE ${N} · ${model}`), left: W + GAP * 2, top: 0 },
      { input: ref, left: GAP, top: BAR },
      { input: r.poster.master.buffer, left: W + GAP * 2, top: BAR },
    ])
    .jpeg({ quality: 88 }).toFile(join(OUT, `compare-${N}.jpg`));
  entry.comparedWith = refPath;
}
log[N] = entry;
await writeFile(logPath, JSON.stringify(log, null, 2) + "\n");
console.log(JSON.stringify(entry, null, 2));
process.exit(r.ok ? 0 : 2);
