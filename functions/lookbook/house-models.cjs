// ─── THE THREE HOUSE MODELS, ROTATING ────────────────────────────────────────
// Junid, 30 Oct 2026 19:16: the single house model (26 Oct) is rejected and no
// lookbook photo with him is posted again; he is archived under
// social_lookbook/rejected and is nobody's reference. In his place, three
// INVENTED South African men (never a real person's face or likeness), one
// Black, one white, one Coloured, all early-to-mid 20s, tall and slim (a
// runway build), a sharp defined face and jawline, a very short clean haircut,
// clean-shaven or very light stubble, a confident model look.
//
// scripts/social/house-models.mjs makes three full-body candidates per model,
// has the critic model score each against the brief, and stores them:
//
//   social_lookbook/models/{slot} {
//     generatedAt, decideBy (generatedAt + 24 h),
//     candidates: { "1".."3": { path, url, contentType, score, parts, reasons, costUSD } },
//     picked: "n" | null, pickedBy: "junid" | "auto", pickedAt
//   }
//   social_lookbook/modelsApproval { approved: true, by: "junid", at, faces: { slot: path } }
//   social_lookbook/modelRotation  { last: slot, at, postId }
//
// Junid picks one per model (house-models.mjs --pick black=2). With no pick
// within 24 hours the highest-scoring candidate is picked and he is told
// (house-models.mjs --auto, run once by launchd at the deadline).
//
// NOTHING WITH A MODEL POSTS UNTIL JUNID HAS APPROVED THE MODELS (his hard
// constraint): gateFor() refuses until modelsApproval.approved is true, all
// three are picked, AND each picked face is the exact file he approved. A face
// changed after the approval (new candidates, an override, a later auto-pick)
// needs a new approval. An auto-pick is a pick, not an approval. A lookbook never
// generates without its model's reference (the old code drew whoever the
// prompt produced when the reference was missing).
"use strict";

const MODELS_PATH = "social_lookbook/models";
const APPROVAL_PATH = "social_lookbook/modelsApproval";
const ROTATION_PATH = "social_lookbook/modelRotation";
const REF_PREFIX = "aiStudio/social/lookbook/models/";
const DECIDE_MS = 24 * 3600 * 1000;
const CANDIDATES = 3;

// The brief every model shares (Junid, 30 Oct 19:16).
const SHARED = "in his early-to-mid 20s, tall and slim with a runway model's build, a sharp defined face and a strong jawline, a very short clean haircut (a skin fade or a buzz cut, hair barely visible), clean-shaven or very light stubble, a confident fashion-model look";

// The rotation order and each man's own brief. `skin` and `suits` go to the
// stylist and the critic: the outfit's colours must suit his skin tone.
const MODELS = {
  black: {
    key: "black", label: "Black South African",
    description: `a young Black South African man ${SHARED}, with deep brown skin`,
    skin: "deep brown skin with warm undertones",
    suits: "Colours that suit him: crisp white, cream, camel, tan, olive, burgundy, cobalt, mustard and bright accents; black works with a lighter piece near the face. Avoid dark brown or charcoal head to toe, which loses contrast with his skin.",
  },
  white: {
    key: "white", label: "white South African",
    description: `a young white South African man ${SHARED}, with fair-to-light skin`,
    skin: "fair-to-light skin with neutral undertones",
    suits: "Colours that suit him: navy, charcoal, black, forest green, burgundy, stone, denim blue and cool greys. Avoid washed-out pale beige, light khaki or pastel yellow near the face, which wash him out.",
  },
  coloured: {
    key: "coloured", label: "Coloured South African (Cape mixed heritage)",
    description: `a young Coloured South African man (Cape mixed heritage) ${SHARED}, with light-to-medium golden-brown skin`,
    skin: "light-to-medium golden-brown skin with warm undertones",
    suits: "Colours that suit him: white, cream, olive, khaki, rust, terracotta, teal, navy and earth tones. Avoid a top in the same mid-brown as his skin, and neon yellow or lime near the face.",
  },
};
const ORDER = ["black", "white", "coloured"];

// A tie on the overall score goes to the higher sum of the brief's part-scores.
const partsSum = (c) => Object.values((c && c.parts) || {}).reduce((t, v) => t + (Number(v) || 0), 0);

/** A slot's candidates as [{ n, ...c }], best first (score, part-score sum, lower number). Pure. */
function rankCandidates(node) {
  const c = (node && node.candidates) || {};
  return Object.entries(c)
    .filter(([, v]) => v && typeof v.path === "string" && v.path.startsWith(REF_PREFIX))
    .map(([n, v]) => ({ n: String(n), ...v }))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || partsSum(b) - partsSum(a) || Number(a.n) - Number(b.n));
}

/** The update that picks candidate `n` for `slot`. Throws for a candidate that does not exist. Pure. */
function pickUpdates(slot, node, n, { by, nowMs }) {
  if (!MODELS[slot]) throw new Error(`there is no house model "${slot}" (${ORDER.join(", ")})`);
  const c = rankCandidates(node).find((x) => x.n === String(n));
  if (!c) throw new Error(`there is no ${slot} candidate ${n}`);
  return { [`${MODELS_PATH}/${slot}/picked`]: c.n, [`${MODELS_PATH}/${slot}/pickedBy`]: by, [`${MODELS_PATH}/${slot}/pickedAt`]: nowMs };
}

/**
 * The auto-picks due now: every slot with candidates, no pick, and a decideBy
 * that has passed (no decideBy recorded is "not yet"). { updates, picked: [{ slot, n, score }] }. Pure.
 */
function duePicks(models, nowMs) {
  const updates = {}, picked = [];
  for (const slot of ORDER) {
    const node = models && models[slot];
    const ranked = rankCandidates(node);
    if (!node || node.picked || !ranked.length || !(Number(node.decideBy) > 0) || nowMs < Number(node.decideBy)) continue;
    Object.assign(updates, pickUpdates(slot, node, ranked[0].n, { by: "auto", nowMs }));
    picked.push({ slot, n: ranked[0].n, score: ranked[0].score });
  }
  return { updates, picked };
}

/** The candidate a slot uses: the pick, else (allowProvisional) the best-scoring one. Pure. */
function chosenFor(node, { allowProvisional = false } = {}) {
  const ranked = rankCandidates(node);
  if (node && node.picked) {
    const c = ranked.find((x) => x.n === String(node.picked));
    return c ? { ...c, provisional: false } : null;
  }
  return allowProvisional && ranked.length ? { ...ranked[0], provisional: true } : null;
}

/** The faces an approval covers: { slot: path } of each picked face. Pure. */
function approvalFaces(models) {
  return Object.fromEntries(ORDER.map((s) => [s, (chosenFor(models && models[s]) || {}).path || null]));
}

/**
 * May a lookbook with a model post? { ok, reason }. Pure.
 * Approved by Junid, all three picked, and every picked face the one he
 * approved; anything else is a refusal.
 */
function gateFor(models, approval) {
  const missing = ORDER.filter((s) => !chosenFor(models && models[s]));
  if (missing.length) return { ok: false, reason: `no face picked yet for the ${missing.join(", ")} model${missing.length > 1 ? "s" : ""}` };
  if (!(approval && approval.approved === true)) return { ok: false, reason: "Junid has not approved the new house models yet" };
  const faces = approval.faces || {};
  const changed = ORDER.filter((s) => faces[s] !== chosenFor(models[s]).path);
  if (changed.length) return { ok: false, reason: `the ${changed.join(", ")} face changed after Junid's approval: approve again` };
  return { ok: true, reason: null };
}

/** The next model in the rotation after `rotation.last`. Pure. */
function nextSlot(rotation) {
  const i = ORDER.indexOf(rotation && rotation.last);
  return ORDER[(i + 1) % ORDER.length];
}

module.exports = {
  MODELS_PATH, APPROVAL_PATH, ROTATION_PATH, REF_PREFIX, DECIDE_MS, CANDIDATES, MODELS, ORDER,
  rankCandidates, pickUpdates, duePicks, chosenFor, approvalFaces, gateFor, nextSlot,
};
