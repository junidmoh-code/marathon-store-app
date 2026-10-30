// ─── PROOF: SIX FINISHED OUTFIT POSTS, TWO PER HOUSE MODEL ──────────────────
// Junid, 30 Oct 2026 19:16: "Show me 6 finished outfit posts (2 per model)
// before anything goes live." Each card is the production lookbook end to end
// (makeLookbook: the opus stylist with the South African rulebook and the
// model's skin tone, the critic scoring colour, formality, theme, caption and
// model, 8+ or rebuilt, then the 4K hero with the model's reference, the
// checks and the poster), with three differences, all for a sample:
//   · the model is named (two cards each), and an unpicked model stands in
//     with his best-scoring face (allowUnapproved): Junid has not picked yet;
//   · generations are counted on social_generation_budget/{today} past the cap;
//   · the card is saved to ~/Desktop/model-proof/ and the Social queue as
//     status "sample": never scheduled, never posted.
// Resumable: a card already in model-proof.json is not made again.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/model-proof.mjs [--only black-1] [--send]
// --send: the finished cards as one sheet to Junid's WhatsApp (Jimmy, --kind junid).
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
const { criticRecord } = require("./lookbook/fit-agent.cjs");
const hm = require("./lookbook/house-models.cjs");
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const ONLY = arg("only", null);
const OUT = join(homedir(), "Desktop", "model-proof");
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
deps.unitsLeft = async () => 2;
deps.claimUnit = async () => {
  const res = await db.ref(`social_generation_budget/${saDate}/count`).transaction((cur) => (Number(cur) || 0) + 1);
  return { ok: true, count: Number(res.snapshot.val()) || 0, cap: 4 };
};

await mkdir(OUT, { recursive: true });
const logPath = join(OUT, "model-proof.json");
const log = existsSync(logPath) ? JSON.parse(await readFile(logPath, "utf8")) : { cards: {}, skipped: [] };
const save = () => writeFile(logPath, JSON.stringify(log, null, 2) + "\n");
// A card made with a face that is no longer the model's pick (a stand-in, or
// a face since re-shot by house-models.mjs --taller) is made again.
const models = (await db.ref(hm.MODELS_PATH).once("value")).val() || {};
for (const [key, c] of Object.entries(log.cards)) {
  const now = hm.chosenFor(models[c.model], { allowProvisional: true });
  if (!now || String(c.face) !== now.n || c.standIn !== now.provisional) {
    (log.superseded = log.superseded || []).push(c);
    delete log.cards[key];
    console.log(`card ${key}: made with face ${c.face}${c.standIn ? " (stand-in)" : ""}, the pick is now ${now ? now.n : "none"}: made again`);
  }
}
const scoreText = (s) => (s ? Object.entries(s).map(([k, v]) => `${k} ${v}`).join(", ") : "—");

async function upload(key, buffer) {
  const token = randomUUID();
  const path = `aiStudio/social/samples/model-proof-${key}_${token}.jpg`;
  await bucket.file(path).save(buffer, { resumable: false, contentType: "image/jpeg", metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } } });
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// Two cards per model, each card a different scene and hero.
const CARDS = hm.ORDER.flatMap((slot, i) => [1, 2].map((k) => ({ key: `${slot}-${k}`, slot, scene: ["court", "street", "wall"][(i * 2 + k - 1) % 3] })));
const used = new Set();
for (const c of Object.values(log.cards)) for (const r of c.rows || []) if (r.slot === "sneakers") used.add(r.pid);
let tries = 0;
for (const card of CARDS.filter((c) => !ONLY || c.key === ONLY)) {
  while (!log.cards[card.key] && tries < CARDS.length + 6) {
    tries++;
    console.log(`\ncard ${card.key} · ${card.scene}`);
    const t0 = Date.now();
    const r = await makeLookbook(db, deps, {
      nowMs: Date.now(), used: new Set(used), scene: card.scene, headwear: "allow",
      modelSlot: card.slot, allowUnapproved: true,
      avoidFormulas: Object.values(log.cards).sort((a, b) => (a.at < b.at ? 1 : -1)).map((c) => c.formula).filter(Boolean).slice(0, 3),
    });
    const critic = (r.look && r.look.critic) || (r.critic ? criticRecord(r.critic) : null);
    const scored = critic ? critic.history.filter((h) => h.scores) : [];
    const entry = {
      key: card.key, model: card.slot, face: r.model ? r.model.candidate : null, standIn: r.model ? r.model.provisional : null,
      ok: r.ok, gate: r.gate || null, reason: r.reason || null, scene: card.scene, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
      theme: r.look ? r.look.name : null, formula: r.look ? r.look.key : null,
      rows: (r.rows || []).map((x) => ({ slot: x.slot, pid: x.pid, name: x.displayName, panel: `${x.brandLine} ${x.nameLine}`, price: x.priceText })),
      total: r.total ? r.total.text : null, caption: r.caption || null,
      first: scored[0] ? scored[0].scores : null, scores: r.ok && critic ? critic.scores : null, rounds: critic ? critic.rounds : 0, reasons: critic ? critic.reasons : null,
      cost: { fitUSD: +(critic ? critic.costUSD : 0).toFixed(4), thumbsUSD: +(r.thumbCostUSD || 0).toFixed(4), totalUSD: +(r.costUSD || 0).toFixed(4) },
      modelCheck: r.modelCheck ? r.modelCheck.seen : null,
    };
    if (!r.ok) {
      console.log(`card ${card.key}: ${r.gate} — ${r.reason}`);
      log.skipped.push(entry);
      await save();
      continue;
    }
    for (const [tag, buf] of [["", r.poster.master.buffer], ["-feed", r.poster.feed.buffer], ["-hero", r.hero.buffer]]) await writeFile(join(OUT, `${card.key}${tag}.jpg`), buf);
    const url = await upload(card.key, r.poster.feed.buffer);
    const id = db.ref("social_posts").push().key;
    await db.ref(`social_posts/${id}`).set({
      status: "sample", kind: "lookbook", format: "feed", media: [{ type: "image", url }],
      caption: `MODEL PROOF ${card.key} · ${hm.MODELS[card.slot].label}, face ${entry.face}${entry.standIn ? " (best-scoring stand-in)" : ""} · ${entry.theme} · critic ${scoreText(entry.scores)} · ${entry.rounds} round(s) · $${entry.cost.totalUSD}. Not scheduled; never posted.\n\n${entry.caption}`,
      captionSource: "not-needed",
      products: entry.rows.map((x) => ({ pid: x.pid, name: x.name, price: x.price })),
      platforms: { instagram: false, facebook: false, tiktok: false }, scheduledAt: null,
      model: { slot: card.slot, candidate: entry.face },
      sample: { key: card.key, proof: "model-proof", look: r.look ? { key: r.look.key, name: r.look.name, critic } : null, costUSD: entry.cost.totalUSD, scene: card.scene },
      createdAt: Date.now(), updatedAt: Date.now(), updatedBy: "script:model-proof",
    });
    entry.postId = id; entry.url = url;
    for (const x of entry.rows) if (x.slot === "sneakers") used.add(x.pid);
    log.cards[card.key] = entry;
    await save();
    console.log(`card ${card.key}: ${entry.theme} · ${scoreText(entry.scores)} · ${entry.rounds} round(s) · fit $${entry.cost.fitUSD} · total $${entry.cost.totalUSD}`);
  }
}
const done = Object.values(log.cards);
log.summary = {
  cards: done.length, skipped: log.skipped.length,
  perPostUSD: { mean: +(done.reduce((t, c) => t + c.cost.totalUSD, 0) / (done.length || 1)).toFixed(4), max: Math.max(0, ...done.map((c) => c.cost.totalUSD)) },
  fitUSD: { mean: +(done.reduce((t, c) => t + c.cost.fitUSD, 0) / (done.length || 1)).toFixed(4) },
  skippedUSD: +log.skipped.reduce((t, c) => t + (c.cost.totalUSD || 0), 0).toFixed(4),
};
await save();
console.log(JSON.stringify(log.summary, null, 2));
if (process.argv.includes("--send") && done.length) {
  const sharp = require("sharp");
  const W = 540, H = 675, PAD = 16;
  // One row per model, card 1 left and card 2 right; a missing card leaves its place empty.
  const cards = CARDS.filter((c) => log.cards[c.key]);
  const tiles = await Promise.all(cards.map(async (c) => ({
    input: await sharp(join(OUT, `${c.key}-feed.jpg`)).resize(W, H, { fit: "cover" }).jpeg().toBuffer(),
    left: PAD + (Number(c.key.split("-")[1]) - 1) * (W + PAD), top: PAD + hm.ORDER.indexOf(c.slot) * (H + PAD),
  })));
  const sheet = join(OUT, "model-proof-sheet.jpg");
  await sharp({ create: { width: PAD + 2 * (W + PAD), height: PAD + hm.ORDER.length * (H + PAD), channels: 3, background: "#000" } }).composite(tiles).jpeg({ quality: 85 }).toFile(sheet);
  const text = [
    `Model proof: ${done.length} of ${CARDS.length} outfit posts (samples, none posted). One row per model (black, white, coloured): card 1 left, card 2 right.`,
    ...cards.map((c) => { const e = log.cards[c.key]; return `• ${c.key}: ${e.theme} · ${e.total} · critic ${scoreText(e.scores)} · $${e.cost.totalUSD}`; }),
    `Mean $${log.summary.perPostUSD.mean} per post. Nothing with a model posts until you reply "approve models".`,
  ].join("\n");
  console.log(execFileSync(process.execPath, ["bin/jimmy-send.mjs", "--to", "27813995333", "--kind", "junid", "--text", text, "--media", sheet], { cwd: join(homedir(), "marathon-dm-agent"), encoding: "utf8", timeout: 60000 }).split("\n")[0]);
}
process.exit(0);
