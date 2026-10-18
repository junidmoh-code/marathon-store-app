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
const { renderLookbookPoster, cutout: defaultCutout, gridOverlay } = require("../lib/lookbook-render.cjs");
const { loadLookbookCandidates, loadRecentLookbookPids } = require("./load.cjs");

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
 * @param opts  { nowMs, used: Set of pids already posted today, maxAttempts: heroes
 *               generated before the text gate gives up (production: 1) }
 * @returns { ok: true, rows, total, poster, costUSD, engine, attempts, check, anchors }
 *        | { ok: false, gate, reason, costUSD, attempts, rows? }
 */
async function makeLookbook(db, deps, { nowMs = Date.now(), used = new Set(), maxAttempts = 2 } = {}) {
  const log = deps.log || (() => {});
  let costUSD = 0;
  const attempts = [];

  // ── 1. THE OUTFIT, with real photos that actually download ─────────────
  const [{ candidates }, recent] = await Promise.all([
    loadLookbookCandidates(db, { nowMs }),
    loadRecentLookbookPids(db),
  ]);
  // A row needs a photo that downloads AND cuts out cleanly. One that fails
  // either is excluded and its slot re-picked, never drawn badly and never a
  // reason to stall: the next product in the slot is tried.
  const cut = deps.cutout || defaultCutout;
  const exclude = new Set(used);
  const ready = new Map();          // pid → { thumb, contentType, cutout }
  let picked = null;
  for (let round = 0; round < 8; round++) {
    const p = lookbook.pickLookbookOutfit(candidates, { recent, used: exclude });
    if (p.reason) return { ok: false, gate: "outfit", reason: p.reason, costUSD, attempts };
    const fresh = p.rows.filter((r) => !ready.has(r.pid));
    // One at a time: each cut-out holds an ONNX session's worth of memory, and
    // six in parallel is how a 2 GiB instance dies (architect review, B2).
    for (const r of fresh) await (async () => {
      try {
        const img = await deps.fetchImage(r.photoUrl);
        const c = await cut(img.buffer);
        if (!c || !c.png) { log(`lookbook: ${r.pid} photo does not cut out cleanly (${(c && c.tried || []).join(", ")}) — skipping it`); exclude.add(r.pid); return; }
        ready.set(r.pid, { thumb: img.buffer, contentType: img.contentType, cutout: c });
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
  if (!picked) return { ok: false, gate: "outfit", reason: "no full outfit with photos that download and cut out cleanly", costUSD, attempts };
  const rows = picked.rows;

  // ── 2. THE HERO, with the real garments attached ───────────────────────
  const prompt = lookbook.buildHeroPrompt(rows);
  const parts = [{ text: prompt }];
  rows.forEach((r, i) => {
    parts.push({ text: `REFERENCE ${i + 1} — ${r.slot.toUpperCase()}: ${r.displayName}. He wears exactly this item:` });
    parts.push(deps.inlineImagePart(r.thumb, r.contentType || "image/jpeg"));
  });
  const checkPrompt = lookbook.buildHeroCheckPrompt();

  let hero = null, check = null, engine = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // EVERY generation, the first included, must leave one unit for the
    // current-style fallback. Without this a morning that already spent three
    // (a billed reel retry) let the lookbook take the fourth, and a failed gate
    // then left the day with nothing (architect review, B1).
    const left = await deps.unitsLeft();
    if (!(Number.isFinite(left) && left >= 2)) {
      return attempt === 1
        ? { ok: false, gate: "cap", costUSD, attempts, rows, reason: `only ${Number.isFinite(left) ? left : "an unknown number of"} generation unit(s) left today — the lookbook would leave the current-style fallback none` }
        : { ok: false, gate: "text", costUSD, attempts, rows, reason: `${check.reason} — not regenerated: ${Number.isFinite(left) ? left : "unknown"} unit(s) left today and the current-style fallback needs one` };
    }
    if (attempt === 2 && deps.deadlineMs && Date.now() > deps.deadlineMs) {
      return { ok: false, gate: "text", costUSD, attempts, rows, reason: `${check.reason} — not regenerated: out of time for a second attempt and the fallback` };
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
    attempts.push({ attempt, engine, costUSD: gen.costUSD || 0, textOk: check.ok, seen: check.seen || null, reason: check.reason });
    if (check.ok) { hero = gen; break; }
    log(`lookbook: attempt ${attempt} failed the text check — ${check.reason}`);
  }
  if (!hero) return { ok: false, gate: "text", reason: `the hero failed the no-text check${attempts.length === 2 ? " twice" : ""} (${check.reason})`, costUSD, attempts, rows };

  // ── 3. WHERE THE GARMENTS ARE (for the dots) ───────────────────────────
  // Best effort: an unanswered locate leaves the dots on the category spots.
  let located = { anchors: {}, head: null };
  try {
    const gridded = await gridOverlay(hero.buffer, lookbook.GRID);
    located = lookbook.readLocate(await deps.checkHero(gridded, "image/jpeg", lookbook.buildLocatePrompt(rows)), rows);
  } catch (e) { log(`lookbook: locate failed (${e && e.message}) — dots on the category spots`); }

  // ── 4. THE POSTER ──────────────────────────────────────────────────────
  const anchors = lookbook.anchorsFor(rows, located.anchors, located.head);
  try {
    const poster = await renderLookbookPoster({ hero: hero.buffer, rows, anchors, subject: located.head });
    return { ok: true, rows, total: poster.total, poster, costUSD, engine, attempts, check, located, anchors, hero, prompt };
  } catch (e) {
    return { ok: false, gate: "render", reason: `the poster could not be rendered: ${String(e && e.message).slice(0, 160)}`, costUSD, attempts, rows };
  }
}

module.exports = { makeLookbook };
