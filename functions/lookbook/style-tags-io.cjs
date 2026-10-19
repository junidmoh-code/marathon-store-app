// ─── THE STYLE TAGS: CACHE, VISION CALL, AND TAGGING WHAT IS MISSING ─────────
// social_lookbook/styleTags/{pid} holds one product's tags (lib/style-tags.cjs).
// Read by pid only, never as a node. A product with a complete record is never
// tagged again: the pre-warm (scripts/social/style-tags-prewarm.mjs) tags the
// whole catalogue once, and a run tags only what arrived since, up to a
// ceiling. A v1 record (no gender, cut, headwear, knit) counts as missing
// those four: the same vision call tops it up and keeps its other tags.
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

/**
 * Does the product have COMPLETE tags this guide can read? A complete record
 * is never overwritten. One the guide can no longer read (a colour or family
 * renamed in docs/style-guide.md) is no tag at all, and is tagged again
 * (CodeRabbit on #759); a v1 record is topped up with the v2 fields.
 */
async function hasTagRecord(db, pid) {
  const t = styleTags.usableTags((await db.ref(TAG_PATH(pid)).once("value")).val());
  return Boolean(t) && !styleTags.needsV2(t);
}

/**
 * Write a fresh vision answer: a usable older record keeps its tags and gains
 * the v2 fields (upgradeRecord), anything else is replaced whole. Returns the
 * tags the stylist should use now.
 */
async function writeVisionTags(db, pid, v, { src, nowMs }) {
  const old = (await db.ref(TAG_PATH(pid)).once("value")).val();
  const kept = styleTags.usableTags(old);
  if (kept) {
    const rec = styleTags.upgradeRecord(old, v.tags, { model: v.model, costUSD: v.costUSD, nowMs });
    await db.ref(TAG_PATH(pid)).set(rec);
    return styleTags.usableTags(rec);
  }
  await db.ref(TAG_PATH(pid)).set(styleTags.tagRecord(v.tags, { model: v.model, costUSD: v.costUSD, src, nowMs }));
  return { ...v.tags, source: "vision" };
}

/**
 * ONE vision call: the product photo (downscaled to TAG_IMAGE_PX, sent at low
 * media resolution: 256 input tokens) and the tagging prompt, answered in the
 * guide's vocabulary through a response schema, no thinking. 3.1 Flash-Lite
 * first, 3.5 Flash-Lite if it errors.
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
    generationConfig: {
      temperature: 0, responseMimeType: "application/json", responseSchema: styleTags.tagSchema(), maxOutputTokens: 200,
      mediaResolution: "MEDIA_RESOLUTION_LOW", thinkingConfig: { thinkingLevel: "minimal" },
    },
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
      const read = styleTags.readTags(text, undefined, { requireV2: true });
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
    const have = tags.get(it.pid);
    if ((have && !styleTags.needsV2(have)) || !SAFE_PID.test(String(it.pid))) continue;
    const p = it.product || {};
    if (deps.geminiApiKey && deps.fetchImage && it.photoUrl && tagged < maxNew && Date.now() < deadlineMs) {
      try {
        // Checked again just before the call: a parallel run may have tagged it.
        if (!(await hasTagRecord(db, it.pid))) {
          const img = await deps.fetchImage(it.photoUrl);
          const v = await visionTags(deps.geminiApiKey, img, { brand: p.brand, name: p.name || it.websiteName, websiteName: it.websiteName, categoryKey: p.categoryKey });
          costUSD += v.costUSD;
          tagged++;
          tags.set(it.pid, await writeVisionTags(db, it.pid, v, { src: it.photoUrl, nowMs }));
          continue;
        }
        // Tagged by a parallel run since the first read: use what it wrote.
        tags.set(it.pid, styleTags.usableTags((await db.ref(TAG_PATH(it.pid)).once("value")).val()));
        continue;
      } catch (e) {
        costUSD += (e && e.costUSD) || 0;
        log(`stylist: vision tags for ${it.pid} failed (${String(e && e.message).slice(0, 100)}) — reading its name`);
      }
    }
    // A v1 record keeps its photo tags with gender unknown: off a men's post
    // until it is topped up, never guessed from the name.
    if (have) continue;
    tags.set(it.pid, styleTags.nameTags({ name: p.name, websiteName: it.websiteName, brand: p.brand, categoryKey: p.categoryKey }));
    named++;
  }
  return { tags, tagged, named, costUSD };
}

module.exports = { TAG_PATH, readStyleTags, hasTagRecord, writeVisionTags, visionTags, ensureStyleTags };
