// ─── THE STYLE TAGS: CACHE, VISION CALL, AND TAGGING WHAT IS MISSING ─────────
// social_lookbook/styleTags/{pid} holds one product's tags (lib/style-tags.cjs).
// Read by pid only, never as a node. A product with a record is never tagged
// again: the pre-warm (scripts/social/style-tags-prewarm.mjs) tags the whole
// catalogue once, and a run tags only what arrived since, up to a ceiling.
"use strict";

const styleTags = require("../lib/style-tags.cjs");

const TAG_PATH = (pid) => `social_lookbook/styleTags/${pid}`;
const SAFE_PID = /^[A-Za-z0-9_-]{1,80}$/;
const TAG_TIMEOUT_MS = 30000;

/** The cached tags for these pids: Map pid → tags (only usable ones). Point reads. */
async function readStyleTags(db, pids) {
  const out = new Map();
  const list = [...new Set(pids)].filter((p) => SAFE_PID.test(String(p)));
  for (let i = 0; i < list.length; i += 25) {
    await Promise.all(list.slice(i, i + 25).map(async (pid) => {
      const t = styleTags.usableTags((await db.ref(TAG_PATH(pid)).once("value")).val());
      if (t) out.set(pid, t);
    }));
  }
  return out;
}

/** Is there a record at all (usable or not)? A record is never overwritten. */
async function hasTagRecord(db, pid) {
  return (await db.ref(TAG_PATH(pid)).once("value")).exists();
}

/**
 * ONE vision call: the product photo (downscaled to TAG_IMAGE_PX, 258 input
 * tokens) and the tagging prompt, answered in the guide's vocabulary through
 * a response schema. Flash-Lite 2.5 first, 3.1 Flash-Lite if it errors.
 * @returns { tags, model, costUSD } — throws when neither model answers usably
 */
async function visionTags(geminiApiKey, image, product, { fetchImpl = fetch, models = [styleTags.TAG_MODEL, styleTags.TAG_FALLBACK_MODEL] } = {}) {
  const sharp = require("sharp");
  const jpeg = await sharp(image.buffer).rotate()
    .resize(styleTags.TAG_IMAGE_PX, styleTags.TAG_IMAGE_PX, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  const body = {
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } },
      { text: styleTags.buildTagPrompt(product) },
    ] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: styleTags.tagSchema(), maxOutputTokens: 200 },
  };
  let costUSD = 0, last = null;
  for (const model of models) {
    try {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TAG_TIMEOUT_MS),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${String((json.error && json.error.message) || "").slice(0, 120)}`);
      costUSD += styleTags.tagCostUSD(json.usageMetadata, model);
      const text = (((json.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || "").join("") || "";
      const read = styleTags.readTags(text);
      if (read.ok) return { tags: read.tags, model, costUSD };
      last = new Error(`${model}: ${read.reason}`);
    } catch (e) { last = e; }
  }
  const err = new Error(`no usable tags: ${last && last.message}`);
  err.costUSD = costUSD;
  throw err;
}

/**
 * Tags for every candidate: cached ones read, missing ones tagged by vision
 * (at most `maxNew`, before `deadlineMs`), the rest from the name (not cached).
 *
 * @param items [{ pid, photoUrl, product: { brand, name, categoryKey }, websiteName }]
 * @param deps  { geminiApiKey, fetchImage(url) → { buffer, contentType }, log? }
 * @returns { tags: Map pid → tags, tagged, named, costUSD }
 */
async function ensureStyleTags(db, items, deps = {}, { maxNew = 24, deadlineMs = Infinity, nowMs = Date.now() } = {}) {
  const log = deps.log || (() => {});
  const tags = await readStyleTags(db, items.map((x) => x.pid));
  let tagged = 0, named = 0, costUSD = 0;
  for (const it of items) {
    if (tags.has(it.pid) || !SAFE_PID.test(String(it.pid))) continue;
    const p = it.product || {};
    if (deps.geminiApiKey && deps.fetchImage && it.photoUrl && tagged < maxNew && Date.now() < deadlineMs) {
      try {
        // A record that exists but is unusable (an older vocabulary) is left alone.
        if (!(await hasTagRecord(db, it.pid))) {
          const img = await deps.fetchImage(it.photoUrl);
          const v = await visionTags(deps.geminiApiKey, img, { brand: p.brand, name: it.websiteName || p.name, categoryKey: p.categoryKey });
          costUSD += v.costUSD;
          tagged++;
          await db.ref(TAG_PATH(it.pid)).set(styleTags.tagRecord(v.tags, { model: v.model, costUSD: v.costUSD, src: it.photoUrl, nowMs }));
          tags.set(it.pid, { ...v.tags, source: "vision" });
          continue;
        }
      } catch (e) {
        costUSD += (e && e.costUSD) || 0;
        log(`stylist: vision tags for ${it.pid} failed (${String(e && e.message).slice(0, 100)}) — reading its name`);
      }
    }
    tags.set(it.pid, styleTags.nameTags({ name: p.name, websiteName: it.websiteName, brand: p.brand, categoryKey: p.categoryKey }));
    named++;
  }
  return { tags, tagged, named, costUSD };
}

module.exports = { TAG_PATH, readStyleTags, hasTagRecord, visionTags, ensureStyleTags };
