// ─── labelAlias CALLABLE — match a label reading / file a confirmed one ──────
// The ONLY reader and writer of /label_aliases (Admin SDK — no client rules
// needed, no rules change; see lib/label-alias.cjs for the model and bands).
//
//   { action: "match", tokens: [...] }
//     → { band: "high"|"mid"|"low", candidates: [{productId, score, shared}] }
//   { action: "add", productId, tokens: [...] }
//     → { ok: true, aliasId } | { ok: true, deduped: true }
//   { action: "codeLookup", code }
//     → { productId } | { productId: null }        exact code-alias lookup
//   { action: "recordLabelCodes", productId, chosenCode, otherCodes: [...] }
//     → { ok: true, attached: [...], conflicts: [{code, ownerId}] }
//   { action: "learnLayout", codes: [...], chosenCode }
//     → { ok: true, layoutKey, rule } | { ok: false, reason }
//
// "add" follows a merged product's pointer to its survivor (an alias must
// never point at a hidden record) and de-duplicates near-identical readings.
//
// "recordLabelCodes" is the multi-token-label rule (owner spec 2026-08-08):
// one shoe in the hand means EVERY code-shaped token on its label identifies
// the chosen product. Each token is filed as an exact CODE ALIAS — unless a
// DIFFERENT product already claims or aliases it, in which case nothing is
// attached and the pair is surfaced through the EXISTING duplicate flow
// (/duplicate_candidates), never silently. "learnLayout" records which token
// SHAPE the human picked for this label layout so the question is not asked
// twice (lib/label-layout.cjs has the model and the invalidation rule).
// Auth: the same staff set as every other style-code surface.

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const {
  LABEL_ALIASES_PATH, BANDS, normaliseAliasTokens, tokensToMap,
  scoreAliases, bandFor, isDuplicateAlias,
  normaliseAliasCodes, codesToMap, codeAliasOwnersAll, isDuplicateCodeAlias,
} = require("../lib/label-alias.cjs");
const { LAYOUT_RULES_PATH, layoutKeyFor, learnLayoutTransition } = require("../lib/label-layout.cjs");
const { normaliseStyleCode, styleCodeFormat } = require("../lib/style-code.cjs");
const { claimOwnerIds } = require("../lib/style-code-siblings.cjs");
const {
  STYLE_CODE_INDEX_PATH, flagDuplicates, duplicatePairId,
} = require("../styleCode/resolveStyleCode.js");
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

async function runLabelAlias(db, { action, tokens, productId, code, chosenCode, otherCodes, codes, actor, nowMs }) {
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

  // ── EXACT CODE-ALIAS LOOKUP — the untapped token resolves too ──────────────
  // Read-open like "match": the assistant's finder depends on it. Follows
  // merge pointers. Disagreement (two records, two products — the write race
  // the non-transactional attach can produce) FAILS CLOSED for the caller,
  // but never silently for good: the disagreeing pair is filed in the
  // duplicate queue so a human resolves it (Kimi review, PR #334).
  if (action === "codeLookup") {
    const norm = normaliseStyleCode(code);
    if (!norm) return { productId: null };
    const aliases = (await db.ref(LABEL_ALIASES_PATH).get()).val() || {};
    const owners = codeAliasOwnersAll(norm, aliases);
    if (!owners.length) return { productId: null };
    const resolved = [...new Set((await Promise.all(owners.map((o) => resolveProductId(db, o)))).filter(Boolean))].sort();
    if (resolved.length === 1) return { productId: resolved[0] };
    if (resolved.length > 1) {
      const [anchor, ...rest] = resolved;
      for (const other of rest) {
        await flagDuplicates(db, norm,
          [{ pairId: duplicatePairId(anchor, other), productIdA: anchor, productIdB: other }], actor, nowMs);
      }
    }
    return { productId: null };
  }

  // ── FILE EVERY CODE ON A MULTI-TOKEN LABEL (owner spec 2026-08-08) ─────────
  // One shoe in the hand → every code-shaped token identifies the chosen
  // product. A token some OTHER product already claims (index) or aliases is
  // NOT attached — it is surfaced as a possible duplicate through the existing
  // /duplicate_candidates flow instead, never silently swallowed.
  if (action === "recordLabelCodes") {
    const targetId = await resolveProductId(db, productId);
    if (!targetId) throw new HttpsError("not-found", "That product no longer exists.");
    const all = normaliseAliasCodes([chosenCode, ...(Array.isArray(otherCodes) ? otherCodes : [])]);
    if (!all.length) return { ok: true, attached: [], conflicts: [] };

    const aliases = (await db.ref(LABEL_ALIASES_PATH).get()).val() || {};
    const attachable = [];
    const conflicts = [];
    for (const c of all) {
      // The index is THE authority on who owns a code; a claim naming a
      // different product (primary or sibling) makes this token a collision,
      // not an alias. `.child()`-style single-row reads keep this bounded.
      const claim = (await db.ref(`${STYLE_CODE_INDEX_PATH}/${c}`).get()).val();
      const owners = claimOwnerIds(claim);
      if (owners.length) {
        const resolvedOwners = [];
        for (const o of owners) resolvedOwners.push(await resolveProductId(db, o));
        if (!resolvedOwners.includes(targetId)) {
          conflicts.push({ code: c, ownerId: resolvedOwners[0] || owners[0] });
          continue;
        }
        // The target itself owns the claim — nothing to alias, nothing wrong.
        continue;
      }
      // ALL alias records for this code, not the collapsed single-owner view:
      // codeAliasOwner folds "two products dispute this code" into null, and
      // treating that null as "free" would file a THIRD record for a disputed
      // token (CodeRabbit, PR #334). Any live holder other than the target —
      // sole or disputed — makes this a conflict, never an attach.
      const aliasHolders = codeAliasOwnersAll(c, aliases);
      if (aliasHolders.length) {
        const resolved = [...new Set((await Promise.all(aliasHolders.map((o) => resolveProductId(db, o)))).filter(Boolean))];
        const others = resolved.filter((r) => r !== targetId).sort();
        if (others.length) {
          conflicts.push({ code: c, ownerId: others[0] });
          continue;
        }
        if (resolved.includes(targetId)) continue; // already filed
        // every record points at a dead product — the code is free again
      }
      attachable.push(c);
    }

    // Conflicts go to the duplicate queue — deterministic pair rows, the same
    // never-reopen transaction the resolver uses. The style code on the row is
    // the COLLIDING token, so the reviewer sees what actually collided.
    for (const { code: c, ownerId } of conflicts) {
      if (!ownerId || ownerId === targetId) continue;
      const [a, b] = [targetId, ownerId].sort();
      await flagDuplicates(db, c, [{ pairId: duplicatePairId(a, b), productIdA: a, productIdB: b }], actor, nowMs);
    }

    if (attachable.length && !isDuplicateCodeAlias(attachable, targetId, aliases)) {
      const map = codesToMap(attachable);
      if (map) {
        const ref = db.ref(LABEL_ALIASES_PATH).push();
        await ref.set({
          productId: targetId,
          c: map,
          n: Object.keys(map).length,
          addedAt: nowMs,
          addedBy: actor.uid,
          src: "multi_code_label",
        });
      }
    }
    return { ok: true, attached: attachable, conflicts };
  }

  // ── LEARN THE LAYOUT — the human's tap teaches the shape rule ──────────────
  // Pure transition in lib/label-layout.cjs, applied inside a transaction so
  // two tablets answering at once cannot clobber each other's counts.
  if (action === "learnLayout") {
    const key = layoutKeyFor(codes);
    const chosenNorm = normaliseStyleCode(chosenCode);
    const chosenFormat = styleCodeFormat(chosenNorm);
    if (!key || !chosenFormat) return { ok: false, reason: "unkeyable-layout" };
    const inSet = normaliseAliasCodes(codes).includes(chosenNorm);
    if (!inSet) return { ok: false, reason: "chosen-not-a-candidate" };
    const ruleRef = db.ref(`${LAYOUT_RULES_PATH}/${key}`);
    const res = await ruleRef.transaction((cur) =>
      learnLayoutTransition(cur, chosenFormat, { nowMs, uid: actor ? actor.uid : null }));
    const rule = res && res.snapshot ? res.snapshot.val() : null;
    return { ok: true, layoutKey: key, rule };
  }

  throw new HttpsError("invalid-argument", "Unknown action.");
}

exports.runLabelAlias = runLabelAlias;
exports.resolveProductId = resolveProductId;

// Reading (match) is open to every style-code role INCLUDING store assistants
// — their label finder depends on it. MUTATING the alias store is not: an
// alias shapes identity resolution for everyone, so "add" demands one of the
// write-capable roles (the pre-assistant set) or the super-admin.
const ALIAS_WRITE_PERMISSIONS = ["product_admin", "display_checks", "stock_add", "stock_management"];

// Every action that WRITES identity state — filing a reading, filing a
// label's code set, teaching a layout rule — demands a write-capable role.
// The lookups ("match", "codeLookup") stay open to assistants.
const ALIAS_WRITE_ACTIONS = ["add", "recordLabelCodes", "learnLayout"];

exports.labelAlias = onCall({ region: "europe-west1" }, async (request) => {
  const db = admin.database();
  const actor = await assertStyleCodeAccess(request, db);
  const { action, tokens, productId, code, chosenCode, otherCodes, codes } = request.data || {};
  if (ALIAS_WRITE_ACTIONS.includes(action)
      && !actor.isSuper && !ALIAS_WRITE_PERMISSIONS.some((p) => actor.permissions.includes(p))) {
    throw new HttpsError("permission-denied", "Filing label readings needs a stock or display role.");
  }
  return runLabelAlias(db, { action, tokens, productId, code, chosenCode, otherCodes, codes, actor, nowMs: Date.now() });
});
exports.ALIAS_WRITE_PERMISSIONS = ALIAS_WRITE_PERMISSIONS;
