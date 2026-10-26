// ─── THE HOUSE MODEL: ONE INVENTED MAN, THE BRAND'S FACE ────────────────────
// Junid, 26 Oct 2026: one consistent house model for every outfit post — a
// young South African Black man, early 20s, slim athletic build, dark brown
// skin, a clean low fade, clean-shaven or very light stubble, calm and
// confident. An INVENTED person: never a real person's photo or likeness.
//
// scripts/social/house-model.mjs makes four candidate faces once, has the
// critic model score each against that brief, and stores them:
//
//   social_lookbook/houseModel {
//     generatedAt, decideBy (generatedAt + 24 h),
//     candidates: { "1".."4": { path, url, contentType, score, reasons, costUSD } },
//     picked: "n" | null, pickedBy: "junid" | "auto", pickedAt
//   }
//
// Junid picks one (house-model.mjs --pick n). Until he does, the best-scoring
// candidate stands in; once decideBy passes with no pick, the best-scoring
// one is PICKED (written here the first time a hero needs the reference) and
// the choice is final. A pick writes social_lookbook/model, the reference
// lookbook/engines readModelRef attaches to every hero.
"use strict";

const HOUSE_PATH = "social_lookbook/houseModel";
const MODEL_PATH = "social_lookbook/model";
const REF_PREFIX = "aiStudio/social/lookbook/model/";
const DECIDE_MS = 24 * 3600 * 1000;

/** The candidates as [{ n, ...c }], best score first (ties: the lower number). Pure. */
function rankCandidates(hm) {
  const c = (hm && hm.candidates) || {};
  return Object.entries(c)
    .filter(([, v]) => v && typeof v.path === "string" && v.path.startsWith(REF_PREFIX))
    .map(([n, v]) => ({ n: String(n), ...v }))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || Number(a.n) - Number(b.n));
}

/**
 * The multi-path update that makes candidate `n` the house model. Pure.
 * Throws for a candidate that does not exist.
 */
function pickUpdates(hm, n, { by, nowMs }) {
  const c = rankCandidates(hm).find((x) => x.n === String(n));
  if (!c) throw new Error(`there is no house-model candidate ${n}`);
  return {
    [`${HOUSE_PATH}/picked`]: c.n,
    [`${HOUSE_PATH}/pickedBy`]: by,
    [`${HOUSE_PATH}/pickedAt`]: nowMs,
    [MODEL_PATH]: {
      path: c.path, url: c.url || null, contentType: c.contentType || "image/jpeg", at: nowMs,
      engine: c.engine || null, costUSD: Number(c.costUSD) || 0, house: c.n, pickedBy: by,
      check: c.check || null,
    },
  };
}

/**
 * Which reference a hero gets now: { path, contentType, house, provisional }
 * or null (the older social_lookbook/model, or nothing). Writes the auto-pick
 * once decideBy has passed with no pick. `hm` and `model` are the two nodes
 * as read; `pick(updates)` applies an update (a transaction-free multi-path
 * update is enough: the auto-pick is the same answer however often it runs).
 */
async function resolveRef(hm, model, { nowMs = Date.now(), pick = null } = {}) {
  const ranked = rankCandidates(hm);
  if (hm && ranked.length && !hm.picked) {
    const best = ranked[0];
    if (nowMs >= Number(hm.decideBy || 0) && pick) {
      await pick(pickUpdates(hm, best.n, { by: "auto", nowMs }));
      return { path: best.path, contentType: best.contentType || "image/jpeg", house: best.n, provisional: false, auto: true };
    }
    return { path: best.path, contentType: best.contentType || "image/jpeg", house: best.n, provisional: true };
  }
  if (model && typeof model.path === "string" && model.path.startsWith(REF_PREFIX)) {
    return { path: model.path, contentType: model.contentType || "image/jpeg", house: model.house || null, provisional: false };
  }
  return null;
}

module.exports = { HOUSE_PATH, MODEL_PATH, REF_PREFIX, DECIDE_MS, rankCandidates, pickUpdates, resolveRef };
