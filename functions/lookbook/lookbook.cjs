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
//   cap      the day's generation cap refused the unit           (costs nothing)
//   generate the model call failed                              (5xx released)
//   text     the hero contained text (after the allowed retry)
//   render   the renderer threw
//
// ── "REGENERATE ONCE" AND THE CAP ────────────────────────────────────────────
// A hero that fails the text check is regenerated once ONLY when the day's cap
// would still have a unit left afterwards for the current-style fallback. A
// failed lookbook must never cost the day its post (owner addendum), and the
// cap of 4 is an owner brief that is not raised here. On a normal day (2 reels
// + this still = 3) that means a hero with text goes straight to the fallback.
"use strict";

const lookbook = require("../lib/social-lookbook.cjs");
const { renderLookbookPoster } = require("../lib/lookbook-render.cjs");
const { loadLookbookCandidates, loadRecentLookbookPids } = require("./load.cjs");

/**
 * @param db    RTDB handle (reads only)
 * @param deps  {
 *   fetchImage(url) → { buffer, contentType },
 *   generateHero(parts) → { buffer, mime, costUSD, engine },   // 9:16
 *   inlineImagePart(buffer, contentType) → part,
 *   checkHero(buffer, mime, prompt) → text,                   // vision answer
 *   claimUnit() → { ok, why, count, cap },
 *   releaseUnit() → Promise,                                  // unbilled 5xx only
 *   isUnbilledError(message) → boolean,
 *   unitsLeft() → number | null,                              // cap − count, after this call's claims
 *   log?(msg)
 * }
 * @param opts  { nowMs, used: Set of pids already posted today }
 * @returns { ok: true, rows, total, poster, costUSD, engine, attempts, check, anchors }
 *        | { ok: false, gate, reason, costUSD, attempts, rows? }
 */
async function makeLookbook(db, deps, { nowMs = Date.now(), used = new Set() } = {}) {
  const log = deps.log || (() => {});
  let costUSD = 0;
  const attempts = [];

  // ── 1. THE OUTFIT, with real photos that actually download ─────────────
  const [{ candidates }, recent] = await Promise.all([
    loadLookbookCandidates(db, { nowMs }),
    loadRecentLookbookPids(db),
  ]);
  const exclude = new Set(used);
  let picked = null;
  for (let round = 0; round < 3; round++) {
    const p = lookbook.pickLookbookOutfit(candidates, { recent, used: exclude });
    if (p.reason) return { ok: false, gate: "outfit", reason: p.reason, costUSD, attempts };
    const photos = await Promise.all(p.rows.map(async (r) => {
      try { return await deps.fetchImage(r.photoUrl); } catch (e) { log(`lookbook: photo for ${r.pid} failed (${e && e.message}) — skipping it`); return null; }
    }));
    const bad = p.rows.filter((_, i) => !photos[i]);
    if (!bad.length) {
      picked = { ...p, rows: p.rows.map((r, i) => ({ ...r, thumb: photos[i].buffer, contentType: photos[i].contentType })) };
      break;
    }
    for (const r of bad) exclude.add(r.pid);
  }
  if (!picked) return { ok: false, gate: "outfit", reason: "product photos could not be fetched for a full outfit", costUSD, attempts };
  const rows = picked.rows;

  // ── 2. THE HERO, with the real garments attached ───────────────────────
  const prompt = lookbook.buildHeroPrompt(rows);
  const parts = [{ text: prompt }];
  rows.forEach((r, i) => {
    parts.push({ text: `REFERENCE ${i + 1} — ${r.slot.toUpperCase()}: ${r.displayName}. He wears exactly this item:` });
    parts.push(deps.inlineImagePart(r.thumb, r.contentType || "image/jpeg"));
  });
  const checkPrompt = lookbook.buildHeroCheckPrompt(rows);

  let hero = null, check = null, engine = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) {
      const left = await deps.unitsLeft();
      // One more generation must still leave one unit for the fallback.
      if (!(Number.isFinite(left) && left >= 2)) {
        return {
          ok: false, gate: "text", costUSD, attempts, rows,
          reason: `${check.reason} — not regenerated: ${Number.isFinite(left) ? left : "unknown"} unit(s) left today and the current-style fallback needs one`,
        };
      }
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
      if (deps.isUnbilledError(msg)) { try { await deps.releaseUnit(); } catch { /* best effort */ } }
      attempts.push({ attempt, error: msg.slice(0, 200) });
      return { ok: false, gate: "generate", reason: `the hero could not be generated: ${msg.slice(0, 160)}`, costUSD, attempts, rows };
    }
    costUSD += gen.costUSD || 0;
    engine = gen.engine || null;
    let answer = "";
    try { answer = await deps.checkHero(gen.buffer, gen.mime || "image/png", checkPrompt); } catch (e) { answer = ""; log(`lookbook: text check failed: ${e && e.message}`); }
    check = lookbook.readHeroCheck(answer, rows);
    attempts.push({ attempt, engine, costUSD: gen.costUSD || 0, textOk: check.ok, seen: check.seen || null, reason: check.reason });
    if (check.ok) { hero = gen; break; }
    log(`lookbook: attempt ${attempt} failed the text check — ${check.reason}`);
  }
  if (!hero) return { ok: false, gate: "text", reason: `the hero failed the no-text check twice (${check.reason})`, costUSD, attempts, rows };

  // ── 3. THE POSTER ──────────────────────────────────────────────────────
  const anchors = lookbook.anchorsFor(rows, check.anchors);
  try {
    const poster = await renderLookbookPoster({ hero: hero.buffer, rows, anchors, subject: check.head });
    return { ok: true, rows, total: poster.total, poster, costUSD, engine, attempts, check, anchors, hero, prompt };
  } catch (e) {
    return { ok: false, gate: "render", reason: `the poster could not be rendered: ${String(e && e.message).slice(0, 160)}`, costUSD, attempts, rows };
  }
}

module.exports = { makeLookbook };
