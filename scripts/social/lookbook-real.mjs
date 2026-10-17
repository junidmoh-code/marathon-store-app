// ─── ONE REAL LOOKBOOK POSTER, MADE BY THE PRODUCTION CODE, POSTED NOWHERE ───
// Runs functions/lookbook/lookbook.cjs with the real engines (Nano Banana Pro
// via lib/gemini-image.cjs, the claude-haiku-4-5 text check, the live
// catalogue) and writes the three exports to docs/lookbook-real*.jpg.
//
// It SPENDS ONE GENERATION (two if the hero fails the text check) and claims
// it on social_generation_budget/{today}, the same cap the autopilot uses.
// It writes NO post, NO lookbook history and does not touch the rotation.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/lookbook-real.mjs
//
// Keys come from Secret Manager through gcloud (the same secrets the
// functions bind: GEMINI_API_KEY, anthropic-api-key) and are never printed.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const { makeLookbook } = require("./lookbook/lookbook.cjs");
const { engines } = require("./lookbook/engines.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");
// The rate the repo already quotes rand with (functions/lib/alt-shared/visionNaming.js).
const USD_TO_ZAR = 18.0;

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
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

const deps = engines({
  db, saDate,
  geminiApiKey: secret("GEMINI_API_KEY"),
  anthropicApiKey: secret("anthropic-api-key"),
  visionModel: "claude-haiku-4-5",
  fetchImage, Anthropic,
  log: (m) => console.log(m),
});
// No lookbook is scheduled today (this runs before the deploy), so no
// current-style fallback needs a unit held back: the brief's "regenerate
// once" is allowed whenever one unit remains.
const realLeft = deps.unitsLeft;
deps.unitsLeft = async () => { const l = await realLeft(); return l === null ? null : l + 1; };

const before = (await db.ref(`social_generation_budget/${saDate}/count`).once("value")).val();
const r = await makeLookbook(db, deps, { nowMs });
const after = (await db.ref(`social_generation_budget/${saDate}/count`).once("value")).val();

const report = {
  saDate, ok: r.ok, gate: r.gate || null, reason: r.reason || null,
  budget: { before, after, cap: 4 },
  costUSD: r.costUSD, costZAR: +(r.costUSD * USD_TO_ZAR).toFixed(2),
  attempts: r.attempts,
  rows: (r.rows || []).map((x) => ({ slot: x.slot, pid: x.pid, name: x.displayName, price: x.priceText, studio: x.studio })),
  total: r.total ? r.total.text : null,
  anchors: r.anchors || null, head: r.check ? r.check.head : null,
  cutouts: r.poster ? r.poster.cutouts : null,
};
await mkdir(join(ROOT, "docs"), { recursive: true });
if (r.ok) {
  await writeFile(join(ROOT, "docs/lookbook-real.jpg"), r.poster.master.buffer);
  await writeFile(join(ROOT, "docs/lookbook-real-feed.jpg"), r.poster.feed.buffer);
  await writeFile(join(ROOT, "docs/lookbook-real-story.jpg"), r.poster.story.buffer);
  await writeFile(join(ROOT, "docs/lookbook-real-hero.jpg"), r.hero.buffer);
}
await writeFile(join(ROOT, "docs/lookbook-real.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exit(r.ok ? 0 : 2);
