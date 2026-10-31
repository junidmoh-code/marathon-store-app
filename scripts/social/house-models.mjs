// ─── THE THREE HOUSE MODELS: THREE CANDIDATES EACH, JUNID PICKS ──────────────
// Junid, 30 Oct 2026 19:16 (lookbook/house-models.cjs has the brief and the
// lifecycle). Every face is INVENTED: made from the text brief alone, no photo
// of anyone is ever sent.
//
//   --candidates [--slot black|white|coloured] [--replace]
//                  three full-body candidates per model on Nano Banana Pro,
//                  scored by claude-opus-5-5 against the brief, uploaded, and
//                  social_lookbook/models/{slot} written with decideBy = now + 24 h.
//                  Writes ~/Desktop/house-models/{slot}-{n}.jpg and a contact
//                  sheet of all nine, all-models.jpg.
//   --taller [--slot s] [--send]
//                  Junid, 30 Oct: "still short in height". Each PICKED face is
//                  shot again from itself (the same man, his face as the
//                  reference), taller and longer-legged with a low camera,
//                  scored (height included), stored as a new candidate and made
//                  the pick (tallerOf: the face he chose). Writes
//                  ~/Desktop/house-models/{slot}-tall.jpg and taller.jpg (his
//                  picks above, the taller re-shoots below); --send sends it.
//   --taller-sheet [--send]   that sheet alone, from what is stored.
//   --send         the contact sheet to Junid's WhatsApp (Jimmy, --kind junid).
//   --pick black=2 [white=1] [coloured=3] [--override]   Junid's choice.
//   --auto         the 24-hour fallback: each unpicked model past its deadline
//                  gets its highest-scoring face, and Junid is told on WhatsApp.
//                  Run once by launchd at the deadline. NOT an approval.
//   --approve      Junid has approved the three models: lookbooks may post.
//                  Only when Junid says so. Refuses until all three are picked.
//   --status
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/house-models.mjs --status
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
const hm = require("./lookbook/house-models.cjs");
const fitRules = require("./lib/fit-rules.cjs");
const { STORAGE_BUCKET } = require("./lib/photo-scope.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const has = (name) => process.argv.includes(`--${name}`);
const secret = (name) => execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, "--project", "marathon-club"], { encoding: "utf8" }).trim();
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const bucket = admin.storage().bucket(STORAGE_BUCKET);
const OUT = join(homedir(), "Desktop", "house-models");
const SHEET = join(OUT, "all-models.jpg");
// Junid's own number, through Jimmy's outbox (kind "junid" goes to no one else).
const JIMMY_DIR = join(homedir(), "marathon-dm-agent");
const JUNID_WHATSAPP = "27813995333";

const models = (await db.ref(hm.MODELS_PATH).once("value")).val() || {};
const sast = (ms) => new Date(Number(ms) + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " SAST";

function tellJunid(text, media = null) {
  const a = ["bin/jimmy-send.mjs", "--to", JUNID_WHATSAPP, "--kind", "junid", "--text", text];
  if (media) a.push("--media", media);
  const out = execFileSync(process.execPath, a, { cwd: JIMMY_DIR, encoding: "utf8", timeout: 60000 });
  console.log(out.split("\n")[0]);
}

if (has("status")) {
  for (const slot of hm.ORDER) {
    const n = models[slot];
    console.log(`${slot}: ${n ? `picked ${n.picked || "–"}${n.pickedBy ? ` (${n.pickedBy})` : ""}, decide by ${sast(n.decideBy)}, ranked ${hm.rankCandidates(n).map((c) => `${c.n}:${c.score}`).join(" ")}` : "no candidates"}`);
  }
  const ap = (await db.ref(hm.APPROVAL_PATH).once("value")).val();
  console.log(`approved: ${ap && ap.approved ? `yes (${ap.by}, ${sast(ap.at)})` : "NO — no lookbook with a model posts"}`);
  console.log(`gate: ${JSON.stringify(hm.gateFor(models, ap))}`);
  process.exit(0);
}

if (has("pick")) {
  const picks = process.argv.slice(process.argv.indexOf("--pick") + 1).filter((x) => /^[a-z]+=\d$/.test(x)).map((x) => x.split("="));
  if (!picks.length) throw new Error("usage: --pick black=2 [white=1] [coloured=3]");
  const u = {};
  for (const [slot, n] of picks) {
    const node = models[slot];
    if (!node) throw new Error(`no ${slot} candidates yet`);
    if (node.picked && String(node.picked) !== n && !has("override")) throw new Error(`${slot} already has candidate ${node.picked} (${node.pickedBy}) — pass --override to change him`);
    Object.assign(u, hm.pickUpdates(slot, node, n, { by: "junid", nowMs: Date.now() }));
  }
  await db.ref().update(u);
  console.log(`picked: ${picks.map(([s, n]) => `${s} ${n}`).join(", ")}`);
  process.exit(0);
}

if (has("auto")) {
  const { updates, picked } = hm.duePicks(models, Date.now());
  if (!picked.length) { console.log("nothing due: every model is picked or still inside its 24 hours"); process.exit(0); }
  await db.ref().update(updates);
  const text = [
    "House models: no pick came in within 24 hours, so the highest-scoring face is now locked:",
    ...picked.map((p) => `• ${hm.MODELS[p.slot].label}: candidate ${p.n} (${p.score}/10)`),
    "Nothing with a model posts until you approve the models. Reply \"approve models\" (or name a different face, e.g. \"black 2\").",
  ].join("\n");
  tellJunid(text);
  console.log(text);
  process.exit(0);
}

if (has("approve")) {
  const faces = hm.approvalFaces(models);
  const g = hm.gateFor(models, { approved: true, faces });
  if (!g.ok) throw new Error(`cannot approve: ${g.reason}`);
  // The approval names the exact face files: a face changed later needs a new one.
  await db.ref(hm.APPROVAL_PATH).set({ approved: true, by: "junid", at: Date.now(), faces, picked: Object.fromEntries(hm.ORDER.map((s) => [s, String(models[s].picked)])) });
  console.log("approved: lookbooks with the three house models may post");
  process.exit(0);
}

if (has("send") && !has("taller") && !has("taller-sheet")) {
  tellJunid([
    "The 9 house-model candidates (invented faces, made from the brief only). Pick one per model, e.g. \"black 2, white 1, coloured 3\".",
    ...hm.ORDER.map((slot) => `${hm.MODELS[slot].label}: ${hm.rankCandidates(models[slot]).sort((a, b) => a.n - b.n).map((c) => `${c.n} = ${c.score}/10`).join(", ")}`),
    `No pick within 24 hours: the highest score is used and I'll tell you. Nothing with a model posts until you approve.`,
  ].join("\n"), SHEET);
  process.exit(0);
}

if (!has("candidates") && !has("taller") && !has("taller-sheet")) { console.error("usage: --candidates [--slot s] [--replace] | --taller [--slot s] [--send] | --send | --pick black=2 … | --auto | --approve | --status"); process.exit(1); }
const slots = arg("slot") ? [arg("slot")] : hm.ORDER;
for (const s of slots) {
  if (!hm.MODELS[s]) throw new Error(`no model "${s}"`);
  if (has("candidates") && models[s] && !has("replace")) throw new Error(`${s} already has candidates — pass --replace for new faces`);
  if (has("taller") && !hm.chosenFor(models[s])) throw new Error(`${s} has no picked face to make taller`);
}

const geminiApiKey = secret("GEMINI_API_KEY");
const anthropic = new (Anthropic.default || Anthropic)({ apiKey: secret("anthropic-api-key") });
await mkdir(OUT, { recursive: true });
const saDate = saDateStringFromMs(Date.now());

// The critic model scores each candidate against his brief, from the photo alone.
const PARTS = ["age", "build", "height", "shoulders", "face", "hair", "stubble", "heritage", "look", "photo", "realism"];
const SCORE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["score", ...PARTS, "reasons"],
  properties: {
    score: { type: "integer", description: "1 to 10: how well the photo matches the whole brief" },
    ...Object.fromEntries(PARTS.map((k) => [k, { type: "integer", description: "1 to 10" }])),
    reasons: { type: "string" },
  },
};
async function scoreFace(jpg, model) {
  const small = await sharp(jpg).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  const msg = await anthropic.messages.create({
    model: fitRules.FIT_MODEL, max_tokens: 1500,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCORE_SCHEMA } },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: small.toString("base64") } },
      { type: "text", text: [
        "This is a candidate for one of a clothing brand's three house models. Score it strictly against his brief, 1 to 10 each:",
        `Brief: ${model.description}. A professional fashion shoot (good camera, good light, model posing), not a phone snap. Full length.`,
        "age (early-to-mid 20s), build (slim, runway), height (reads as a very tall 1.90 m runway model: long legs more than half his height, a small head, about eight and a half heads tall; a short or stocky look scores low), shoulders (proper wide, broad, square shoulders over a slim waist, a clear V shape; narrow or sloping shoulders score low, so does a bulky bodybuilder), face (sharp, defined, strong jawline), hair (very short: skin fade or buzz cut, hair barely visible), stubble (clean-shaven or very light), heritage (clearly matches the brief's heritage and skin tone), look (a confident fashion model, posing), photo (looks like a professional fashion shoot, not a phone snap; full length, head to toe), realism (a real photograph: no AI artefacts in eyes, teeth, hands, ears, feet or skin), and score: the whole brief, and how well he would carry a brand as its recurring model.",
        "Under 60 words of reasons.",
      ].join("\n") },
    ] }],
  });
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { ...JSON.parse(text), costUSD: fitRules.costOf(msg.usage) };
}

async function store(slot, n, jpg, gen, s, at, extra = {}) {
  const path = `${hm.REF_PREFIX}${slot}-${at}-${n}.jpg`;
  const token = randomUUID();
  await bucket.file(path).save(jpg, { resumable: false, contentType: "image/jpeg", metadata: { cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } } });
  const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  const costUSD = +(gen.costUSD + s.costUSD).toFixed(5);
  const { reasons, score, costUSD: _c, ...parts } = s;
  return { path, url, contentType: "image/jpeg", engine: gemini.NBPRO_MODEL, score, parts, reasons: String(reasons).slice(0, 600), costUSD, ...extra };
}

// The taller sheet, from what is stored: for each model whose pick is a
// re-shoot, the face Junid chose on top and the taller pick below. --send
// sends it to him. Also run alone (--taller-sheet [--send]) once every model
// has been re-shot one --slot at a time.
async function sendTallerSheet() {
  const W = 480, H = 853, PAD = 16, LABEL = 56, tiles = [], lines = [];
  const label = (t) => Buffer.from(`<svg width="${W}" height="${LABEL}"><rect width="100%" height="100%" fill="#111"/><text x="16" y="38" font-family="Helvetica, Arial" font-size="26" font-weight="700" fill="#fff">${t}</text></svg>`);
  const rows = hm.ORDER.map((slot) => ({ slot, pick: hm.chosenFor(models[slot]) })).filter((r) => r.pick && r.pick.tallerOf);
  if (!rows.length) throw new Error("no model has a taller re-shoot yet");
  for (const [col, r] of rows.entries()) {
    const before = hm.rankCandidates(models[r.slot]).find((c) => c.n === String(r.pick.tallerOf));
    const x = PAD + col * (W + PAD);
    for (const [row, [c, t]] of [[before, `${r.slot.toUpperCase()} ${r.pick.tallerOf} · YOUR PICK`], [r.pick, `${r.slot.toUpperCase()} ${r.pick.tallerOf} TALLER · H ${r.pick.parts.height} · S ${r.pick.parts.shoulders || "–"}`]].entries()) {
      const [buf] = await bucket.file(c.path).download();
      const y = PAD + row * (H + LABEL + PAD);
      tiles.push({ input: await sharp(buf).resize(W, H, { fit: "cover" }).jpeg().toBuffer(), left: x, top: y + LABEL }, { input: label(t), left: x, top: y });
    }
    lines.push(`• ${hm.MODELS[r.slot].label} ${r.pick.tallerOf}: ${r.pick.score}/10, height ${r.pick.parts.height}/10, shoulders ${r.pick.parts.shoulders || "–"}/10`);
  }
  const sheet = join(OUT, "taller.jpg");
  await mkdir(OUT, { recursive: true });
  await sharp({ create: { width: PAD + rows.length * (W + PAD), height: PAD + 2 * (H + LABEL + PAD), channels: 3, background: "#000" } }).composite(tiles).jpeg({ quality: 85 }).toFile(sheet);
  console.log(`sheet: ${sheet}`);
  if (has("send")) tellJunid([
    "Your picks, re-shot taller with wide shoulders (same faces: top row is your pick, bottom row the new version).",
    ...lines,
    "The new ones are now the faces. Reply \"approve models\" to let lookbooks with them post, or tell me what to change. Nothing with a model posts until you approve.",
  ].join("\n"), sheet);
}

if (has("taller-sheet")) { await sendTallerSheet(); process.exit(0); }

if (has("taller")) {
  // Up to two re-shoots per man; the first that scores 8+ overall and on height is kept, else the better one.
  const at = Date.now();
  let totalUSD = 0;
  const rows = [];
  for (const slot of slots) {
    const model = hm.MODELS[slot];
    // Always from the face Junid chose, never from an earlier re-shoot of it.
    const pick = hm.chosenFor(models[slot]);
    const chosen = pick.tallerOf ? hm.rankCandidates(models[slot]).find((c) => c.n === String(pick.tallerOf)) : pick;
    const [face] = await bucket.file(chosen.path).download();
    const prompt = lookbook.buildModelRefPrompt(model, { fromFace: true });
    let best = null;
    for (let k = 1; k <= 2 && !(best && best.s.score >= 8 && best.s.height >= 8 && best.s.shoulders >= 8); k++) {
      await db.ref(`social_generation_budget/${saDate}/count`).transaction((cur) => (Number(cur) || 0) + 1);
      const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.NBPRO_MODEL, [
        { text: "FACE REFERENCE — the man to photograph again (his face, skin tone, hair and stubble only; not his height, pose or framing):" },
        gemini.inlineImagePart(face, chosen.contentType || "image/jpeg"),
        { text: prompt },
      ], { outPerMtok: gemini.NBPRO_OUT_PER_MTOK, flatUsd: gemini.NBPRO_FLAT_IMAGE_USD, imageConfig: { aspectRatio: "9:16", imageSize: "2K" } });
      const jpg = await sharp(gen.buffer).jpeg({ quality: 92 }).toBuffer();
      const s = await scoreFace(jpg, model);
      totalUSD += gen.costUSD + s.costUSD;
      console.log(`${slot} taller ${k}: ${s.score}/10, height ${s.height}, shoulders ${s.shoulders} — ${s.reasons}`);
      // One that meets both targets beats one that does not; then the higher score plus height.
      const meets = (x) => x.score >= 8 && x.height >= 8 && x.shoulders >= 8;
      if (!best || (meets(s) && !meets(best.s)) || (meets(s) === meets(best.s) && s.score + s.height + s.shoulders > best.s.score + best.s.height + best.s.shoulders)) best = { jpg, gen, s };
    }
    const n = String(Math.max(...Object.keys(models[slot].candidates).map(Number)) + 1);
    const c = await store(slot, n, best.jpg, best.gen, best.s, at, { tallerOf: chosen.n });
    await db.ref().update({
      [`${hm.MODELS_PATH}/${slot}/candidates/${n}`]: c,
      ...hm.pickUpdates(slot, { candidates: { ...models[slot].candidates, [n]: c } }, n, { by: models[slot].pickedBy || "junid", nowMs: Date.now() }),
    });
    models[slot].candidates[n] = c;
    models[slot].picked = n;
    await writeFile(join(OUT, `${slot}-tall.jpg`), best.jpg);
    rows.push({ slot, from: chosen.n, n, score: c.score, height: c.parts.height, before: face, after: best.jpg });
  }
  if (has("send")) await sendTallerSheet();
  console.log(JSON.stringify({ totalUSD: +totalUSD.toFixed(4), rows: rows.map(({ before, after, ...r }) => r) }, null, 2));
  process.exit(0);
}

const at = Date.now();
let totalUSD = 0;
for (const slot of slots) {
  const model = hm.MODELS[slot];
  const prompt = lookbook.buildModelRefPrompt(model);
  const candidates = {};
  for (let n = 1; n <= hm.CANDIDATES; n++) {
    await db.ref(`social_generation_budget/${saDate}/count`).transaction((cur) => (Number(cur) || 0) + 1);
    const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.NBPRO_MODEL, [{ text: prompt }], {
      outPerMtok: gemini.NBPRO_OUT_PER_MTOK, flatUsd: gemini.NBPRO_FLAT_IMAGE_USD,
      imageConfig: { aspectRatio: "9:16", imageSize: "2K" },
    });
    const jpg = await sharp(gen.buffer).jpeg({ quality: 92 }).toBuffer();
    const s = await scoreFace(jpg, model);
    candidates[n] = await store(slot, n, jpg, gen, s, at);
    totalUSD += candidates[n].costUSD;
    await writeFile(join(OUT, `${slot}-${n}.jpg`), jpg);
    console.log(`${slot} ${n}: ${s.score}/10 — ${s.reasons} ($${candidates[n].costUSD})`);
  }
  await db.ref(`${hm.MODELS_PATH}/${slot}`).set({ generatedAt: at, decideBy: at + hm.DECIDE_MS, candidates, picked: null, prompt, replaced: models[slot] ? models[slot].generatedAt : null });
  models[slot] = { candidates };
}

// The contact sheet: three rows (one per model), three faces each, labelled.
const W = 480, H = 853, PAD = 16, LABEL = 56;
const tiles = [];
for (const [row, slot] of hm.ORDER.entries()) {
  for (const c of hm.rankCandidates(models[slot]).sort((a, b) => a.n - b.n)) {
    const [buf] = await bucket.file(c.path).download();
    const img = await sharp(buf).resize(W, H, { fit: "cover" }).jpeg().toBuffer();
    const col = Number(c.n) - 1;
    const x = PAD + col * (W + PAD), y = PAD + row * (H + LABEL + PAD);
    const label = Buffer.from(`<svg width="${W}" height="${LABEL}"><rect width="100%" height="100%" fill="#111"/><text x="16" y="38" font-family="Helvetica, Arial" font-size="28" font-weight="700" fill="#fff">${slot.toUpperCase()} ${c.n}  ·  ${c.score}/10</text></svg>`);
    tiles.push({ input: img, left: x, top: y + LABEL }, { input: label, left: x, top: y });
  }
}
const sheetW = PAD + 3 * (W + PAD), sheetH = PAD + 3 * (H + LABEL + PAD);
await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: "#000" } }).composite(tiles).jpeg({ quality: 85 }).toFile(SHEET);
console.log(JSON.stringify({ totalUSD: +totalUSD.toFixed(4), decideBy: sast(at + hm.DECIDE_MS), out: OUT, sheet: SHEET }, null, 2));
process.exit(0);
