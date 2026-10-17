// ─── THE LOOKBOOK'S REAL ENGINES ─────────────────────────────────────────────
// Builds the `deps` lookbook.cjs takes, from what the pipeline already uses:
//   · Nano Banana Pro (gemini-3-pro-image) through lib/gemini-image.cjs, with
//     the same Pro → Flash fallback on an unbilled 5xx that generateSocialScene
//     makes (7 Oct 2026), at 9:16 / 2K;
//   · the vision model the pipeline already pays for (claude-haiku-4-5,
//     REORDER_MODEL in index.js) for the no-text check;
//   · the day's generation cap: social_generation_budget/{saDate}/count,
//     reserved through social-budget's reserveGeneration and released through
//     social-recovery's releaseGeneration. The same counter, the same
//     transaction bodies and the same cap the reels use.
"use strict";

const gemini = require("../lib/gemini-image.cjs");
const socialBudget = require("../lib/social-budget.cjs");
const socialRecovery = require("../lib/social-recovery.cjs");

function engines({ db, saDate, geminiApiKey, anthropicApiKey, visionModel, fetchImage, Anthropic, log }) {
  const counter = () => db.ref(`social_generation_budget/${saDate}/count`);
  const cap = socialBudget.MAX_IMAGE_GENERATIONS_PER_DAY;

  async function generateHero(parts) {
    try {
      const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.NBPRO_MODEL, parts, {
        outPerMtok: gemini.NBPRO_OUT_PER_MTOK, flatUsd: gemini.NBPRO_FLAT_IMAGE_USD,
        imageConfig: { aspectRatio: "9:16", imageSize: "2K" },
      });
      return { ...gen, engine: "nbpro" };
    } catch (err) {
      if (!socialRecovery.isUnbilledProviderError(err && err.message)) throw err;
      if (log) log(`lookbook: ${gemini.NBPRO_MODEL} unavailable — retrying on ${gemini.GEMINI_MODEL}`);
      const gen = await gemini.geminiGenerateImage(geminiApiKey, gemini.GEMINI_MODEL, parts, {
        outPerMtok: gemini.GEMINI_OUT_PER_MTOK, flatUsd: gemini.GEMINI_FLAT_IMAGE_USD,
        imageConfig: { aspectRatio: "9:16" },
      });
      return { ...gen, engine: "nb2" };
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

  return {
    fetchImage, generateHero, checkHero, claimUnit, releaseUnit, unitsLeft,
    inlineImagePart: gemini.inlineImagePart,
    isUnbilledError: (m) => socialRecovery.isUnbilledProviderError(m),
    log,
  };
}

module.exports = { engines };
