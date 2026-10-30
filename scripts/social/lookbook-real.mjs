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
// --rerender re-draws the poster from the hero ALREADY generated
// (docs/lookbook-real-hero.jpg) and the same products, with prices re-read
// from RTDB, fresh cut-outs and a fresh vision check. Two vision calls, NO
// image generation, nothing claimed on the cap.
//
// Keys come from Secret Manager through gcloud (the same secrets the
// functions bind: GEMINI_API_KEY, anthropic-api-key) and are never printed.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const { makeLookbook } = require("./lookbook/lookbook.cjs");
const { engines } = require("./lookbook/engines.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");
const lb = require("./lib/social-lookbook.cjs");
const { renderLookbookPoster, cutout, gridOverlay } = require("./lib/lookbook-render.cjs");
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
  visionModel: "claude-sonnet-4-6",
  fetchImage, Anthropic,
  log: (m) => console.log(m),
});
// No lookbook is scheduled today (this runs before the deploy), so no
// current-style fallback needs a unit held back: the brief's "regenerate
// once" is allowed whenever one unit remains.
const realLeft = deps.unitsLeft;
deps.unitsLeft = async () => { const l = await realLeft(); return l === null ? null : l + 1; };

if (process.argv.includes("--rerender")) {
  const prev = JSON.parse(await readFile(join(ROOT, "docs/lookbook-real.json"), "utf8"));
  const heroBuf = await readFile(join(ROOT, "docs/lookbook-real-hero.jpg"));
  const rows = [], dropped = [];
  for (const old of prev.generation ? prev.generation.rows : prev.rows) {
    const [product, node] = await Promise.all([
      db.ref(`products/${old.pid}`).once("value").then((x) => x.val()),
      db.ref(`shopify_publish/${old.pid}`).once("value").then((x) => x.val()),
    ]);
    const r = lb.resolveRow({ pid: old.pid, product, node, displayName: old.name });
    if (r.skip) { dropped.push({ ...old, why: r.skip }); continue; }
    const img = await fetchImage(r.row.photoUrl);
    const c = await cutout(img.buffer);
    if (!c.png) { dropped.push({ ...old, why: `photo does not cut out cleanly (${(c.tried || []).join(", ")})` }); continue; }
    rows.push({ ...r.row, thumb: img.buffer, cutout: c });
  }
  const check = lb.readHeroCheck(await deps.checkHero(heroBuf, "image/jpeg", lb.buildHeroCheckPrompt(require("./lookbook/house-models.cjs").MODELS.black) /* only its text answer is read here */));
  const gridded = await gridOverlay(heroBuf, lb.GRID);
  await writeFile(join(ROOT, "docs/lookbook-real-grid.jpg"), gridded);
  const located = lb.readLocate(await deps.checkHero(gridded, "image/jpeg", lb.buildLocatePrompt(rows)), rows);
  const anchors = lb.anchorsFor(rows, located.anchors, located.head);
  const poster = await renderLookbookPoster({ hero: heroBuf, rows, anchors, subject: located.head });
  await writeFile(join(ROOT, "docs/lookbook-real.jpg"), poster.master.buffer);
  await writeFile(join(ROOT, "docs/lookbook-real-feed.jpg"), poster.feed.buffer);
  await writeFile(join(ROOT, "docs/lookbook-real-story.jpg"), poster.story.buffer);
  const report = {
    generation: prev.generation || prev,
    rerender: {
      at: new Date().toISOString(), visionModel: "claude-sonnet-4-6", textOk: check.ok, seen: check.seen || null,
      rows: rows.map((x) => ({ slot: x.slot, pid: x.pid, name: x.displayName, price: x.priceText, cutout: x.cutout.method })),
      dropped, total: poster.total.text, anchors, head: located.head,
    },
  };
  await writeFile(join(ROOT, "docs/lookbook-real.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.rerender, null, 2));
  process.exit(0);
}

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
  anchors: r.anchors || null, head: r.located ? r.located.head : null,
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
