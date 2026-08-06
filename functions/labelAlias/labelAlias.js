// ─── labelAlias CALLABLE — match a label reading / file a confirmed one ──────
// The ONLY reader and writer of /label_aliases (Admin SDK — no client rules
// needed, no rules change; see lib/label-alias.cjs for the model and bands).
//
//   { action: "match", tokens: [...] }
//     → { band: "high"|"mid"|"low", candidates: [{productId, score, shared}] }
//   { action: "add", productId, tokens: [...] }
//     → { ok: true, aliasId } | { ok: true, deduped: true }
//
// "add" follows a merged product's pointer to its survivor (an alias must
// never point at a hidden record) and de-duplicates near-identical readings.
// Auth: the same staff set as every other style-code surface.

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const {
  LABEL_ALIASES_PATH, BANDS, normaliseAliasTokens, tokensToMap,
  scoreAliases, bandFor, isDuplicateAlias,
} = require("../lib/label-alias.cjs");
const { assertStyleCodeAccess } = require("../styleCode/access.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

/** Follow a mergedInto chain (bounded) to the record that answers today. */
async function resolveProductId(db, productId) {
  // Sanitise ONCE and use the sanitised id throughout — looking up "p123 "
  // as products/p123 but then STORING "p123 " would mint aliases pointing at
  // an id that does not exist.
  const clean = (v) => String(v ?? "").replace(/[.#$/\[\]\s]/g, "");
  let id = clean(productId);
  for (let hops = 0; hops < 5 && id; hops++) {
    const p = (await db.ref(`products/${id}`).get()).val();
    if (!p) return null;
    if (!p.mergedInto) return id;
    id = clean(p.mergedInto);
  }
  return null;
}

async function runLabelAlias(db, { action, tokens, productId, actor, nowMs }) {
  // ── WHY A FULL-NODE READ IS THE RIGHT SIZE HERE ────────────────────────────
  // /label_aliases grows by one row per HUMAN-CONFIRMED reading of a shoe with
  // no printed code — a bounded, low-hundreds population for this business,
  // read server-side on the Admin SDK. An index would add write-path
  // complexity to optimise a node smaller than one product photo. The
  // check-then-push dedupe below is likewise not atomic ON PURPOSE: the worst
  // a concurrent double-confirm can produce is one redundant near-duplicate
  // alias for the SAME product, which scoring treats identically (proven by
  // test) — never a wrong match, never data loss.
  if (action === "match") {
    const clean = normaliseAliasTokens(tokens);
    if (clean.length < BANDS.MIN_TOKENS) {
      return { band: "low", candidates: [], tokenCount: clean.length };
    }
    const aliases = (await db.ref(LABEL_ALIASES_PATH).get()).val() || {};
    const scored = scoreAliases(clean, aliases).slice(0, 3)
      .map(({ productId: pid, score, shared }) => ({ productId: pid, score: Math.round(score * 100) / 100, shared }));
    return { band: bandFor(scored), candidates: scored, tokenCount: clean.length };
  }

  if (action === "add") {
    const map = tokensToMap(tokens);
    if (!map) throw new HttpsError("invalid-argument", "That reading has too few usable tokens to be an identity.");
    const targetId = await resolveProductId(db, productId);
    if (!targetId) throw new HttpsError("not-found", "That product no longer exists.");
    const aliases = (await db.ref(LABEL_ALIASES_PATH).get()).val() || {};
    if (isDuplicateAlias(Object.keys(map), targetId, aliases)) {
      return { ok: true, deduped: true, productId: targetId };
    }
    const ref = db.ref(LABEL_ALIASES_PATH).push();
    await ref.set({
      productId: targetId,
      t: map,
      n: Object.keys(map).length,
      addedAt: nowMs,
      addedBy: actor.uid,
    });
    return { ok: true, aliasId: ref.key, productId: targetId };
  }

  throw new HttpsError("invalid-argument", "Unknown action.");
}

exports.runLabelAlias = runLabelAlias;
exports.resolveProductId = resolveProductId;

exports.labelAlias = onCall({ region: "europe-west1" }, async (request) => {
  const db = admin.database();
  const actor = await assertStyleCodeAccess(request, db);
  const { action, tokens, productId } = request.data || {};
  return runLabelAlias(db, { action, tokens, productId, actor, nowMs: Date.now() });
});
