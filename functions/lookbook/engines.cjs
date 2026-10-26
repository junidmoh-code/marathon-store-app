// ─── THE LOOKBOOK'S REAL ENGINES ─────────────────────────────────────────────
// Builds the `deps` lookbook.cjs takes, from what the pipeline already uses:
//   · Nano Banana Pro (gemini-3-pro-image) through lib/gemini-image.cjs, with
//     the same Pro → Flash fallback on an unbilled 5xx that generateSocialScene
//     makes (7 Oct 2026), at 9:16 and 4K, each model's maximum (owner review,
//     18 Oct: 2K gave 1536x2752);
//   · the panel's clean product shots (thumbs.cjs): Flash-Lite with Flash
//     behind it, cached in social_lookbook/thumbs/{pid} + Storage, under
//     their own daily ceiling (THUMBS_PER_DAY), never the hero cap;
//   · the house model (house-model.cjs → social_lookbook/model), attached to
//     every hero so the posters show one man;
//   · the fit agent (fit-agent.cjs): the opus-5-5 stylist and critic that
//     build and score every lookbook fit;
//   · a vision model the pipeline already pays for, for the no-text check and
//     the garment positions: claude-sonnet-4-6 (CHAT_MODEL in index.js, the
//     caption model). claude-haiku-4-5 was tried first and placed the hat a
//     head-height above the beanie on the first real poster (2026-10-17);
//     about a cent more per poster buys dots that land on the garments.
//   · the stylist's tie-break (stylist-call.cjs): one claude-haiku-5-5 call
//     over the shortlist, and the Gemini key for tagging a product the
//     style-tag pre-warm has not reached;
//   · the day's generation cap: social_generation_budget/{saDate}/count,
//     reserved through social-budget's reserveGeneration and released through
//     social-recovery's releaseGeneration. The same counter, the same
//     transaction bodies and the same cap the reels use.
"use strict";

const gemini = require("../lib/gemini-image.cjs");
const socialBudget = require("../lib/social-budget.cjs");
const socialRecovery = require("../lib/social-recovery.cjs");
const lookbook = require("../lib/social-lookbook.cjs");
const { makeStylistChooser } = require("./stylist-call.cjs");
const fitAgent = require("./fit-agent.cjs");
const houseModel = require("./house-model.cjs");
const fitRules = require("../lib/fit-rules.cjs");

/** { build(offer, opts), budgetUSD }: the fit agent on opus-5-5 with the critic's photo reader. */
function fitAgentFor({ Anthropic, apiKey, fetchImage, log }) {
  const call = fitAgent.makeOpusCall({ Anthropic, apiKey });
  const photo = fitAgent.makePhotoReader(fetchImage);
  return {
    budgetUSD: fitRules.BUDGET_USD,
    build: (offer, opts) => fitAgent.buildFit(offer, { call, photo, log }, opts),
    score: (fit) => fitAgent.scoreFit(fit, { call, photo }),
  };
}

// 4K output: $0.24 on Pro, $0.151 on Flash (Gemini API pricing, Oct 2026),
// the estimates used when a response carries no usage metadata.
const NBPRO_4K_FLAT_USD = 0.24;
const FLASH_4K_FLAT_USD = 0.151;
const THUMB_DIR = "aiStudio/social/lookbook/thumbs";
const THUMB_PATH = (pid) => `${THUMB_DIR}/${pid}.png`;
// A pid is an RTDB key and a Storage name: nothing else is accepted.
const SAFE_PID = /^[A-Za-z0-9_-]{1,80}$/;
// A thumbnail is a small 1K picture: a call that has not answered in a minute
// is not going to, and the hero is waiting (architect review of #750).
const THUMB_TIMEOUT_MS = 60000;

function engines({ db, bucket, saDate, geminiApiKey, anthropicApiKey, visionModel, fetchImage, Anthropic, log, deadlineMs }) {
  const counter = () => db.ref(`social_generation_budget/${saDate}/count`);
  const cap = socialBudget.MAX_IMAGE_GENERATIONS_PER_DAY;

  async function generateHero(parts) {
    try {
      const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.NBPRO_MODEL, parts, {
        outPerMtok: gemini.NBPRO_OUT_PER_MTOK, flatUsd: NBPRO_4K_FLAT_USD,
        imageConfig: { aspectRatio: "9:16", imageSize: "4K" },
      });
      return { ...gen, engine: "nbpro" };
    } catch (err) {
      if (!socialRecovery.isUnbilledProviderError(err && err.message)) throw err;
      if (log) log(`lookbook: ${gemini.NBPRO_MODEL} unavailable — retrying on ${gemini.GEMINI_MODEL}`);
      try {
        const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.GEMINI_MODEL, parts, {
          outPerMtok: gemini.GEMINI_OUT_PER_MTOK, flatUsd: FLASH_4K_FLAT_USD,
          imageConfig: { aspectRatio: "9:16", imageSize: "4K" },
        });
        return { ...gen, engine: "nb2" };
      } catch (flashErr) {
        // Pro made nothing (5xx) and Flash made nothing either: no image was
        // returned by either call, so the unit goes back whatever Flash said.
        const e = new Error(`${gemini.NBPRO_MODEL} 5xx, then ${gemini.GEMINI_MODEL}: ${flashErr && flashErr.message}`);
        e.unbilled = true;
        throw e;
      }
    }
  }

  async function checkHero(buffer, _mime, prompt) {
    const sharp = require("sharp");
    // Downscaled for the vision call: text a phone can read is still there at
    // 1568 px, and the call costs a fraction of a cent instead of a few cents.
    const jpeg = await sharp(buffer).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    const Ctor = Anthropic.default || Anthropic;
    const client = new Ctor({ apiKey: anthropicApiKey });
    const msg = await client.messages.create({
      model: visionModel,
      max_tokens: 400,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
          { type: "text", text: prompt },
        ],
      }],
    });
    return (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  async function claimUnit() {
    try {
      const res = await counter().transaction((cur) => socialBudget.reserveGeneration(cur, cap));
      if (res.committed) return { ok: true, count: Number(res.snapshot.val()) || 0, cap };
      const cur = res.snapshot.val();
      const atCap = typeof cur === "number" && Number.isFinite(cur) && cur >= cap;
      return { ok: false, count: atCap ? cur : cap, cap, why: atCap ? "cap" : "unreadable" };
    } catch {
      return { ok: false, count: cap, cap, why: "unreadable" };
    }
  }

  async function releaseUnit() {
    await counter().transaction(socialRecovery.releaseGeneration);
  }

  async function unitsLeft() {
    const v = (await counter().once("value")).val();
    if (v === null) return cap;
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, cap - v) : null;
  }

  // ── THE PANEL'S CLEAN PRODUCT SHOTS ────────────────────────────────────
  async function generateThumb(parts) {
    try {
      const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.FLASH_LITE_MODEL, parts, {
        outPerMtok: gemini.FLASH_LITE_OUT_PER_MTOK, flatUsd: gemini.FLASH_LITE_FLAT_IMAGE_USD,
        imageConfig: { aspectRatio: "1:1" }, timeoutMs: THUMB_TIMEOUT_MS,
      });
      return { ...gen, engine: "flash-lite" };
    } catch (err) {
      // Lite unavailable (a 5xx) or refusing the request: the same parts to Flash.
      if (log) log(`lookbook: ${gemini.FLASH_LITE_MODEL} failed (${String(err && err.message).slice(0, 80)}) — thumbnail on ${gemini.GEMINI_MODEL}`);
      const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.GEMINI_MODEL, parts, {
        outPerMtok: gemini.GEMINI_OUT_PER_MTOK, flatUsd: gemini.GEMINI_FLAT_IMAGE_USD,
        imageConfig: { aspectRatio: "1:1", imageSize: "1K" }, timeoutMs: THUMB_TIMEOUT_MS,
      });
      return { ...gen, engine: "flash" };
    }
  }

  async function claimThumbUnit() {
    const res = await db.ref(`social_lookbook/thumbBudget/${saDate}`).transaction((cur) => {
      const n = cur === null ? 0 : Number(cur);
      if (!Number.isFinite(n) || n >= lookbook.THUMBS_PER_DAY) return undefined;
      return n + 1;
    });
    return { ok: Boolean(res.committed) };
  }

  // `src`: the product's photo now. A shot made from a DIFFERENT photo (the
  // shop replaced a wrong one) is a shot of something else: a miss. A pointer
  // that never recorded its source stays valid (CodeRabbit on #750).
  async function readThumbCache(pid, src = null) {
    if (!bucket || !SAFE_PID.test(String(pid))) return null;
    const ptr = (await db.ref(`social_lookbook/thumbs/${pid}`).once("value")).val();
    if (ptr && src && ptr.src && ptr.src !== src) return null;
    // A shot that was paid for and did not cut out: not bought again.
    if (ptr && ptr.failed) return { failed: true };
    // The file is always at its own pid's path; the pointer's path is a record.
    const file = bucket.file(THUMB_PATH(pid));
    // No pointer: the file may still be there (a pointer write that failed
    // after the upload). It is used, and the pointer put back.
    if (!ptr) {
      const [exists] = await file.exists();
      if (!exists) return null;
      const [png] = await file.download();
      await db.ref(`social_lookbook/thumbs/${pid}`).set({ path: file.name, at: Date.now(), repaired: true });
      return { png };
    }
    const [png] = await file.download();
    return { png };
  }

  async function writeThumbCache(pid, png, meta = {}) {
    if (!bucket || !SAFE_PID.test(String(pid))) throw new Error("no bucket or an unusable pid");
    const token = require("crypto").randomUUID();
    const path = THUMB_PATH(pid);
    await bucket.file(path).save(png, {
      resumable: false, contentType: "image/png",
      metadata: { cacheControl: "public, max-age=31536000", metadata: { firebaseStorageDownloadTokens: token } },
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    await db.ref(`social_lookbook/thumbs/${pid}`).set({
      path, url, at: Date.now(),
      engine: meta.engine || null, costUSD: Number(meta.costUSD) || 0,
      method: meta.method || null, src: meta.src || null,
    });
    return { path, url };
  }

  async function markThumbFailed(pid, meta = {}) {
    if (!SAFE_PID.test(String(pid))) return;
    await db.ref(`social_lookbook/thumbs/${pid}`).set({
      failed: true, at: Date.now(), engine: meta.engine || null, costUSD: Number(meta.costUSD) || 0, src: meta.src || null,
      tried: Array.isArray(meta.tried) ? meta.tried.slice(0, 4).map(String) : [],
    });
  }

  // ── THE CHARACTER REFERENCE ────────────────────────────────────────────
  // The house model (house-model.cjs): Junid's pick, the best-scoring
  // candidate until he picks, and the auto-pick once 24 hours pass.
  async function readModelRef() {
    if (!bucket) return null;
    const [hm, model] = await Promise.all([db.ref(houseModel.HOUSE_PATH).once("value"), db.ref(houseModel.MODEL_PATH).once("value")]);
    const ref = await houseModel.resolveRef(hm.val(), model.val(), { pick: (u) => db.ref().update(u) });
    if (!ref) return null;
    if (log && ref.house) log(`lookbook: house model ${ref.house}${ref.provisional ? " (best-scoring, not picked yet)" : ref.auto ? " (auto-picked: no reply within 24 hours)" : ""}`);
    const [buffer] = await bucket.file(ref.path).download();
    return { buffer, contentType: ref.contentType };
  }

  return {
    fetchImage, generateHero, checkHero, claimUnit, releaseUnit, unitsLeft,
    generateThumb, claimThumbUnit, readThumbCache, writeThumbCache, markThumbFailed, readModelRef,
    inlineImagePart: gemini.inlineImagePart,
    isUnbilledError: (m) => socialRecovery.isUnbilledProviderError(m),
    // No Anthropic key (the thumbnail pre-warm): no chooser, the top score stands.
    chooseOutfit: anthropicApiKey && Anthropic ? makeStylistChooser({ Anthropic, apiKey: anthropicApiKey }) : null,
    // The opus stylist and critic (fit-agent.cjs): the lookbook's fits since
    // 26 Oct. No Anthropic key (the thumbnail pre-warm) means no fits.
    fitAgent: anthropicApiKey && Anthropic && fetchImage ? fitAgentFor({ Anthropic, apiKey: anthropicApiKey, fetchImage, log }) : null,
    geminiApiKey,
    log, deadlineMs,
  };
}

module.exports = { engines, fitAgentFor, THUMB_DIR, THUMB_PATH, NBPRO_4K_FLAT_USD };
