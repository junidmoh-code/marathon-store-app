// ─── styleCodeSibling CALLABLE — the registration collision, answered ────────
// At registration the operator has ALREADY found and selected the product — a
// human has vouched for the identity. When the label's code turns out to be
// claimed by a DIFFERENT product, that is no longer automatically a duplicate:
// the standard Nike tongue label prints no colourway text, so one code on two
// products can be two real colourways (owner evidence 2026-08-07, HF5509-002 —
// see lib/style-code-siblings.cjs). The UI asks ONE question and this callable
// records the answer. It never resolves the collision silently in either
// direction, and it never merges anything.
//
//   { action: "differentColourway", code, productId }
//     → registers productId as a SIBLING owner of the code. Both products keep
//       the code, neither is flagged, nothing lands in /duplicate_candidates.
//       Stamps the code onto the product IF its slot is empty (immutable once
//       set — an occupied slot is left alone; a DIFFERENT occupied code is a
//       refusal, same as the capture worker's code-conflict rule).
//   { action: "sameShoe", code, productId, otherId }
//     → records the answer and upserts the /duplicate_candidates pair row so
//       the EXISTING merge flow takes over. This callable does not merge.
//
// Every answer becomes a row in /style_code_sibling_events (Admin-SDK only,
// no client rules — invisible to devices, visible to anyone auditing). When a
// code accumulates owners unusually fast, or the same pair keeps being
// answered "different colourway", the event is FLAGGED and logged — and
// nothing else happens. Flags are for a human's eyes, never an input to
// behaviour.
//
// ── WHY THE ADMIN SDK, AND WHY NO RULES CHANGE ───────────────────────────────
// The live claim rule permits exactly {productId, claimedAt, claimedBy} from
// clients, create-once. The `siblings` child would fail every client write —
// which is correct: siblingship is an ANSWERED QUESTION, not a form field, so
// it must only ever be written by this callable after validation. The Admin
// SDK bypasses rules, so no rule text changes; the client claim path is
// untouched (a claim create never contains `siblings`).
//
// DEPLOY (scoped, when the owner chooses to):
//   firebase deploy --only functions:styleCodeSibling

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const {
  SIBLING_EVENTS_PATH,
  ANSWER_SAME_SHOE,
  ANSWER_DIFFERENT_COLOURWAY,
  claimOwnerIds,
  buildSiblingEntry,
  siblingVelocity,
  repeatAnswerCount,
} = require("../lib/style-code-siblings.cjs");
const { normaliseStyleCode, formatStyleCodeForDisplay } = require("../lib/style-code.cjs");
const { STYLE_CODE_INDEX_PATH, DUPLICATE_CANDIDATES_PATH, DUP_REASON_STYLE_CODE, duplicatePairId } = require("./resolveStyleCode.js");
const { assertStyleCodeAccess } = require("./access.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// The same write-capable set that may file label aliases: answering the
// collision question shapes identity resolution for every later scan, so the
// read-only assistant role does not qualify.
const SIBLING_WRITE_PERMISSIONS = ["product_admin", "display_checks", "stock_add", "stock_management"];

// A legal RTDB key — same guard the merge uses. An id with "/." would resolve
// to a nested node, not a product.
const SAFE_KEY = /^[^./#$[\]\s]+$/;

/**
 * The worker core — injectable db/clock so every branch is node-testable.
 * @returns one of:
 *   { ok:true, registered:true, owners, flagged }          (differentColourway)
 *   { ok:true, registered:false, alreadyOwner:true, owners } (idempotent repeat)
 *   { ok:true, recorded:true, pairId }                     (sameShoe)
 */
async function runSibling(db, { action, code, productId, otherId, actor, nowMs }) {
  const normalised = normaliseStyleCode(code);
  if (!normalised) throw new HttpsError("invalid-argument", "A style code is required.");
  if (typeof productId !== "string" || !SAFE_KEY.test(productId)) {
    throw new HttpsError("invalid-argument", "productId is not a legal id.");
  }

  const claimRef = db.ref(`${STYLE_CODE_INDEX_PATH}/${normalised}`);
  let claim = (await claimRef.get()).val();
  if (!claim || typeof claim.productId !== "string" || !claim.productId) {
    // No claim exists. Codes that PRE-DATE the index sit stamped on products
    // that never claimed them (this repo's own twin incident), so a collision
    // can be real while the index is empty. When the caller names the other
    // product AND that product genuinely carries this code, the claim is
    // bootstrapped for IT (it carried the code first) and the answer proceeds.
    // Anything else is not a collision — the normal create-once claim path is
    // the right door, and this callable refuses to be a way around it.
    const cleanOther = typeof otherId === "string" && SAFE_KEY.test(otherId) ? otherId : null;
    const other = cleanOther ? (await db.ref(`products/${cleanOther}`).get()).val() : null;
    const otherCarries = other && !other.mergedInto
      && normaliseStyleCode(other.styleCodeNormalised) === normalised;
    if (!otherCarries) {
      throw new HttpsError("failed-precondition", "This code is not claimed yet — save it the normal way.");
    }
    await claimRef.transaction((cur) => {
      if (cur) return undefined; // someone claimed in the meantime — keep theirs
      return { productId: cleanOther, claimedAt: nowMs, claimedBy: actor ? actor.uid : null };
    });
    claim = (await claimRef.get()).val();
    if (!claim || typeof claim.productId !== "string" || !claim.productId) {
      throw new HttpsError("internal", "Could not establish the code's claim — try again.");
    }
  }

  const product = (await db.ref(`products/${productId}`).get()).val();
  if (!product) throw new HttpsError("not-found", "That product no longer exists.");
  if (product.mergedInto) {
    throw new HttpsError("failed-precondition", "That product was merged away — work with its survivor.");
  }

  if (action === ANSWER_SAME_SHOE || action === "sameShoe") {
    // Record the answer, make sure the pair row exists, and hand over to the
    // EXISTING merge flow. Never merges here; never reopens a human-closed row.
    const cleanOther = typeof otherId === "string" && SAFE_KEY.test(otherId) ? otherId : null;
    if (!cleanOther) throw new HttpsError("invalid-argument", "otherId is required for a same-shoe answer.");
    // A pair is TWO products. duplicatePairs in the resolver can never emit a
    // self-pair; this callable is the only writer that could, so it refuses —
    // a "p__p" row would enter the human merge queue offering a self-merge.
    if (cleanOther === productId) {
      throw new HttpsError("invalid-argument", "otherId must name a different product.");
    }
    // And it must name a REAL, live product — same bar the differentColourway
    // branch holds productId to. A mistyped id filing a phantom pair row would
    // sit in the merge queue pointing at nothing.
    const otherProduct = (await db.ref(`products/${cleanOther}`).get()).val();
    if (!otherProduct) throw new HttpsError("not-found", "That other product no longer exists.");
    if (otherProduct.mergedInto) {
      throw new HttpsError("failed-precondition", "That other product was merged away — work with its survivor.");
    }
    const pairId = duplicatePairId(productId, cleanOther);
    const pairRef = db.ref(`${DUPLICATE_CANDIDATES_PATH}/${pairId}`);
    const prior = (await pairRef.get()).val();
    const [a, b] = [productId, cleanOther].sort();
    // update(), not set(): the write must be ADDITIVE. A set() would erase any
    // children a later writer needs preserved — and the resolver's re-detection
    // path must likewise carry the answered-same-shoe evidence forward (see
    // flagDuplicates), or the strongest fact on the row dies on the next scan.
    await pairRef.update({
      productIdA: a,
      productIdB: b,
      reason: DUP_REASON_STYLE_CODE,
      status: prior && typeof prior.status === "string" ? prior.status : "open",
      detectedAt: prior && Number.isFinite(Number(prior.detectedAt)) ? Number(prior.detectedAt) : nowMs,
      styleCodeNormalised: normalised,
      detectedBy: actor ? actor.uid : null,
      // $other is permissive on this node (SCHEMA.md) — record that a human
      // answered "same shoe", which is stronger evidence than a scan collision.
      answeredSameShoeBy: actor ? actor.uid : null,
      answeredSameShoeAt: nowMs,
    });
    await db.ref(`${SIBLING_EVENTS_PATH}/${normalised}`).push({
      productId, otherId: cleanOther,
      answer: ANSWER_SAME_SHOE, by: actor ? actor.uid : null, at: nowMs, flagged: false,
    });
    console.log(`styleCodeSibling: ${normalised} answered SAME SHOE (${productId} vs ${cleanOther}) — routed to merge`);
    return { ok: true, recorded: true, pairId };
  }

  if (action === ANSWER_DIFFERENT_COLOURWAY || action === "differentColourway") {
    // The answer covers a PAIR: the operator's product AND the named other.
    // With three products on one code the UI asks once and answers per pair,
    // so a stamped-but-unregistered OTHER is registered here too — the
    // operator explicitly vouched for both sides of this pair. An other that
    // does not carry the code is simply not registered (it was context, not a
    // party to the answer).
    const cleanOther = typeof otherId === "string" && SAFE_KEY.test(otherId) && otherId !== productId ? otherId : null;
    const registerOtherIfStamped = async () => {
      if (!cleanOther) return false;
      const current = (await claimRef.get()).val();
      if (claimOwnerIds(current).includes(cleanOther)) return false;
      const other = (await db.ref(`products/${cleanOther}`).get()).val();
      if (!other || other.mergedInto) return false;
      if (normaliseStyleCode(other.styleCodeNormalised) !== normalised) return false;
      const res = await db.ref(`${STYLE_CODE_INDEX_PATH}/${normalised}/siblings/${cleanOther}`).transaction((cur) => {
        if (cur) return undefined;
        return buildSiblingEntry({ addedBy: actor ? actor.uid : null, nowMs, origin: "registration-other" });
      });
      return !!res.committed;
    };

    const ownersBefore = claimOwnerIds(claim);
    if (ownersBefore.includes(productId)) {
      // The product is already an owner — a repeat answer for a FURTHER pair
      // (three-way collisions answer once per other), or a plain retry. The
      // other side of the pair may still need registering; the answer for a
      // genuinely new pair is still recorded.
      const otherRegistered = await registerOtherIfStamped();
      if (otherRegistered) {
        await db.ref(`${SIBLING_EVENTS_PATH}/${normalised}`).push({
          productId, otherId: cleanOther,
          answer: ANSWER_DIFFERENT_COLOURWAY, by: actor ? actor.uid : null, at: nowMs, flagged: false,
        });
      }
      return {
        ok: true, registered: false, alreadyOwner: true, otherRegistered,
        owners: claimOwnerIds((await claimRef.get()).val()),
      };
    }

    // The product's own code slot: empty → stamp (the sibling now carries the
    // code like any owner); same code → fine; a DIFFERENT code → refuse. The
    // slot is immutable once set and this is not ours to resolve — mirrors the
    // capture worker's code-conflict rule exactly.
    const existingOwn = normaliseStyleCode(product.styleCodeNormalised);
    if (existingOwn && existingOwn !== normalised) {
      throw new HttpsError("failed-precondition",
        `That product already carries a different style code (${formatStyleCodeForDisplay(existingOwn)}).`);
    }

    // Create-once on the sibling slot — two tablets answering at once must not
    // double-write. First writer wins; the second reads back as alreadyOwner.
    const sibRef = db.ref(`${STYLE_CODE_INDEX_PATH}/${normalised}/siblings/${productId}`);
    const res = await sibRef.transaction((cur) => {
      if (cur) return undefined; // occupied — abort
      return buildSiblingEntry({ addedBy: actor ? actor.uid : null, nowMs, origin: "registration" });
    });
    if (!res.committed) {
      return { ok: true, registered: false, alreadyOwner: true, owners: claimOwnerIds((await claimRef.get()).val()) };
    }

    if (!existingOwn) {
      await db.ref(`products/${productId}`).update({
        styleCode: formatStyleCodeForDisplay(normalised),
        styleCodeNormalised: normalised,
        styleCodeSource: "manual",
        styleCodeFetchedAt: nowMs,
        styleCodeConfirmedBy: actor ? actor.uid : null,
      });
    }

    // The other side of this pair (three-way collisions register both parties).
    await registerOtherIfStamped();

    // ── Observability: velocity + repeat answers. LOGGED, NEVER ACTED ON. ──
    const after = (await claimRef.get()).val();
    const velocity = siblingVelocity(after, nowMs);
    // The pair the operator actually answered about: the named other when one
    // was given, else the primary claimant they were shown.
    const primary = cleanOther || claim.productId;
    let repeats = 0;
    try {
      // Events are keyed BY CODE (…/{code}/{pushId}) precisely so this read is
      // bounded: one code's history, not every answer ever given. No index, no
      // rules change, no unbounded egress as the node grows.
      const events = (await db.ref(`${SIBLING_EVENTS_PATH}/${normalised}`).get()).val();
      repeats = repeatAnswerCount(events, normalised, productId, primary);
    } catch (err) {
      console.warn(`styleCodeSibling: repeat-answer read failed for ${normalised}:`, err && err.message);
    }
    const flagged = velocity.flag || repeats > 0;
    if (flagged) {
      console.warn(`styleCodeSibling: FLAG ${normalised} — ${velocity.reasons.join(",") || "repeat-answer"} ` +
        `owners=${velocity.ownerCount} repeats=${repeats} (logged only, nothing acted on)`);
    }
    await db.ref(`${SIBLING_EVENTS_PATH}/${normalised}`).push({
      productId, otherId: primary,
      answer: ANSWER_DIFFERENT_COLOURWAY, by: actor ? actor.uid : null, at: nowMs,
      flagged, ...(flagged ? { flagReasons: [...velocity.reasons, ...(repeats ? ["repeat-answer"] : [])] } : {}),
    });

    console.log(`styleCodeSibling: ${normalised} answered DIFFERENT COLOURWAY — ${productId} registered as sibling ` +
      `(owners now ${claimOwnerIds(after).length})`);
    return { ok: true, registered: true, owners: claimOwnerIds(after), flagged };
  }

  throw new HttpsError("invalid-argument", "Unknown action.");
}

exports.runSibling = runSibling;
exports.SIBLING_WRITE_PERMISSIONS = SIBLING_WRITE_PERMISSIONS;

exports.styleCodeSibling = onCall({ region: "europe-west1" }, async (request) => {
  const db = admin.database();
  const actor = await assertStyleCodeAccess(request, db);
  if (!actor.isSuper && !SIBLING_WRITE_PERMISSIONS.some((p) => actor.permissions.includes(p))) {
    throw new HttpsError("permission-denied", "Answering a style-code collision needs a stock or display role.");
  }
  const { action, code, productId, otherId } = request.data || {};
  return runSibling(db, { action, code, productId, otherId, actor, nowMs: Date.now() });
});
