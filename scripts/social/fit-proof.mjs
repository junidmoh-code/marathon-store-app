// ─── PROOF: THE LOUBOUTIN POST REBUILT, AND TEN NEW OUTFIT CARDS ────────────
// Junid, 26 Oct 2026: "Rebuild today's Louboutin post with a proper fit and
// generate 10 new outfit cards. Show me all 11 with scores before/after.
// Delete nothing that's already posted."
//
//   · BEFORE for the Louboutin post: the critic (claude-opus-5-5, the same
//     call production makes) scores the fit that went out on 26 Oct, from its
//     product photos, theme name and feed caption. The post is only READ.
//   · Card 00 rebuilds it: the production lookbook (makeLookbook with the
//     opus stylist + critic) with the Louboutins fixed as the hero.
//   · Cards 01–10: ten new lookbooks, each with products none of the others
//     use. A fit the critic skips is reported and another is made.
//   · BEFORE / AFTER for every card: the critic's first scored round and the
//     round that passed.
//
// Every card is the production code end to end (4K hero, house model, real
// SA scene) and is saved to ~/Desktop/fit-proof/ and put in the Social queue
// as status "sample": never scheduled, never posted. Each card's generation
// is counted on social_generation_budget/{today} past the cap (Junid asked for
// these cards). Resumable: a card already in fit-proof.json is not made again.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/fit-proof.mjs [--cards 10]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const { makeLookbook } = require("./lookbook/lookbook.cjs");
const { engines } = require("./lookbook/engines.cjs");
const lookbookLib = require("./lib/social-lookbook.cjs");
const fitRules = require("./lib/fit-rules.cjs");
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");
const USD_TO_ZAR = 18.0;

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const CARDS = Number(arg("cards", 10));
// Today's Louboutin lookbook: the story and its feed twin (which has the caption).
const BEFORE_POST = "-P4q_O8LhHXfB1395LHX";
const BEFORE_TWIN = "-P4q_P3wgpmLXC-E_gyo";
const SCENES = ["court", "street", "wall"];
const OUT = join(homedir(), "Desktop", "fit-proof");
const secret = (name) => execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, "--project", "marathon-club"], { encoding: "utf8" }).trim();

admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const bucket = admin.storage().bucket(STORAGE_BUCKET);
const saDate = saDateStringFromMs(Date.now());
const fetchImage = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "image/jpeg" };
};
const deps = engines({
  db, saDate, geminiApiKey: secret("GEMINI_API_KEY"), bucket, anthropicApiKey: secret("anthropic-api-key"),
  visionModel: "claude-sonnet-4-6", fetchImage, Anthropic, log: (m) => console.log(`  ${m}`),
});
// Past the day's cap, still counted (as lookbook-samples --override-cap).
deps.unitsLeft = async () => 2;
deps.claimUnit = async () => {
  const res = await db.ref(`social_generation_budget/${saDate}/count`).transaction((cur) => (Number(cur) || 0) + 1);
  return { ok: true, count: Number(res.snapshot.val()) || 0, cap: 4 };
};

await mkdir(OUT, { recursive: true });
const logPath = join(OUT, "fit-proof.json");
const log = existsSync(logPath) ? JSON.parse(await readFile(logPath, "utf8")) : { cards: {} };
const save = () => writeFile(logPath, JSON.stringify(log, null, 2) + "\n");

// ── BEFORE: the posted Louboutin fit, scored by the critic ─────────────────
const [story, twin] = await Promise.all([BEFORE_POST, BEFORE_TWIN].map(async (id) => (await db.ref(`social_posts/${id}`).once("value")).val()));
const LOUB = story.products.find((p) => p.slot === "sneakers").pid;
if (!log.before) {
  const pieces = [];
  for (const p of story.products) {
    const product = (await db.ref(`products/${p.pid}`).once("value")).val() || {};
    const node = (await db.ref(`shopify_publish/${p.pid}`).once("value")).val() || {};
    const ph = lookbookLib.approvedPhoto(product, node);
    pieces.push({ pid: p.pid, slot: p.slot, brand: lookbookLib.posterBrand(product) || product.brand || "", name: p.name, displayName: p.displayName, price: p.price, photoUrl: ph && ph.url });
  }
  const fit = { formula: story.look.key, theme: story.look.name, hero: pieces.find((x) => x.slot === "sneakers"), pieces, colours: ["(not recorded on the post)"], caption: twin.caption };
  const { verdict, costUSD } = await deps.fitAgent.score(fit);
  log.before = { postId: BEFORE_POST, twinId: BEFORE_TWIN, theme: fit.theme, pids: pieces.map((x) => x.pid), names: pieces.map((x) => x.displayName), caption: twin.caption, image: story.artwork && story.artwork.feed && story.artwork.feed.url, verdict, costUSD };
  await save();
}
console.log(`BEFORE ${log.before.theme}: ${JSON.stringify(log.before.verdict.scores)} — ${log.before.verdict.fix}`);

// ── THE CARDS ──────────────────────────────────────────────────────────────
async function upload(n, buffer) {
  const token = randomUUID();
  const path = `aiStudio/social/samples/fit-proof-${n}_${token}.jpg`;
  await bucket.file(path).save(buffer, { resumable: false, contentType: "image/jpeg", metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } } });
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}
const scoreText = (s) => (s ? fitRules.CRITERIA.map((k) => `${k} ${s[k]}`).join(", ") : "—");

const used = new Set();
for (const c of Object.values(log.cards)) for (const pid of c.pids || []) used.add(pid);
const want = ["00", ...Array.from({ length: CARDS }, (_, i) => String(i + 1).padStart(2, "0"))];
let tries = 0;
for (const n of want) {
  while (!(log.cards[n] && log.cards[n].ok) && tries < want.length + 6) {
    tries++;
    const scene = SCENES[Number(n) % SCENES.length];
    const isRebuild = n === "00";
    console.log(`\ncard ${n}${isRebuild ? " (Louboutin rebuild)" : ""} · ${scene}`);
    const t0 = Date.now();
    const r = await makeLookbook(db, deps, {
      nowMs: Date.now(), used: isRebuild ? new Set(used) : new Set([...used, LOUB]), scene, headwear: "allow",
      ...(isRebuild ? { hero: LOUB } : {}),
    });
    const critic = (r.look && r.look.critic) || (r.critic ? require("./lookbook/fit-agent.cjs").criticRecord(r.critic) : null);
    const scored = critic ? critic.history.filter((h) => h.scores) : [];
    const entry = {
      n, ok: r.ok, gate: r.gate || null, reason: r.reason || null, scene, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
      theme: r.look ? r.look.name : null, formula: r.look ? r.look.key : null, hero: r.look ? r.look.hero : null,
      pids: (r.rows || []).map((x) => x.pid), rows: (r.rows || []).map((x) => ({ slot: x.slot, pid: x.pid, name: x.displayName, panel: `${x.brandLine} ${x.nameLine}`, price: x.priceText })),
      total: r.total ? r.total.text : null, caption: r.caption || null,
      before: scored[0] ? scored[0].scores : null, after: r.ok && critic ? critic.scores : null, rounds: critic ? critic.rounds : 0, history: critic ? critic.history : [],
      reasons: critic ? critic.reasons : null,
      cost: { fitUSD: +(critic ? critic.costUSD : 0).toFixed(4), stylistAndTagsUSD: +(r.stylistCostUSD || 0).toFixed(4), thumbsUSD: +(r.thumbCostUSD || 0).toFixed(4), totalUSD: +(r.costUSD || 0).toFixed(4) },
    };
    if (r.ok) {
      for (const [tag, buf] of [["", r.poster.master.buffer], ["-feed", r.poster.feed.buffer], ["-hero", r.hero.buffer]]) await writeFile(join(OUT, `${n}${tag}.jpg`), buf);
      const url = await upload(n, r.poster.feed.buffer);
      const id = db.ref("social_posts").push().key;
      await db.ref(`social_posts/${id}`).set({
        status: "sample", kind: "lookbook", format: "feed", media: [{ type: "image", url }],
        caption: `FIT PROOF ${n}${isRebuild ? " · the 26 Oct Louboutin post, rebuilt" : ""} · ${entry.theme} · critic before ${scoreText(entry.before)} → after ${scoreText(entry.after)} · ${entry.rounds} round(s) · stylist+critic $${entry.cost.fitUSD}. Not scheduled; never posted.\n\n${entry.caption}`,
        captionSource: "not-needed",
        products: entry.rows.map((x) => ({ pid: x.pid, name: x.name, price: x.price })),
        platforms: { instagram: false, facebook: false, tiktok: false }, scheduledAt: null,
        sample: { n, proof: "fit-proof", look: r.look ? { key: r.look.key, name: r.look.name, critic } : null, costUSD: entry.cost.totalUSD, scene },
        createdAt: Date.now(), updatedAt: Date.now(), updatedBy: "script:fit-proof",
      });
      entry.postId = id; entry.url = url;
      for (const pid of entry.pids) used.add(pid);
      console.log(`card ${n}: ${entry.theme} · before ${scoreText(entry.before)} → after ${scoreText(entry.after)} · ${entry.rounds} round(s) · fit $${entry.cost.fitUSD} · total $${entry.cost.totalUSD}`);
    } else {
      console.log(`card ${n}: ${r.gate} — ${r.reason}`);
      log.skipped = [...(log.skipped || []), entry];
      // The products the skipped fit tried stay available; a rebuild that cannot find a fit stops here.
      if (isRebuild) { log.cards[n] = entry; await save(); break; }
      await save();
      continue;
    }
    log.cards[n] = entry;
    await save();
  }
}
const done = Object.values(log.cards).filter((c) => c.ok);
const fit = done.map((c) => c.cost.fitUSD);
log.summary = {
  cards: done.length, skipped: (log.skipped || []).length,
  fitUSD: { mean: +(fit.reduce((a, b) => a + b, 0) / (fit.length || 1)).toFixed(4), max: Math.max(0, ...fit), min: Math.min(...fit) },
  totalUSD: +done.reduce((t, c) => t + c.cost.totalUSD, 0).toFixed(3),
};
await save();
console.log(JSON.stringify(log.summary, null, 2));
process.exit(0);
