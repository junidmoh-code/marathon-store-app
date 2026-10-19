// ─── ONE LOOKBOOK POSTER, END TO END ─────────────────────────────────────────
// Pick the outfit, fetch the real product photos, generate ONE hero with
// those photos attached as references, check the hero has no text, and render
// the poster. Every external call is passed in (`deps`), so the Cloud Function,
// the one-off real run (scripts/social/lookbook-real.mjs) and the tests run
// this same code.
//
// IT NEVER POSTS AND NEVER WRITES A POST. It returns the poster or a gate that
// failed, and the caller (socialStillAutopilot) decides: a poster goes in the
// queue, and a failed gate makes the day post the current style instead.
//
// ── THE GATES ────────────────────────────────────────────────────────────────
//   outfit   fewer than MIN_ROWS slots could be filled           (costs nothing)
//   price    looks exist, but none totals within PRICE_BAND      (costs nothing)
//   style    looks in the band exist, but none passes the style guide
//            (docs/style-guide.md hard rules)                    (costs nothing)
//   cap      the day's generation cap refused the unit           (costs nothing)
//   generate the model call failed                              (5xx released)
//   text     the hero contained text (after the allowed retry)
//   model    the model is not visibly a Black man (after ONE regeneration,
//            which this gate gets whatever maxAttempts says: owner review of
//            sample 01, 18 Oct — "regenerate once, then fall back")
//   resolution the hero came back smaller than the model's native maximum
//            (minHeroPx on its long side): it is never upscaled
//   render   the renderer threw, or the poster it drew upscaled the hero or
//            has two leader lines crossing
//
// ── "REGENERATE ONCE" AND THE CAP ────────────────────────────────────────────
// A hero that fails the text check is regenerated once ONLY when the day's cap
// would still have a unit left afterwards for the current-style fallback. A
// failed lookbook must never cost the day its post (owner addendum), and the
// cap of 4 is an owner brief that is not raised here. On a normal day (2 reels
// + this still = 3) that means a hero with text goes straight to the fallback.
"use strict";

const lookbook = require("../lib/social-lookbook.cjs");
const { renderLookbookPoster, cutout: defaultCutout, gridOverlay, segmentsCross } = require("../lib/lookbook-render.cjs");
const { loadLookbookCandidates, loadLookbookHistory } = require("./load.cjs");
const { resolveThumb } = require("./thumbs.cjs");
const { ensureStyleTags } = require("./style-tags-io.cjs");
const { saDateStringFromMs } = require("../lib/sa-time.cjs");

// New products tagged by vision during one run (the pre-warm tags the rest);
// past this the stylist reads their names. One tag is ~$0.0003.
const RUN_TAGS = 24;
// Text-model choices per run: the first shortlist, and one re-pick when a
// chosen row's photo fails. After that the top score stands.
const MAX_CHOICES = 2;

/**
 * @param db    RTDB handle (reads only)
 * @param deps  {
 *   fetchImage(url) → { buffer, contentType },
 *   generateHero(parts) → { buffer, mime, costUSD, engine },   // 9:16
 *   inlineImagePart(buffer, contentType) → part,
 *   checkHero(buffer, mime, prompt) → text,                   // a vision answer (text check, then locate)
 *   claimUnit() → { ok, why, count, cap },
 *   releaseUnit() → Promise,                                  // unbilled 5xx only
 *   isUnbilledError(message) → boolean,
 *   unitsLeft() → number | null,                              // cap − count, after this call's claims
 *   deadlineMs?: number                                       // no second attempt after this
 *   log?(msg)
 * }
 *   thumbnail engines (thumbs.cjs, all optional): readThumbCache, writeThumbCache,
 *     claimThumbUnit, generateThumb; readModelRef?() → { buffer, contentType } | null
 *   the stylist (optional): chooseOutfit(prompt) → { text, costUSD } — one short
 *     text-model call that picks among the shortlist and writes the note;
 *     geminiApiKey — tags products the pre-warm has not reached
 * @param opts.look  force one named look (the samples); opts.month 1–12 (default: the SA month)
 * @param opts  { nowMs, used: Set of pids already posted today, maxAttempts: heroes
 *               generated before the text gate gives up (production: 1); the model
 *               gate always gets one regeneration; scene: a LOOKBOOK_SCENE_DEFS
 *               entry or key (default: the first of DEFAULT_LOOKBOOK_SCENES) }
 * @returns { ok: true, rows, total, poster, costUSD, engine, attempts, check, anchors, look, stylistCostUSD }
 *        | { ok: false, gate, reason, costUSD, attempts, rows? }
 */
async function makeLookbook(db, deps, { nowMs = Date.now(), used = new Set(), maxAttempts = 2, scene = lookbook.DEFAULT_LOOKBOOK_SCENES[0], minHeroPx = lookbook.HERO_MIN_LONG_SIDE, look = null, month = null } = {}) {
  const log = deps.log || (() => {});
  let costUSD = 0, thumbCostUSD = 0, stylistCostUSD = 0;
  const saDate = saDateStringFromMs(nowMs);
  const saMonth = month || Number(saDate.slice(5, 7));
  const sceneDef = typeof scene === "string" ? lookbook.LOOKBOOK_SCENE_DEFS[scene] : scene;
  if (!sceneDef) throw new Error(`makeLookbook: unknown scene ${JSON.stringify(scene)}`);
  const attempts = [];

  // No unit for a hero that would leave the fallback one: stop BEFORE any
  // thumbnail is bought (architect review of #750).
  const leftAtStart = await deps.unitsLeft();
  if (!(Number.isFinite(leftAtStart) && leftAtStart >= 2)) {
    return { ok: false, gate: "cap", costUSD, attempts, reason: `only ${Number.isFinite(leftAtStart) ? leftAtStart : "an unknown number of"} generation unit(s) left today — the lookbook would leave the current-style fallback none` };
  }
  // Thumbnails get the first four minutes; after that the rows use their
  // shop photos, so the hero (and the fallback after it) keep their time.
  const thumbDeadlineMs = Date.now() + 240 * 1000;

  // ── 1. THE OUTFIT, styled, with real photos that actually download ─────
  const [{ candidates }, history] = await Promise.all([
    loadLookbookCandidates(db, { nowMs }),
    loadLookbookHistory(db),
  ]);
  const recent = lookbook.recentLookbookPids(history);
  // The 14-day no-repeat: never picked, whatever the score.
  const blocked = lookbook.pidsWithinDays(history, saDate, 14);
  // Every candidate's style tags: cached, tagged now (a few), or read from its name.
  const tagRun = await ensureStyleTags(db, candidates.map((c) => {
    const ph = lookbook.approvedPhoto(c.product, c.node);
    return { pid: c.pid, photoUrl: ph && ph.url, product: c.product, websiteName: c.name };
  }), { geminiApiKey: deps.geminiApiKey, fetchImage: deps.fetchImage, log }, { maxNew: RUN_TAGS, deadlineMs: Date.now() + 90 * 1000, nowMs });
  stylistCostUSD += tagRun.costUSD;
  if (tagRun.tagged || tagRun.named) log(`stylist: ${tagRun.tags.size - tagRun.tagged - tagRun.named} tags cached, ${tagRun.tagged} tagged now, ${tagRun.named} read from names`);
  // A row needs a photo that downloads AND cuts out cleanly. One that fails
  // either is excluded and its slot re-picked, never drawn badly and never a
  // reason to stall: the next product in the slot is tried.
  const cut = deps.cutout || defaultCutout;
  const exclude = new Set(used);
  const ready = new Map();          // pid → { thumb, contentType, cutout, thumbSource }
  let picked = null, choices = 0;
  for (let round = 0; round < 8; round++) {
    let p = lookbook.pickLookbookOutfit(candidates, { recent, blocked, used: exclude, tags: tagRun.tags, month: saMonth, look });
    if (p.reason) return { ok: false, gate: p.band ? "price" : p.style ? "style" : "outfit", reason: p.reason, costUSD: costUSD + thumbCostUSD + stylistCostUSD, thumbCostUSD, stylistCostUSD, attempts };
    // The stylist's tie-break: one short text call over the shortlist. Any
    // failure keeps the top score and the deterministic note.
    let answer = "";
    if (deps.chooseOutfit && p.shortlist.length > 1 && choices < MAX_CHOICES) {
      choices++;
      try {
        const r = await deps.chooseOutfit(lookbook.lookbookChoicePrompt(p, { month: saMonth }));
        answer = (r && r.text) || "";
        stylistCostUSD += (r && r.costUSD) || 0;
      } catch (e) { log(`stylist: the choice call failed (${String(e && e.message).slice(0, 100)}) — the top score stands`); }
    }
    p = lookbook.chooseLookbookOutfit(p, answer, { month: saMonth });
    const fresh = p.rows.filter((r) => !ready.has(r.pid));
    // One at a time: each cut-out holds an ONNX session's worth of memory, and
    // six in parallel is how a 2 GiB instance dies (architect review, B2).
    for (const r of fresh) await (async () => {
      try {
        const img = await deps.fetchImage(r.photoUrl);
        // The panel picture: studio photo, cached clean shot, a new clean
        // shot, or the shop photo cut out (thumbs.cjs). The shop photo stays
        // the hero's reference either way: it is the real product.
        const t = await resolveThumb(r, img, { thumbDeadlineMs, ...deps, cutout: cut, log });
        thumbCostUSD += t.costUSD || 0;
        if (!t.cutout) { log(`lookbook: ${r.pid} has no clean picture (${t.source}: ${(t.tried || []).join(", ")}) — skipping it`); exclude.add(r.pid); return; }
        ready.set(r.pid, { thumb: img.buffer, contentType: img.contentType, cutout: t.cutout, thumbSource: t.source });
      } catch (e) {
        log(`lookbook: photo for ${r.pid} failed (${e && e.message}) — skipping it`);
        exclude.add(r.pid);
      }
    })();
    if (p.rows.every((r) => ready.has(r.pid))) {
      picked = { ...p, rows: p.rows.map((r) => ({ ...r, ...ready.get(r.pid) })) };
      break;
    }
  }
  costUSD += thumbCostUSD + stylistCostUSD;
  if (!picked) return { ok: false, gate: "outfit", reason: "no full outfit with photos that download and cut out cleanly", costUSD, attempts, thumbCostUSD, stylistCostUSD };
  const rows = picked.rows;
  const lookInfo = picked.look || null;
  log(`stylist: ${lookInfo ? `${lookInfo.name || "no named look"} (${lookInfo.key || "-"}), ${lookInfo.score}/100, option ${lookInfo.choice} of ${lookInfo.of} by ${lookInfo.source}: ${lookInfo.note}` : "no look"}`);

  // ── 2. THE HERO, with the real garments attached ───────────────────────
  // The character reference first, so every poster shows the same man. A
  // missing or unreadable reference is not a gate: the prompt still pins him.
  let modelRef = null;
  if (deps.readModelRef) {
    try { modelRef = await deps.readModelRef(); } catch (e) { log(`lookbook: character reference unreadable (${e && e.message}) — generating without it`); }
  }
  const prompt = lookbook.buildHeroPrompt(rows, { scene: sceneDef, modelRef: Boolean(modelRef) });
  const parts = [{ text: prompt }];
  if (modelRef) {
    parts.push({ text: "MODEL REFERENCE — this is the man to photograph (his face, skin tone, hair and build only):" });
    parts.push(deps.inlineImagePart(modelRef.buffer, modelRef.contentType || "image/jpeg"));
  }
  rows.forEach((r, i) => {
    parts.push({ text: `REFERENCE ${i + 1} — ${r.slot.toUpperCase()}: ${r.displayName}. He wears exactly this item:` });
    parts.push(deps.inlineImagePart(r.thumb, r.contentType || "image/jpeg"));
  });
  const checkPrompt = lookbook.buildHeroCheckPrompt();

  let hero = null, check = null, modelCheck = null, engine = null, failed = null;
  // The text gate regenerates only within maxAttempts; the model gate always
  // gets one regeneration. Both still obey the unit and deadline rules below.
  for (let attempt = 1; attempt <= Math.max(2, maxAttempts); attempt++) {
    if (attempt > 1 && failed === "text" && attempt > maxAttempts) break;
    // EVERY generation, the first included, must leave one unit for the
    // current-style fallback. Without this a morning that already spent three
    // (a billed reel retry) let the lookbook take the fourth, and a failed gate
    // then left the day with nothing (architect review, B1).
    const left = await deps.unitsLeft();
    if (!(Number.isFinite(left) && left >= 2)) {
      return attempt === 1
        ? { ok: false, gate: "cap", costUSD, attempts, rows, reason: `only ${Number.isFinite(left) ? left : "an unknown number of"} generation unit(s) left today — the lookbook would leave the current-style fallback none` }
        : { ok: false, gate: failed, costUSD, attempts, rows, reason: `${failedReason()} — not regenerated: ${Number.isFinite(left) ? left : "unknown"} unit(s) left today and the current-style fallback needs one` };
    }
    if (deps.deadlineMs && Date.now() > deps.deadlineMs) {
      return attempt === 1
        ? { ok: false, gate: "time", costUSD, attempts, rows, reason: "out of time for a hero before the current-style fallback" }
        : { ok: false, gate: failed, costUSD, attempts, rows, reason: `${failedReason()} — not regenerated: out of time for a second attempt and the fallback` };
    }
    const unit = await deps.claimUnit();
    if (!unit.ok) {
      return { ok: false, gate: "cap", reason: unit.why === "unreadable" ? "the generation budget could not be read" : `the daily image-generation cap of ${unit.cap} was reached`, costUSD, attempts, rows };
    }
    let gen;
    try {
      gen = await deps.generateHero(parts);
    } catch (e) {
      const msg = String(e && e.message);
      if ((e && e.unbilled) || deps.isUnbilledError(msg)) { try { await deps.releaseUnit(); } catch { /* best effort */ } }
      attempts.push({ attempt, error: msg.slice(0, 200) });
      return { ok: false, gate: "generate", reason: `the hero could not be generated: ${msg.slice(0, 160)}`, costUSD, attempts, rows };
    }
    costUSD += gen.costUSD || 0;
    engine = gen.engine || null;
    let answer = "";
    try { answer = await deps.checkHero(gen.buffer, gen.mime || "image/png", checkPrompt); } catch (e) { answer = ""; log(`lookbook: text check failed: ${e && e.message}`); }
    check = lookbook.readHeroCheck(answer);
    modelCheck = lookbook.readModelCheck(answer);
    attempts.push({ attempt, engine, costUSD: gen.costUSD || 0, textOk: check.ok, seen: check.seen || null, modelOk: modelCheck.ok, modelSeen: modelCheck.seen || null, reason: check.reason || modelCheck.reason });
    if (check.ok && modelCheck.ok) { hero = gen; break; }
    failed = check.ok ? "model" : "text";
    log(`lookbook: attempt ${attempt} failed the ${failed} check — ${failedReason()}`);
    // An unanswered model check says nothing about the picture: no second
    // 4K hero for it, straight to the fallback.
    if (failed === "model" && modelCheck.unreadable) break;
  }
  function failedReason() { return failed === "model" ? modelCheck.reason : check.reason; }
  if (!hero) {
    const twice = attempts.filter((a) => a.engine).length >= 2 ? " twice" : "";
    return failed === "model"
      ? { ok: false, gate: "model", reason: `the hero failed the model check${twice} (${modelCheck.reason})`, costUSD, attempts, rows }
      : { ok: false, gate: "text", reason: `the hero failed the no-text check${twice} (${check.reason})`, costUSD, attempts, rows };
  }

  // ── 2b. NATIVE RESOLUTION ──────────────────────────────────────────────
  // The hero is asked for at the model's maximum (4K, engines.cjs). Anything
  // smaller (a fallback that ignored imageSize) is not drawn: the poster never
  // upscales a small render (owner go-live brief, 19 Oct).
  let heroMeta;
  try { heroMeta = await require("sharp")(hero.buffer).metadata(); } catch (e) {
    return { ok: false, gate: "render", reason: `the hero could not be read: ${String(e && e.message).slice(0, 120)}`, costUSD, attempts, rows };
  }
  const heroLong = Math.max(heroMeta.width || 0, heroMeta.height || 0);
  if (heroLong < minHeroPx) {
    return { ok: false, gate: "resolution", reason: `the hero is ${heroMeta.width}x${heroMeta.height}, under the model's native ${minHeroPx}px — it would have to be upscaled`, costUSD, attempts, rows };
  }

  // ── 3. WHERE THE GARMENTS ARE (for the dots) ───────────────────────────
  // Best effort: an unanswered locate leaves the dots on the category spots.
  let located = { anchors: {}, head: null };
  try {
    const gridded = await gridOverlay(hero.buffer, lookbook.GRID);
    located = lookbook.readLocate(await deps.checkHero(gridded, "image/jpeg", lookbook.buildLocatePrompt(rows)), rows);
  } catch (e) { log(`lookbook: locate failed (${e && e.message}) — dots on the category spots`); }

  // ── 4. THE POSTER ──────────────────────────────────────────────────────
  const anchors = lookbook.anchorsFor(rows, located.anchors, located.head);
  const body = lookbook.bodyExtent(located, anchors);
  // The panel lists the pieces in the order they sit on the body, so each
  // row's line goes to its own garment AND the dots run top to bottom in row
  // order (owner go-live brief, 19 Oct): a sling bag worn at the chest is
  // listed above the trousers. Head to toe breaks a tie.
  // The SAME key planLeaders sorts the dots by (y, then x), so a tie on one
  // grid row (a sling bag beside the tee) cannot swap two rows' dots (Fable
  // re-review of #756).
  const bodyOrder = rows.map((r, i) => ({ r, i, a: anchors[r.slot] })).sort((a, b) =>
    a.a.y - b.a.y || a.a.x - b.a.x || a.i - b.i).map((x) => x.r);
  rows.splice(0, rows.length, ...bodyOrder);
  try {
    const poster = await renderLookbookPoster({ hero: hero.buffer, rows, anchors, subject: located.head, body, header: lookInfo && lookInfo.header });
    // The drawn poster, checked: the photograph only ever scaled down, and no
    // two leader lines crossing, on either canvas.
    // minHeroPx 0 switches the resolution gate off (the tests' small fakes).
    const upscaled = minHeroPx > 0 ? Object.entries(poster.heroScale || {}).filter(([, k]) => k > 1.0001) : [];
    if (upscaled.length) return { ok: false, gate: "resolution", reason: `the hero would be upscaled on the ${upscaled.map(([c, k]) => `${c} (x${k.toFixed(2)})`).join(", ")}`, costUSD, attempts, rows };
    const crossed = Object.entries(poster.leaders || {}).filter(([, ls]) => ls.some((a, i) => ls.some((b, j) => j > i && segmentsCross(a.a, a.end, b.a, b.end))));
    if (crossed.length) return { ok: false, gate: "render", reason: `leader lines cross on the ${crossed.map(([c]) => c).join(", ")}`, costUSD, attempts, rows };
    return {
      ok: true, rows, total: poster.total, poster, costUSD, thumbCostUSD, stylistCostUSD, engine, attempts, check, modelCheck, located, anchors, body, hero, prompt,
      look: lookInfo,
      styled: picked.styled ? {
        score: picked.styled.score, parts: picked.styled.parts, reasoning: picked.styled.reasoning,
        tags: Object.fromEntries(picked.styled.pieces.map((x) => [x.pid, x.tags])),
      } : null,
      heroSize: `${heroMeta.width}x${heroMeta.height}`,
      scene: sceneDef.key, modelRef: Boolean(modelRef),
      thumbs: Object.fromEntries(rows.map((r) => [r.pid, r.thumbSource || null])),
    };
  } catch (e) {
    return { ok: false, gate: "render", reason: `the poster could not be rendered: ${String(e && e.message).slice(0, 160)}`, costUSD, attempts, rows };
  }
}

module.exports = { makeLookbook };
